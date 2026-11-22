import { expect, test, type Page } from "@playwright/test";

const videoId = "HDdbU10r7Js";
const contextPath = (id = videoId, language = "ja") => `/api/video-contexts/${id}?targetLanguage=${language}`;

test.beforeEach(async ({ page }) => {
  await page.route("https://www.youtube-nocookie.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#101613;color:#a5d7c3;font:16px sans-serif">YouTube player · test fixture</body></html>',
  }));
  // Fake only the permission/device boundary. Worklet, WAV, IndexedDB, HTTP,
  // WebSocket, SQLite, background context jobs and caption events are real.
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 18;
      canvas.getContext("2d")!.fillRect(0, 0, 32, 18);
      const video = canvas.captureStream(1).getVideoTracks()[0]!;
      video.getSettings = () => ({ displaySurface: "browser" });
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await context.resume();
      return new MediaStream([video, ...destination.stream.getAudioTracks()]);
    };
  });
});

async function loadVideo(page: Page, id = videoId) {
  await page.goto("/");
  await page.getByLabel("YouTubeの動画URL").fill(`https://www.youtube.com/watch?v=${id}`);
  await page.getByRole("button", { name: "動画を表示", exact: true }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", new RegExp(id));
  await expect(page.getByRole("button", { name: "翻訳を開始", exact: true })).toBeEnabled();
}

async function resetAutomatic(page: Page) {
  let value = await (await page.request.post(contextPath(), { data: {} })).json();
  await expect.poll(async () => (await (await page.request.get(contextPath())).json()).status).not.toBe("generating");
  value = await (await page.request.get(contextPath())).json();
  value = await (await page.request.put(contextPath(), { data: { mode: "manual", expectedVersion: value.version, hints: { topic: "", glossary: [] } } })).json();
  await page.request.put(contextPath(), { data: { mode: "auto", expectedVersion: value.version } });
  await expect.poll(async () => (await (await page.request.get(contextPath())).json()).status).toBe("ready");
}

async function captureAndStop(page: Page) {
  await page.getByRole("button", { name: "翻訳を開始", exact: true }).click();
  await expect(page.getByRole("button", { name: "録音を停止", exact: true })).toBeEnabled();
  await expect(page.locator(".audio-meter i.on").first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "録音を停止", exact: true }).click();
  await expect(page.locator(".translation-block p").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "翻訳を開始", exact: true })).toBeEnabled();
}

test("displays the selected provider, model and auth without confusing a missing Go key with OpenAI login", async ({ page }) => {
  let selection = "opencode-go";
  let authType: string | null = "api_key";
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: {
      ...await response.json(),
      translationSelection: selection,
      translationProvider: selection === "opencode-go" ? "opencode-go" : "chatgpt-subscription",
      translationModel: selection === "opencode-go" ? "glm-5.3-flash" : "gpt-6-luna",
      translationReady: authType !== null,
      translationAuthType: authType,
      translationMessage: authType === null ? "OpenCode GoのAPIキーが未設定です。OPENCODE_API_KEYを設定してください。" : null,
    } });
  });
  await page.goto("/");
  const settings = page.getByRole("region", { name: "翻訳プロバイダー設定" });
  await expect(settings).toContainText("OpenCode Go");
  await expect(settings).toContainText("glm-5.3-flash");
  await expect(settings).toContainText("APIキー");
  await expect(settings).toContainText("自動切り替えはしません");
  await expect(page.locator(".header-status")).toContainText("OPENCODE GO SET");
  authType = null;
  await page.reload();
  await expect(settings).toContainText("OPENCODE_API_KEY");
  await expect(settings).toContainText("認証未設定");
  await expect(settings).not.toContainText("pnpm auth:openai");
  selection = "openai"; authType = "oauth";
  await page.reload();
  await expect(settings).toContainText("ChatGPT (OpenAI)");
  await expect(settings).toContainText("OpenAIログイン (OAuth)");
});

test("restores captions from a direct link without browser storage and updates that link for a new capture", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await captureAndStop(page);
  const savedUrl = page.url();
  const savedId = new URL(savedUrl).searchParams.get("sessionId");
  expect(savedId).toBeTruthy();
  await page.getByRole("button", { name: "新規", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("sessionId")).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("realtime-translate:last-session"))).toBeNull();
  await page.goto(savedUrl);
  await expect(page.locator(".translation-block p")).toContainText("コーディングエージェント");
  await expect(page.locator(".pipeline-state")).toContainText("復元");
  await expect(page.getByRole("button", { name: "録音を停止", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("realtime-translate:last-session"))).toBe(savedId);
  await captureAndStop(page);
  const nextUrl = page.url();
  expect(new URL(nextUrl).searchParams.get("sessionId")).not.toBe(savedId);
  await page.reload();
  await expect(page.locator(".translation-block p")).toContainText("コーディングエージェント");
  expect(page.url()).toBe(nextUrl);
});

test("keeps the saved session reference after a temporary restore error and recovers on reload", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await captureAndStop(page);
  const id = new URL(page.url()).searchParams.get("sessionId")!;
  // Exercise the legacy/localStorage-only restoration route too.
  await page.evaluate(() => history.replaceState(null, "", "/"));
  let fail = true;
  await page.route(`**/api/sessions/${id}`, (route) => fail
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary test outage" }) })
    : route.continue());
  await page.reload();
  await expect(page.locator(".notice.error")).toContainText("セッションの記録は保持");
  expect(await page.evaluate(() => localStorage.getItem("realtime-translate:last-session"))).toBe(id);
  fail = false;
  await page.reload();
  await expect(page.locator(".translation-block p")).toContainText("コーディングエージェント");
  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(id);
});

test("automatically prepares metadata, learns terms from speech, and preserves video/caption visibility", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  await page.locator(".context-panel summary").click();
  await expect(page.locator(".context-metadata")).toContainText("State of Agentic Coding #11");
  await expect(page.locator(".context-glossary")).toContainText("Agentic Coding");
  await captureAndStop(page);
  await expect(page.locator(".context-glossary")).toContainText("Pi");
  await expect(page.locator(".context-body")).toContainText("動画情報＋実際の発言");
  await expect(page.locator(".translation-block p")).toContainText("コーディングエージェント");
  await expect(page.locator("iframe")).toBeInViewport();
  await expect(page.locator(".translation-block p")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("video-and-context.png") });
});

test("manual corrections survive reload, are used for translation, and remain isolated by target language", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  await page.locator(".context-panel summary").click();
  await page.getByRole("button", { name: "確認・編集", exact: true }).click();
  await page.getByLabel("話題", { exact: true }).fill("Piについての技術対談");
  await page.getByRole("button", { name: "用語を追加", exact: true }).click();
  await page.getByLabel("原語", { exact: true }).last().fill("Pi");
  await page.getByLabel("訳語・表記", { exact: true }).last().fill("Pi CLI");
  await page.getByRole("button", { name: "保存して固定", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("手動で固定");
  await page.reload();
  await expect(page.getByRole("status")).toContainText("手動で固定");
  await captureAndStop(page);
  await expect(page.locator(".translation-block p")).toContainText("Pi CLI");
  await page.locator(".control-panel select").last().selectOption("en");
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  await page.locator(".control-panel select").last().selectOption("ja");
  await expect(page.getByRole("status")).toContainText("手動で固定");
  await page.locator(".context-panel summary").click();
  await expect(page.locator(".context-glossary")).toContainText("Pi CLI");
  await page.getByRole("button", { name: "自動生成に戻す", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("自動生成済み");
});

test("a conflicting save preserves the draft and allows an explicit retry", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  await page.locator(".context-panel summary").click();
  await page.getByRole("button", { name: "確認・編集", exact: true }).click();
  await page.getByLabel("話題", { exact: true }).fill("保持したい下書き");
  const latest = await (await page.request.get(contextPath())).json();
  await page.request.put(contextPath(), { data: { mode: "manual", expectedVersion: latest.version, hints: { topic: "別の画面からの修正", glossary: [] } } });
  await page.getByRole("button", { name: "保存して固定", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("内容が更新されました");
  await expect(page.getByLabel("話題", { exact: true })).toHaveValue("保持したい下書き");
  await page.getByRole("button", { name: "保存して固定", exact: true }).click();
  await expect(page.locator(".context-topic")).toHaveText("保持したい下書き");
});

test("generation failure is visible/retryable and never disables capture", async ({ page }) => {
  await loadVideo(page, "failVideo01");
  await expect(page.getByRole("status")).toContainText("生成に失敗");
  await expect(page.getByRole("button", { name: "翻訳を開始", exact: true })).toBeEnabled();
  await page.locator(".context-panel summary").click();
  await page.getByRole("button", { name: "再生成", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("自動生成済み");
});

test("a manual edit during generation wins over the background result", async ({ page }) => {
  await loadVideo(page, "slowVideo01");
  await expect(page.getByRole("status")).toContainText("自動生成中");
  await page.locator(".context-panel summary").click();
  await expect(page.locator(".context-metadata")).toContainText("Slow");
  await page.getByRole("button", { name: "確認・編集", exact: true }).click();
  await page.getByLabel("話題", { exact: true }).fill("手動の修正を優先する");
  await page.getByRole("button", { name: "保存して固定", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("手動で固定");
  await page.waitForTimeout(2200);
  await expect(page.locator(".context-topic")).toHaveText("手動の修正を優先する");
});

test("metadata failure still permits translation and learning from real transcripts", async ({ page }) => {
  await loadVideo(page, "noMeta00001");
  await expect(page.getByRole("status")).toContainText("生成に失敗");
  await captureAndStop(page);
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  await page.locator(".context-panel summary").click();
  await expect(page.locator(".context-glossary")).toContainText("Pi");
});

test("mobile and short desktop layouts do not hide the context editor or overflow horizontally", async ({ page }) => {
  await resetAutomatic(page);
  await loadVideo(page);
  await expect(page.getByRole("status")).toContainText("自動生成済み");
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 600 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".context-panel summary").scrollIntoViewIfNeeded();
    await expect(page.locator(".context-panel summary")).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`layout-${viewport.width}x${viewport.height}.png`), fullPage: viewport.width < 780 });
  }
});
