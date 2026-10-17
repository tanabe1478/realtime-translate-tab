// Deterministic, isolated test backend. No real credentials, models, or user data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "../../server/dist/database.js";
import { createApplication } from "../../server/dist/app.js";

const directory = mkdtempSync(join(tmpdir(), "rt-browser-test-"));
const attempts = new Map();
const app = createApplication({
  database: new AppDatabase(join(directory, "test.sqlite")),
  audioRoot: join(directory, "audio"),
  webRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../dist"),
  metadataFetcher: async (videoId) => {
    if (videoId === "noMeta00001") throw new Error("Metadata unavailable");
    return {
      title: `${videoId === "slowVideo01" ? "Slow " : videoId === "failVideo01" ? "Fail " : ""}State of Agentic Coding #11 with Geoff, Armin, and Ben`,
      authorName: "Armin Ronacher",
    };
  },
  providers: {
    translationAuthType: "oauth",
    translationSelection: "openai", translationModel: "test", translationIssue: null,
    recognizer: { provider: "test", model: "test", checkHealth: async () => true,
      transcribe: async () => ({ text: "Pi is a coding agent that supports tool calling.", language: "en" }),
    },
    translator: { provider: "test", model: "test", translate: async (input) => {
      const pi = input.hints?.glossary.find((entry) => entry.term === "Pi")?.translation ?? "Pi";
      return { text: `${pi}はツール呼び出しに対応するコーディングエージェントです。` };
    } },
    contextGenerator: { generateContext: async (input, signal) => {
      const key = input.metadata?.title ?? "transcript";
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (key.startsWith("Fail") && attempt === 1) throw new Error("Simulated provider failure");
      if (key.startsWith("Slow")) await new Promise((done, reject) => {
        const timer = setTimeout(done, 8000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return {
        topic: input.targetLanguage === "ja" ? "AIコーディングエージェントの技術対談" : "A technical discussion of AI coding agents",
        glossary: input.transcripts.length
          ? [{ term: "Pi", translation: "Pi", note: "製品名" }, { term: "tool calling", translation: "ツール呼び出し", note: "" }]
          : [{ term: "Agentic Coding", translation: input.targetLanguage === "ja" ? "エージェントによるコーディング" : "Agentic Coding", note: "" }],
      };
    } },
  },
});
app.server.listen(18787, "127.0.0.1");
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); });
});
