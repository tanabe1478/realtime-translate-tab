const TARGET_SAMPLE_RATE = 16_000;

interface YouTubeCaptureOptions extends DisplayMediaStreamOptions {
  preferCurrentTab: true;
  selfBrowserSurface: "include";
  surfaceSwitching: "exclude";
  systemAudio: "exclude";
  audio: MediaTrackConstraints & { suppressLocalAudioPlayback: false; restrictOwnAudio: false };
}

/** These are picker hints, not a way to bypass the user's sharing permission. */
export function getYouTubeCaptureOptions(): YouTubeCaptureOptions {
  return {
    video: { displaySurface: "browser" },
    audio: {
      suppressLocalAudioPlayback: false,
      restrictOwnAudio: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
  };
}

export interface CapturedChunk {
  blob: Blob;
  capturedAt: string;
  durationMs: number;
}

export interface CaptureOptions {
  chunkSeconds: number;
  onChunk(chunk: CapturedChunk): Promise<void> | void;
  onLevel(level: number): void;
  onEnded(): void;
}

export class PcmAudioCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private readonly samples = new SampleAccumulator();
  private emissionTail: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private emittedSamples = 0;
  private stopping = false;
  private flushResolver: (() => void) | null = null;

  constructor(private readonly options: CaptureOptions) {}

  async start(stream: MediaStream): Promise<void> {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("共有されたソースに音声トラックがありません。このアプリのタブを選び、「タブの音声を共有」を有効にしてください。");

    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/pcm-capture-worklet.js");
    await this.context.resume();

    this.source = this.context.createMediaStreamSource(new MediaStream([audioTrack]));
    this.worklet = new AudioWorkletNode(this.context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
    });
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<unknown>) => this.handleWorkletMessage(event.data);
    this.source.connect(this.worklet).connect(this.sink).connect(this.context.destination);
    this.startedAt = Date.now();
    audioTrack.addEventListener("ended", () => {
      if (!this.stopping) this.options.onEnded();
    }, { once: true });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.emissionTail;
    this.stopping = true;

    if (this.worklet) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.flushResolver = resolve;
          this.worklet?.port.postMessage({ type: "flush" });
        }),
        new Promise<void>((resolve) => window.setTimeout(resolve, 250)),
      ]);
    }
    this.emitAvailableChunks(true);
    await this.emissionTail;

    this.source?.disconnect();
    this.worklet?.disconnect();
    this.sink?.disconnect();
    await this.context?.close();
    this.context = null;
  }

  private handleWorkletMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as { type?: unknown; pcm?: unknown; level?: unknown };
    if (message.type === "flushed") {
      this.flushResolver?.();
      this.flushResolver = null;
      return;
    }
    if (message.type !== "pcm" || !(message.pcm instanceof Int16Array)) return;
    this.samples.append(message.pcm);
    if (typeof message.level === "number") this.options.onLevel(Math.min(1, message.level * 5));
    this.emitAvailableChunks(false);
  }

  private emitAvailableChunks(flushRemainder: boolean): void {
    const chunkSamples = Math.max(TARGET_SAMPLE_RATE, Math.round(this.options.chunkSeconds * TARGET_SAMPLE_RATE));
    while (this.samples.length >= chunkSamples) this.scheduleChunk(this.samples.take(chunkSamples));
    if (flushRemainder && this.samples.length >= TARGET_SAMPLE_RATE / 4) this.scheduleChunk(this.samples.take(this.samples.length));
  }

  private scheduleChunk(pcm: Int16Array): void {
    const capturedAt = new Date(this.startedAt + (this.emittedSamples / TARGET_SAMPLE_RATE) * 1000).toISOString();
    this.emittedSamples += pcm.length;
    const chunk: CapturedChunk = {
      blob: encodeWav(pcm, TARGET_SAMPLE_RATE),
      capturedAt,
      durationMs: Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000),
    };
    this.emissionTail = this.emissionTail.then(() => this.options.onChunk(chunk));
  }
}

class SampleAccumulator {
  private chunks: Int16Array[] = [];
  private firstOffset = 0;
  length = 0;

  append(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  take(count: number): Int16Array {
    if (count < 0 || count > this.length) throw new RangeError("Not enough PCM samples");
    const output = new Int16Array(count);
    let written = 0;
    while (written < count) {
      const first = this.chunks[0];
      if (!first) throw new Error("PCM accumulator is inconsistent");
      const available = first.length - this.firstOffset;
      const amount = Math.min(available, count - written);
      output.set(first.subarray(this.firstOffset, this.firstOffset + amount), written);
      written += amount;
      this.firstOffset += amount;
      if (this.firstOffset === first.length) {
        this.chunks.shift();
        this.firstOffset = 0;
      }
    }
    this.length -= count;
    return output;
  }
}

export function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const headerBytes = 44;
  const buffer = new ArrayBuffer(headerBytes + samples.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.byteLength, true);
  new Int16Array(buffer, headerBytes).set(samples);
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
