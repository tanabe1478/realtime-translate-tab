export interface AudioInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  sourceLanguage: string | null;
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

export interface TranslationInput {
  sessionId: string;
  text: string;
  sourceLanguage: string | null;
  targetLanguage: string;
}

export interface TranslationResult {
  text: string;
}

export interface Translator {
  readonly provider: string;
  readonly model: string;
  translate(input: TranslationInput, signal: AbortSignal): Promise<TranslationResult>;
}
