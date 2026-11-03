import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@realtime-translate/contracts";
import { AppDatabase } from "../src/database.js";
import type { CorrectionBatchInput, CorrectionBatchResult, TranscriptCorrector } from "../src/providers/types.js";
import { CorrectionService, parseCorrectionBatchSize } from "../src/services/correction-service.js";
import { EventHub } from "../src/services/event-hub.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface SetupOptions {
  outputMode?: "correct" | "transcribe";
  title?: string | null;
  /** Whether the transcription of the session is finished. */
  completed?: boolean;
}

function setup(texts: string[], options: SetupOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rt-correction-"));
  temporaryDirectories.push(directory);
  const database = new AppDatabase(join(directory, "test.sqlite"));
  const events = new EventHub();
  const session = database.createSession({ sourceKind: "file", sourceLanguage: "ja", targetLanguage: "ja", title: options.title === undefined ? "podcast-47.mp3" : options.title, outputMode: options.outputMode ?? "correct" });
  if (options.completed ?? true) database.setSessionStatus(session.id, "completed");
  texts.forEach((text, seq) => addUtterance(database, session.id, seq, text));
  const seen: ServerEvent[] = [];
  events.subscribe(session.id, (event) => seen.push(event));
  return { database, events, session, seen };
}
function addUtterance(database: AppDatabase, sessionId: string, seq: number, text: string) {
  return database.upsertUtterance({ sessionId, startSeq: seq, endSeq: seq, text, language: "ja", startedAtMs: seq * 1_000, endedAtMs: seq * 1_000 + 900 });
}
function corrector(correct: (input: CorrectionBatchInput, signal: AbortSignal) => Promise<CorrectionBatchResult>): TranscriptCorrector & { correctBatch: ReturnType<typeof vi.fn> } {
  return { provider: "test", model: "test-model", correctBatch: vi.fn(async (input: CorrectionBatchInput, signal: AbortSignal) => correct(input, signal)) };
}
const upper = async (input: CorrectionBatchInput) => ({ items: input.items.map((item) => ({ id: item.id, text: item.text.toUpperCase() })) });
const batchesOf = (model: { correctBatch: ReturnType<typeof vi.fn> }) => model.correctBatch.mock.calls.map(([input]) => input as CorrectionBatchInput);
const batchTexts = (model: { correctBatch: ReturnType<typeof vi.fn> }) => batchesOf(model).map((input) => input.items.map((item) => item.text));
const names = (count: number, prefix = "u") => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
const corrections = (database: AppDatabase, sessionId: string) => database.getSnapshot(sessionId)!.transcript.map((entry) => entry.correction?.text ?? null);

describe("parseCorrectionBatchSize", () => {
  it("accepts 1 to 50 and falls back to 15 for anything else", () => {
    expect(parseCorrectionBatchSize("1")).toBe(1);
    expect(parseCorrectionBatchSize(" 20 ")).toBe(20);
    expect(parseCorrectionBatchSize("50")).toBe(50);
    for (const invalid of [undefined, "", "0", "51", "-3", "abc", "2.5", "1e1"]) expect(parseCorrectionBatchSize(invalid)).toBe(15);
  });
});

describe("CorrectionService batching", () => {
  it("sends the utterances of a completed session in batches of 15 with sequential ids and the title", async () => {
    const { database, events, session, seen } = setup(names(33, "text"));
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    service.enqueueSession(session.id); // coalesced into the running loop
    await service.waitForIdle();

    const batches = batchesOf(model);
    expect(batches.map((input) => input.items.length)).toEqual([15, 15, 3]);
    expect(batches[0]!.items.map((item) => item.id)).toEqual(Array.from({ length: 15 }, (_, index) => String(index + 1)));
    expect(batches[2]!.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(batches[0]).toMatchObject({ sessionId: session.id, language: "ja", title: "podcast-47" });
    expect(model.correctBatch.mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true);
    expect(seen.filter((event) => event.type === "correction.final")).toHaveLength(33);
    expect(corrections(database, session.id)).toEqual(names(33, "text").map((text) => text.toUpperCase()));
    expect(database.getSnapshot(session.id)!.transcript.map((entry) => entry.utterance.text)).toEqual(names(33, "text"));
    database.close();
  });

  it("honors batchSize and cuts a batch by total characters, sending an overlong utterance alone", async () => {
    const { database, events, session } = setup(["aaaa", "bbbb", "cccc", "d".repeat(30), "ee", "ff"]);
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model, { batchSize: 4, maxBatchCharacters: 10 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    // 4+4=8, +4 would be 12 > 10; the 30-character utterance exceeds the limit on its own; then the rest.
    expect(batchTexts(model)).toEqual([["aaaa", "bbbb"], ["cccc"], ["d".repeat(30)], ["ee", "ff"]]);
    database.close();
  });

  it("limits a batch to batchSize utterances even when they are short", async () => {
    const { database, events, session } = setup(names(5));
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model, { batchSize: 2 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["u1", "u2"], ["u3", "u4"], ["u5"]]);
    database.close();
  });

  it("passes the three utterances before the batch as context, corrected text when available", async () => {
    const { database, events, session } = setup(["one", "two", "three", "four", "five", "six"]);
    const first = database.getUncorrectedUtterances(session.id)[2]!;
    database.upsertCorrection({ utteranceId: first.id, text: "THREE", provider: "test", model: "test-model" });
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model, { batchSize: 2 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    // Uncorrected: one two | four five | six. "three" was corrected before.
    expect(batchTexts(model)).toEqual([["one", "two"], ["four", "five"], ["six"]]);
    expect(batchesOf(model).map((input) => input.recentContext)).toEqual([[], ["ONE", "TWO", "THREE"], ["THREE", "FOUR", "FIVE"]]);
    database.close();
  });

  it("waits for a full batch while the transcription runs, and sends the remainder when it completes", async () => {
    const { database, events, session } = setup(names(5), { completed: false });
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model, { batchSize: 4 });
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["u1", "u2", "u3", "u4"]]);
    expect(corrections(database, session.id)).toEqual(["U1", "U2", "U3", "U4", null]);

    // Still running: one more utterance is not a full batch.
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(1);

    database.setSessionStatus(session.id, "completed");
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["u1", "u2", "u3", "u4"], ["u5"]]);
    expect(corrections(database, session.id)).toEqual(["U1", "U2", "U3", "U4", "U5"]);
    database.close();
  });

  it("treats a character-limit hit as a full batch while the transcription runs", async () => {
    const { database, events, session } = setup(["a".repeat(6), "b".repeat(6), "c"], { completed: false });
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model, { maxBatchCharacters: 10 });
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    // "a" is sent once "b" would exceed the limit; "b" and "c" (7 characters) are not a full batch yet.
    expect(batchTexts(model)).toEqual([["a".repeat(6)]]);
    expect(corrections(database, session.id)).toEqual(["A".repeat(6), null, null]);
    database.close();
  });

  it("does not correct an already corrected utterance again", async () => {
    const { database, events, session } = setup(["alpha one", "bravo two"]);
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("picks up utterances that arrive while a request is running", async () => {
    const { database, events, session } = setup(["alpha one"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = corrector(async (input) => {
      if (input.items[0]!.text === "alpha one") await gate;
      return upper(input);
    });
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    addUtterance(database, session.id, 1, "late arrival");
    service.enqueueSession(session.id, { resume: false });
    release();
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["alpha one"], ["late arrival"]]);
    expect(database.getUncorrectedUtterances(session.id)).toEqual([]);
    database.close();
  });

  it("resumes unfinished work at start-up, only for correct sessions", async () => {
    const { database, events, session } = setup(["alpha one", "bravo two", "charlie three"]);
    const transcribeOnly = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    database.setSessionStatus(transcribeOnly.id, "completed");
    addUtterance(database, transcribeOnly.id, 0, "untouched");
    const first = database.getUncorrectedUtterances(session.id)[0]!;
    database.upsertCorrection({ utteranceId: first.id, text: "ALPHA ONE", provider: "test", model: "test-model" });
    const model = corrector(upper);
    const service = new CorrectionService(database, events, model);
    service.resumePending();
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["bravo two", "charlie three"]]);
    expect(batchesOf(model)[0]!.recentContext).toEqual(["ALPHA ONE"]);
    expect(database.getUncorrectedUtterances(transcribeOnly.id)).toHaveLength(1);
    database.close();
  });

  it("does nothing without a corrector", async () => {
    const { database, events, session, seen } = setup(["alpha one"]);
    const service = new CorrectionService(database, events, null);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(seen).toEqual([]);
    expect(service.available).toBe(false);
    database.close();
  });
});

describe("CorrectionService partial results", () => {
  it("fails only the items that are missing, duplicated, empty or of a bad length; unknown ids are ignored", async () => {
    const long = (index: number) => `${"あ".repeat(30)}${index}。`;
    const texts = [1, 2, 3, 4, 5, 6].map(long);
    const { database, events, session, seen } = setup(texts);
    const model = corrector(async () => ({ items: [
      { id: "1", text: `${long(1).slice(0, -1)}！` },
      // id 2 is missing
      { id: "3", text: "   " },
      { id: "4", text: "短" },
      { id: "5", text: long(5) },
      { id: "5", text: `${long(5).slice(0, -1)}！` },
      { id: "6", text: `${long(6).slice(0, -1)}！` },
      { id: "99", text: "unknown" },
    ] }));
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();

    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    expect(corrections(database, session.id)).toEqual([`${long(1).slice(0, -1)}！`, null, null, null, null, `${long(6).slice(0, -1)}！`]);
    const failed = seen.filter((event) => event.type === "correction.failed");
    expect(failed.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.filter((event) => event.type === "correction.final").map((event) => event.seq)).toEqual([0, 5]);
    database.close();
  });

  it("matches items by id regardless of the order of the response", async () => {
    const { database, events, session } = setup(["first line", "second line"]);
    const model = corrector(async (input) => ({ items: [...input.items].reverse().map((item) => ({ id: item.id, text: item.text.toUpperCase() })) }));
    new CorrectionService(database, events, model).enqueueSession(session.id);
    await vi.waitFor(() => expect(corrections(database, session.id)).toEqual(["FIRST LINE", "SECOND LINE"]));
    database.close();
  });

  it("fails every utterance of the batch when the request fails, without leaking the provider message", async () => {
    const { database, events, session, seen } = setup(["alpha one", "bravo two", "charlie three"]);
    const model = corrector(async () => { throw new Error("Bearer secret-token upstream failure"); });
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    const failed = seen.filter((event) => event.type === "correction.failed");
    expect(failed.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(JSON.stringify(failed)).not.toContain("secret-token");
    expect(corrections(database, session.id)).toEqual([null, null, null]);
    database.close();
  });
});

describe("CorrectionService cross-item shift", () => {
  const sentence = (label: string, count: number) => `${label}${"あ".repeat(count - 1)}`;
  const texts = [sentence("A", 40), sentence("B", 40), sentence("C", 40), sentence("D", 40)];

  it("keeps the original of two neighbours that exchanged a sentence and saves the others", async () => {
    const { database, events, session, seen } = setup(texts);
    // B gained a sentence (+20) that C lost; A and D are only touched up.
    const answers = new Map([[texts[0]!, `${texts[0]!}。`], [texts[1]!, sentence("B", 60)], [texts[2]!, sentence("C", 20)]]);
    const model = corrector(async (input) => ({ items: input.items.map((item) => ({ id: item.id, text: answers.get(item.text) ?? item.text })) }));
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();

    expect(corrections(database, session.id)).toEqual([`${texts[0]!}。`, null, null, texts[3]!]);
    const failed = seen.filter((event) => event.type === "correction.failed");
    expect(failed.map((event) => event.seq)).toEqual([1, 2]);
    expect(failed.every((event) => event.message.includes("文が移動した可能性"))).toBe(true);
    expect(seen.filter((event) => event.type === "correction.final").map((event) => event.seq)).toEqual([0, 3]);
    expect(database.getSnapshot(session.id)!.transcript.map((entry) => entry.utterance.text)).toEqual(texts);

    // Not sent again automatically; an explicit enqueue (POST /correct) tries them again.
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("saves a lone outlier, which is not a move", async () => {
    const { database, events, session, seen } = setup(texts);
    const answers = [texts[0]!, sentence("B", 60), texts[2]!, texts[3]!];
    const model = corrector(async (input) => ({ items: input.items.map((item, index) => ({ id: item.id, text: answers[index]! })) }));
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(corrections(database, session.id)).toEqual(answers);
    expect(seen.filter((event) => event.type === "correction.failed")).toEqual([]);
    database.close();
  });

  it("does not pair across an item that was rejected individually", async () => {
    const { database, events, session, seen } = setup(texts.slice(0, 3));
    // B is missing from the response, so A (grown) and C (shrunk) are not neighbours any more.
    const model = corrector(async (input) => ({ items: [
      { id: input.items[0]!.id, text: sentence("A", 60) },
      { id: input.items[2]!.id, text: sentence("C", 20) },
    ] }));
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(corrections(database, session.id)).toEqual([sentence("A", 60), null, sentence("C", 20)]);
    expect(seen.filter((event) => event.type === "correction.failed").map((event) => event.seq)).toEqual([1]);
    database.close();
  });

  it("does not compare items across batches", async () => {
    const { database, events, session, seen } = setup(texts);
    const answers = new Map([[texts[1]!, sentence("B", 60)], [texts[2]!, sentence("C", 20)]]);
    const model = corrector(async (input) => ({ items: input.items.map((item) => ({ id: item.id, text: answers.get(item.text) ?? item.text })) }));
    const service = new CorrectionService(database, events, model, { batchSize: 2 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([[texts[0], texts[1]], [texts[2], texts[3]]]);
    expect(seen.filter((event) => event.type === "correction.failed")).toEqual([]);
    expect(corrections(database, session.id)).toEqual([texts[0], sentence("B", 60), sentence("C", 20), texts[3]]);
    database.close();
  });
});

describe("CorrectionService failure memory", () => {
  it("does not send failed utterances again automatically, but retries them on an explicit enqueue", async () => {
    const { database, events, session, seen } = setup(["alpha one", "bravo two", "charlie three"]);
    let failBravo = true;
    const model = corrector(async (input) => ({
      items: input.items.filter((item) => !(failBravo && item.text === "bravo two")).map((item) => ({ id: item.id, text: item.text.toUpperCase() })),
    }));
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    expect(corrections(database, session.id)).toEqual(["ALPHA ONE", null, "CHARLIE THREE"]);

    // A new utterance announced by the pipeline: only the new one is sent, not the failed one.
    addUtterance(database, session.id, 3, "delta four");
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(batchTexts(model)).toEqual([["alpha one", "bravo two", "charlie three"], ["delta four"]]);
    // Failed bravo falls back to its original text as context.
    expect(batchesOf(model)[1]!.recentContext).toEqual(["ALPHA ONE", "bravo two", "CHARLIE THREE"]);
    expect(seen.filter((event) => event.type === "correction.failed")).toHaveLength(1);

    failBravo = false;
    service.enqueueSession(session.id); // POST /correct
    await service.waitForIdle();
    expect(batchTexts(model).at(-1)).toEqual(["bravo two"]);
    expect(corrections(database, session.id)).toEqual(["ALPHA ONE", "BRAVO TWO", "CHARLIE THREE", "DELTA FOUR"]);
    database.close();
  });

  it("retries failed utterances after a restart", async () => {
    const { database, events, session } = setup(["alpha one", "bravo two"]);
    const failing = corrector(async () => ({ items: [] }));
    const first = new CorrectionService(database, events, failing);
    first.enqueueSession(session.id);
    await first.waitForIdle();
    expect(corrections(database, session.id)).toEqual([null, null]);

    const model = corrector(upper);
    const second = new CorrectionService(database, events, model);
    second.resumePending();
    await second.waitForIdle();
    expect(corrections(database, session.id)).toEqual(["ALPHA ONE", "BRAVO TWO"]);
    database.close();
  });

  it("halts after three consecutive whole-batch failures and resumes only on an explicit enqueue", async () => {
    const { database, events, session, seen } = setup(names(10));
    let failing = true;
    const model = corrector(async (input) => {
      if (failing) throw new Error("401 unauthorized");
      return upper(input);
    });
    const service = new CorrectionService(database, events, model, { batchSize: 2 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(3);
    expect(seen.filter((event) => event.type === "correction.failed")).toHaveLength(6);

    // The pipeline announcing something does not restart a halted session...
    addUtterance(database, session.id, 10, "u11");
    service.enqueueSession(session.id, { resume: false });
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(3);

    // ...but an explicit request does, and it picks up everything still uncorrected.
    failing = false;
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(database.getUncorrectedUtterances(session.id)).toEqual([]);
    expect(batchTexts(model).slice(3).flat()).toEqual(names(11));
    database.close();
  });

  it("a successful batch in between resets the consecutive failure count", async () => {
    const { database, events, session } = setup(names(10));
    let call = 0;
    const model = corrector(async (input) => {
      call += 1;
      if (call === 3) return upper(input);
      throw new Error("boom");
    });
    const service = new CorrectionService(database, events, model, { batchSize: 1 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    // fail, fail, success, fail, fail, fail -> halted after the 6th request.
    expect(model.correctBatch).toHaveBeenCalledTimes(6);
    database.close();
  });

  it("a batch whose items were all rejected individually is not a whole-batch failure", async () => {
    const { database, events, session } = setup(names(8));
    const model = corrector(async () => ({ items: [] }));
    const service = new CorrectionService(database, events, model, { batchSize: 1 });
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(8);
    database.close();
  });
});

describe("CorrectionService shutdown", () => {
  it("aborts the request in flight on close, returns from waitForIdle promptly and leaves the utterances uncorrected", async () => {
    const { database, events, session, seen } = setup(names(6));
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const model = corrector((_input, signal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const service = new CorrectionService(database, events, model, { batchSize: 2, timeoutMs: 60_000 });
    service.enqueueSession(session.id);
    await requestStarted;

    const startedAt = Date.now();
    service.close();
    await service.waitForIdle();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    expect(seen.filter((event) => event.type === "correction.failed")).toEqual([]);
    expect(database.getUncorrectedUtterances(session.id)).toHaveLength(6);

    // A closed service takes no new work.
    service.enqueueSession(session.id);
    await service.waitForIdle();
    expect(model.correctBatch).toHaveBeenCalledTimes(1);
    // The next run resumes the aborted utterances.
    const next = corrector(upper);
    const restarted = new CorrectionService(database, events, next);
    restarted.resumePending();
    await restarted.waitForIdle();
    expect(database.getUncorrectedUtterances(session.id)).toEqual([]);
    database.close();
  });

  it("does not store a result that arrives after close", async () => {
    const { database, events, session } = setup(names(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = corrector(async (input) => { await gate; return upper(input); });
    const service = new CorrectionService(database, events, model);
    service.enqueueSession(session.id);
    service.close();
    release();
    await service.waitForIdle();
    expect(database.getUncorrectedUtterances(session.id)).toHaveLength(2);
    database.close();
  });
});
