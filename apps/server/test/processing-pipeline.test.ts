import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@realtime-translate/contracts";
import { AppDatabase } from "../src/database.js";
import type { SpeechRecognizer, TranslationInput, Translator } from "../src/providers/types.js";
import { EventHub } from "../src/services/event-hub.js";
import { ProcessingPipeline } from "../src/services/processing-pipeline.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProcessingPipeline contextual utterances", () => {
  it("joins incomplete chunks and passes finalized history to the next translation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const events = new EventHub();
    const translationInputs: TranslationInput[] = [];
    const recognizer: SpeechRecognizer = {
      provider: "test-asr",
      model: "test",
      checkHealth: async () => true,
      transcribe: async (input) => ({ text: new TextDecoder().decode(input.bytes), language: "en" }),
    };
    const translate = vi.fn(async (input: TranslationInput) => {
      translationInputs.push(input);
      return { text: `訳: ${input.text}` };
    });
    const translator: Translator = { provider: "test-translation", model: "test", translate };
    const pipeline = new ProcessingPipeline(database, events, recognizer, translator);
    const session = database.createSession({ sourceKind: "browser-tab", sourceLanguage: "en", targetLanguage: "ja" });

    const partial = nextEvent(events, session.id, "utterance.partial");
    enqueueText(database, pipeline, directory, session.id, 0, "This is an");
    expect((await partial).utterance.text).toBe("This is an");

    const firstTranslation = nextEvent(events, session.id, "translation.final");
    enqueueText(database, pipeline, directory, session.id, 1, "important example.");
    await firstTranslation;

    const secondTranslation = nextEvent(events, session.id, "translation.final");
    enqueueText(database, pipeline, directory, session.id, 2, "It keeps context.");
    await secondTranslation;

    const snapshot = database.getSnapshot(session.id);
    expect(snapshot?.transcript).toHaveLength(2);
    expect(snapshot?.transcript[0]?.utterance).toMatchObject({
      startSeq: 0,
      endSeq: 1,
      text: "This is an important example.",
    });
    expect(translationInputs[0]?.context).toEqual([]);
    expect(translationInputs[1]?.context).toEqual([
      { sourceText: "This is an important example.", translatedText: "訳: This is an important example." },
    ]);
    database.close();
  });
});

describe("ProcessingPipeline transcribe-only sessions", () => {
  it("never calls the translator and completes the session once every chunk is transcribed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const events = new EventHub();
    const recognizer: SpeechRecognizer = {
      provider: "test-asr",
      model: "test",
      checkHealth: async () => true,
      transcribe: async (input) => ({ text: new TextDecoder().decode(input.bytes), language: "en" }),
    };
    const translate = vi.fn(async (input: TranslationInput) => ({ text: `訳: ${input.text}` }));
    const pipeline = new ProcessingPipeline(database, events, recognizer, { provider: "test-translation", model: "test", translate });
    const session = database.createSession({ sourceKind: "file", sourceLanguage: "en", targetLanguage: "ja", outputMode: "transcribe" });
    const seen: ServerEvent["type"][] = [];
    events.subscribe(session.id, (event) => seen.push(event.type));

    const completed = new Promise<void>((resolve) => {
      events.subscribe(session.id, (event) => { if (event.type === "session.status" && event.status === "completed") resolve(); });
    });
    enqueueText(database, pipeline, directory, session.id, 0, "First part.");
    enqueueText(database, pipeline, directory, session.id, 1, "Second part.");
    database.stopSession(session.id, 1);
    await pipeline.waitForIdle();
    await completed;

    expect(translate).not.toHaveBeenCalled();
    expect(seen).not.toContain("translation.final");
    expect(seen).not.toContain("processing.skipped");
    expect(seen).not.toContain("processing.failed");
    const snapshot = database.getSnapshot(session.id);
    expect(snapshot?.session.status).toBe("completed");
    expect(snapshot?.transcript.map((entry) => entry.utterance.text)).toEqual(["First part.", "Second part."]);
    expect(snapshot?.transcript.every((entry) => entry.translation === null)).toBe(true);
    expect([0, 1].map((seq) => database.getAudioSegment(session.id, seq)?.processing_status)).toEqual(["completed", "completed"]);
    database.close();
  });

  it("completes silent chunks without a translator when the session is transcribe-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const events = new EventHub();
    const recognizer: SpeechRecognizer = { provider: "test-asr", model: "test", checkHealth: async () => true, transcribe: async () => ({ text: "", language: null }) };
    const pipeline = new ProcessingPipeline(database, events, recognizer, null);
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    enqueueText(database, pipeline, directory, session.id, 0, "ignored");
    database.stopSession(session.id, 0);
    await pipeline.waitForIdle();
    expect(database.getAudioSegment(session.id, 0)?.processing_status).toBe("completed");
    database.close();
  });
});

describe("ProcessingPipeline correct sessions", () => {
  it("never translates, completes the chunks without waiting for the correction, and queues the session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const events = new EventHub();
    const recognizer: SpeechRecognizer = {
      provider: "test-asr", model: "test", checkHealth: async () => true,
      transcribe: async (input) => ({ text: new TextDecoder().decode(input.bytes), language: "ja" }),
    };
    const translate = vi.fn(async (input: TranslationInput) => ({ text: `訳: ${input.text}` }));
    const statusAtCall: Array<string | undefined> = [];
    const enqueueSession = vi.fn((sessionId: string) => { statusAtCall.push(database.getSession(sessionId)?.status); });
    const pipeline = new ProcessingPipeline(database, events, recognizer, { provider: "test-translation", model: "test", translate }, undefined, undefined, { enqueueSession });
    const session = database.createSession({ sourceKind: "file", sourceLanguage: "ja", targetLanguage: "ja", outputMode: "correct" });
    const seen: ServerEvent["type"][] = [];
    events.subscribe(session.id, (event) => seen.push(event.type));

    enqueueText(database, pipeline, directory, session.id, 0, "イスコンの話。");
    enqueueText(database, pipeline, directory, session.id, 1, "前職の話。");
    database.stopSession(session.id, 1);
    await pipeline.waitForIdle();

    expect(translate).not.toHaveBeenCalled();
    expect(seen).not.toContain("translation.final");
    expect(seen).not.toContain("processing.skipped");
    expect(seen).not.toContain("processing.failed");
    const snapshot = database.getSnapshot(session.id)!;
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.transcript.map((entry) => [entry.utterance.text, entry.translation, entry.correction])).toEqual([["イスコンの話。", null, null], ["前職の話。", null, null]]);
    expect([0, 1].map((seq) => database.getAudioSegment(session.id, seq)?.processing_status)).toEqual(["completed", "completed"]);
    expect(enqueueSession).toHaveBeenCalledWith(session.id, { resume: false });
    // Once per utterance, plus once more when the session completes.
    expect(enqueueSession).toHaveBeenCalledTimes(3);
    // The notice after the last utterance and the completion notice both arrive with the session completed.
    expect(statusAtCall).toEqual(["processing", "completed", "completed"]);
    database.close();
  });

  it("does not notify the correction service for translate and transcribe sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const recognizer: SpeechRecognizer = {
      provider: "test-asr", model: "test", checkHealth: async () => true,
      transcribe: async (input) => ({ text: new TextDecoder().decode(input.bytes), language: "en" }),
    };
    const enqueueSession = vi.fn();
    const pipeline = new ProcessingPipeline(database, new EventHub(), recognizer, { provider: "t", model: "t", translate: async () => ({ text: "訳" }) }, undefined, undefined, { enqueueSession });
    const transcribeSession = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    const translateSession = database.createSession({ sourceKind: "file", targetLanguage: "ja" });
    enqueueText(database, pipeline, directory, transcribeSession.id, 0, "One.");
    database.stopSession(transcribeSession.id, 0);
    enqueueText(database, pipeline, directory, translateSession.id, 0, "Two.");
    database.stopSession(translateSession.id, 0);
    await pipeline.waitForIdle();
    expect(enqueueSession).not.toHaveBeenCalled();
    database.close();
  });

  it("queues a transcript-only session that is switched to correct while its last chunk is being recognized", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-pipeline-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    const enqueueSession = vi.fn();
    const recognizer: SpeechRecognizer = {
      provider: "test-asr", model: "test", checkHealth: async () => true,
      transcribe: async (input) => {
        database.setSessionOutputMode(session.id, "correct");
        return { text: new TextDecoder().decode(input.bytes), language: "ja" };
      },
    };
    const pipeline = new ProcessingPipeline(database, new EventHub(), recognizer, null, undefined, undefined, { enqueueSession });
    enqueueText(database, pipeline, directory, session.id, 0, "最後の発話。");
    database.stopSession(session.id, 0);
    await pipeline.waitForIdle();
    expect(enqueueSession).toHaveBeenCalledWith(session.id, { resume: false });
    database.close();
  });
});

function enqueueText(database: AppDatabase, pipeline: ProcessingPipeline, directory: string, sessionId: string, seq: number, text: string): void {
  const path = join(directory, `${seq}.txt`);
  writeFileSync(path, text);
  database.insertAudioSegment({
    session_id: sessionId,
    seq,
    path,
    mime_type: "audio/wav",
    file_name: `${seq}.wav`,
    duration_ms: 5_000,
    captured_at: new Date(seq * 5_000).toISOString(),
    sha256: `hash-${seq}`,
  });
  const segment = database.getAudioSegment(sessionId, seq);
  if (!segment) throw new Error("Segment was not stored");
  pipeline.enqueue(segment);
}

function nextEvent<TType extends ServerEvent["type"]>(events: EventHub, sessionId: string, type: TType): Promise<Extract<ServerEvent, { type: TType }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 2_000);
    const unsubscribe = events.subscribe(sessionId, (event) => {
      if (event.type !== type) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event as Extract<ServerEvent, { type: TType }>);
    });
  });
}
