import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

describe("AppDatabase corrections", () => {
  function open() {
    const directory = mkdtempSync(join(tmpdir(), "rt-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.sqlite");
    return { path, database: new AppDatabase(path) };
  }
  function utterance(database: AppDatabase, sessionId: string, seq: number, text: string) {
    return database.upsertUtterance({ sessionId, startSeq: seq, endSeq: seq, text, language: "ja", startedAtMs: seq * 1_000, endedAtMs: seq * 1_000 + 900 });
  }

  it("stores a correction without touching the original text and never corrects an utterance twice", () => {
    const { database } = open();
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "correct" });
    const first = utterance(database, session.id, 0, "イスコンの話です。");
    const saved = database.upsertCorrection({ utteranceId: first.id, text: "ISUCONの話です。", provider: "test", model: "m1" });
    const again = database.upsertCorrection({ utteranceId: first.id, text: "別の校正", provider: "test", model: "m2" });
    expect(again).toEqual(saved);
    expect(again.text).toBe("ISUCONの話です。");

    const snapshot = database.getSnapshot(session.id)!;
    expect(snapshot.session.outputMode).toBe("correct");
    expect(snapshot.transcript[0]?.utterance.text).toBe("イスコンの話です。");
    expect(snapshot.transcript[0]?.correction).toMatchObject({ utteranceId: first.id, text: "ISUCONの話です。", provider: "test", model: "m1" });
    expect(snapshot.transcript[0]?.translation).toBeNull();
    database.close();
  });

  it("lists uncorrected utterances per session in seq order and the preceding context (corrected text, else original)", () => {
    const { database } = open();
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "correct" });
    const other = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "correct" });
    const u2 = utterance(database, session.id, 2, "two");
    const u0 = utterance(database, session.id, 0, "zero");
    const u1 = utterance(database, session.id, 1, "one");
    utterance(database, other.id, 0, "other");
    database.upsertCorrection({ utteranceId: u0.id, text: "ZERO", provider: "test", model: "m" });

    expect(database.getUncorrectedUtterances(session.id).map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(database.getCorrectionContext(session.id, 2)).toEqual(["ZERO", "one"]);
    expect(database.getCorrectionContext(session.id, 2, 1)).toEqual(["one"]);
    expect(database.getCorrectionContext(session.id, 0)).toEqual([]);
    expect(database.getCorrectSessionIds().sort()).toEqual([session.id, other.id].sort());
    database.upsertCorrection({ utteranceId: u1.id, text: "ONE", provider: "test", model: "m" });
    database.upsertCorrection({ utteranceId: u2.id, text: "TWO", provider: "test", model: "m" });
    expect(database.getUncorrectedUtterances(session.id)).toEqual([]);
    database.close();
  });

  it("switches the output mode of an existing session", () => {
    const { database } = open();
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    expect(database.getCorrectSessionIds()).toEqual([]);
    expect(database.setSessionOutputMode(session.id, "correct")?.outputMode).toBe("correct");
    expect(database.getCorrectSessionIds()).toEqual([session.id]);
    database.close();
  });

  it("adds the corrections table to a database created before this feature and keeps its data", () => {
    const { path, database: fresh } = open();
    fresh.close();
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE corrections");
    old.close();
    const database = new AppDatabase(path);
    const session = database.createSession({ sourceKind: "file", targetLanguage: "ja", outputMode: "transcribe" });
    const saved = utterance(database, session.id, 0, "前職の話");
    expect(database.getSnapshot(session.id)?.transcript[0]?.correction).toBeNull();
    database.upsertCorrection({ utteranceId: saved.id, text: "前職の話。", provider: "test", model: "m" });
    database.close();
    const reopened = new AppDatabase(path);
    expect(reopened.getSnapshot(session.id)?.transcript[0]?.correction?.text).toBe("前職の話。");
    reopened.close();
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
