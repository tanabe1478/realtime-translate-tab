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
