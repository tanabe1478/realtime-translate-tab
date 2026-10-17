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
  VideoContextView,
} from "@realtime-translate/contracts";

interface SessionRow {
  id: string;
  status: SessionStatus;
  source_kind: SourceKind;
  source_language: string | null;
  target_language: string;
  title: string | null;
  video_id: string | null;
  context_through_seq: number;
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
  processing_status: "stored" | "processing" | "completed" | "waiting_asr" | "waiting_utterance" | "waiting_translation" | "failed";
  last_error: string | null;
}

interface UtteranceRow {
  id: string;
  session_id: string;
  seq: number;
  start_seq: number | null;
  end_seq: number | null;
  text: string;
  language: string | null;
  started_at_ms: number;
  ended_at_ms: number;
  created_at: string;
}

export interface AsrFragmentRow {
  session_id: string;
  seq: number;
  text: string;
  language: string | null;
  started_at_ms: number;
  ended_at_ms: number;
  created_at: string;
}

export interface TranslationContextRow {
  sourceText: string;
  translatedText: string | null;
}

export interface AssembledUtterance {
  utterance: UtteranceView;
  startSeq: number;
  endSeq: number;
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
        start_seq INTEGER,
        end_seq INTEGER,
        text TEXT NOT NULL,
        language TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS asr_fragments (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        language TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
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

      CREATE TABLE IF NOT EXISTS video_contexts (
        video_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        version INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (video_id, target_language)
      );

      CREATE INDEX IF NOT EXISTS idx_audio_processing ON audio_segments(processing_status, session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_utterances_session ON utterances(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_fragments_session ON asr_fragments(session_id, seq);
    `);

    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "video_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN video_id TEXT");
    if (!sessionColumns.some((column) => column.name === "context_through_seq")) this.db.exec("ALTER TABLE sessions ADD COLUMN context_through_seq INTEGER NOT NULL DEFAULT -1");
    if (!sessionColumns.some((column) => column.name === "expected_last_seq")) this.db.exec("ALTER TABLE sessions ADD COLUMN expected_last_seq INTEGER");

    const utteranceColumns = this.db.prepare("PRAGMA table_info(utterances)").all() as unknown as Array<{ name: string }>;
    if (!utteranceColumns.some((column) => column.name === "start_seq")) {
      this.db.exec("ALTER TABLE utterances ADD COLUMN start_seq INTEGER");
    }
    if (!utteranceColumns.some((column) => column.name === "end_seq")) {
      this.db.exec("ALTER TABLE utterances ADD COLUMN end_seq INTEGER");
    }
    this.db.exec("UPDATE utterances SET start_seq = seq WHERE start_seq IS NULL; UPDATE utterances SET end_seq = seq WHERE end_seq IS NULL;");
  }

  createSession(input: CreateSessionRequest): SessionView {
    const session: SessionView = {
      id: randomUUID(),
      status: input.sourceKind === "file" ? "processing" : "recording",
      sourceKind: input.sourceKind,
      sourceLanguage: input.sourceLanguage ?? null,
      targetLanguage: input.targetLanguage,
      title: input.title ?? null,
      videoId: input.videoId ?? null,
      lastAckedSeq: -1,
      createdAt: new Date().toISOString(),
      stoppedAt: null,
    };
    this.db.prepare(`
      INSERT INTO sessions (id, status, source_kind, source_language, target_language, title, video_id, last_acked_seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.status, session.sourceKind, session.sourceLanguage, session.targetLanguage, session.title, session.videoId, session.lastAckedSeq, session.createdAt);
    if (session.videoId) this.ensureVideoContext(session.videoId, session.targetLanguage);
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
    return { session, transcript, videoContext: session.videoId ? this.getVideoContext(session.videoId, session.targetLanguage) : null };
  }

  ensureVideoContext(videoId: string, targetLanguage: string): VideoContextView {
    const initial: VideoContextView = {
      videoId, targetLanguage, metadata: null, hints: { topic: "", glossary: [] },
      mode: "auto", status: "idle", basis: "metadata", message: null,
      version: 0, updatedAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT OR IGNORE INTO video_contexts (video_id, target_language, version, value_json) VALUES (?, ?, 0, ?)")
      .run(videoId, targetLanguage, JSON.stringify(initial));
    return this.getVideoContext(videoId, targetLanguage)!;
  }

  getVideoContext(videoId: string, targetLanguage: string): VideoContextView | null {
    const row = this.db.prepare("SELECT value_json FROM video_contexts WHERE video_id = ? AND target_language = ?")
      .get(videoId, targetLanguage) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as VideoContextView : null;
  }

  /** Compare-and-swap: a slow model response must never overwrite a user's edit. */
  saveVideoContext(value: VideoContextView, expectedVersion: number): VideoContextView | null {
    const next = { ...value, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const result = this.db.prepare("UPDATE video_contexts SET version = ?, value_json = ? WHERE video_id = ? AND target_language = ? AND version = ?")
      .run(next.version, JSON.stringify(next), value.videoId, value.targetLanguage, expectedVersion);
    return result.changes === 1 ? next : null;
  }

  getSessionVideoContext(sessionId: string): VideoContextView | null {
    const session = this.getSession(sessionId);
    return session?.videoId ? this.getVideoContext(session.videoId, session.targetLanguage) : null;
  }

  getContextAnalysisSeq(sessionId: string): number {
    const row = this.db.prepare("SELECT context_through_seq FROM sessions WHERE id = ?").get(sessionId) as { context_through_seq: number } | undefined;
    return row?.context_through_seq ?? -1;
  }

  markContextAnalysis(sessionId: string, throughSeq: number): void {
    this.db.prepare("UPDATE sessions SET context_through_seq = ? WHERE id = ?").run(throughSeq, sessionId);
  }

  getContextTranscripts(sessionId: string, throughSeq: number): string[] {
    const rows = this.db.prepare("SELECT text FROM utterances WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 8")
      .all(sessionId, throughSeq) as unknown as Array<{ text: string }>;
    return rows.reverse().map((row) => row.text.slice(0, 1_000));
  }

  stopSession(id: string, expectedLastSeq?: number): SessionView | null {
    const stoppedAt = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = 'processing', stopped_at = ?, expected_last_seq = ? WHERE id = ?")
      .run(stoppedAt, expectedLastSeq ?? this.getSession(id)?.lastAckedSeq ?? -1, id);
    return this.getSession(id);
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
  }

  completeSessionIfDrained(id: string): boolean {
    const session = this.getSession(id);
    if (!session?.stoppedAt || session.status === "completed") return false;
    const expected = this.db.prepare("SELECT expected_last_seq FROM sessions WHERE id = ?").get(id) as { expected_last_seq: number | null };
    if (expected.expected_last_seq !== null && session.lastAckedSeq < expected.expected_last_seq) return false;
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
      WHERE processing_status IN ('stored', 'processing', 'waiting_asr', 'waiting_utterance', 'waiting_translation', 'failed')
      ORDER BY session_id, seq
    `).all() as unknown as AudioSegmentRow[];
  }

  getAudioOffsetMs(sessionId: string, seq: number): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(duration_ms), 0) AS total FROM audio_segments WHERE session_id = ? AND seq < ?").get(sessionId, seq) as unknown as { total: number };
    return row.total;
  }

  getUtteranceForSegment(sessionId: string, seq: number): AssembledUtterance | null {
    const row = this.db.prepare(`
      SELECT * FROM utterances
      WHERE session_id = ? AND ? BETWEEN COALESCE(start_seq, seq) AND COALESCE(end_seq, seq)
      LIMIT 1
    `).get(sessionId, seq) as unknown as UtteranceRow | undefined;
    if (!row) return null;
    return {
      utterance: mapUtterance(row),
      startSeq: row.start_seq ?? row.seq,
      endSeq: row.end_seq ?? row.seq,
    };
  }

  upsertAsrFragment(input: Omit<AsrFragmentRow, "created_at">): AsrFragmentRow {
    const existing = this.db.prepare("SELECT * FROM asr_fragments WHERE session_id = ? AND seq = ?").get(input.session_id, input.seq) as unknown as AsrFragmentRow | undefined;
    if (existing) return existing;
    const row: AsrFragmentRow = { ...input, created_at: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO asr_fragments (session_id, seq, text, language, started_at_ms, ended_at_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.session_id, row.seq, row.text, row.language, row.started_at_ms, row.ended_at_ms, row.created_at);
    return row;
  }

  getAsrFragment(sessionId: string, seq: number): AsrFragmentRow | null {
    return (this.db.prepare("SELECT * FROM asr_fragments WHERE session_id = ? AND seq = ?").get(sessionId, seq) as unknown as AsrFragmentRow | undefined) ?? null;
  }

  getPendingAsrFragments(sessionId: string, throughSeq = Number.MAX_SAFE_INTEGER): AsrFragmentRow[] {
    return this.db.prepare(`
      SELECT fragment.* FROM asr_fragments fragment
      WHERE fragment.session_id = ? AND fragment.seq <= ?
        AND NOT EXISTS (
          SELECT 1 FROM utterances utterance
          WHERE utterance.session_id = fragment.session_id
            AND fragment.seq BETWEEN COALESCE(utterance.start_seq, utterance.seq) AND COALESCE(utterance.end_seq, utterance.seq)
        )
      ORDER BY fragment.seq
    `).all(sessionId, throughSeq) as unknown as AsrFragmentRow[];
  }

  getRecentAsrPrompt(sessionId: string, beforeSeq: number, maximumCharacters = 800): string {
    const rows = this.db.prepare(`
      SELECT text FROM asr_fragments
      WHERE session_id = ? AND seq < ? AND text != ''
      ORDER BY seq DESC LIMIT 4
    `).all(sessionId, beforeSeq) as unknown as Array<{ text: string }>;
    return rows.reverse().map((row) => row.text).join(" ").slice(-maximumCharacters);
  }

  upsertUtterance(input: { sessionId: string; startSeq: number; endSeq: number; text: string; language: string | null; startedAtMs: number; endedAtMs: number }): UtteranceView {
    const existing = this.db.prepare("SELECT * FROM utterances WHERE session_id = ? AND COALESCE(end_seq, seq) = ?").get(input.sessionId, input.endSeq) as unknown as UtteranceRow | undefined;
    if (existing) return mapUtterance(existing);
    const row: UtteranceRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      seq: input.endSeq,
      start_seq: input.startSeq,
      end_seq: input.endSeq,
      text: input.text,
      language: input.language,
      started_at_ms: input.startedAtMs,
      ended_at_ms: input.endedAtMs,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO utterances (id, session_id, seq, start_seq, end_seq, text, language, started_at_ms, ended_at_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.session_id, row.seq, row.start_seq, row.end_seq, row.text, row.language, row.started_at_ms, row.ended_at_ms, row.created_at);
    return mapUtterance(row);
  }

  setAudioRangeProcessingStatus(sessionId: string, startSeq: number, endSeq: number, status: AudioSegmentRow["processing_status"], error: string | null = null): void {
    this.db.prepare(`
      UPDATE audio_segments SET processing_status = ?, last_error = ?
      WHERE session_id = ? AND seq BETWEEN ? AND ?
    `).run(status, error, sessionId, startSeq, endSeq);
  }

  getTranslationContext(sessionId: string, beforeSeq: number, targetLanguage: string, limit = 6): TranslationContextRow[] {
    const rows = this.db.prepare(`
      SELECT utterance.text AS sourceText, translation.text AS translatedText
      FROM utterances utterance
      LEFT JOIN translations translation
        ON translation.utterance_id = utterance.id AND translation.target_language = ?
      WHERE utterance.session_id = ? AND COALESCE(utterance.end_seq, utterance.seq) < ?
      ORDER BY COALESCE(utterance.end_seq, utterance.seq) DESC
      LIMIT ?
    `).all(targetLanguage, sessionId, beforeSeq, limit) as unknown as TranslationContextRow[];
    return rows.reverse();
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
    videoId: row.video_id,
    lastAckedSeq: row.last_acked_seq,
    createdAt: row.created_at,
    stoppedAt: row.stopped_at,
  };
}

function mapUtterance(row: UtteranceRow): UtteranceView {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.end_seq ?? row.seq,
    startSeq: row.start_seq ?? row.seq,
    endSeq: row.end_seq ?? row.seq,
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
