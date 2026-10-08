import { readFile } from "node:fs/promises";
import type { ServerEvent } from "@realtime-translate/contracts";
import { AppDatabase, type AudioSegmentRow } from "../database.js";
import type { SpeechRecognizer, Translator } from "../providers/index.js";
import { EventHub } from "./event-hub.js";

export class ProcessingPipeline {
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly scheduled = new Set<string>();

  constructor(
    private readonly database: AppDatabase,
    private readonly events: EventHub,
    private readonly recognizer: SpeechRecognizer | null,
    private readonly translator: Translator | null,
  ) {}

  enqueue(segment: AudioSegmentRow): void {
    const key = `${segment.session_id}:${segment.seq}`;
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);

    const previous = this.sessionTails.get(segment.session_id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(segment))
      .catch((error: unknown) => console.error(`Pipeline failed for ${key}`, error))
      .finally(() => {
        this.scheduled.delete(key);
        if (this.sessionTails.get(segment.session_id) === next) this.sessionTails.delete(segment.session_id);
      });
    this.sessionTails.set(segment.session_id, next);
  }

  private publish(event: ServerEvent): void {
    this.events.publish(event);
  }

  private async process(segment: AudioSegmentRow): Promise<void> {
    const session = this.database.getSession(segment.session_id);
    if (!session) return;

    this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "processing");
    let utterance = this.database.getUtterance(segment.session_id, segment.seq);

    if (!utterance) {
      if (!this.recognizer) {
        this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "waiting_asr");
        this.publish({
          type: "processing.skipped",
          sessionId: segment.session_id,
          seq: segment.seq,
          stage: "asr",
          reason: "ローカルWhisperが無効です。音声は保存済みです。",
        });
        return;
      }

      this.publish({ type: "asr.started", sessionId: segment.session_id, seq: segment.seq });
      let transcription;
      try {
        const bytes = await readFile(segment.path);
        transcription = await this.recognizer.transcribe(
          {
            bytes,
            mimeType: segment.mime_type,
            fileName: segment.file_name,
            sourceLanguage: session.sourceLanguage,
          },
          AbortSignal.timeout(120_000),
        );
      } catch (error) {
        const message = errorMessage(error);
        this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "failed", message);
        this.publish({ type: "processing.failed", sessionId: segment.session_id, seq: segment.seq, stage: "asr", message });
        return;
      }

      if (!transcription.text) {
        this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "completed");
        this.finishSessionIfReady(segment.session_id);
        return;
      }

      const startedAtMs = this.database.getAudioOffsetMs(segment.session_id, segment.seq);
      utterance = this.database.upsertUtterance({
        sessionId: segment.session_id,
        seq: segment.seq,
        text: transcription.text,
        language: transcription.language,
        startedAtMs,
        endedAtMs: startedAtMs + segment.duration_ms,
      });
      this.publish({ type: "utterance.final", sessionId: segment.session_id, seq: segment.seq, utterance });
    }

    if (!this.translator) {
      this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "waiting_translation");
      this.publish({
        type: "processing.skipped",
        sessionId: segment.session_id,
        seq: segment.seq,
        stage: "translation",
        reason: "ChatGPTへ未ログインです。`pnpm auth:openai`を実行してサーバーを再起動してください。",
      });
      return;
    }

    try {
      const result = await this.translator.translate(
        {
          sessionId: segment.session_id,
          text: utterance.text,
          sourceLanguage: utterance.language,
          targetLanguage: session.targetLanguage,
        },
        AbortSignal.timeout(120_000),
      );
      const translation = this.database.upsertTranslation({
        utteranceId: utterance.id,
        targetLanguage: session.targetLanguage,
        text: result.text,
        provider: this.translator.provider,
        model: this.translator.model,
      });
      this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "completed");
      this.publish({ type: "translation.final", sessionId: segment.session_id, seq: segment.seq, translation });
      this.finishSessionIfReady(segment.session_id);
    } catch (error) {
      const message = errorMessage(error);
      this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "failed", message);
      this.publish({ type: "processing.failed", sessionId: segment.session_id, seq: segment.seq, stage: "translation", message });
    }
  }

  private finishSessionIfReady(sessionId: string): void {
    if (this.database.completeSessionIfDrained(sessionId)) {
      this.publish({ type: "session.status", sessionId, status: "completed" });
    }
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}
