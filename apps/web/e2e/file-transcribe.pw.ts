import { expect, test } from "@playwright/test";
import { captureDownloads, downloadedText, makeWav, translateCalls } from "./helpers.js";

test("transcribes a long file in the background without translating and exports timestamped text", async ({ page, request }) => {
  test.setTimeout(90_000);
  const callsBefore = await translateCalls(request);
  await captureDownloads(page);
  // Record every pipeline status so short-lived progress texts can be asserted.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    window.addEventListener("DOMContentLoaded", () => {
      const target = document.querySelector(".pipeline-state")?.parentElement ?? document.body;
      new MutationObserver(() => {
        const text = document.querySelector(".pipeline-state")?.textContent;
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(target, { subtree: true, childList: true, characterData: true });
    });
  });
  // Playing audio would also be a bug: the file must never reach a media element.
  await page.addInitScript(() => {
    (window as unknown as { __played: number }).__played = 0;
    HTMLMediaElement.prototype.play = function play() { (window as unknown as { __played: number }).__played += 1; return Promise.resolve(); };
  });

  await page.goto("/");
  await page.getByRole("button", { name: /ファイル/ }).click();
  await expect(page.getByRole("group", { name: "出力モード" })).toBeVisible();
  await expect(page.getByRole("button", { name: "翻訳する", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "文字起こしのみ", exact: true }).click();
  await expect(page.getByRole("button", { name: "文字起こしのみ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".source-section ~ .panel-section select").first().selectOption("ja");
  await expect(page.getByRole("button", { name: "テキストで保存" })).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({
    name: "long-interview.wav",
    mimeType: "audio/wav",
    buffer: makeWav(70, [[26, 27], [52, 53]]),
  });

  await expect(page.locator(".transcript-card")).toHaveCount(3);
  await expect(page.locator(".pipeline-state")).toContainText("文字起こし完了");
  await expect(page.locator(".notice.success")).toContainText("アップロード完了。このタブを閉じても文字起こしは続きます。");
  await expect(page.locator(".translation-block")).toHaveCount(0);
  await expect(page.locator(".translation-pending")).toHaveCount(0);
  await expect(page.locator(".transcript-card .source-text")).toHaveText([
    "第1チャンクの文字起こしです。",
    "第2チャンクの文字起こしです。",
    "第3チャンクの文字起こしです。",
  ]);

  const sessionId = new URL(page.url()).searchParams.get("sessionId")!;
  const snapshot = await (await request.get(`/api/sessions/${sessionId}`)).json() as { session: { status: string; outputMode: string }; transcript: Array<{ translation: unknown }> };
  expect(snapshot.session).toMatchObject({ status: "completed", outputMode: "transcribe" });
  expect(snapshot.transcript.every((entry) => entry.translation === null)).toBe(true);
  expect(await translateCalls(request)).toBe(callsBefore);

  const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  expect(statuses.some((text) => text.includes("音声を展開中"))).toBe(true);
  expect(statuses.some((text) => /文字起こし中 · #\d+ \/ 3$/.test(text))).toBe(true);
  expect(statuses.some((text) => text.includes("翻訳中"))).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __played: number }).__played)).toBe(0);

  await page.getByRole("button", { name: "テキストで保存" }).click();
  const { name, text } = await downloadedText(page);
  expect(name).toBe("long-interview.txt");
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("");
  const stamped = lines.filter((line) => /^\[\d{2}:\d{2}:\d{2}\] /.test(line));
  expect(stamped).toHaveLength(3);
  expect(stamped[0]).toBe("[00:00:00] 第1チャンクの文字起こしです。");
  // Second chunk starts at the first silent gap (26-27 s), the third at the second one (52-53 s).
  expect(stamped[1]).toMatch(/^\[00:00:2[67]\] 第2チャンク/);
  expect(stamped[2]).toMatch(/^\[00:00:5[23]\] 第3チャンク/);
});

test("translate mode still translates file chunks and the export includes the translation", async ({ page, request }) => {
  test.setTimeout(60_000);
  const callsBefore = await translateCalls(request);
  await captureDownloads(page);
  await page.goto("/");
  await page.getByRole("button", { name: /ファイル/ }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "short.wav", mimeType: "audio/wav", buffer: makeWav(5, []) });
  await expect(page.locator(".translation-block p")).toContainText("コーディングエージェント");
  await expect(page.locator(".pipeline-state")).toContainText("最新の翻訳まで完了");
  expect(await translateCalls(request)).toBe(callsBefore + 1);
  await page.getByRole("button", { name: "テキストで保存" }).click();
  const { name, text } = await downloadedText(page);
  expect(name).toBe("short.txt");
  expect(text).toMatch(/^\[00:00:00\] Pi is a coding agent[^\n]*\n  Piは/);
});
