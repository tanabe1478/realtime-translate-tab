import { readFile } from "node:fs/promises";
import type { PartialUtteranceView, ServerEvent } from "@realtime-translate/contracts";
import { AppDatabase, type AssembledUtterance, type AudioSegmentRow } from "../database.js";
import type { SpeechRecognizer, Translator } from "../providers/index.js";
import { EventHub } from "./event-hub.js";
import { assembleUtterance, type UtteranceAssembly } from "./utterance-assembler.js";
import { buildAsrPrompt } from "./context-hints.js";
import type { VideoContextService } from "./video-context.js";

export class ProcessingPipeline {
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly scheduled = new Set<string>();

  constructor(
    private readonly database: AppDatabase,
    private readonly events: EventHub,
    private readonly recognizer: SpeechRecognizer | null,
    private readonly translator: Translator | null,
    private readonly videoContexts?: Pick<VideoContextService, "onUtterance">,
    private readonly translationUnavailableReason = "翻訳の認証が未設定です。選択中のプロバイダー設定を確認してサーバーを再起動してください。",
  ) {}

  async waitForIdle(): Promise<void> {
    await Promise.all(this.sessionTails.values());
  }

  enqueue(segment: AudioSegmentRow): void {
    const key = `${segment.session_id}:${segment.seq}`;
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.appendToSession(segment.session_id, async () => {
      try {
        await this.process(segment);
      } finally {
        this.scheduled.delete(key);
      }
    });
  }

  /** Finalize an incomplete utterance after the user stops capture. */
  flushSession(sessionId: string): void {
    this.appendToSession(sessionId, async () => {
      const pending = this.database.getPendingAsrFragments(sessionId);
      const last = pending.at(-1);
      if (!last) return;
      const segment = this.database.getAudioSegment(sessionId, last.seq);
      if (segment) await this.process(segment, true);
    });
  }

  private appendToSession(sessionId: string, work: () => Promise<void>): void {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => console.error(`Pipeline failed for session ${sessionId}`, error));
    this.sessionTails.set(sessionId, next);
    void next.then(() => {
      if (this.sessionTails.get(sessionId) === next) this.sessionTails.delete(sessionId);
    });
  }

  private publish(event: ServerEvent): void {
    this.events.publish(event);
  }

  private async process(originalSegment: AudioSegmentRow, forceFinalize = false): Promise<void> {
    const segment = this.database.getAudioSegment(originalSegment.session_id, originalSegment.seq);
    if (!segment || segment.processing_status === "completed") return;
    const session = this.database.getSession(segment.session_id);
    if (!session) return;

    let assembled = this.database.getUtteranceForSegment(segment.session_id, segment.seq);
    if (!assembled) {
      let fragment = this.database.getAsrFragment(segment.session_id, segment.seq);
      if (!fragment) {
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

        this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "processing");
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
              prompt: buildAsrPrompt(
                this.database.getRecentAsrPrompt(segment.session_id, segment.seq),
                this.database.getSessionVideoContext(segment.session_id)?.hints,
              ),
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
          const pendingBeforeSilence = this.database.getPendingAsrFragments(segment.session_id, segment.seq - 1);
          const silenceBoundary = assembleUtterance(pendingBeforeSilence, { sourceKind: session.sourceKind, force: true });
          this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "completed");
          if (!silenceBoundary) {
            this.finishSessionIfReady(segment.session_id);
            return;
          }
          assembled = this.persistAssembly(segment.session_id, silenceBoundary);
        } else {
          const startedAtMs = this.database.getAudioOffsetMs(segment.session_id, segment.seq);
          fragment = this.database.upsertAsrFragment({
            session_id: segment.session_id,
            seq: segment.seq,
            text: transcription.text,
            language: transcription.language,
            started_at_ms: startedAtMs,
            ended_at_ms: startedAtMs + segment.duration_ms,
          });
        }
      }

      if (!assembled) {
        const pending = this.database.getPendingAsrFragments(segment.session_id, segment.seq);
        const assembly = assembleUtterance(pending, {
          sourceKind: session.sourceKind,
          force: forceFinalize || session.stoppedAt !== null,
        });
        if (!assembly) {
          this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "completed");
          this.finishSessionIfReady(segment.session_id);
          return;
        }
        if (!assembly.final) {
          this.database.setAudioProcessingStatus(segment.session_id, segment.seq, "waiting_utterance");
          const partial: PartialUtteranceView = {
            sessionId: segment.session_id,
            startSeq: assembly.startSeq,
            endSeq: assembly.endSeq,
            text: assembly.text,
            language: assembly.language,
            startedAtMs: assembly.startedAtMs,
            endedAtMs: assembly.endedAtMs,
          };
          this.publish({ type: "utterance.partial", sessionId: segment.session_id, seq: assembly.endSeq, utterance: partial });
          return;
        }
        assembled = this.persistAssembly(segment.session_id, assembly);
      }
    }

    await this.translateUtterance(assembled, session.targetLanguage);
  }

  private persistAssembly(sessionId: string, assembly: UtteranceAssembly): AssembledUtterance {
    const utterance = this.database.upsertUtterance({
      sessionId,
      startSeq: assembly.startSeq,
      endSeq: assembly.endSeq,
      text: assembly.text,
      language: assembly.language,
      startedAtMs: assembly.startedAtMs,
      endedAtMs: assembly.endedAtMs,
    });
    this.database.setAudioRangeProcessingStatus(sessionId, assembly.startSeq, assembly.endSeq, "processing");
    this.publish({ type: "utterance.final", sessionId, seq: assembly.endSeq, utterance });
    this.videoContexts?.onUtterance(sessionId, assembly.endSeq);
    return { utterance, startSeq: assembly.startSeq, endSeq: assembly.endSeq };
  }

  private async translateUtterance(assembled: AssembledUtterance, targetLanguage: string): Promise<void> {
    const { utterance, startSeq, endSeq } = assembled;
    if (!this.translator) {
      this.database.setAudioRangeProcessingStatus(utterance.sessionId, startSeq, endSeq, "waiting_translation");
      this.publish({
        type: "processing.skipped",
        sessionId: utterance.sessionId,
        seq: endSeq,
        stage: "translation",
        reason: this.translationUnavailableReason,
      });
      return;
    }

    try {
      const result = await this.translator.translate(
        {
          sessionId: utterance.sessionId,
          text: utterance.text,
          sourceLanguage: utterance.language,
          targetLanguage,
          context: this.database.getTranslationContext(utterance.sessionId, startSeq, targetLanguage),
          hints: this.database.getSessionVideoContext(utterance.sessionId)?.hints ?? null,
        },
        AbortSignal.timeout(120_000),
      );
      const translation = this.database.upsertTranslation({
        utteranceId: utterance.id,
        targetLanguage,
        text: result.text,
        provider: this.translator.provider,
        model: this.translator.model,
      });
      this.database.setAudioRangeProcessingStatus(utterance.sessionId, startSeq, endSeq, "completed");
      this.publish({ type: "translation.final", sessionId: utterance.sessionId, seq: endSeq, translation });
      this.finishSessionIfReady(utterance.sessionId);
    } catch (error) {
      const message = errorMessage(error);
      this.database.setAudioRangeProcessingStatus(utterance.sessionId, startSeq, endSeq, "failed", message);
      this.publish({ type: "processing.failed", sessionId: utterance.sessionId, seq: endSeq, stage: "translation", message });
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
