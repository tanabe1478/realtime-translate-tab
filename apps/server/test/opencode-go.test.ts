import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeGoTranslator } from "../src/providers/opencode-go.js";

const key = "test-opencode-secret-not-a-real-key";
const translation = { sessionId: "session-1", text: "Pi supports tool calling.", sourceLanguage: "en", targetLanguage: "ja", context: [] };
const context = { videoId: "HDdbU10r7Js", targetLanguage: "ja", metadata: { title: "Pi coding agent", authorName: "Armin" }, previous: { topic: "", glossary: [] }, transcripts: ["Pi supports tool calling."] };
const hints = { topic: "コーディングエージェント", glossary: [{ term: "Pi", translation: "Pi", note: "製品名" }] };

afterEach(() => vi.unstubAllGlobals());

function stream(text: string, finish = "stop") {
  const chunk = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "glm-5.3-flash", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: finish }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
function mockFetch(responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request: automatic retries/fallbacks are forbidden");
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return { requests, fetch };
}

describe("OpenCode Go adapter (real SDK, mocked HTTP only)", () => {
  it("uses the documented endpoint, bearer key, honest user agent and stable conversation headers for both operations", async () => {
    const { requests } = mockFetch([stream("Piはツール呼び出しに対応します。"), stream(JSON.stringify(hints)), stream(JSON.stringify(hints))]);
    const translator = createOpenCodeGoTranslator(key)!;
    expect(translator.provider).toBe("opencode-go");
    expect(translator.model).toBe("glm-5.3-flash");
    expect(await translator.translate(translation, AbortSignal.timeout(2000))).toEqual({ text: "Piはツール呼び出しに対応します。" });
    expect(await translator.generateContext(context, AbortSignal.timeout(2000))).toEqual(hints);
    await translator.generateContext({ ...context, transcripts: ["Pi uses tools."] }, AbortSignal.timeout(2000));
    for (const request of requests) {
      expect(request.url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      expect(request.headers.get("user-agent")).toBe("realtime-translate-tab/0.1.0");
    }
    expect(requests[0]!.headers.get("x-opencode-session")).toBe("session-1");
    expect(requests[1]!.headers.get("x-opencode-session")).toBe("video-context:HDdbU10r7Js:ja");
    expect(requests[2]!.headers.get("x-opencode-session")).toBe(requests[1]!.headers.get("x-opencode-session"));
    const body = await requests[0]!.json();
    expect(body).toMatchObject({ model: "glm-5.3-flash", max_tokens: 8000, reasoning_effort: "low", stream: true });
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.messages[1].content).currentTranscript).toBe(translation.text);
  });

  it.each([401, 403, 429, 500])("reports HTTP %s without leaking keys/provider bodies or trying OpenAI", async (status) => {
    const { fetch } = mockFetch([new Response(JSON.stringify({ error: { message: `Bearer ${key} PRIVATE_RESPONSE` } }), { status, headers: { "Content-Type": "application/json" } })]);
    const translator = createOpenCodeGoTranslator(key)!;
    let message = "";
    try { await translator.translate(translation, AbortSignal.timeout(2000)); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("OpenCode Go");
    expect(message).toContain("切り替えません");
    expect(message).not.toContain(key);
    expect(message).not.toContain("PRIVATE_RESPONSE");
    if (status === 401) expect(message).toContain("認証");
    if (status === 403) expect(message).toContain("利用条件");
    if (status === 429) expect(message).toContain("利用枠");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds requests with cancellation and safe errors", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal).toBeDefined();
      throw new DOMException("PRIVATE_RESPONSE", "AbortError");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createOpenCodeGoTranslator(key)!.translate(translation, controller.signal)).rejects.toThrow(/中断|タイムアウト/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, truncated and empty output", async () => {
    mockFetch([stream("not JSON PRIVATE_RESPONSE"), stream("not JSON AGAIN"), stream(JSON.stringify(hints), "length"), stream("")]);
    const translator = createOpenCodeGoTranslator(key)!;
    await expect(translator.generateContext(context, AbortSignal.timeout(2000))).rejects.toThrow("JSON");
    await expect(translator.generateContext(context, AbortSignal.timeout(2000))).rejects.toThrow("出力上限");
    await expect(translator.translate(translation, AbortSignal.timeout(2000))).rejects.toThrow("空の応答");
  });

  it("does not use an ambient key and rejects unknown configured models", () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(createOpenCodeGoTranslator(undefined)).toBeNull();
    expect(createOpenCodeGoTranslator("   ")).toBeNull();
    expect(() => createOpenCodeGoTranslator(key, "not-a-model")).toThrow("OPENCODE_TRANSLATE_MODEL");
  });
});
