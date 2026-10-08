export const PROTOCOL_VERSION = 1 as const;

export type SourceKind = "microphone" | "browser-tab" | "file";
export type SessionStatus = "created" | "recording" | "processing" | "completed" | "failed";
export type ProcessingStage = "storage" | "asr" | "translation";

export interface CreateSessionRequest {
  sourceKind: SourceKind;
  sourceLanguage?: string | null;
  targetLanguage: string;
  title?: string | null;
}

export interface SessionView {
  id: string;
  status: SessionStatus;
  sourceKind: SourceKind;
  sourceLanguage: string | null;
  targetLanguage: string;
  title: string | null;
  lastAckedSeq: number;
  createdAt: string;
  stoppedAt: string | null;
}

export interface UtteranceView {
  id: string;
  sessionId: string;
  seq: number;
  text: string;
  language: string | null;
  startedAtMs: number;
  endedAtMs: number;
  createdAt: string;
}

export interface TranslationView {
  id: string;
  utteranceId: string;
  targetLanguage: string;
  text: string;
  provider: string;
  model: string;
  createdAt: string;
}

export interface TranscriptEntry {
  utterance: UtteranceView;
  translation: TranslationView | null;
}

export interface SessionSnapshot {
  session: SessionView;
  transcript: TranscriptEntry[];
}

export interface HealthResponse {
  ok: true;
  asrProvider: "local-whisper" | "disabled";
  asrReady: boolean;
  asrModel: string | null;
  translationProvider: "chatgpt-subscription" | "openai-api" | "disabled";
  translationReady: boolean;
  translationModel: string | null;
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface AudioFrameHeader {
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  seq: number;
  capturedAt: string;
  durationMs: number;
  mimeType: string;
  sourceKind: SourceKind;
  fileName?: string;
}

export type ServerEvent =
  | { type: "connected"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; lastAckedSeq: number }
  | { type: "audio.ack"; sessionId: string; seq: number }
  | { type: "audio.rejected"; sessionId: string; seq: number; message: string; retryable: boolean }
  | { type: "asr.started"; sessionId: string; seq: number }
  | { type: "utterance.final"; sessionId: string; seq: number; utterance: UtteranceView }
  | { type: "translation.final"; sessionId: string; seq: number; translation: TranslationView }
  | { type: "processing.skipped"; sessionId: string; seq: number; stage: "asr" | "translation"; reason: string }
  | { type: "processing.failed"; sessionId: string; seq: number; stage: ProcessingStage; message: string }
  | { type: "session.status"; sessionId: string; status: SessionStatus };

const MAGIC = [0x52, 0x54, 0x30, 0x31] as const; // RT01
const PREFIX_BYTES = 8;
const MAX_HEADER_BYTES = 64 * 1024;

export function encodeAudioFrame(header: AudioFrameHeader, audio: ArrayBuffer | Uint8Array): ArrayBuffer {
  assertAudioFrameHeader(header);
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new Error("Audio frame header is too large");
  }

  const audioBytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  const frame = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + audioBytes.byteLength);
  frame.set(MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, headerBytes.byteLength, false);
  frame.set(headerBytes, PREFIX_BYTES);
  frame.set(audioBytes, PREFIX_BYTES + headerBytes.byteLength);
  return frame.buffer;
}

export function decodeAudioFrame(input: ArrayBuffer | Uint8Array): { header: AudioFrameHeader; audio: Uint8Array } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < PREFIX_BYTES || MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error("Invalid audio frame magic");
  }

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || PREFIX_BYTES + headerLength > bytes.byteLength) {
    throw new Error("Invalid audio frame header length");
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength));
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid audio frame header JSON");
  }

  assertAudioFrameHeader(parsed);
  return {
    header: parsed,
    audio: bytes.subarray(PREFIX_BYTES + headerLength),
  };
}

export function assertAudioFrameHeader(value: unknown): asserts value is AudioFrameHeader {
  if (!value || typeof value !== "object") throw new Error("Invalid audio frame header");
  const header = value as Record<string, unknown>;
  if (header.version !== PROTOCOL_VERSION) throw new Error("Unsupported protocol version");
  if (typeof header.sessionId !== "string" || header.sessionId.length < 1) throw new Error("Invalid sessionId");
  if (!Number.isSafeInteger(header.seq) || (header.seq as number) < 0) throw new Error("Invalid sequence number");
  if (typeof header.capturedAt !== "string") throw new Error("Invalid capturedAt");
  if (typeof header.durationMs !== "number" || !Number.isFinite(header.durationMs) || header.durationMs < 0) throw new Error("Invalid durationMs");
  if (typeof header.mimeType !== "string" || header.mimeType.length < 1) throw new Error("Invalid mimeType");
  if (header.sourceKind !== "microphone" && header.sourceKind !== "browser-tab" && header.sourceKind !== "file") {
    throw new Error("Invalid sourceKind");
  }
  if (header.fileName !== undefined && typeof header.fileName !== "string") throw new Error("Invalid fileName");
}

export function isServerEvent(value: unknown): value is ServerEvent {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}
