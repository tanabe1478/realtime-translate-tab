import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAudioFrame, type ServerEvent, type VideoContextView } from "@realtime-translate/contracts";
import { AppDatabase } from "../src/database.js";
import { createApplication } from "../src/app.js";
import type { Providers } from "../src/providers/index.js";

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
  const app = createApplication({
    database, audioRoot: join(directory, "audio"), webRoot: join(directory, "web"),
    metadataFetcher: async () => ({ title: "Pi coding agent", authorName: "Armin" }),
    providers: {
      recognizer: { provider: "test", model: "test", checkHealth: async () => true, transcribe },
      translator: { provider: "test", model: "test", translate }, translationAuthType: "oauth",
      translationSelection: "openai", translationModel: "test", translationIssue: null,
      contextGenerator: { generateContext: async () => ({ topic: "エージェント", glossary: [{ term: "Pi", translation: "Pi", note: "" }] }) },
      ...overrides,
    },
  });
  running.push({ app, directory });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  return { app, database, base, transcribe, translate };
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
