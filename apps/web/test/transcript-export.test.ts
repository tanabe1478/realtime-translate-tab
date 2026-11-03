import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@realtime-translate/contracts";
import { formatTimestamp, formatTranscriptText } from "../src/transcript-export.js";

function entry(index: number, startedAtMs: number, text: string, translation?: string, correction?: string): TranscriptEntry {
  return {
    utterance: { id: `u${index}`, sessionId: "s", seq: index, startSeq: index, endSeq: index, text, language: "en", startedAtMs, endedAtMs: startedAtMs + 1_000, createdAt: "2025-01-01T00:00:00.000Z" },
    translation: translation === undefined ? null : { id: `t${index}`, utteranceId: `u${index}`, targetLanguage: "ja", text: translation, provider: "test", model: "test", createdAt: "2025-01-01T00:00:00.000Z" },
    correction: correction === undefined ? null : { id: `c${index}`, utteranceId: `u${index}`, text: correction, provider: "test", model: "test", createdAt: "2025-01-01T00:00:00.000Z" },
  };
}

describe("formatTimestamp", () => {
  it("formats HH:MM:SS and truncates milliseconds", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(61_999)).toBe("00:01:01");
    expect(formatTimestamp(3_600_000 + 23 * 60_000 + 45_000)).toBe("01:23:45");
    expect(formatTimestamp(-5)).toBe("00:00:00");
  });
});

describe("formatTranscriptText", () => {
  it("writes one timestamped line per utterance with a trailing newline", () => {
    expect(formatTranscriptText([entry(0, 0, "Hello."), entry(1, 125_000, "Bye.")])).toBe("[00:00:00] Hello.\n[00:02:05] Bye.\n");
  });

  it("puts the translation on an indented following line", () => {
    expect(formatTranscriptText([entry(0, 3_000, "Hello.", "こんにちは。"), entry(1, 9_000, "Bye.")])).toBe("[00:00:03] Hello.\n  こんにちは。\n[00:00:09] Bye.\n");
  });

  it("writes the corrected text instead of the Whisper original, and the original where there is no correction", () => {
    expect(formatTranscriptText([entry(0, 0, "イスコンの話。", undefined, "ISUCONの話。"), entry(1, 9_000, "前職の話。")])).toBe("[00:00:00] ISUCONの話。\n[00:00:09] 前職の話。\n");
  });

  it("keeps the translation handling when an utterance is also corrected", () => {
    expect(formatTranscriptText([entry(0, 0, "Hello", "こんにちは。", "Hello.")])).toBe("[00:00:00] Hello.\n  こんにちは。\n");
  });

  it("returns an empty string for no entries", () => {
    expect(formatTranscriptText([])).toBe("");
  });
});
