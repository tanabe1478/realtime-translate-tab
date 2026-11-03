import { expect, test, type Page } from "@playwright/test";
import { captureDownloads, correctStats, downloadedText, makeWav, translateCalls } from "./helpers.js";

const LONG_FILE = (name: string) => ({ name, mimeType: "audio/wav", buffer: makeWav(70, [[26, 27], [52, 53]]) });
const SHORT_FILE = (name: string) => ({ name, mimeType: "audio/wav", buffer: makeWav(5, []) });
const ORIGINAL = ["第1チャンクの文字起こしです。", "第2チャンクの文字起こしです。", "第3チャンクの文字起こしです。"];
const CORRECTED = ["第1セグメントの文字起こしです。", "第2セグメントの文字起こしです。", "第3セグメントの文字起こしです。"];

async function openFileInput(page: Page, mode: "翻訳する" | "文字起こしのみ" | "AI校正つき"): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /ファイル/ }).click();
  await page.getByRole("button", { name: mode, exact: true }).click();
  await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".source-section ~ .panel-section select").first().selectOption("ja");
}

function sessionIdOf(page: Page): string {
  return new URL(page.url()).searchParams.get("sessionId")!;
}

test("AI校正つき: shows the corrected text, keeps the Whisper original, counts progress and exports the corrected text", async ({ page, request }) => {
  test.setTimeout(90_000);
  const translateBefore = await translateCalls(request);
  const statsBefore = await correctStats(request);
  await captureDownloads(page);
  await openFileInput(page, "AI校正つき");
  await page.locator('input[type="file"]').setInputFiles(LONG_FILE("proofread.wav"));

  await expect(page.locator(".transcript-card")).toHaveCount(3);
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 3 / 3");
  await expect(page.locator(".pipeline-state")).toContainText("校正完了");
  await expect(page.locator(".transcript-card .source-text")).toHaveText(CORRECTED);
  await expect(page.locator(".correction-label")).toHaveCount(0);
  await expect(page.locator(".translation-block")).toHaveCount(0);

  // The Whisper original is behind a <details> and stays unchanged.
  const details = page.locator(".transcript-card details");
  await expect(details).toHaveCount(3);
  await expect(details.first().locator("summary")).toHaveText("Whisperの原文");
  await expect(details.first().locator("p")).toBeHidden();
  await details.first().locator("summary").click();
  await expect(details.first().locator("p")).toHaveText(ORIGINAL[0]!);
  await expect(page.getByRole("button", { name: "AI校正を実行" })).toHaveCount(0);

  const snapshot = await (await request.get(`/api/sessions/${sessionIdOf(page)}`)).json() as {
    session: { outputMode: string; status: string };
    transcript: Array<{ utterance: { text: string }; translation: unknown; correction: { text: string; model: string } | null }>;
  };
  expect(snapshot.session).toMatchObject({ outputMode: "correct", status: "completed" });
  expect(snapshot.transcript.map((entry) => entry.utterance.text)).toEqual(ORIGINAL);
  expect(snapshot.transcript.map((entry) => entry.correction?.text)).toEqual(CORRECTED);
  expect(snapshot.transcript.every((entry) => entry.translation === null && entry.correction?.model === "test-correction")).toBe(true);
  expect(await translateCalls(request)).toBe(translateBefore);
  // Three utterances are proofread by one request, not one request each.
  const statsAfter = await correctStats(request);
  expect(statsAfter.requests - statsBefore.requests).toBe(1);
  expect(statsAfter.items - statsBefore.items).toBe(3);

  await page.getByRole("button", { name: "テキストで保存" }).click();
  const { name, text } = await downloadedText(page);
  expect(name).toBe("proofread.txt");
  const stamped = text.split("\n").filter((line) => /^\[\d{2}:\d{2}:\d{2}\] /.test(line));
  expect(stamped).toHaveLength(3);
  expect(stamped[0]).toBe(`[00:00:00] ${CORRECTED[0]}`);
  expect(stamped[1]).toMatch(/^\[00:00:2[67]\] 第2セグメント/);
  expect(stamped[2]).toMatch(/^\[00:00:5[23]\] 第3セグメント/);
  expect(text).not.toContain("チャンク");
});

test("shows 校正中 and 校正済み 0 / N until the proofreading arrives", async ({ page, request }) => {
  test.setTimeout(90_000);
  await request.get("http://127.0.0.1:18788/hold-correction");
  await openFileInput(page, "AI校正つき");
  await page.locator('input[type="file"]').setInputFiles(LONG_FILE("slow-correction.wav"));

  await expect(page.locator(".transcript-card")).toHaveCount(3);
  // Transcription is already complete while every utterance still waits for its proofreading.
  await expect(page.locator(".pipeline-state")).toContainText("文字起こし完了");
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 0 / 3");
  await expect(page.locator(".correction-label.pending")).toHaveText(["校正中", "校正中", "校正中"]);
  await expect(page.locator(".transcript-card .source-text")).toHaveText(ORIGINAL);
  await expect(page.locator(".transcript-card details")).toHaveCount(0);

  await request.get("http://127.0.0.1:18788/release-correction");
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 3 / 3");
  await expect(page.locator(".correction-label")).toHaveCount(0);
  await expect(page.locator(".transcript-card .source-text")).toHaveText(CORRECTED);
});

test("文字起こしのみ → AI校正を実行 proofreads the saved utterances afterwards", async ({ page, request }) => {
  test.setTimeout(90_000);
  await openFileInput(page, "文字起こしのみ");
  await page.locator('input[type="file"]').setInputFiles(LONG_FILE("later.wav"));
  await expect(page.locator(".transcript-card")).toHaveCount(3);
  await expect(page.locator(".pipeline-state")).toContainText("文字起こし完了");
  await expect(page.locator(".transcript-card .source-text")).toHaveText(ORIGINAL);
  await expect(page.locator(".correction-progress")).toHaveCount(0);
  await expect(page.locator(".transcript-card details")).toHaveCount(0);
  const statsBefore = await correctStats(request);
  const sessionId = sessionIdOf(page);

  await page.getByRole("button", { name: "AI校正を実行" }).click();

  await expect(page.locator(".transcript-card .source-text")).toHaveText(CORRECTED);
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 3 / 3");
  await expect(page.getByRole("button", { name: "AI校正を実行" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI校正つき", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".transcript-card details summary").first().click();
  await expect(page.locator(".transcript-card details p").first()).toHaveText(ORIGINAL[0]!);
  expect(await correctStats(request)).toEqual({ requests: statsBefore.requests + 1, items: statsBefore.items + 3 });
  const snapshot = await (await request.get(`/api/sessions/${sessionId}`)).json() as { session: { outputMode: string }; transcript: Array<{ utterance: { text: string }; correction: { text: string } | null }> };
  expect(snapshot.session.outputMode).toBe("correct");
  expect(snapshot.transcript.map((entry) => entry.utterance.text)).toEqual(ORIGINAL);

  // Idempotent: asking again does not proofread anything twice.
  expect((await request.post(`/api/sessions/${sessionId}/correct`, { data: {} })).status()).toBe(202);
  await page.waitForTimeout(300);
  expect(await correctStats(request)).toEqual({ requests: statsBefore.requests + 1, items: statsBefore.items + 3 });
});

test("a failed proofreading keeps the original text with a failure label and does not stop the other utterances", async ({ page }) => {
  test.setTimeout(90_000);
  await captureDownloads(page);
  await openFileInput(page, "AI校正つき");
  await page.locator('input[type="file"]').setInputFiles(LONG_FILE("fail-correction.wav"));

  await expect(page.locator(".transcript-card")).toHaveCount(3);
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 2 / 3");
  await expect(page.locator(".correction-label.failed")).toHaveText("校正失敗（原文を表示）");
  await expect(page.locator(".transcript-card .source-text")).toHaveText([CORRECTED[0]!, ORIGINAL[1]!, CORRECTED[2]!]);
  await expect(page.locator(".transcript-card").nth(1).locator("details")).toHaveCount(0);
  // The reason is available on the label itself (tooltip), independent of the single notice slot.
  await expect(page.locator(".correction-label.failed")).toHaveAttribute("title", /この発話が含まれていませんでした/);
  // The failed utterance can be retried by the user.
  await expect(page.getByRole("button", { name: "AI校正を実行" })).toBeVisible();

  await page.getByRole("button", { name: "テキストで保存" }).click();
  const { text } = await downloadedText(page);
  expect(text).toContain(`] ${CORRECTED[0]}\n`);
  expect(text).toContain(`] ${ORIGINAL[1]}\n`);
  expect(text).toContain(`] ${CORRECTED[2]}\n`);
});

test("a restored session keeps the output mode in the selector (reload and direct link)", async ({ page }) => {
  test.setTimeout(90_000);
  await openFileInput(page, "文字起こしのみ");
  await page.locator('input[type="file"]').setInputFiles(SHORT_FILE("restore-transcribe.wav"));
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  await expect(page.locator(".pipeline-state")).toContainText("文字起こし完了");
  const transcribeId = sessionIdOf(page);

  await page.reload();
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "文字起こしのみ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "翻訳する", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".translation-block")).toHaveCount(0);

  await page.getByRole("button", { name: "新規" }).click();
  await page.getByRole("button", { name: "AI校正つき", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(SHORT_FILE("restore-correct.wav"));
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 1 / 1");
  const correctId = sessionIdOf(page);
  expect(correctId).not.toBe(transcribeId);

  // A direct link in a fresh page without any remembered state.
  await page.goto("about:blank");
  await page.evaluate(() => localStorage.clear()).catch(() => undefined);
  await page.goto(`/?sessionId=${correctId}`);
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "AI校正つき", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".correction-progress")).toHaveText("校正済み 1 / 1");
  await expect(page.locator(".transcript-card details summary")).toHaveText("Whisperの原文");

  await page.goto(`/?sessionId=${transcribeId}`);
  await expect(page.getByRole("button", { name: "文字起こしのみ", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("文字起こしのみ / AI校正つき do not warn about a missing translation login and the file empty state has no 5-second wording", async ({ page }) => {
  test.setTimeout(60_000);
  const warning = "翻訳の認証が未設定です。選択中のプロバイダー設定を確認してサーバーを再起動してください。";
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const health = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...health, translationReady: false, translationMessage: warning, translationProvider: "disabled", translationAuthType: null } });
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __emptyTexts: string[] }).__emptyTexts = seen;
    window.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        const text = document.querySelector(".empty-state")?.textContent;
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.goto("/");
  // Control: with the translation source selected the warning is still shown.
  await expect(page.locator(".empty-warning")).toContainText(warning);
  await page.getByRole("button", { name: /ファイル/ }).click();
  await expect(page.getByRole("button", { name: "翻訳する", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".empty-warning")).toContainText(warning);

  for (const mode of ["文字起こしのみ", "AI校正つき"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await expect(page.locator(".empty-warning")).toHaveCount(0);
    await expect(page.locator(".empty-state")).not.toContainText("5秒チャンク");
  }
  // The provider settings column keeps showing the translation setup problem.
  await expect(page.locator(".translation-settings .translation-warning")).toContainText(warning);

  await page.locator(".source-section ~ .panel-section select").first().selectOption("ja");
  await page.locator('input[type="file"]').setInputFiles(SHORT_FILE("empty-state.wav"));
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  const texts = await page.evaluate(() => (window as unknown as { __emptyTexts: string[] }).__emptyTexts);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.some((text) => text.includes("5秒チャンク"))).toBe(false);
});

test("the proofreading mode is disabled with the reason when the server cannot proofread", async ({ page }) => {
  const issue = "校正モデルgpt-5.6-terraはこのアカウントでは利用できません。";
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const health = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...health, correctionReady: false, correctionModel: "gpt-5.6-terra", correctionMessage: issue } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /ファイル/ }).click();
  await expect(page.getByRole("button", { name: "AI校正つき", exact: true })).toBeDisabled();
  await expect(page.locator(".mode-note")).toContainText(issue);
  await expect(page.getByRole("button", { name: "文字起こしのみ", exact: true })).toBeEnabled();
});

test("the footer describes the file splitting for file input and keeps the 5-second wording for live input", async ({ page }) => {
  test.setTimeout(90_000);
  const footer = page.locator(".panel-footer");
  await page.goto("/");
  await expect(footer).toContainText("16 kHz mono PCM/WAV · 5秒チャンク");
  await page.getByRole("button", { name: /マイク/ }).click();
  await expect(footer).toContainText("5秒チャンク");

  await page.getByRole("button", { name: /ファイル/ }).click();
  await expect(footer).toContainText("16 kHz mono WAV · 20〜30秒ごとに分割");
  await expect(footer).not.toContainText("5秒チャンク");

  await page.locator(".source-section ~ .panel-section select").first().selectOption("ja");
  await page.locator('input[type="file"]').setInputFiles(SHORT_FILE("footer.wav"));
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  const sessionId = sessionIdOf(page);
  await expect(footer).toContainText("20〜30秒ごとに分割");

  // A restored file session keeps the file wording.
  await page.goto(`/?sessionId=${sessionId}`);
  await expect(page.locator(".transcript-card")).toHaveCount(1);
  await expect(footer).toContainText("20〜30秒ごとに分割");
  await expect(footer).not.toContainText("5秒チャンク");
});
