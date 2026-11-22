import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import { JsonCredentialStore } from "./credential-store.js";
import { createChatGptTranslator } from "./providers/chatgpt-subscription.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  const usage = "Usage: pnpm transcribe:ja <local file or YouTube URL> [--output result.md]";
  if (values.help) return console.log(usage);
  if (positionals.length !== 1) throw new Error(usage);

  loadEnv({ path: join(root, ".env"), quiet: true });
  const { translator } = await createChatGptTranslator(
    new JsonCredentialStore(join(root, "data", "auth.json")),
    process.env.OPENAI_TRANSLATE_MODEL || "gpt-6-luna",
  );
  if (!translator) throw new Error("ChatGPT authentication is not set up. Run `pnpm auth:openai` first.");

  const source = positionals[0]!;
  const cwd = process.env.INIT_CWD || root;
  console.error("Transcribing English audio locally…");
  const raw = await transcribe(source, cwd);
  if (!raw) throw new Error("No speech was detected.");

  const parts: string[] = [];
  const chunks = splitTranscript(raw);
  let previous = "";
  for (const [index, chunk] of chunks.entries()) {
    console.error(`Correcting and translating with ChatGPT (${index + 1}/${chunks.length})…`);
    const { english, japanese } = await translator.editAndTranslateEnglish(chunk, previous, AbortSignal.timeout(240_000));
    parts.push(`## ${index + 1}\n\n**補正済み英語**\n\n${english}\n\n**日本語訳**\n\n${japanese}`);
    previous = english.slice(-1_200);
  }
  const report = `# 英語文字起こしと日本語訳\n\n${parts.join("\n\n")}\n\n## 未補正の文字起こし\n\n${raw}\n`;
  if (values.output) {
    const output = resolve(cwd, values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, report, { encoding: "utf8", flag: "wx" });
    console.error(`Saved: ${output}`);
  } else {
    process.stdout.write(report);
  }
}

function splitTranscript(text: string): string[] {
  const words = text.trim().split(/\s+/u);
  const chunks: string[] = [];
  for (let start = 0; start < words.length;) {
    const limit = Math.min(start + 500, words.length);
    let end = limit;
    if (end < words.length) {
      while (end > start + 350 && !/[.!?]["'”’)]*$/u.test(words[end - 1]!)) end--;
      if (end <= start + 350) end = limit;
    }
    chunks.push(words.slice(start, end).join(" "));
    start = end;
  }
  return chunks;
}

function transcribe(source: string, cwd: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", "whisper.mjs"), "transcribe", "--language", "en", "--", source], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { text += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveText(text.trim());
      else reject(new Error(`Whisper failed (${signal ?? code})`));
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(/\binvalid_grant\b/i.test(message)
    ? "ChatGPT OAuth could not be renewed. Run `pnpm auth:openai` and retry."
    : message);
  process.exitCode = 1;
});
