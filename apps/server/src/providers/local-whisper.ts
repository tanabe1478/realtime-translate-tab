import type { AudioInput, SpeechRecognizer, TranscriptionResult } from "./types.js";

export class LocalWhisperRecognizer implements SpeechRecognizer {
  readonly provider = "local-whisper";

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  async checkHealth(signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  async transcribe(input: AudioInput, signal: AbortSignal): Promise<TranscriptionResult> {
    const response = await fetch(`${this.baseUrl}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": input.mimeType,
        "X-File-Name": encodeURIComponent(input.fileName),
        ...(input.sourceLanguage && input.sourceLanguage !== "auto" ? { "X-Source-Language": input.sourceLanguage } : {}),
      },
      body: new Uint8Array(input.bytes),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Local Whisper failed (${response.status}): ${detail}`);
    }
    const body = (await response.json()) as { text?: unknown; language?: unknown };
    if (typeof body.text !== "string") throw new Error("Local Whisper returned no text");
    return {
      text: body.text.trim(),
      language: typeof body.language === "string" ? body.language : input.sourceLanguage,
    };
  }
}
