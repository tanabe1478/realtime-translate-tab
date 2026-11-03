// Deterministic, isolated test backend. No real credentials, models, or user data.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "../../server/dist/database.js";
import { createApplication } from "../../server/dist/app.js";

const directory = mkdtempSync(join(tmpdir(), "rt-browser-test-"));
const attempts = new Map();
let translateCalls = 0;
// Requests (batches) the stand-in proofreader received, and the utterances in them.
let correctCalls = 0;
let correctItems = 0;
// Sessions titled "slow-correction" wait while the gate is closed, so that tests can observe the "校正中" state.
// GET /hold-correction closes the gate and GET /release-correction opens it (counter server below).
let correctionGateOpen = true;
// Deterministic stand-in for the LLM: rewrites a few known words, never touches anything else.
const CORRECTION_REPLACEMENTS = [["チャンク", "セグメント"], ["coding agent", "coding-agent"]];
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
    correctionModel: "test-correction", correctionIssue: null,
    corrector: { provider: "test", model: "test-correction", correctBatch: async (input) => {
      correctCalls += 1;
      correctItems += input.items.length;
      if (input.title === "slow-correction") {
        while (!correctionGateOpen) await new Promise((done) => setTimeout(done, 20));
      }
      return { items: input.items
        // Sessions titled "fail-correction" cannot proofread their second chunk: the answer simply lacks that item.
        .filter((item) => !(input.title === "fail-correction" && item.text.startsWith("第2")))
        .map((item) => ({ id: item.id, text: CORRECTION_REPLACEMENTS.reduce((text, [from, to]) => text.replaceAll(from, to), item.text) })) };
    } },
    recognizer: { provider: "test", model: "test", checkHealth: async () => true,
      // A session with an explicit Japanese source language gets one distinct line per chunk
      // (segment-000001.wav -> "第2チャンク…"), so file-input tests can tell the chunks apart.
      transcribe: async (input) => {
        const chunk = /segment-(\d+)\./.exec(input.fileName ?? "");
        if (input.sourceLanguage === "ja" && chunk) return { text: `第${Number(chunk[1]) + 1}チャンクの文字起こしです。`, language: "ja" };
        return { text: "Pi is a coding agent that supports tool calling.", language: "en" };
      },
    },
    translator: { provider: "test", model: "test", translate: async (input) => {
      translateCalls += 1;
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
// Test-only counter so e2e tests can assert that transcribe-only sessions never reach the translator.
const counter = createServer((request, response) => {
  if (request.url === "/hold-correction") correctionGateOpen = false;
  if (request.url === "/release-correction") correctionGateOpen = true;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ translateCalls, correctCalls, correctItems }));
}).listen(18788, "127.0.0.1");
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (closing) return;
  closing = true;
  counter.close();
  void app.close().finally(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); });
});
