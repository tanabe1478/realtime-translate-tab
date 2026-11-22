export const MAX_GLOSSARY_TERMS = 20;

export interface GlossaryEntry {
  term: string;
  translation: string;
  note: string;
}

export interface TranslationHints {
  topic: string;
  glossary: GlossaryEntry[];
}

export interface VideoMetadata {
  title: string;
  authorName: string;
}

export interface VideoContextView {
  videoId: string;
  targetLanguage: string;
  metadata: VideoMetadata | null;
  hints: TranslationHints;
  mode: "auto" | "manual";
  status: "idle" | "generating" | "ready" | "unavailable" | "failed";
  basis: "metadata" | "transcript" | "manual";
  message: string | null;
  version: number;
  updatedAt: string;
}

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}

export function isLanguageCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(value)
  );
}

/** Strict at the API/model boundary; never silently truncate a user's corrections. */
export function parseTranslationHints(value: unknown): TranslationHints {
  const object = record(value);
  const topic = text(object.topic, "topic", 800, true);
  if (
    !Array.isArray(object.glossary) ||
    object.glossary.length > MAX_GLOSSARY_TERMS
  ) {
    throw new Error(
      `glossary must contain at most ${MAX_GLOSSARY_TERMS} entries`,
    );
  }
  const terms = new Set<string>();
  const glossary = object.glossary.map((entry: unknown) => {
    const row = record(entry);
    const term = text(row.term, "term", 80);
    const key = term.normalize("NFKC").toLocaleLowerCase();
    if (terms.has(key)) throw new Error(`Duplicate glossary term: ${term}`);
    terms.add(key);
    return {
      term,
      translation: text(row.translation, "translation", 160),
      note: text(row.note ?? "", "note", 160, true),
    };
  });
  return { topic, glossary };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim())
  ) {
    throw new Error(
      `${name} must be ${allowEmpty ? "0" : "1"}–${maximum} characters`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    throw new Error(`Invalid control character in ${name}`);
  return value.trim();
}
