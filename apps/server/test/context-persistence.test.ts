import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/database.js";

describe("context schema migration and persistence", () => {
  it("opens old databases without losing sessions and persists session/context links across reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-migration-"));
    const path = join(directory, "test.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, source_kind TEXT NOT NULL, source_language TEXT,
      target_language TEXT NOT NULL, title TEXT, last_acked_seq INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL, stopped_at TEXT
    ); INSERT INTO sessions VALUES ('old', 'completed', 'microphone', 'en', 'ja', 'Existing', -1, '2025-01-01', '2025-01-01');`);
    old.close();
    let database = new AppDatabase(path);
    try {
      expect(database.getSession("old")).toMatchObject({ title: "Existing", videoId: null });
      expect(database.getSnapshot("old")?.videoContext).toBeNull();
      const session = database.createSession({ sourceKind: "browser-tab", targetLanguage: "ja", videoId: "HDdbU10r7Js" });
      const initial = database.getSessionVideoContext(session.id)!;
      const saved = database.saveVideoContext({ ...initial, mode: "manual", hints: { topic: "Pi", glossary: [] } }, initial.version)!;
      database.markContextAnalysis(session.id, 6);
      database.close();
      database = new AppDatabase(path);
      expect(database.getSnapshot(session.id)?.videoContext).toEqual(saved);
      expect(database.getContextAnalysisSeq(session.id)).toBe(6);
      expect(database.saveVideoContext(saved, initial.version)).toBeNull();
      database.stopSession(session.id, 1);
      expect(database.completeSessionIfDrained(session.id)).toBe(false);
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
