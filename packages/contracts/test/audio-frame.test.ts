import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, decodeAudioFrame, encodeAudioFrame } from "../src/index.js";

describe("audio frame codec", () => {
  it("round-trips metadata and binary audio", () => {
    const encoded = encodeAudioFrame(
      {
        version: PROTOCOL_VERSION,
        sessionId: "session-1",
        seq: 7,
        capturedAt: "2025-01-01T00:00:00.000Z",
        durationMs: 5_000,
        mimeType: "audio/wav",
        sourceKind: "browser-tab",
      },
      new Uint8Array([0, 1, 2, 255]),
    );

    const decoded = decodeAudioFrame(encoded);
    expect(decoded.header.sessionId).toBe("session-1");
    expect(decoded.header.seq).toBe(7);
    expect([...decoded.audio]).toEqual([0, 1, 2, 255]);
  });

  it("rejects malformed frames", () => {
    expect(() => decodeAudioFrame(new Uint8Array([1, 2, 3]))).toThrow("magic");
  });
});
