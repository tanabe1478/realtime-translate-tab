import type { TranscriptEntry } from "@realtime-translate/contracts";

/**
 * One `[HH:MM:SS] text` line per utterance; the translation, if any, follows indented.
 * The AI-corrected text replaces the Whisper original when there is one.
 */
export function formatTranscriptText(entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`[${formatTimestamp(entry.utterance.startedAtMs)}] ${entry.correction?.text ?? entry.utterance.text}`);
    if (entry.translation) lines.push(`  ${entry.translation.text}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function formatTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
