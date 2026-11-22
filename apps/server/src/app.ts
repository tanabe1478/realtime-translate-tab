import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  decodeAudioFrame,
  isLanguageCode,
  isYouTubeVideoId,
  parseTranslationHints,
  type CreateSessionRequest,
  type HealthResponse,
  type ServerEvent,
  type SourceKind,
} from "@realtime-translate/contracts";
import { AppDatabase } from "./database.js";
import type { Providers } from "./providers/index.js";
import { AudioIngestService } from "./services/audio-ingest.js";
import { EventHub } from "./services/event-hub.js";
import { ProcessingPipeline } from "./services/processing-pipeline.js";
import { VideoContextService } from "./services/video-context.js";
import type { fetchVideoMetadata } from "./services/video-metadata.js";

export interface ApplicationOptions {
  database: AppDatabase;
  providers: Providers;
  audioRoot: string;
  webRoot: string;
  metadataFetcher?: typeof fetchVideoMetadata;
}

/** No listening/global side effects: also used by HTTP and end-to-end tests. */
export function createApplication(options: ApplicationOptions) {
  const { database, providers, audioRoot, webRoot } = options;
  const events = new EventHub();
  const videoContexts = new VideoContextService(
    database,
    providers.contextGenerator,
    options.metadataFetcher,
    providers.translationIssue ?? undefined,
  );
  const pipeline = new ProcessingPipeline(
    database,
    events,
    providers.recognizer,
    providers.translator,
    videoContexts,
    providers.translationIssue ?? undefined,
  );
  const ingest = new AudioIngestService(database, pipeline, audioRoot);

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: "Internal server error" });
    });
  });

  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 26 * 1024 * 1024,
  });

  server.on("upgrade", (request, socket, head) => {
    if (!allowedOrigin(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !database.getSession(sessionId)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      attachWebSocket(webSocket, sessionId),
    );
  });

  for (const segment of database.getRecoverableSegments())
    pipeline.enqueue(segment);

  function attachWebSocket(webSocket: WebSocket, sessionId: string): void {
    let receiving = false;
    const send = (event: ServerEvent): void => {
      if (webSocket.readyState === WebSocket.OPEN)
        webSocket.send(JSON.stringify(event));
    };
    const unsubscribe = events.subscribe(sessionId, send);
    const session = database.getSession(sessionId)!;
    send({
      type: "connected",
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      lastAckedSeq: session.lastAckedSeq,
    });

    webSocket.on("message", async (raw: RawData, isBinary: boolean) => {
      if (!isBinary || receiving) {
        webSocket.close(
          1008,
          isBinary
            ? "Only one audio frame may be uploaded at a time"
            : "Binary audio frame required",
        );
        return;
      }
      receiving = true;
      let sequence = -1;
      try {
        const frame = decodeAudioFrame(toUint8Array(raw));
        sequence = frame.header.seq;
        if (frame.header.sessionId !== sessionId)
          throw new Error("Frame session does not match this connection");
        await ingest.ingest(frame.header, frame.audio);
        send({ type: "audio.ack", sessionId, seq: frame.header.seq });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({
          type: "audio.rejected",
          sessionId,
          seq: sequence,
          message: message.slice(0, 300),
          retryable: false,
        });
      } finally {
        receiving = false;
      }
    });

    webSocket.on("close", unsubscribe);
    webSocket.on("error", (error) =>
      console.error(`WebSocket error for ${sessionId}`, error),
    );
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!allowedOrigin(request)) throw new HttpError(403, "Origin not allowed");
    const method = request.method || "GET";
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );

    if (method === "GET" && url.pathname === "/api/health") {
      const asrReady = providers.recognizer
        ? await providers.recognizer.checkHealth(AbortSignal.timeout(1_500))
        : false;
      const health: HealthResponse = {
        ok: true,
        asrProvider: providers.recognizer ? "local-whisper" : "disabled",
        asrReady,
        asrModel: providers.recognizer?.model ?? null,
        translationProvider: providers.translator
          ? providers.translationSelection === "opencode-go" ? "opencode-go"
            : providers.translationAuthType === "oauth" ? "chatgpt-subscription" : "openai-api"
          : "disabled",
        translationSelection: providers.translationSelection,
        translationAuthType: providers.translationAuthType,
        translationMessage: providers.translationIssue,
        translationReady: providers.translator !== null,
        translationModel: providers.translationModel,
        protocolVersion: PROTOCOL_VERSION,
      };
      sendJson(response, 200, health);
      return;
    }

    const contextMatch = /^\/api\/video-contexts\/([a-zA-Z0-9_-]+)$/.exec(
      url.pathname,
    );
    if (contextMatch?.[1]) {
      const videoId = contextMatch[1];
      const targetLanguage = url.searchParams.get("targetLanguage");
      if (!isYouTubeVideoId(videoId) || !isLanguageCode(targetLanguage))
        throw new HttpError(400, "Invalid videoId or targetLanguage");
      if (method === "GET") {
        const value = database.getVideoContext(videoId, targetLanguage);
        sendJson(
          response,
          value ? 200 : 404,
          value ?? { error: "Video context not found" },
        );
        return;
      }
      if (method === "POST") {
        const body = (await readJson(request)) as { force?: unknown } | null;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          (body.force !== undefined && typeof body.force !== "boolean")
        )
          throw new HttpError(400, "Invalid request body");
        sendJson(
          response,
          200,
          videoContexts.prepare(videoId, targetLanguage, body.force === true),
        );
        return;
      }
      if (method === "PUT") {
        const body = (await readJson(request)) as {
          mode?: unknown;
          hints?: unknown;
          expectedVersion?: unknown;
        } | null;
        if (
          !body ||
          Array.isArray(body) ||
          !Number.isSafeInteger(body.expectedVersion) ||
          (body.expectedVersion as number) < 0 ||
          (body.mode !== "manual" && body.mode !== "auto")
        )
          throw new HttpError(400, "Invalid context update");
        if (!database.getVideoContext(videoId, targetLanguage))
          throw new HttpError(404, "Video context not found");
        let hints;
        if (body.mode === "manual") {
          try {
            hints = parseTranslationHints(body.hints);
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error ? error.message : "Invalid hints",
            );
          }
        }
        const value = hints
          ? videoContexts.saveManual(
              videoId,
              targetLanguage,
              hints,
              body.expectedVersion as number,
            )
          : videoContexts.resumeAutomatic(
              videoId,
              targetLanguage,
              body.expectedVersion as number,
            );
        if (!value)
          throw new HttpError(
            409,
            "内容が更新されました。最新の内容を確認してから、もう一度保存してください。",
          );
        sendJson(response, 200, value);
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(request);
      const input = parseCreateSession(body);
      const session = database.createSession(input);
      if (session.videoId)
        videoContexts.prepare(session.videoId, session.targetLanguage);
      sendJson(response, 201, session);
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([0-9a-f-]+)$/.exec(url.pathname);
    if (method === "GET" && sessionMatch?.[1]) {
      const snapshot = database.getSnapshot(sessionMatch[1]);
      sendJson(
        response,
        snapshot ? 200 : 404,
        snapshot ?? { error: "Session not found" },
      );
      return;
    }

    const stopMatch = /^\/api\/sessions\/([0-9a-f-]+)\/stop$/.exec(
      url.pathname,
    );
    if (method === "POST" && stopMatch?.[1]) {
      let lastSeq: number | undefined;
      if (request.headers["content-type"]?.includes("application/json")) {
        const body = (await readJson(request)) as { lastSeq?: unknown } | null;
        if (
          !body ||
          !Number.isSafeInteger(body.lastSeq) ||
          (body.lastSeq as number) < -1
        )
          throw new HttpError(400, "Invalid lastSeq");
        lastSeq = body.lastSeq as number;
      }
      const session = database.stopSession(stopMatch[1], lastSeq);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      events.publish({
        type: "session.status",
        sessionId: session.id,
        status: session.status,
      });
      pipeline.flushSession(session.id);
      if (database.completeSessionIfDrained(session.id)) {
        events.publish({
          type: "session.status",
          sessionId: session.id,
          status: "completed",
        });
      }
      sendJson(response, 200, database.getSession(session.id));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    await serveWeb(url.pathname, response);
  }

  async function serveWeb(
    pathname: string,
    response: ServerResponse,
  ): Promise<void> {
    if (!existsSync(webRoot)) {
      sendJson(response, 404, {
        error: "Web application is not built. Run `pnpm dev` or `pnpm build`.",
      });
      return;
    }
    const requested =
      pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = normalize(resolve(webRoot, requested));
    const path =
      (candidate === webRoot ||
        candidate.startsWith(`${webRoot}\\`) ||
        candidate.startsWith(`${webRoot}/`)) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
        ? candidate
        : join(webRoot, "index.html");
    const cacheControl =
      path.endsWith("index.html") || path.endsWith("pcm-capture-worklet.js")
        ? "no-cache"
        : "public, max-age=31536000, immutable";
    response.writeHead(200, {
      "Content-Type": contentType(path),
      "Cache-Control": cacheControl,
    });
    createReadStream(path).pipe(response);
  }

  function parseCreateSession(value: unknown): CreateSessionRequest {
    if (!value || typeof value !== "object")
      throw new HttpError(400, "Invalid request body");
    const body = value as Record<string, unknown>;
    const sourceKind = body.sourceKind;
    if (
      sourceKind !== "microphone" &&
      sourceKind !== "browser-tab" &&
      sourceKind !== "file"
    )
      throw new HttpError(400, "Invalid sourceKind");
    if (!isLanguageCode(body.targetLanguage))
      throw new HttpError(400, "Invalid targetLanguage");
    if (
      body.videoId !== undefined &&
      body.videoId !== null &&
      (!isYouTubeVideoId(body.videoId) || sourceKind !== "browser-tab")
    )
      throw new HttpError(400, "Invalid videoId");
    return {
      sourceKind: sourceKind as SourceKind,
      sourceLanguage:
        typeof body.sourceLanguage === "string" && body.sourceLanguage
          ? body.sourceLanguage
          : null,
      targetLanguage: body.targetLanguage,
      title:
        typeof body.title === "string" && body.title
          ? body.title.slice(0, 200)
          : null,
      videoId: typeof body.videoId === "string" ? body.videoId : null,
    };
  }

  async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > 64 * 1024)
        throw new HttpError(413, "Request body is too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  function sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    if (response.headersSent) return;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  }

  function toUint8Array(raw: RawData): Uint8Array {
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function contentType(path: string): string {
    const extension = extname(path).toLowerCase();
    return (
      (
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".json": "application/json; charset=utf-8",
        } as Record<string, string>
      )[extension] || "application/octet-stream"
    );
  }

  function allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // CLI/local integrations do not send Origin.
    const host = request.headers.host;
    return (
      origin === `http://${host}` ||
      origin === `https://${host}` ||
      origin === "http://127.0.0.1:5173" ||
      origin === "http://localhost:5173"
    );
  }

  class HttpError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    server,
    videoContexts,
    pipeline,
    async close(): Promise<void> {
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await stopped;
      await pipeline.waitForIdle();
      await videoContexts.close();
      database.close();
    },
  };
}
