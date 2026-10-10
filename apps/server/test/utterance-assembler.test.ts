import { describe, expect, it } from "vitest";
import type { AsrFragmentRow } from "../src/database.js";
import { assembleUtterance, joinTranscriptFragments } from "../src/services/utterance-assembler.js";

describe("utterance assembler", () => {
  it("keeps an incomplete fragment provisional and joins the next chunk", () => {
    const first = assembleUtterance([fragment(0, "This is an")], { sourceKind: "browser-tab" });
    expect(first?.final).toBe(false);

    const completed = assembleUtterance([
      fragment(0, "This is an"),
      fragment(1, "important example."),
    ], { sourceKind: "browser-tab" });
    expect(completed).toMatchObject({
      startSeq: 0,
      endSeq: 1,
      text: "This is an important example.",
      final: true,
    });
  });

  it("joins Japanese fragments without inserting an artificial space", () => {
    expect(joinTranscriptFragments(["これは", "テストです。"])).toBe("これはテストです。");
  });

  it("forces a boundary after three chunks", () => {
    const result = assembleUtterance([
      fragment(0, "one"),
      fragment(1, "two"),
      fragment(2, "three"),
    ], { sourceKind: "microphone" });
    expect(result?.final).toBe(true);
  });
});

function fragment(seq: number, text: string): AsrFragmentRow {
  return {
    session_id: "session-1",
    seq,
    text,
    language: "en",
    started_at_ms: seq * 5_000,
    ended_at_ms: (seq + 1) * 5_000,
    created_at: "2025-01-01T00:00:00.000Z",
  };
}
