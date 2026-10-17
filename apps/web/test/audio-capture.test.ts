import { describe, expect, it } from "vitest";
import { encodeWav, getYouTubeCaptureOptions } from "../src/audio-capture.js";

describe("YouTube tab capture", () => {
  it("offers the current app tab without requesting system audio or suppressing playback", () => {
    expect(getYouTubeCaptureOptions()).toEqual({
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
    });
  });
});

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
