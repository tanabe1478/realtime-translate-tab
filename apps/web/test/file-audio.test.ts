import { describe, expect, it } from "vitest";
import { encodeSamplesToWav, floatToInt16, planSilenceSplits } from "../src/file-audio.js";

const RATE = 16_000;

/** Constant-amplitude "speech" with silent gaps (in seconds) filled with zeros. */
function signal(totalSeconds: number, silences: Array<[number, number]>): Float32Array {
  const samples = new Float32Array(Math.round(totalSeconds * RATE)).fill(0.3);
  for (const [from, to] of silences) samples.fill(0, Math.round(from * RATE), Math.round(to * RATE));
  return samples;
}

describe("planSilenceSplits", () => {
  it("keeps a short input as a single chunk", () => {
    const samples = signal(12, []);
    expect(planSilenceSplits(samples, RATE)).toEqual([{ start: 0, end: samples.length }]);
    expect(planSilenceSplits(signal(30, []), RATE)).toHaveLength(1);
  });

  it("returns no ranges for empty input", () => {
    expect(planSilenceSplits(new Float32Array(0), RATE)).toEqual([]);
  });

  it("cuts inside the silent gap between 20 and 30 seconds", () => {
    const samples = signal(70, [[26, 26.6], [51, 51.6]]);
    const ranges = planSilenceSplits(samples, RATE);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    const firstCut = ranges[0]!.end;
    expect(firstCut).toBeGreaterThanOrEqual(26 * RATE);
    expect(firstCut).toBeLessThanOrEqual(26.6 * RATE);
    // The window around each cut is silent, i.e. no speech is cut through.
    for (const range of ranges.slice(0, -1)) {
      const around = samples.subarray(range.end - 400, range.end + 400);
      expect(Math.max(...around.map(Math.abs))).toBe(0);
    }
  });

  it("covers every sample without gaps or overlap and never exceeds the maximum", () => {
    const samples = signal(137.3, [[24, 25], [49, 50], [75, 76], [101, 102]]);
    const ranges = planSilenceSplits(samples, RATE);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(samples.length);
    for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
    for (const range of ranges) {
      expect(range.end).toBeGreaterThan(range.start);
      expect(range.end - range.start).toBeLessThanOrEqual(30 * RATE);
    }
    for (const range of ranges.slice(0, -1)) expect(range.end - range.start).toBeGreaterThanOrEqual(20 * RATE);
  });

  it("keeps a short tail as the last chunk", () => {
    const samples = signal(33, [[25, 26]]);
    const ranges = planSilenceSplits(samples, RATE);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]!.end - ranges[1]!.start).toBeLessThan(20 * RATE);
    expect(ranges[1]!.end).toBe(samples.length);
  });

  it("honours custom min, max and window options", () => {
    const samples = signal(25, [[7, 7.5]]);
    const ranges = planSilenceSplits(samples, RATE, { minSeconds: 5, maxSeconds: 10, windowMs: 50 });
    expect(ranges[0]!.end).toBeGreaterThanOrEqual(7 * RATE);
    expect(ranges[0]!.end).toBeLessThanOrEqual(7.5 * RATE);
    for (const range of ranges) expect(range.end - range.start).toBeLessThanOrEqual(10 * RATE);
  });
});

describe("WAV encoding of decoded samples", () => {
  it("converts float samples to clamped 16-bit PCM", () => {
    expect(Array.from(floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("produces a 16 kHz mono WAV with one sample per input sample", async () => {
    const blob = encodeSamplesToWav(new Float32Array(160));
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.type).toBe("audio/wav");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.byteLength).toBe(44 + 320);
  });
});
