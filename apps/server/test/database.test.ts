import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/database.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AppDatabase audio acknowledgement cursor", () => {
  it("only advances over a contiguous sequence", () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-db-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const session = database.createSession({ sourceKind: "browser-tab", targetLanguage: "ja" });

    const sequenceOne = database.insertAudioSegment(segment(session.id, 1));
    expect(sequenceOne.lastAckedSeq).toBe(-1);

    const sequenceZero = database.insertAudioSegment(segment(session.id, 0));
    expect(sequenceZero.lastAckedSeq).toBe(1);
    expect(database.getSession(session.id)?.lastAckedSeq).toBe(1);
    database.close();
  });

  it("persists ASR fragments, assembled ranges, and translation context", () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-db-"));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(join(directory, "test.sqlite"));
    const session = database.createSession({ sourceKind: "browser-tab", targetLanguage: "ja" });
    database.insertAudioSegment(segment(session.id, 0));
    database.insertAudioSegment(segment(session.id, 1));
    database.upsertAsrFragment({ session_id: session.id, seq: 0, text: "This is", language: "en", started_at_ms: 0, ended_at_ms: 5_000 });
    database.upsertAsrFragment({ session_id: session.id, seq: 1, text: "a test.", language: "en", started_at_ms: 5_000, ended_at_ms: 10_000 });

    expect(database.getPendingAsrFragments(session.id)).toHaveLength(2);
    const utterance = database.upsertUtterance({
      sessionId: session.id,
      startSeq: 0,
      endSeq: 1,
      text: "This is a test.",
      language: "en",
      startedAtMs: 0,
      endedAtMs: 10_000,
    });
    database.upsertTranslation({ utteranceId: utterance.id, targetLanguage: "ja", text: "これはテストです。", provider: "test", model: "test" });

    expect(database.getPendingAsrFragments(session.id)).toHaveLength(0);
    expect(database.getUtteranceForSegment(session.id, 0)?.utterance.id).toBe(utterance.id);
    expect(database.getTranslationContext(session.id, 2, "ja")).toEqual([
      { sourceText: "This is a test.", translatedText: "これはテストです。" },
    ]);
    database.close();
  });
});

function segment(sessionId: string, seq: number) {
  return {
    session_id: sessionId,
    seq,
    path: join("audio", `${seq}.wav`),
    mime_type: "audio/wav",
    file_name: `${seq}.wav`,
    duration_ms: 5_000,
    captured_at: "2025-01-01T00:00:00.000Z",
    sha256: `hash-${seq}`,
  };
}
