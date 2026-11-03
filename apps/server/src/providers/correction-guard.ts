/** Proofread text must stay close to the original length; anything else is treated as a rewrite. */
export const CORRECTION_MIN_RATIO = 0.5;
export const CORRECTION_MAX_RATIO = 1.5;
/** Originals shorter than this are judged by an absolute difference: a ratio is meaningless for a few characters. */
export const CORRECTION_SHORT_LENGTH = 20;
export const CORRECTION_SHORT_MAX_DIFFERENCE = 10;

/** Returns a user-facing reason when the proofread text must not replace the original, else null. */
export function correctionRejection(original: string, corrected: string): string | null {
  const text = corrected.trim();
  if (!text) return "校正モデルが空の応答を返しました。原文を表示します。";
  const length = original.trim().length;
  const tooDifferent = length < CORRECTION_SHORT_LENGTH
    ? Math.abs(text.length - length) > CORRECTION_SHORT_MAX_DIFFERENCE
    : text.length < length * CORRECTION_MIN_RATIO || text.length > length * CORRECTION_MAX_RATIO;
  if (tooDifferent) return "校正結果の長さが原文と大きく異なるため採用しませんでした。原文を表示します。";
  return null;
}

/** Between neighbouring items one grew beyond this and the other shrank below the lower bound: a sentence moved. */
export const SHIFT_GROWN_PERCENT = 115;
export const SHIFT_SHRUNK_PERCENT = 85;
/** Originals shorter than this (without punctuation and spaces) are not judged: a ratio is too coarse. */
export const SHIFT_MIN_LENGTH = 20;
export const CROSS_ITEM_SHIFT_MESSAGE = "校正で発話をまたいで文が移動した可能性があるため、原文を残しました。";

const IGNORED_FOR_SHIFT = /[\s、。，．！？!?,.「」『』（）()…・ー]/gu;

function contentLength(text: string): number {
  return [...text.replace(IGNORED_FOR_SHIFT, "")].length;
}

/**
 * Indexes of items suspected of having exchanged a sentence with a neighbour. The length measured without
 * punctuation and spaces of one grows by more than 15% while the next one's shrinks by more than 15%
 * (or the reverse). A lone outlier is not a move. Pass an unchanged pair for an item that is already rejected.
 */
export function detectCrossItemShift(pairs: readonly { original: string; corrected: string }[]): Set<number> {
  const suspects = new Set<number>();
  const direction = (pair: { original: string; corrected: string } | undefined): "grown" | "shrunk" | null => {
    if (!pair) return null;
    const original = contentLength(pair.original);
    if (original < SHIFT_MIN_LENGTH) return null;
    const corrected = contentLength(pair.corrected);
    if (corrected * 100 > original * SHIFT_GROWN_PERCENT) return "grown";
    if (corrected * 100 < original * SHIFT_SHRUNK_PERCENT) return "shrunk";
    return null;
  };
  for (let index = 0; index + 1 < pairs.length; index += 1) {
    const current = direction(pairs[index]);
    const next = direction(pairs[index + 1]);
    if (current && next && current !== next) {
      suspects.add(index);
      suspects.add(index + 1);
    }
  }
  return suspects;
}
