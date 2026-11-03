import type { ServerEvent, UtteranceView } from "@realtime-translate/contracts";
import type { AppDatabase } from "../database.js";
import { correctionRejection } from "../providers/correction-guard.js";
import type { TranscriptCorrector } from "../providers/types.js";
import type { EventHub } from "./event-hub.js";

export const DEFAULT_CORRECTION_BATCH_SIZE = 15;
export const MAX_CORRECTION_BATCH_SIZE = 50;
export const DEFAULT_CORRECTION_BATCH_CHARACTERS = 4_000;
const CONTEXT_UTTERANCES = 3;

export interface CorrectionServiceOptions {
  timeoutMs?: number;
  /** Utterances per request. */
  batchSize?: number;
  /** Total text characters per request; one longer utterance is sent alone. */
  maxBatchCharacters?: number;
  /** Consecutive whole-batch failures within one session after which its processing is halted. */
  maxConsecutiveBatchFailures?: number;
}

export interface EnqueueOptions {
  /**
   * Whether a session halted by repeated failures, and utterances whose proofreading already failed,
   * are tried again. Explicit user actions and server start-up do; the pipeline announcing new
   * utterances does not.
   */
  resume?: boolean;
}

/** CORRECTION_BATCH_SIZE: an integer from 1 to 50; anything else falls back to the default. */
export function parseCorrectionBatchSize(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (!/^\d+$/.test(text)) return DEFAULT_CORRECTION_BATCH_SIZE;
  const size = Number(text);
  return size >= 1 && size <= MAX_CORRECTION_BATCH_SIZE ? size : DEFAULT_CORRECTION_BATCH_SIZE;
}

type BatchOutcome = "done" | "failed" | "aborted";

/**
 * Proofreads utterances of "correct" sessions in batches, in seq order. It is independent of the
 * audio pipeline: transcription completes without waiting for it, and the original text is untouched.
 */
export class CorrectionService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  private readonly halted = new Set<string>();
  /** Utterances whose proofreading failed, per session: automatic processing does not send them again. */
  private readonly failedUtterances = new Map<string, Set<string>>();
  private readonly shutdown = new AbortController();
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly maxBatchCharacters: number;
  private readonly maxConsecutiveBatchFailures: number;

  constructor(
    private readonly database: AppDatabase,
    private readonly events: EventHub,
    private readonly corrector: TranscriptCorrector | null,
    options: CorrectionServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.batchSize = options.batchSize ?? DEFAULT_CORRECTION_BATCH_SIZE;
    this.maxBatchCharacters = options.maxBatchCharacters ?? DEFAULT_CORRECTION_BATCH_CHARACTERS;
    this.maxConsecutiveBatchFailures = options.maxConsecutiveBatchFailures ?? 3;
  }

  get available(): boolean {
    return this.corrector !== null;
  }

  /**
   * Queues the not-yet-corrected utterances of the session. While its transcription is unfinished only
   * full batches are sent; once it completed the remainder is sent as well. Calls for a running session coalesce.
   */
  enqueueSession(sessionId: string, options: EnqueueOptions = {}): void {
    if (!this.corrector || this.shutdown.signal.aborted) return;
    if (options.resume ?? true) {
      this.halted.delete(sessionId);
      this.failedUtterances.delete(sessionId);
    } else if (this.halted.has(sessionId)) return;
    if (this.running.has(sessionId)) {
      this.rerun.add(sessionId);
      return;
    }
    this.running.set(sessionId, this.drain(sessionId));
  }

  /** Picks up unfinished work of previous server runs. */
  resumePending(): void {
    for (const sessionId of this.database.getCorrectSessionIds()) this.enqueueSession(sessionId);
  }

  /** Stops for good: the request in flight is aborted and no new batch starts. Aborted utterances stay uncorrected. */
  close(): void {
    this.shutdown.abort();
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private async drain(sessionId: string): Promise<void> {
    try {
      do {
        this.rerun.delete(sessionId);
        await this.processPass(sessionId);
      } while (this.rerun.has(sessionId) && !this.halted.has(sessionId) && !this.shutdown.signal.aborted);
    } catch (error) {
      console.error(`Correction failed for session ${sessionId}`, error);
    } finally {
      // Same synchronous step as the last rerun check, so a concurrent enqueue is never lost.
      this.rerun.delete(sessionId);
      this.running.delete(sessionId);
    }
  }

  private async processPass(sessionId: string): Promise<void> {
    let consecutiveBatchFailures = 0;
    while (!this.shutdown.signal.aborted) {
      const session = this.database.getSession(sessionId);
      if (!session || session.outputMode !== "correct") return;
      const failed = this.failedUtterances.get(sessionId);
      const pending = this.database.getUncorrectedUtterances(sessionId).filter((utterance) => !failed?.has(utterance.id));
      const { batch, full } = this.takeBatch(pending);
      // Transcription still running: wait for a full batch. The completion notice sends the remainder.
      if (batch.length === 0 || (!full && session.status !== "completed")) return;
      const outcome = await this.correctBatch(sessionId, session.title, batch);
      if (outcome === "aborted") return;
      if (outcome === "done") {
        consecutiveBatchFailures = 0;
        continue;
      }
      consecutiveBatchFailures += 1;
      if (consecutiveBatchFailures >= this.maxConsecutiveBatchFailures) {
        this.halted.add(sessionId);
        return;
      }
    }
  }

  /** The leading utterances that fit one request. `full` means a limit (count or characters) was reached. */
  private takeBatch(pending: readonly UtteranceView[]): { batch: UtteranceView[]; full: boolean } {
    const batch: UtteranceView[] = [];
    let characters = 0;
    for (const utterance of pending) {
      if (batch.length > 0 && (batch.length >= this.batchSize || characters + utterance.text.length > this.maxBatchCharacters)) {
        return { batch, full: true };
      }
      batch.push(utterance);
      characters += utterance.text.length;
    }
    return { batch, full: batch.length >= this.batchSize || characters >= this.maxBatchCharacters };
  }

  private async correctBatch(sessionId: string, title: string | null, batch: readonly UtteranceView[]): Promise<BatchOutcome> {
    const corrector = this.corrector!;
    let result;
    try {
      result = await corrector.correctBatch(
        {
          sessionId,
          title: titleWithoutExtension(title),
          language: batch.find((utterance) => utterance.language)?.language ?? null,
          recentContext: this.database.getCorrectionContext(sessionId, batch[0]!.startSeq, CONTEXT_UTTERANCES),
          items: batch.map((utterance, index) => ({ id: String(index + 1), text: utterance.text })),
        },
        AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
      );
    } catch (error) {
      if (this.shutdown.signal.aborted) return "aborted";
      const message = errorMessage(error);
      for (const utterance of batch) this.fail(sessionId, utterance, message);
      return "failed";
    }
    if (this.shutdown.signal.aborted) return "aborted";

    const answers = new Map<string, string[]>();
    for (const item of result.items) answers.set(item.id, [...(answers.get(item.id) ?? []), item.text]);
    batch.forEach((utterance, index) => {
      const texts = answers.get(String(index + 1)) ?? [];
      if (texts.length !== 1) {
        this.fail(sessionId, utterance, texts.length === 0
          ? "校正モデルの応答にこの発話が含まれていませんでした。原文を表示します。"
          : "校正モデルの応答でこの発話が重複していたため採用しませんでした。原文を表示します。");
        return;
      }
      const rejection = correctionRejection(utterance.text, texts[0]!);
      if (rejection) {
        this.fail(sessionId, utterance, rejection);
        return;
      }
      const correction = this.database.upsertCorrection({
        utteranceId: utterance.id,
        text: texts[0]!.trim(),
        provider: corrector.provider,
        model: corrector.model,
      });
      this.publish({ type: "correction.final", sessionId, seq: utterance.seq, correction });
    });
    return "done";
  }

  private fail(sessionId: string, utterance: UtteranceView, message: string): void {
    const failed = this.failedUtterances.get(sessionId) ?? new Set<string>();
    failed.add(utterance.id);
    this.failedUtterances.set(sessionId, failed);
    this.publish({ type: "correction.failed", sessionId, seq: utterance.seq, message });
  }

  private publish(event: ServerEvent): void {
    this.events.publish(event);
  }
}

function titleWithoutExtension(title: string | null): string | null {
  const base = (title ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return base || null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}
