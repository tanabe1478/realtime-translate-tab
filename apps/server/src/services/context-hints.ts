import {
  MAX_GLOSSARY_TERMS,
  type TranslationHints,
} from "@realtime-translate/contracts";

/** Only source terms go to Whisper; definitions/instructions belong to translation. */
export function buildAsrPrompt(
  recentTranscript: string,
  hints?: TranslationHints | null,
): string {
  const terms =
    hints?.glossary
      .map((entry) => entry.term.replace(/[\r\n]+/g, " "))
      .join(", ")
      .slice(0, 350) ?? "";
  return [terms, recentTranscript.slice(-600)].filter(Boolean).join("\n");
}

/** Do not let the model invent glossary terms that never appeared in the evidence. */
export function groundGeneratedHints(
  generated: TranslationHints,
  previous: TranslationHints,
  evidence: string,
): TranslationHints {
  const allowedPrevious = new Set(
    previous.glossary.map((entry) => normalize(entry.term)),
  );
  const grounded = generated.glossary.filter(
    (entry) =>
      allowedPrevious.has(normalize(entry.term)) ||
      containsTerm(evidence, entry.term),
  );
  const byTerm = new Map(
    previous.glossary.map((entry) => [normalize(entry.term), entry]),
  );
  for (const entry of grounded) byTerm.set(normalize(entry.term), entry);
  return {
    topic: generated.topic || previous.topic,
    glossary: [...byTerm.values()].slice(-MAX_GLOSSARY_TERMS),
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function containsTerm(evidence: string, term: string): boolean {
  const needle = normalize(term);
  const haystack = normalize(evidence);
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      needle,
    )
  )
    return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(haystack);
}
