import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionRequest,
  SessionSnapshot,
  SessionStatus,
  SessionView,
  SourceKind,
  TranscriptEntry,
  TranslationView,
  UtteranceView,
} from "@realtime-translate/contracts";

interface SessionRow {
  id: string;
  status: SessionStatus;
  source_kind: SourceKind;
  source_language: string | null;
  target_language: string;
  title: string | null;
  last_acked_seq: number;
  created_at: string;
  stopped_at: string | null;
}

export interface AudioSegmentRow {
  session_id: string;
  seq: number;
  path: string;
  mime_type: string;
  file_name: string;
  duration_ms: number;
  captured_at: string;
  sha256: string;
  processing_status: "stored" | "processing" | "completed" | "waiting_asr" | "waiting_translation" | "failed";
  last_error: string | null;
}

interface UtteranceRow {
  id: string;
  session_id: string;
  seq: number;
  text: string;
  language: string | null;
  started_at_ms: number;
  ended_at_ms: number;
  created_at: string;
}

interface TranslationRow {
  id: string;
  utterance_id: string;
  target_language: string;
  text: string;
  provider: string;
  model: string;
  created_at: string;
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_language TEXT,
        target_language TEXT NOT NULL,
        title TEXT,
        last_acked_seq INTEGER NOT NULL DEFAULT -1,
        created_at TEXT NOT NULL,
        stopped_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audio_segments (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        processing_status TEXT NOT NULL DEFAULT 'stored',
        last_error TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS utterances (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        language TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS translations (
        id TEXT PRIMARY KEY,
        utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
        target_language TEXT NOT NULL,
        text TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (utterance_id, target_language)
      );

      CREATE INDEX IF NOT EXISTS idx_audio_processing ON audio_segments(processing_status, session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_utterances_session ON utterances(session_id, seq);
    `);
  }

  createSession(input: CreateSessionRequest): SessionView {
    const session: SessionView = {
      id: randomUUID(),
      status: input.sourceKind === "file" ? "processing" : "recording",
      sourceKind: input.sourceKind,
      sourceLanguage: input.sourceLanguage ?? null,
      targetLanguage: input.targetLanguage,
      title: input.title ?? null,
      lastAckedSeq: -1,
      createdAt: new Date().toISOString(),
      stoppedAt: null,
    };
    this.db.prepare(`
      INSERT INTO sessions (id, status, source_kind, source_language, target_language, title, last_acked_seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.status, session.sourceKind, session.sourceLanguage, session.targetLanguage, session.title, session.lastAckedSeq, session.createdAt);
    return session;
  }

  getSession(id: string): SessionView | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getSnapshot(id: string): SessionSnapshot | null {
    const session = this.getSession(id);
    if (!session) return null;
    const utterances = this.db.prepare("SELECT * FROM utterances WHERE session_id = ? ORDER BY seq").all(id) as unknown as UtteranceRow[];
    const translationStatement = this.db.prepare("SELECT * FROM translations WHERE utterance_id = ? AND target_language = ?");
    const transcript: TranscriptEntry[] = utterances.map((row) => {
      const translation = translationStatement.get(row.id, session.targetLanguage) as unknown as TranslationRow | undefined;
      return { utterance: mapUtterance(row), translation: translation ? mapTranslation(translation) : null };
    });
    return { session, transcript };
  }

  stopSession(id: string): SessionView | null {
    const stoppedAt = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = 'processing', stopped_at = ? WHERE id = ?").run(stoppedAt, id);
    return this.getSession(id);
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
  }

  completeSessionIfDrained(id: string): boolean {
    const session = this.getSession(id);
    if (!session?.stoppedAt) return false;
    const row = this.db.prepare("SELECT COUNT(*) AS pending FROM audio_segments WHERE session_id = ? AND processing_status != 'completed'").get(id) as unknown as { pending: number };
    if (row.pending > 0) return false;
    this.setSessionStatus(id, "completed");
    return true;
  }

  getAudioSegment(sessionId: string, seq: number): AudioSegmentRow | null {
    return (this.db.prepare("SELECT * FROM audio_segments WHERE session_id = ? AND seq = ?").get(sessionId, seq) as unknown as AudioSegmentRow | undefined) ?? null;
  }

  insertAudioSegment(segment: Omit<AudioSegmentRow, "processing_status" | "last_error">): { created: boolean; lastAckedSeq: number } {
    const existing = this.getAudioSegment(segment.session_id, segment.seq);
    if (existing) {
      if (existing.sha256 !== segment.sha256) throw new Error(`Sequence ${segment.seq} already exists with different audio`);
      return { created: false, lastAckedSeq: this.getSession(segment.session_id)?.lastAckedSeq ?? -1 };
    }

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO audio_segments
          (session_id, seq, path, mime_type, file_name, duration_ms, captured_at, sha256, processing_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?)
      `).run(segment.session_id, segment.seq, segment.path, segment.mime_type, segment.file_name, segment.duration_ms, segment.captured_at, segment.sha256, now);

      const session = this.getSession(segment.session_id);
      if (!session) throw new Error("Session does not exist");
      let cursor = session.lastAckedSeq;
      const exists = this.db.prepare("SELECT 1 AS found FROM audio_segments WHERE session_id = ? AND seq = ?");
      while (exists.get(segment.session_id, cursor + 1)) cursor += 1;
      this.db.prepare("UPDATE sessions SET last_acked_seq = ? WHERE id = ?").run(cursor, segment.session_id);
      this.db.exec("COMMIT");
      return { created: true, lastAckedSeq: cursor };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAudioProcessingStatus(sessionId: string, seq: number, status: AudioSegmentRow["processing_status"], error: string | null = null): void {
    this.db.prepare("UPDATE audio_segments SET processing_status = ?, last_error = ? WHERE session_id = ? AND seq = ?").run(status, error, sessionId, seq);
  }

  getRecoverableSegments(): AudioSegmentRow[] {
    return this.db.prepare(`
      SELECT * FROM audio_segments
      WHERE processing_status IN ('stored', 'processing', 'waiting_asr', 'waiting_translation', 'failed')
      ORDER BY session_id, seq
    `).all() as unknown as AudioSegmentRow[];
  }

  getAudioOffsetMs(sessionId: string, seq: number): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(duration_ms), 0) AS total FROM audio_segments WHERE session_id = ? AND seq < ?").get(sessionId, seq) as unknown as { total: number };
    return row.total;
  }

  getUtterance(sessionId: string, seq: number): UtteranceView | null {
    const row = this.db.prepare("SELECT * FROM utterances WHERE session_id = ? AND seq = ?").get(sessionId, seq) as unknown as UtteranceRow | undefined;
    return row ? mapUtterance(row) : null;
  }

  upsertUtterance(input: { sessionId: string; seq: number; text: string; language: string | null; startedAtMs: number; endedAtMs: number }): UtteranceView {
    const existing = this.db.prepare("SELECT * FROM utterances WHERE session_id = ? AND seq = ?").get(input.sessionId, input.seq) as unknown as UtteranceRow | undefined;
    if (existing) return mapUtterance(existing);
    const row: UtteranceRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      seq: input.seq,
      text: input.text,
      language: input.language,
      started_at_ms: input.startedAtMs,
      ended_at_ms: input.endedAtMs,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO utterances (id, session_id, seq, text, language, started_at_ms, ended_at_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.session_id, row.seq, row.text, row.language, row.started_at_ms, row.ended_at_ms, row.created_at);
    return mapUtterance(row);
  }

  upsertTranslation(input: { utteranceId: string; targetLanguage: string; text: string; provider: string; model: string }): TranslationView {
    const existing = this.db.prepare("SELECT * FROM translations WHERE utterance_id = ? AND target_language = ?").get(input.utteranceId, input.targetLanguage) as unknown as TranslationRow | undefined;
    if (existing) return mapTranslation(existing);
    const row: TranslationRow = {
      id: randomUUID(),
      utterance_id: input.utteranceId,
      target_language: input.targetLanguage,
      text: input.text,
      provider: input.provider,
      model: input.model,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO translations (id, utterance_id, target_language, text, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.utterance_id, row.target_language, row.text, row.provider, row.model, row.created_at);
    return mapTranslation(row);
  }
}

function mapSession(row: SessionRow): SessionView {
  return {
    id: row.id,
    status: row.status,
    sourceKind: row.source_kind,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    title: row.title,
    lastAckedSeq: row.last_acked_seq,
    createdAt: row.created_at,
    stoppedAt: row.stopped_at,
  };
}

function mapUtterance(row: UtteranceRow): UtteranceView {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    text: row.text,
    language: row.language,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    createdAt: row.created_at,
  };
}

function mapTranslation(row: TranslationRow): TranslationView {
  return {
    id: row.id,
    utteranceId: row.utterance_id,
    targetLanguage: row.target_language,
    text: row.text,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
  };
}
