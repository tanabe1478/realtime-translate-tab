import type {
  TranslationHints,
  VideoContextView,
  VideoMetadata,
} from "@realtime-translate/contracts";
import { AppDatabase } from "../database.js";
import type { ContextGenerator } from "../providers/types.js";
import { groundGeneratedHints } from "./context-hints.js";
import { fetchVideoMetadata } from "./video-metadata.js";
import { TranslationProviderError } from "../providers/model-translator.js";

type MetadataFetcher = (
  videoId: string,
  signal: AbortSignal,
) => Promise<VideoMetadata>;
interface Job {
  controller: AbortController;
  promise: Promise<void>;
}

export class VideoContextService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly generator: ContextGenerator | null,
    private readonly metadataFetcher: MetadataFetcher = fetchVideoMetadata,
    private readonly unavailableMessage = "翻訳の認証が未設定のため自動生成できません。動画情報だけで続行できます。プロバイダー設定後に再試行してください。",
  ) {}

  /** Return immediately: neither the picker nor caption translation waits for AI. */
  prepare(
    videoId: string,
    targetLanguage: string,
    force = false,
  ): VideoContextView {
    const current = this.database.ensureVideoContext(videoId, targetLanguage);
    const key = this.key(current);
    if (
      this.closed ||
      current.mode === "manual" ||
      this.jobs.has(key) ||
      (!force && current.status === "ready")
    )
      return current;
    // Also recovers a persisted "generating" state after a process restart.
    const pending = this.database.saveVideoContext(
      { ...current, status: "generating", message: null },
      current.version,
    )!;
    this.launch(pending, async (signal) => {
      let value = pending;
      if (!value.metadata) {
        const metadata = await this.metadataFetcher(
          videoId,
          AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        );
        if (signal.aborted || this.closed) return;
        const updated = this.database.saveVideoContext(
          {
            ...value,
            metadata,
            hints: {
              ...value.hints,
              topic: value.hints.topic || metadata.title,
            },
          },
          value.version,
        );
        if (!updated) return;
        value = updated;
      }
      await this.generate(value, [], "metadata", signal);
    });
    return pending;
  }

  /** At most once per ~30 seconds of 5-second chunks; one job per video/language. */
  onUtterance(sessionId: string, throughSeq: number): void {
    if (this.closed || !this.generator) return;
    const value = this.database.getSessionVideoContext(sessionId);
    if (!value || value.mode === "manual" || this.jobs.has(this.key(value)))
      return;
    const previousSeq = this.database.getContextAnalysisSeq(sessionId);
    if (previousSeq >= 0 && throughSeq - previousSeq < 6) return;
    const transcripts = this.database.getContextTranscripts(
      sessionId,
      throughSeq,
    );
    if (!transcripts.some((text) => text.trim())) return;
    const pending = this.database.saveVideoContext(
      { ...value, status: "generating", message: null },
      value.version,
    );
    if (!pending) return;
    // Count failed attempts too: a provider failure must not cause an API-call storm.
    this.database.markContextAnalysis(sessionId, throughSeq);
    this.launch(pending, (signal) =>
      this.generate(pending, transcripts, "transcript", signal),
    );
  }

  saveManual(
    videoId: string,
    targetLanguage: string,
    hints: TranslationHints,
    expectedVersion: number,
  ): VideoContextView | null {
    const current = this.database.getVideoContext(videoId, targetLanguage);
    if (!current) return null;
    const next = this.database.saveVideoContext(
      {
        ...current,
        hints,
        mode: "manual",
        status: "ready",
        basis: "manual",
        message: null,
      },
      expectedVersion,
    );
    if (next) this.cancel(this.key(next));
    return next;
  }

  resumeAutomatic(
    videoId: string,
    targetLanguage: string,
    expectedVersion: number,
  ): VideoContextView | null {
    const current = this.database.getVideoContext(videoId, targetLanguage);
    if (!current) return null;
    const next = this.database.saveVideoContext(
      { ...current, mode: "auto", status: "idle", message: null },
      expectedVersion,
    );
    if (!next) return null;
    this.cancel(this.key(next));
    return this.prepare(videoId, targetLanguage, true);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.promise));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await this.waitForIdle();
  }

  private async generate(
    value: VideoContextView,
    transcripts: string[],
    basis: "metadata" | "transcript",
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.generator) {
      this.database.saveVideoContext(
        {
          ...value,
          status: "unavailable",
          message: this.unavailableMessage,
        },
        value.version,
      );
      return;
    }
    const generated = await this.generator.generateContext(
      {
        videoId: value.videoId,
        targetLanguage: value.targetLanguage,
        metadata: value.metadata,
        previous: value.hints,
        transcripts,
      },
      signal,
    );
    if (signal.aborted || this.closed) return;
    const evidence = [
      value.metadata?.title,
      value.metadata?.authorName,
      ...transcripts,
    ]
      .filter(Boolean)
      .join("\n");
    const hints = groundGeneratedHints(generated, value.hints, evidence);
    this.database.saveVideoContext(
      { ...value, hints, basis, status: "ready", message: null },
      value.version,
    );
  }

  private launch(
    value: VideoContextView,
    work: (signal: AbortSignal) => Promise<void>,
  ): void {
    const key = this.key(value);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    const job: Job = { controller, promise: Promise.resolve() };
    job.promise = Promise.resolve()
      .then(() => work(signal))
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.closed) return;
        const current = this.database.getVideoContext(
          value.videoId,
          value.targetLanguage,
        );
        // A manual edit or newer job must not be touched, even by this error path.
        if (current?.mode === "auto" && this.jobs.get(key) === job) {
          this.database.saveVideoContext(
            {
              ...current,
              status: "failed",
              message: error instanceof TranslationProviderError
                ? `${error.message} 既存の話題・用語集は保持します。`
                : "話題・用語集を自動生成できませんでした。既存の内容で翻訳を続けます。再試行するか、手動で編集できます。",
            },
            current.version,
          );
        }
      })
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
    this.jobs.set(key, job);
  }

  private key(value: VideoContextView): string {
    return `${value.videoId}:${value.targetLanguage}`;
  }
  private cancel(key: string): void {
    this.jobs.get(key)?.controller.abort();
    this.jobs.delete(key);
  }
}
