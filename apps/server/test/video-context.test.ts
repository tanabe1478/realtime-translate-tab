import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationHints } from "@realtime-translate/contracts";
import { AppDatabase } from "../src/database.js";
import type { ContextGenerator } from "../src/providers/types.js";
import { VideoContextService } from "../src/services/video-context.js";
import { buildAsrPrompt, groundGeneratedHints } from "../src/services/context-hints.js";

const videoId = "HDdbU10r7Js";
const hints: TranslationHints = { topic: "コーディングエージェント", glossary: [{ term: "Pi", translation: "Pi", note: "製品名" }] };
const fixtures: Array<{ service: VideoContextService; database: AppDatabase; directory: string }> = [];
function fixture(generator: ContextGenerator | null = { generateContext: vi.fn(async () => hints) }) {
  const directory = mkdtempSync(join(tmpdir(), "rt-context-"));
  const database = new AppDatabase(join(directory, "test.sqlite"));
  const metadata = vi.fn(async () => ({ title: "Pi coding agent tutorial", authorName: "Armin" }));
  const service = new VideoContextService(database, generator, metadata);
  fixtures.push({ service, database, directory });
  return { service, database, metadata, generator };
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.service.close();
    item.database.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("VideoContextService", () => {
  it("returns immediately, deduplicates requests, and persists/caches generated context", async () => {
    const { service, database, metadata, generator } = fixture();
    expect(service.prepare(videoId, "ja").status).toBe("generating");
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    const value = database.getVideoContext(videoId, "ja")!;
    expect(value).toMatchObject({ status: "ready", basis: "metadata", hints });
    expect(value.metadata?.title).toContain("Pi");
    expect(metadata).toHaveBeenCalledOnce();
    expect(generator!.generateContext).toHaveBeenCalledOnce();
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    expect(generator!.generateContext).toHaveBeenCalledOnce();
    const session = database.createSession({ sourceKind: "browser-tab", targetLanguage: "ja", videoId });
    expect(database.getSnapshot(session.id)?.videoContext).toEqual(value);
  });

  it("degrades to metadata when the user has not logged in", async () => {
    const { service, database } = fixture(null);
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "ja")).toMatchObject({ status: "unavailable", hints: { topic: "Pi coding agent tutorial", glossary: [] } });
  });

  it("keeps existing hints on failure and supports explicit retry", async () => {
    const generateContext = vi.fn().mockRejectedValueOnce(new Error("provider secret that must not reach the UI")).mockResolvedValue(hints);
    const { service, database } = fixture({ generateContext });
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "ja")?.status).toBe("failed");
    expect(database.getVideoContext(videoId, "ja")?.message).not.toContain("secret");
    service.prepare(videoId, "ja", true);
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "ja")?.status).toBe("ready");
  });

  it("never overwrites a manual edit with a late model result", async () => {
    let resolve!: (value: TranslationHints) => void;
    const generateContext = vi.fn(() => new Promise<TranslationHints>((done) => { resolve = done; }));
    const { service, database } = fixture({ generateContext });
    service.prepare(videoId, "ja");
    await vi.waitFor(() => expect(generateContext).toHaveBeenCalledOnce());
    const current = database.getVideoContext(videoId, "ja")!;
    const manual = { topic: "自分で修正", glossary: [{ term: "Pi", translation: "Pi CLI", note: "" }] };
    expect(service.saveManual(videoId, "ja", manual, current.version)?.mode).toBe("manual");
    resolve(hints);
    await new Promise((done) => setTimeout(done, 0));
    expect(database.getVideoContext(videoId, "ja")).toMatchObject({ mode: "manual", hints: manual });
    service.prepare(videoId, "ja", true);
    expect(generateContext).toHaveBeenCalledOnce();
    expect(service.saveManual(videoId, "ja", hints, current.version)).toBeNull();
  });

  it("supports resuming automation and isolates videos/target languages", async () => {
    const { service, database } = fixture();
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    const value = database.getVideoContext(videoId, "ja")!;
    const manual = service.saveManual(videoId, "ja", { topic: "manual", glossary: [] }, value.version)!;
    service.resumeAutomatic(videoId, "ja", manual.version);
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "ja")?.mode).toBe("auto");
    service.prepare(videoId, "en");
    service.prepare("dQw4w9WgXcQ", "ja");
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "en")?.targetLanguage).toBe("en");
    expect(database.getVideoContext("dQw4w9WgXcQ", "ja")?.videoId).toBe("dQw4w9WgXcQ");
  });

  it("learns only observed terms from source transcripts without blocking the pipeline; throttles updates", async () => {
    const generateContext = vi.fn(async (input) => input.transcripts.length
      ? { topic: "ツール呼び出し", glossary: [{ term: "tool calling", translation: "ツール呼び出し", note: "" }, { term: "ImaginaryProduct", translation: "架空", note: "" }] }
      : hints);
    const { service, database } = fixture({ generateContext });
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    const session = database.createSession({ sourceKind: "browser-tab", videoId, targetLanguage: "ja" });
    database.upsertUtterance({ sessionId: session.id, startSeq: 0, endSeq: 0, text: "Pi supports tool calling.", language: "en", startedAtMs: 0, endedAtMs: 5000 });
    service.onUtterance(session.id, 0);
    expect(database.getSessionVideoContext(session.id)?.status).toBe("generating");
    await service.waitForIdle();
    expect(database.getSessionVideoContext(session.id)?.hints.glossary.map((entry) => entry.term)).toEqual(["Pi", "tool calling"]);
    service.onUtterance(session.id, 1);
    service.onUtterance(session.id, 5);
    expect(generateContext).toHaveBeenCalledTimes(2);
    service.onUtterance(session.id, 6);
    await service.waitForIdle();
    expect(generateContext).toHaveBeenCalledTimes(3);
    expect(generateContext.mock.calls[1]?.[0].transcripts).toEqual(["Pi supports tool calling."]);
  });

  it("recovers a persisted generating state after restart", async () => {
    const { service, database } = fixture();
    const initial = database.ensureVideoContext(videoId, "ja");
    database.saveVideoContext({ ...initial, status: "generating" }, initial.version);
    service.prepare(videoId, "ja");
    await service.waitForIdle();
    expect(database.getVideoContext(videoId, "ja")?.status).toBe("ready");
  });
});

describe("context hint boundaries", () => {
  it("passes only short source spellings plus recent transcript to Whisper", () => {
    const prompt = buildAsrPrompt("Recent transcript ".repeat(100), hints);
    expect(prompt).toContain("Pi\n");
    expect(prompt).not.toContain("製品名");
    expect(prompt.length).toBeLessThanOrEqual(951);
  });
  it("does not mistake substrings for product names or erase known terms", () => {
    expect(groundGeneratedHints(hints, { topic: "", glossary: [] }, "A pipeline.").glossary).toEqual([]);
    expect(groundGeneratedHints({ topic: "", glossary: [] }, hints, "Other words")).toEqual(hints);
  });
});
