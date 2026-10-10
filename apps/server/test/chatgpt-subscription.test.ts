import { describe, expect, it, vi } from "vitest";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { ChatGptSubscriptionTranslator } from "../src/providers/chatgpt-subscription.js";

describe("ChatGptSubscriptionTranslator", () => {
  it("returns text from the subscription model and forwards the session id", async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "こんにちは" }],
    });
    const models = { completeSimple } as unknown as Models;
    const model = { id: "gpt-6-luna" } as Model<Api>;
    const translator = new ChatGptSubscriptionTranslator(models, model);

    const result = await translator.translate({
      sessionId: "session-1",
      text: "Hello",
      sourceLanguage: "en",
      targetLanguage: "ja",
      context: [{ sourceText: "We use Durable Objects.", translatedText: "Durable Objectsを使用します。" }],
    }, AbortSignal.timeout(1_000));

    expect(result.text).toBe("こんにちは");
    const prompt = JSON.parse(completeSimple.mock.calls[0]?.[1]?.messages[0]?.content as string) as {
      recentContext: Array<{ source: string }>;
      currentTranscript: string;
    };
    expect(prompt.currentTranscript).toBe("Hello");
    expect(prompt.recentContext[0]?.source).toContain("Durable Objects");
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      reasoning: "low",
      sessionId: "session-1",
    });
  });
});
