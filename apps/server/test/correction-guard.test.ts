import { describe, expect, it } from "vitest";
import { detectCrossItemShift, correctionRejection } from "../src/providers/correction-guard.js";

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

describe("detectCrossItemShift", () => {
  const original = "あ".repeat(100);
  const pair = (originalLength: number, correctedLength: number) => ({ original: "あ".repeat(originalLength), corrected: "あ".repeat(correctedLength) });

  it("flags neighbours where one grew and the other shrank, in either order", () => {
    expect([...detectCrossItemShift([pair(100, 126), pair(100, 76)])]).toEqual([0, 1]);
    expect([...detectCrossItemShift([pair(100, 76), pair(100, 126)])]).toEqual([0, 1]);
    expect([...detectCrossItemShift([pair(100, 100), pair(100, 130), pair(100, 70), pair(100, 100)])]).toEqual([1, 2]);
  });

  it("does not flag a lone outlier or neighbours that moved in the same direction", () => {
    expect(detectCrossItemShift([pair(100, 100), pair(100, 120), pair(100, 100)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 100), pair(100, 80), pair(100, 100)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 130), pair(100, 130)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 70), pair(100, 70)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 130)]).size).toBe(0);
    expect(detectCrossItemShift([]).size).toBe(0);
  });

  it("requires more than 1.15 times and less than 0.85 times", () => {
    expect(detectCrossItemShift([pair(100, 115), pair(100, 85)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 116), pair(100, 85)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 115), pair(100, 84)]).size).toBe(0);
    expect([...detectCrossItemShift([pair(100, 116), pair(100, 84)])]).toEqual([0, 1]);
  });

  it("leaves out originals shorter than 20 characters without punctuation and spaces", () => {
    expect(detectCrossItemShift([pair(19, 29), pair(100, 76)]).size).toBe(0);
    expect(detectCrossItemShift([pair(100, 126), pair(19, 5)]).size).toBe(0);
    expect([...detectCrossItemShift([pair(20, 24), pair(20, 16)])]).toEqual([0, 1]);
  });

  it("measures length without punctuation and whitespace", () => {
    const text = (count: number) => "あ".repeat(count);
    // 20 letters plus punctuation and spaces count as 20; a corrected text gaining only punctuation is unchanged.
    const punctuated = { original: `${text(10)}、 ${text(10)}。`, corrected: `「${text(10)}」、 ${text(10)}。…` };
    expect(detectCrossItemShift([punctuated, { original: text(20), corrected: text(16) }]).size).toBe(0);
    expect(detectCrossItemShift([{ original: text(20), corrected: `${text(20)}。。。` }, { original: text(20), corrected: text(16) }]).size).toBe(0);
    expect([...detectCrossItemShift([{ original: text(20), corrected: `${text(24)}。。。` }, { original: text(20), corrected: text(16) }])]).toEqual([0, 1]);
    expect(original.length).toBe(100);
  });
});
