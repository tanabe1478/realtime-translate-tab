import type { TranslationHints, VideoMetadata } from "@realtime-translate/contracts";

export interface ContextGenerationInput {
  /** Stable routing identity for repeated glossary refinements. */
  videoId?: string;
  targetLanguage: string;
  metadata: VideoMetadata | null;
  previous: TranslationHints;
  /** Source transcripts only; no generated translations used as factual evidence. */
  transcripts: readonly string[];
}

export interface ContextGenerator {
  generateContext(input: ContextGenerationInput, signal: AbortSignal): Promise<TranslationHints>;
}

export interface AudioInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  sourceLanguage: string | null;
  /** Recent finalized source text used only to keep ASR terminology consistent. */
  prompt?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
}

export interface SpeechRecognizer {
  readonly provider: string;
  readonly model: string;
  transcribe(input: AudioInput, signal: AbortSignal): Promise<TranscriptionResult>;
  checkHealth(signal: AbortSignal): Promise<boolean>;
}

export interface TranslationContextEntry {
  sourceText: string;
  translatedText: string | null;
}

export interface TranslationInput {
  sessionId: string;
  text: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  /** Finalized preceding utterances. They are reference context, not translation input. */
  context: readonly TranslationContextEntry[];
  hints?: TranslationHints | null;
}

export interface TranslationResult {
  text: string;
}

export interface Translator {
  readonly provider: string;
  readonly model: string;
  translate(input: TranslationInput, signal: AbortSignal): Promise<TranslationResult>;
}
