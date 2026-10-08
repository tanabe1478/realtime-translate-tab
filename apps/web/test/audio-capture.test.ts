import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio-capture.js";

describe("encodeWav", () => {
  it("writes a valid mono PCM WAV header", async () => {
    const blob = encodeWav(new Int16Array([0, 100, -100, 32767]), 16_000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(bytes.byteLength).toBe(44 + 8);
  });
});
