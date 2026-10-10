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
}

export interface TranslationResult {
  text: string;
}

export interface Translator {
  readonly provider: string;
  readonly model: string;
  translate(input: TranslationInput, signal: AbortSignal): Promise<TranslationResult>;
}
