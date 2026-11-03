import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAudioFrame, type ServerEvent, type VideoContextView } from "@realtime-translate/contracts";
import { AppDatabase } from "../src/database.js";
import { createApplication } from "../src/app.js";
import type { Providers } from "../src/providers/index.js";
import type { CorrectionBatchInput } from "../src/providers/types.js";

const running: Array<{ app: ReturnType<typeof createApplication>; directory: string }> = [];
afterEach(async () => {
  for (const { app, directory } of running.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(overrides: Partial<Providers> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rt-http-"));
  const database = new AppDatabase(join(directory, "test.sqlite"));
  const transcribe = vi.fn(async () => ({ text: "Pi supports tool calling.", language: "en" }));
  const translate = vi.fn(async () => ({ text: "Piはツール呼び出しに対応します。" }));
  const correct = vi.fn(async (input: CorrectionBatchInput, _signal?: AbortSignal) => ({ items: input.items.map((item) => ({ id: item.id, text: item.text.replace("Pi", "Pi (CLI)") })) }));
  const app = createApplication({
    database, audioRoot: join(directory, "audio"), webRoot: join(directory, "web"),
    metadataFetcher: async () => ({ title: "Pi coding agent", authorName: "Armin" }),
    providers: {
      recognizer: { provider: "test", model: "test", checkHealth: async () => true, transcribe },
      translator: { provider: "test", model: "test", translate }, translationAuthType: "oauth",
      translationSelection: "openai", translationModel: "test", translationIssue: null,
      corrector: { provider: "test", model: "test-correction", correctBatch: correct }, correctionModel: "test-correction", correctionIssue: null,
      contextGenerator: { generateContext: async () => ({ topic: "エージェント", glossary: [{ term: "Pi", translation: "Pi", note: "" }] }) },
      ...overrides,
    },
  });
  running.push({ app, directory });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  return { app, database, base, transcribe, translate, correct };
}
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
const contextPath = "/api/video-contexts/HDdbU10r7Js?targetLanguage=ja";

describe("context HTTP + audio pipeline integration", () => {
  it.each(["openai", "opencode-go"] as const)("%s prepares, edits, rejects stale writes and applies saved hints over the real WebSocket pipeline", async (selection) => {
    const { app, base, transcribe, translate } = await start({ translationSelection: selection, translationAuthType: selection === "openai" ? "oauth" : "api_key" });
    const health = await (await fetch(base + "/api/health")).json();
    expect(health).toMatchObject({ translationSelection: selection, translationProvider: selection === "openai" ? "chatgpt-subscription" : "opencode-go", translationReady: true });
    expect((await fetch(base + contextPath, json("POST", {}))).status).toBe(200);
    await app.videoContexts.waitForIdle();
    const initial = await (await fetch(base + contextPath)).json() as VideoContextView;
    expect(initial.status).toBe("ready");
    const editedHints = { topic: "専門的な対談", glossary: [{ term: "Pi", translation: "Pi CLI", note: "製品名" }] };
    const updated = await (await fetch(base + contextPath, json("PUT", { mode: "manual", hints: editedHints, expectedVersion: initial.version }))).json() as VideoContextView;
    expect(updated.mode).toBe("manual");
    expect((await fetch(base + contextPath, json("PUT", { mode: "manual", hints: editedHints, expectedVersion: initial.version }))).status).toBe(409);
    const session = await (await fetch(base + "/api/sessions", json("POST", { sourceKind: "browser-tab", videoId: "HDdbU10r7Js", targetLanguage: "ja" }))).json() as { id: string };
    // Stop can arrive before the last upload: completion must wait for seq 0.
    const stopped = await (await fetch(base + `/api/sessions/${session.id}/stop`, json("POST", { lastSeq: 0 }))).json();
    expect(stopped.status).toBe("processing");
    const socket = new WebSocket(base.replace("http:", "ws:") + `/ws?sessionId=${session.id}`);
    await nextEvent(socket, "connected");
    const completed = nextEvent(socket, "session.status");
    socket.send(encodeAudioFrame({ version: 1, sessionId: session.id, seq: 0, capturedAt: new Date().toISOString(), durationMs: 5000, mimeType: "audio/wav", sourceKind: "browser-tab" }, new Uint8Array([1, 2, 3])));
    expect((await completed).type).toBe("session.status");
    expect((transcribe.mock.calls[0] as unknown as Array<{ prompt: string }>)[0]?.prompt).toContain("Pi");
    expect((translate.mock.calls[0] as unknown as Array<{ hints: unknown }>)[0]?.hints).toEqual(editedHints);
    const snapshot = await (await fetch(base + `/api/sessions/${session.id}`)).json();
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.videoContext.hints).toEqual(editedHints);
    expect(snapshot.transcript[0].translation.text).toContain("ツール呼び出し");
    socket.terminate();
  });

  it("reports the selected Go provider/model even without credentials, and uses its setup instructions for context", async () => {
    const issue = "OpenCode GoのAPIキーが未設定です。OPENCODE_API_KEYを設定してください。";
    const { app, base } = await start({ translator: null, contextGenerator: null, translationAuthType: null, translationSelection: "opencode-go", translationModel: "glm-5.3-flash", translationIssue: issue });
    const health = await (await fetch(base + "/api/health")).json();
    expect(health).toMatchObject({ translationProvider: "disabled", translationSelection: "opencode-go", translationReady: false, translationAuthType: null, translationModel: "glm-5.3-flash", translationMessage: issue });
    await fetch(base + contextPath, json("POST", {}));
    await app.videoContexts.waitForIdle();
    const context = await (await fetch(base + contextPath)).json();
    expect(context.status).toBe("unavailable");
    expect(context.message).toBe(issue);
  });

  it("validates ids, language codes, body bounds, and hint schemas", async () => {
    const { base } = await start();
    expect((await fetch(base + "/api/video-contexts/invalid?targetLanguage=ja", json("POST", {}))).status).toBe(400);
    expect((await fetch(base + "/api/video-contexts/HDdbU10r7Js?targetLanguage=ignore-instructions", json("POST", {}))).status).toBe(400);
    expect((await fetch(base + contextPath, json("POST", {}))).status).toBe(200);
    expect((await fetch(base + contextPath, json("PUT", { mode: "manual", expectedVersion: 0, hints: { topic: "x", glossary: [{ term: "", translation: "x" }] } }))).status).toBe(400);
    expect((await fetch(base + contextPath, json("POST", { force: "yes" }))).status).toBe(400);
    expect((await fetch(base + contextPath, json("POST", []))).status).toBe(400);
    expect((await fetch(base + contextPath, { ...json("POST", {}), headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await fetch(base + "/api/sessions", json("POST", { sourceKind: "microphone", videoId: "HDdbU10r7Js", targetLanguage: "ja" }))).status).toBe(400);
    expect((await fetch(base + "/api/sessions", json("POST", { sourceKind: "browser-tab", targetLanguage: "ja", title: "x".repeat(70_000) }))).status).toBe(413);
  });
});

describe("outputMode API", () => {
  it("stores transcribe, defaults to translate and rejects unknown values", async () => {
    const { base } = await start();
    const create = async (extra: Record<string, unknown>) => fetch(base + "/api/sessions", json("POST", { sourceKind: "file", targetLanguage: "ja", ...extra }));
    expect(((await (await create({})).json()) as { outputMode: string }).outputMode).toBe("translate");
    expect(((await (await create({ outputMode: "translate" })).json()) as { outputMode: string }).outputMode).toBe("translate");
    const transcribe = await (await create({ outputMode: "transcribe" })).json() as { id: string; outputMode: string };
    expect(transcribe.outputMode).toBe("transcribe");
    expect(((await (await fetch(`${base}/api/sessions/${transcribe.id}`)).json()) as { session: { outputMode: string } }).session.outputMode).toBe("transcribe");
    for (const outputMode of ["summarize", "", null, 1, true]) expect((await create({ outputMode })).status).toBe(400);
  });
});

describe("AI correction API", () => {
  async function createSession(base: string, outputMode: string) {
    return await (await fetch(base + "/api/sessions", json("POST", { sourceKind: "file", sourceLanguage: "en", targetLanguage: "ja", title: "talk.mp3", outputMode }))).json() as { id: string; outputMode: string };
  }
  function addUtterance(database: AppDatabase, sessionId: string, seq: number, text: string) {
    return database.upsertUtterance({ sessionId, startSeq: seq, endSeq: seq, text, language: "en", startedAtMs: seq * 1_000, endedAtMs: seq * 1_000 + 900 });
  }

  it("reports correction readiness in /api/health", async () => {
    const ready = await start();
    expect(await (await fetch(ready.base + "/api/health")).json()).toMatchObject({ correctionReady: true, correctionModel: "test-correction", correctionMessage: null });
    const issue = "校正モデルgpt-5.6-terraを利用できません。";
    const unavailable = await start({ corrector: null, correctionModel: "gpt-5.6-terra", correctionIssue: issue });
    expect(await (await fetch(unavailable.base + "/api/health")).json()).toMatchObject({ correctionReady: false, correctionModel: "gpt-5.6-terra", correctionMessage: issue });
  });

  it("accepts correct as an output mode when creating a session", async () => {
    const { base } = await start();
    expect((await createSession(base, "correct")).outputMode).toBe("correct");
  });

  it("switches a transcribe session to correct, answers 202 and proofreads the stored utterances", async () => {
    const { app, base, database, correct } = await start();
    const session = await createSession(base, "transcribe");
    addUtterance(database, session.id, 0, "Pi is a great coding agent.");
    addUtterance(database, session.id, 1, "Pi again and again.");
    database.setSessionStatus(session.id, "completed");

    const response = await fetch(`${base}/api/sessions/${session.id}/correct`, json("POST", {}));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: session.id, outputMode: "correct" });
    await app.corrections.waitForIdle();
    // Both utterances travel in one request.
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0]![0].items.map((item) => item.text)).toEqual(["Pi is a great coding agent.", "Pi again and again."]);
    const snapshot = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as { session: { outputMode: string }; transcript: Array<{ utterance: { text: string }; correction: { text: string; model: string } | null }> };
    expect(snapshot.session.outputMode).toBe("correct");
    expect(snapshot.transcript.map((entry) => [entry.utterance.text, entry.correction?.text])).toEqual([["Pi is a great coding agent.", "Pi (CLI) is a great coding agent."], ["Pi again and again.", "Pi (CLI) again and again."]]);
    expect(snapshot.transcript[0]?.correction?.model).toBe("test-correction");
  });

  it("is idempotent: a second request neither fails nor proofreads again", async () => {
    const { app, base, database, correct } = await start();
    const session = await createSession(base, "correct");
    addUtterance(database, session.id, 0, "Pi is great.");
    database.setSessionStatus(session.id, "completed");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await fetch(`${base}/api/sessions/${session.id}/correct`, json("POST", {}))).status).toBe(202);
      await app.corrections.waitForIdle();
    }
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it("rejects translate sessions with 409, unknown sessions with 404 and a missing corrector with 503", async () => {
    const { base, database, correct } = await start();
    const translate = await createSession(base, "translate");
    addUtterance(database, translate.id, 0, "Pi is great.");
    expect((await fetch(`${base}/api/sessions/${translate.id}/correct`, json("POST", {}))).status).toBe(409);
    expect(database.getSession(translate.id)?.outputMode).toBe("translate");
    expect((await fetch(`${base}/api/sessions/00000000-0000-0000-0000-000000000000/correct`, json("POST", {}))).status).toBe(404);
    expect(correct).not.toHaveBeenCalled();

    const issue = "OpenAIの認証が未設定です。";
    const unavailable = await start({ corrector: null, correctionIssue: issue });
    const transcribe = await createSession(unavailable.base, "transcribe");
    const response = await fetch(`${unavailable.base}/api/sessions/${transcribe.id}/correct`, json("POST", {}));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: issue });
    expect(unavailable.database.getSession(transcribe.id)?.outputMode).toBe("transcribe");
  });

  it("resumes unfinished corrections of correct sessions when the application starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-http-"));
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const session = database.createSession({ sourceKind: "file", sourceLanguage: "en", targetLanguage: "ja", outputMode: "correct" });
    addUtterance(database, session.id, 0, "Pi is great.");
    database.setSessionStatus(session.id, "completed");
    const correct = vi.fn(async (input: CorrectionBatchInput) => ({ items: input.items.map((item) => ({ id: item.id, text: item.text.toUpperCase() })) }));
    const app = createApplication({
      database, audioRoot: join(directory, "audio"), webRoot: join(directory, "web"),
      providers: {
        recognizer: null, translator: null, translationAuthType: null, translationSelection: "openai", translationModel: "test", translationIssue: null,
        corrector: { provider: "test", model: "test-correction", correctBatch: correct }, correctionModel: "test-correction", correctionIssue: null, contextGenerator: null,
      },
    });
    running.push({ app, directory });
    await app.corrections.waitForIdle();
    expect(correct).toHaveBeenCalledTimes(1);
    expect(database.getSnapshot(session.id)?.transcript[0]?.correction?.text).toBe("PI IS GREAT.");
  });

  it("does not send a partial batch for a session whose transcription is still running", async () => {
    const { app, base, database, correct } = await start();
    const session = await createSession(base, "correct");
    addUtterance(database, session.id, 0, "Pi is great.");
    expect((await fetch(`${base}/api/sessions/${session.id}/correct`, json("POST", {}))).status).toBe(202);
    await app.corrections.waitForIdle();
    expect(correct).not.toHaveBeenCalled();
    database.setSessionStatus(session.id, "completed");
    expect((await fetch(`${base}/api/sessions/${session.id}/correct`, json("POST", {}))).status).toBe(202);
    await app.corrections.waitForIdle();
    expect(correct).toHaveBeenCalledTimes(1);
  });

  async function uploadChunks(base: string, sessionId: string, count: number) {
    const socket = new WebSocket(base.replace("http:", "ws:") + `/ws?sessionId=${sessionId}`);
    await nextEvent(socket, "connected");
    // The server accepts one audio frame at a time: wait for each ack.
    for (let seq = 0; seq < count; seq += 1) {
      const acked = nextEvent(socket, "audio.ack");
      socket.send(encodeAudioFrame({ version: 1, sessionId, seq, capturedAt: new Date().toISOString(), durationMs: 5000, mimeType: "audio/wav", sourceKind: "file" }, new Uint8Array([seq, 2, 3])));
      await acked;
    }
    return socket;
  }
  function collectStatuses(socket: WebSocket): string[] {
    const statuses: string[] = [];
    socket.on("message", (raw: Buffer) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      if (event.type === "session.status") statuses.push(event.status);
    });
    return statuses;
  }
  it("proofreads the remainder when stop arrives after every chunk was already transcribed", async () => {
    const { app, base, database, correct, transcribe } = await start();
    let call = 0;
    transcribe.mockImplementation(async () => ({ text: `Pi is great number ${call++}.`, language: "en" }));
    const session = await createSession(base, "correct");
    const socket = await uploadChunks(base, session.id, 3);
    const completions = collectStatuses(socket);
    await app.pipeline.waitForIdle();
    expect(database.getSession(session.id)?.status).not.toBe("completed");
    expect(database.getSnapshot(session.id)?.transcript).toHaveLength(3);
    await app.corrections.waitForIdle();
    expect(correct).not.toHaveBeenCalled();

    const stopped = await fetch(`${base}/api/sessions/${session.id}/stop`, json("POST", { lastSeq: 2 }));
    expect(stopped.status).toBe(200);
    await app.pipeline.waitForIdle();
    await app.corrections.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(completions).toEqual(["processing", "completed"]);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0]![0].items).toHaveLength(3);
    const snapshot = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as { session: { status: string }; transcript: Array<{ correction: { text: string } | null }> };
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.transcript.map((entry) => entry.correction?.text)).toEqual(["Pi (CLI) is great number 0.", "Pi (CLI) is great number 1.", "Pi (CLI) is great number 2."]);
    socket.terminate();
  });

  it("proofreads once and publishes a single completion when stop arrives before the chunks are transcribed", async () => {
    const { app, base, database, correct, transcribe } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    transcribe.mockImplementation(async () => { await gate; return { text: `Pi is great number ${call++}.`, language: "en" }; });
    const session = await createSession(base, "correct");
    const socket = await uploadChunks(base, session.id, 3);
    const completions = collectStatuses(socket);
    expect((await fetch(`${base}/api/sessions/${session.id}/stop`, json("POST", { lastSeq: 2 }))).status).toBe(200);
    expect(database.getSession(session.id)?.status).toBe("processing");
    release();
    await app.pipeline.waitForIdle();
    await app.corrections.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(completions).toEqual(["processing", "completed"]);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0]![0].items).toHaveLength(3);
    expect(database.getSnapshot(session.id)!.transcript.map((entry) => entry.correction?.text)).toEqual(["Pi (CLI) is great number 0.", "Pi (CLI) is great number 1.", "Pi (CLI) is great number 2."]);
    socket.terminate();
  });

  it("aborts the proofreading request in flight when the application closes, without waiting for it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-http-"));
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const session = database.createSession({ sourceKind: "file", sourceLanguage: "en", targetLanguage: "ja", outputMode: "correct" });
    addUtterance(database, session.id, 0, "Pi is great.");
    database.setSessionStatus(session.id, "completed");
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const correctBatch = vi.fn((_input: CorrectionBatchInput, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
    }));
    const app = createApplication({
      database, audioRoot: join(directory, "audio"), webRoot: join(directory, "web"),
      providers: {
        recognizer: null, translator: null, translationAuthType: null, translationSelection: "openai", translationModel: "test", translationIssue: null,
        corrector: { provider: "test", model: "test-correction", correctBatch }, correctionModel: "test-correction", correctionIssue: null, contextGenerator: null,
      },
    });
    try {
      await requestStarted;
      const startedAt = Date.now();
      await app.close();
      expect(aborted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function nextEvent(socket: WebSocket, type: ServerEvent["type"]): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", handle); reject(new Error(`Timeout waiting for ${type}`)); }, 3000);
    function handle(raw: Buffer) {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      if (event.type === type) { clearTimeout(timer); socket.off("message", handle); resolve(event); }
    }
    socket.on("message", handle);
  });
}
