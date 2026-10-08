import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AudioFrameHeader } from "@realtime-translate/contracts";
import { AppDatabase, type AudioSegmentRow } from "../database.js";
import { ProcessingPipeline } from "./processing-pipeline.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".wav", ".webm", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg"]);

export class AudioIngestService {
  constructor(
    private readonly database: AppDatabase,
    private readonly pipeline: ProcessingPipeline,
    private readonly audioRoot: string,
  ) {}

  async ingest(header: AudioFrameHeader, audio: Uint8Array): Promise<{ lastAckedSeq: number }> {
    if (audio.byteLength === 0) throw new Error("Audio frame is empty");
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error("Audio frame exceeds the 25 MB limit");

    const session = this.database.getSession(header.sessionId);
    if (!session) throw new Error("Session does not exist");
    if (session.sourceKind !== header.sourceKind) throw new Error("Audio source does not match the session");

    const hash = createHash("sha256").update(audio).digest("hex");
    const existing = this.database.getAudioSegment(header.sessionId, header.seq);
    if (existing) {
      if (existing.sha256 !== hash) throw new Error(`Sequence ${header.seq} conflicts with stored audio`);
      if (existing.processing_status !== "completed") this.pipeline.enqueue(existing);
      return { lastAckedSeq: session.lastAckedSeq };
    }

    const directory = join(this.audioRoot, header.sessionId);
    await mkdir(directory, { recursive: true });
    const extension = chooseExtension(header.mimeType, header.fileName);
    const storedName = `segment-${String(header.seq).padStart(6, "0")}${extension}`;
    const finalPath = join(directory, storedName);

    if (await pathExists(finalPath)) {
      const orphanHash = createHash("sha256").update(await readFile(finalPath)).digest("hex");
      if (orphanHash !== hash) throw new Error(`Stored file for sequence ${header.seq} has a different checksum`);
    } else {
      const temporaryPath = join(directory, `.${storedName}.${randomUUID()}.tmp`);
      await writeFile(temporaryPath, audio);
      try {
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }

    const segmentInput = {
      session_id: header.sessionId,
      seq: header.seq,
      path: finalPath,
      mime_type: header.mimeType,
      file_name: header.fileName || storedName,
      duration_ms: Math.round(header.durationMs),
      captured_at: header.capturedAt,
      sha256: hash,
    };
    const result = this.database.insertAudioSegment(segmentInput);
    const row: AudioSegmentRow = { ...segmentInput, processing_status: "stored", last_error: null };
    if (result.created) this.pipeline.enqueue(row);
    return { lastAckedSeq: result.lastAckedSeq };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function chooseExtension(mimeType: string, fileName?: string): string {
  const supplied = fileName ? extname(fileName).toLowerCase() : "";
  if (ALLOWED_EXTENSIONS.has(supplied)) return supplied;
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("mpeg")) return ".mp3";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("ogg")) return ".ogg";
  return ".bin";
}
