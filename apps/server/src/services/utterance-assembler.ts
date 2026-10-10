import type { SourceKind } from "@realtime-translate/contracts";
import type { AsrFragmentRow } from "../database.js";

const MAX_UTTERANCE_CHUNKS = 3;
const MAX_UTTERANCE_DURATION_MS = 15_000;
const TERMINAL_PUNCTUATION = /[.!?。！？…]["'”’）)\]]*$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface UtteranceAssembly {
  startSeq: number;
  endSeq: number;
  text: string;
  language: string | null;
  startedAtMs: number;
  endedAtMs: number;
  final: boolean;
}

export function assembleUtterance(
  fragments: readonly AsrFragmentRow[],
  options: { sourceKind: SourceKind; force?: boolean },
): UtteranceAssembly | null {
  const spoken = fragments.filter((fragment) => fragment.text.trim().length > 0);
  if (spoken.length === 0) return null;

  const first = spoken[0]!;
  const last = spoken.at(-1)!;
  const text = joinTranscriptFragments(spoken.map((fragment) => fragment.text));
  const durationMs = last.ended_at_ms - first.started_at_ms;
  const final = options.force === true
    || options.sourceKind === "file"
    || TERMINAL_PUNCTUATION.test(text)
    || spoken.length >= MAX_UTTERANCE_CHUNKS
    || durationMs >= MAX_UTTERANCE_DURATION_MS;

  return {
    startSeq: first.seq,
    endSeq: last.seq,
    text,
    language: last.language ?? first.language,
    startedAtMs: first.started_at_ms,
    endedAtMs: last.ended_at_ms,
    final,
  };
}

export function joinTranscriptFragments(parts: readonly string[]): string {
  let result = "";
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (!result) {
      result = part;
      continue;
    }
    const previous = result.at(-1) ?? "";
    const first = part[0] ?? "";
    const separator = CJK.test(previous) || CJK.test(first) || /^[,.;:!?、。！？]/u.test(first) ? "" : " ";
    result += separator + part;
  }
  return result;
}
