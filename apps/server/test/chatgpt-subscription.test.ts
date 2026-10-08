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
    }, AbortSignal.timeout(1_000));

    expect(result.text).toBe("こんにちは");
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      reasoning: "low",
      sessionId: "session-1",
    });
  });
});
