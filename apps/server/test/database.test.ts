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
