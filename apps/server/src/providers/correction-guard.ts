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
