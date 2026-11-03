import { describe, expect, it } from "vitest";
import { correctionRejection } from "../src/providers/correction-guard.js";

describe("correctionRejection", () => {
  it("always rejects an empty correction", () => {
    expect(correctionRejection("はい", "  ")).toContain("空の応答");
    expect(correctionRejection("あ".repeat(40), "")).toContain("空の応答");
  });

  it("judges originals of 20 characters or more by a 0.5 to 1.5 ratio", () => {
    const original = "あ".repeat(20);
    expect(correctionRejection(original, "あ".repeat(10))).toBeNull();
    expect(correctionRejection(original, "あ".repeat(30))).toBeNull();
    expect(correctionRejection(original, "あ".repeat(9))).toContain("長さ");
    expect(correctionRejection(original, "あ".repeat(31))).toContain("長さ");
  });

  it("judges originals shorter than 20 characters by an absolute difference of at most 10", () => {
    // A short filler stays acceptable when punctuation or a word is added, which a ratio would reject.
    expect(correctionRejection("はい", "はい、そうです。")).toBeNull();
    expect(correctionRejection("えー", "えー、そうですね。")).toBeNull();
    expect(correctionRejection("あ".repeat(19), "あ".repeat(9))).toBeNull();
    expect(correctionRejection("あ".repeat(19), "あ".repeat(29))).toBeNull();
    expect(correctionRejection("あ".repeat(19), "あ".repeat(8))).toContain("長さ");
    expect(correctionRejection("あ".repeat(19), "あ".repeat(30))).toContain("長さ");
    expect(correctionRejection("はい", "はい、" + "そうです".repeat(4))).toContain("長さ");
  });
});
