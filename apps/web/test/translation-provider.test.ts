import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@realtime-translate/contracts";
import { translationAuthLabel, translationProviderLabel } from "../src/translation-provider.js";

const base: HealthResponse = {
  ok: true, asrProvider: "disabled", asrReady: false, asrModel: null,
  translationProvider: "disabled", translationSelection: "openai", translationAuthType: null,
  translationReady: false, translationModel: "test", translationMessage: null, protocolVersion: 1,
};
describe("translation connection labels", () => {
  it("does not call an unconfigured Go connection ChatGPT", () => {
    const health = { ...base, translationSelection: "opencode-go" as const };
    expect(translationProviderLabel(health)).toBe("OpenCode Go");
    expect(translationAuthLabel(health)).toBe("認証未設定");
  });
  it("distinguishes OpenAI OAuth from API-key authentication", () => {
    expect(translationProviderLabel({ ...base, translationAuthType: "oauth" })).toBe("ChatGPT (OpenAI)");
    expect(translationAuthLabel({ ...base, translationAuthType: "oauth" })).toBe("OpenAIログイン (OAuth)");
    expect(translationProviderLabel({ ...base, translationAuthType: "api_key" })).toBe("OpenAI");
    expect(translationAuthLabel({ ...base, translationAuthType: "api_key" })).toBe("APIキー");
    expect(translationProviderLabel(null)).toBe("確認中");
  });
});
