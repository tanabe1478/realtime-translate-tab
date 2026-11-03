import { expect, test } from "@playwright/test";
import { makeWav } from "./helpers.js";

// Chromium's fake microphone: no real device and no permission prompt.
test.use({
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

test("live capture after a file run does not show the file's chunk total as #k / N", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    window.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        const text = document.querySelector(".pipeline-state")?.textContent;
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /ファイル/ }).click();
  await page.getByRole("button", { name: "文字起こしのみ", exact: true }).click();
  await page.locator(".source-section ~ .panel-section select").first().selectOption("ja");
  await page.locator('input[type="file"]').setInputFiles({ name: "three.wav", mimeType: "audio/wav", buffer: makeWav(70, [[26, 27], [52, 53]]) });
  await expect(page.locator(".transcript-card")).toHaveCount(3);
  await expect(page.locator(".pipeline-state")).toContainText("文字起こし完了");
  expect(await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses.some((text) => /文字起こし中 · #\d+ \/ 3$/.test(text)))).toBe(true);

  // Live input without pressing 新規: the stale total must not survive.
  await page.evaluate(() => { (window as unknown as { __statuses: string[] }).__statuses.length = 0; });
  await page.getByRole("button", { name: /マイク/ }).click();
  await page.locator(".source-section ~ .panel-section select").first().selectOption("en");
  await page.getByRole("button", { name: "録音を開始" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses.some((text) => /^文字起こし中 · #\d+/.test(text))), { timeout: 30_000 }).toBe(true);
  const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  expect(statuses.filter((text) => text.startsWith("文字起こし中"))).not.toHaveLength(0);
  expect(statuses.some((text) => /文字起こし中 · #\d+ \/ \d+/.test(text))).toBe(false);
  await page.getByRole("button", { name: "録音を停止" }).click();
});
