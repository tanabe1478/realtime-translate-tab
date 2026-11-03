import { encodeWav } from "./audio-capture.js";

export const FILE_SAMPLE_RATE = 16_000;

export interface SplitOptions {
  /** The cut is searched for in [start + minSeconds, start + maxSeconds]. */
  minSeconds?: number;
  maxSeconds?: number;
  windowMs?: number;
}

export interface SampleRange {
  start: number;
  end: number;
}

/**
 * Decodes an audio/video file to 16 kHz mono samples without playing it.
 * OfflineAudioContext resamples to its own sample rate while decoding.
 */
export async function decodeAudioFileToMono16k(file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, FILE_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(bytes);
  } catch {
    throw new Error(`「${file.name}」の音声を展開できませんでした。ブラウザが対応していない形式の可能性があります。`);
  }
  return mixToMono(decoded);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index]! += data[index]!;
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let index = 0; index < output.length; index += 1) output[index]! *= scale;
  return output;
}

/**
 * Splits samples into contiguous ranges of at most maxSeconds. Each cut is placed at the
 * quietest window within [start + minSeconds, start + maxSeconds]. The tail is always kept.
 */
export function planSilenceSplits(samples: Float32Array, sampleRate: number, options: SplitOptions = {}): SampleRange[] {
  const minSamples = Math.max(1, Math.round((options.minSeconds ?? 20) * sampleRate));
  const maxSamples = Math.max(minSamples, Math.round((options.maxSeconds ?? 30) * sampleRate));
  const windowSamples = Math.max(1, Math.round(((options.windowMs ?? 100) / 1000) * sampleRate));
  const ranges: SampleRange[] = [];

  let start = 0;
  while (start < samples.length) {
    if (samples.length - start <= maxSamples) {
      ranges.push({ start, end: samples.length });
      break;
    }
    const end = findQuietestCut(samples, start + minSamples, start + maxSamples, windowSamples);
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

/** Returns the cut point c in [from, to] whose surrounding window has the lowest RMS. */
function findQuietestCut(samples: Float32Array, from: number, to: number, windowSamples: number): number {
  const step = Math.max(1, Math.floor(windowSamples / 2));
  const half = Math.floor(windowSamples / 2);
  let bestRms = Number.POSITIVE_INFINITY;
  let bestCut = to;
  for (let cut = from; cut <= to; cut += step) {
    const windowStart = Math.max(0, cut - half);
    const windowEnd = Math.min(samples.length, windowStart + windowSamples);
    let energy = 0;
    for (let index = windowStart; index < windowEnd; index += 1) energy += samples[index]! * samples[index]!;
    const rms = Math.sqrt(energy / Math.max(1, windowEnd - windowStart));
    if (rms < bestRms) {
      bestRms = rms;
      bestCut = cut;
    }
  }
  return bestCut;
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    output[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return output;
}

export function encodeSamplesToWav(samples: Float32Array, sampleRate = FILE_SAMPLE_RATE): Blob {
  return encodeWav(floatToInt16(samples), sampleRate);
}
