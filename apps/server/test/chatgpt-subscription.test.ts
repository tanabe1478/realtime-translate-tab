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

  describe("correctBatch", () => {
    const input = {
      sessionId: "session-1", title: "ポッドキャスト47", language: "ja", recentContext: ["前の発話です。"],
      items: [{ id: "1", text: "イスコンの話をします。" }, { id: "2", text: "つぎにすすみます。" }],
    };
    const answer = { items: [{ id: "1", text: "ISUCONの話をします。" }, { id: "2", text: "次に進みます。" }] };
    function translatorReturning(text: string, stopReason = "stop") {
      const completeSimple = vi.fn().mockResolvedValue({ stopReason, content: [{ type: "text", text }] });
      return { completeSimple, translator: new ChatGptSubscriptionTranslator({ completeSimple } as unknown as Models, { id: "gpt-5.6-terra" } as Model<Api>) };
    }

    it("sends title, recent context and the items, and returns the proofread items", async () => {
      const { completeSimple, translator } = translatorReturning(JSON.stringify(answer));
      expect(translator.model).toBe("gpt-5.6-terra");
      await expect(translator.correctBatch(input, AbortSignal.timeout(1_000))).resolves.toEqual(answer);
      const [, context, options] = completeSimple.mock.calls[0]!;
      expect(JSON.parse(context.messages[0].content as string)).toEqual({ title: "ポッドキャスト47", recentContext: ["前の発話です。"], items: input.items });
      expect(context.systemPrompt).toMatch(/proofreader/i);
      expect(context.systemPrompt).toMatch(/fillers/);
      expect(context.systemPrompt).toMatch(/untrusted/);
      expect(context.systemPrompt).toMatch(/Do not summarize, paraphrase, reorder, translate, add or delete/);
      expect(context.systemPrompt).toMatch(/independent utterance/);
      expect(context.systemPrompt).toMatch(/never move, merge, split or reorder sentences between items/);
      expect(context.systemPrompt).toContain('{"items":[{"id":"1","text":"proofread text"}]}');
      expect(context.systemPrompt).toMatch(/Numbers, version numbers, model names, product names and model numbers/);
      expect(context.systemPrompt).toMatch(/never replace them with another name or another version/);
      expect(context.systemPrompt).toMatch(/Never replace a katakana word or abbreviation you do not understand with another proper noun/);
      expect(context.systemPrompt).toMatch(/title, recentContext or another item of the same batch gives evidence/);
      expect(context.systemPrompt).toMatch(/start or end in the middle of a sentence/);
      expect(context.systemPrompt).toMatch(/never move, merge or split sentences or words across item boundaries/);
      expect(context.systemPrompt).toMatch(/only content that is in that item's original text/);
      expect(context.systemPrompt).toMatch(/Do not add speaker names or speaker labels/);
      expect(options).toMatchObject({ reasoning: "low", sessionId: "session-1", maxRetries: 0 });
      expect(options.maxTokens).toBeUndefined();
    });

    it("accepts JSON wrapped in a markdown fence and drops malformed entries", async () => {
      const { translator } = translatorReturning("```json\n" + JSON.stringify({ items: [{ id: 1, text: "A" }, { id: "2" }, "x", null, { id: "3", text: "C" }] }) + "\n```");
      await expect(translator.correctBatch(input, AbortSignal.timeout(1_000))).resolves.toEqual({ items: [{ id: "1", text: "A" }, { id: "3", text: "C" }] });
    });

    it("limits the context to the latest six entries of at most 1500 characters", async () => {
      const { completeSimple, translator } = translatorReturning(JSON.stringify(answer));
      await translator.correctBatch({ ...input, recentContext: Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(2_000, "あ")) }, AbortSignal.timeout(1_000));
      const payload = JSON.parse(completeSimple.mock.calls[0]![1].messages[0].content as string) as { recentContext: string[] };
      expect(payload.recentContext).toHaveLength(6);
      expect(payload.recentContext.every((entry) => entry.length === 1_500)).toBe(true);
    });

    it.each([
      ["empty", "   ", "stop", "校正モデルが空の応答"],
      ["not JSON", "ISUCONの話をします。", "stop", "校正モデルの応答が正しいJSON形式ではありません"],
      ["JSON without an items array", JSON.stringify({ items: "x" }), "stop", "校正モデルの応答が正しいJSON形式ではありません"],
      ["a bare array", JSON.stringify(answer.items), "stop", "校正モデルの応答が正しいJSON形式ではありません"],
      ["truncated", JSON.stringify(answer), "length", "校正モデルの出力上限に達しました"],
    ])("fails the whole batch for a %s response", async (_label, text, stopReason, message) => {
      const { translator } = translatorReturning(text, stopReason);
      await expect(translator.correctBatch(input, AbortSignal.timeout(1_000))).rejects.toThrow(message);
    });

    it("does not echo the model output in the JSON error", async () => {
      const { translator } = translatorReturning("PRIVATE_RESPONSE");
      const error = await translator.correctBatch(input, AbortSignal.timeout(1_000)).catch((caught: Error) => caught);
      expect((error as Error).message).not.toContain("PRIVATE");
    });

    it("keeps the translation wording for translation errors", async () => {
      const { translator } = translatorReturning("", "length");
      await expect(translator.translate({ sessionId: "s", text: "Hello", sourceLanguage: "en", targetLanguage: "ja", context: [] }, AbortSignal.timeout(1_000))).rejects.toThrow("翻訳モデルの出力上限");
    });

    it("reports provider failures without leaking the provider message", async () => {
      const completeSimple = vi.fn().mockResolvedValue({ stopReason: "error", content: [], errorMessage: "429 quota Bearer secret PRIVATE" });
      const translator = new ChatGptSubscriptionTranslator({ completeSimple } as unknown as Models, { id: "gpt-5.6-terra" } as Model<Api>);
      const error = await translator.correctBatch(input, AbortSignal.timeout(1_000)).catch((caught: Error) => caught);
      expect((error as Error).message).toContain("利用枠");
      expect((error as Error).message).not.toContain("PRIVATE");
    });
  });
});
