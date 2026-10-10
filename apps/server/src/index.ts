import { config as loadEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  decodeAudioFrame,
  type CreateSessionRequest,
  type HealthResponse,
  type ServerEvent,
  type SourceKind,
} from "@realtime-translate/contracts";
import { AppDatabase } from "./database.js";
import { createProviders } from "./providers/index.js";
import { AudioIngestService } from "./services/audio-ingest.js";
import { EventHub } from "./services/event-hub.js";
import { ProcessingPipeline } from "./services/processing-pipeline.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(moduleDirectory, "..");
const repositoryRoot = resolve(appDirectory, "../..");
loadEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
const dataRoot = resolve(repositoryRoot, "data");
const webRoot = resolve(repositoryRoot, "apps/web/dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const database = new AppDatabase(join(dataRoot, "realtime-translate.sqlite"));
const providers = await createProviders(process.env, dataRoot);
const events = new EventHub();
const pipeline = new ProcessingPipeline(database, events, providers.recognizer, providers.translator);
const ingest = new AudioIngestService(database, pipeline, join(dataRoot, "audio"));

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

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 26 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
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
  webSockets.handleUpgrade(request, socket, head, (webSocket) => attachWebSocket(webSocket, sessionId));
});

for (const segment of database.getRecoverableSegments()) pipeline.enqueue(segment);

server.listen(port, host, () => {
  console.log(`\nRealtime Translate server: http://${host}:${port}`);
  console.log(`ASR: ${providers.recognizer ? `${providers.recognizer.provider}/${providers.recognizer.model}` : "disabled (audio storage only)"}`);
  console.log(`Translation: ${providers.translator ? `${providers.translator.provider}/${providers.translator.model}` : "disabled (run pnpm auth:openai)"}`);
  if (!existsSync(webRoot)) console.log("Web build not found; use `pnpm dev` for the Vite development server.");
});

function attachWebSocket(webSocket: WebSocket, sessionId: string): void {
  let receiving = false;
  const send = (event: ServerEvent): void => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(event));
  };
  const unsubscribe = events.subscribe(sessionId, send);
  const session = database.getSession(sessionId)!;
  send({ type: "connected", protocolVersion: PROTOCOL_VERSION, sessionId, lastAckedSeq: session.lastAckedSeq });

  webSocket.on("message", async (raw: RawData, isBinary: boolean) => {
    if (!isBinary || receiving) {
      webSocket.close(1008, isBinary ? "Only one audio frame may be uploaded at a time" : "Binary audio frame required");
      return;
    }
    receiving = true;
    let sequence = -1;
    try {
      const frame = decodeAudioFrame(toUint8Array(raw));
      sequence = frame.header.seq;
      if (frame.header.sessionId !== sessionId) throw new Error("Frame session does not match this connection");
      await ingest.ingest(frame.header, frame.audio);
      send({ type: "audio.ack", sessionId, seq: frame.header.seq });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "audio.rejected", sessionId, seq: sequence, message: message.slice(0, 300), retryable: false });
    } finally {
      receiving = false;
    }
  });

  webSocket.on("close", unsubscribe);
  webSocket.on("error", (error) => console.error(`WebSocket error for ${sessionId}`, error));
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

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
        ? (providers.translationAuthType === "oauth" ? "chatgpt-subscription" : "openai-api")
        : "disabled",
      translationReady: providers.translator !== null,
      translationModel: providers.translator?.model ?? null,
      protocolVersion: PROTOCOL_VERSION,
    };
    sendJson(response, 200, health);
    return;
  }

  if (method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    const input = parseCreateSession(body);
    sendJson(response, 201, database.createSession(input));
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([0-9a-f-]+)$/.exec(url.pathname);
  if (method === "GET" && sessionMatch?.[1]) {
    const snapshot = database.getSnapshot(sessionMatch[1]);
    sendJson(response, snapshot ? 200 : 404, snapshot ?? { error: "Session not found" });
    return;
  }

  const stopMatch = /^\/api\/sessions\/([0-9a-f-]+)\/stop$/.exec(url.pathname);
  if (method === "POST" && stopMatch?.[1]) {
    const session = database.stopSession(stopMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: "Session not found" });
      return;
    }
    events.publish({ type: "session.status", sessionId: session.id, status: session.status });
    pipeline.flushSession(session.id);
    if (database.completeSessionIfDrained(session.id)) {
      events.publish({ type: "session.status", sessionId: session.id, status: "completed" });
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

async function serveWeb(pathname: string, response: ServerResponse): Promise<void> {
  if (!existsSync(webRoot)) {
    sendJson(response, 404, { error: "Web application is not built. Run `pnpm dev` or `pnpm build`." });
    return;
  }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(resolve(webRoot, requested));
  const path = (candidate === webRoot || candidate.startsWith(`${webRoot}\\`) || candidate.startsWith(`${webRoot}/`)) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, "index.html");
  const cacheControl = path.endsWith("index.html") || path.endsWith("pcm-capture-worklet.js") ? "no-cache" : "public, max-age=31536000, immutable";
  response.writeHead(200, { "Content-Type": contentType(path), "Cache-Control": cacheControl });
  createReadStream(path).pipe(response);
}

function parseCreateSession(value: unknown): CreateSessionRequest {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid request body");
  const body = value as Record<string, unknown>;
  const sourceKind = body.sourceKind;
  if (sourceKind !== "microphone" && sourceKind !== "browser-tab" && sourceKind !== "file") throw new HttpError(400, "Invalid sourceKind");
  if (typeof body.targetLanguage !== "string" || !body.targetLanguage.trim()) throw new HttpError(400, "targetLanguage is required");
  return {
    sourceKind: sourceKind as SourceKind,
    sourceLanguage: typeof body.sourceLanguage === "string" && body.sourceLanguage ? body.sourceLanguage : null,
    targetLanguage: body.targetLanguage,
    title: typeof body.title === "string" && body.title ? body.title.slice(0, 200) : null,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function toUint8Array(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  webSockets.close();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
