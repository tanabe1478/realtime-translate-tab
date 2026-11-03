import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviders } from "../src/providers/index.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rt-providers-")); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network allowed in configuration tests"))); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("explicit translation provider selection", () => {
  it("preserves the existing OpenAI default even when a Go key is present", async () => {
    const providers = await createProviders({ WHISPER_URL: "disabled", OPENCODE_API_KEY: "test-go-key" }, directory);
    expect(providers.translationSelection).toBe("openai");
    expect(providers.translator).toBeNull();
    expect(providers.translationIssue).toContain("OpenAI");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses Go for translation AND context, without reading or changing stored OpenAI credentials", async () => {
    // Invalid JSON is intentional: selecting Go must never consult this file.
    const original = "untouched private OpenAI credentials";
    writeFileSync(join(directory, "auth.json"), original);
    const providers = await createProviders({ WHISPER_URL: "disabled", TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-go-key" }, directory);
    expect(providers.translationSelection).toBe("opencode-go");
    expect(providers.translator?.provider).toBe("opencode-go");
    expect(providers.translationModel).toBe("glm-5.3-flash");
    expect(providers.contextGenerator).toBe(providers.translator);
    expect(providers.translationAuthType).toBe("api_key");
    expect(providers.translationIssue).toBeNull();
    expect(readFileSync(join(directory, "auth.json"), "utf8")).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not fall back to an available OpenAI API key when Go is missing", async () => {
    const providers = await createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENAI_API_KEY: "test-openai-key" }, directory);
    expect(providers.translator).toBeNull();
    expect(providers.contextGenerator).toBeNull();
    expect(providers.translationIssue).toContain("OPENCODE_API_KEY");
    expect(providers.translationModel).toBe("glm-5.3-flash");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps OpenAI API-key authentication available and records it accurately", async () => {
    const providers = await createProviders({ TRANSLATION_PROVIDER: "openai", OPENAI_API_KEY: "test-openai-key" }, directory);
    expect(providers.translator?.provider).toBe("openai-api");
    expect(providers.translationAuthType).toBe("api_key");
    expect(providers.contextGenerator).toBe(providers.translator);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps OAuth credentials and does not use Go on OAuth errors", async () => {
    const credentials = JSON.stringify({ version: 1, credentials: { openai: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000 } } });
    writeFileSync(join(directory, "auth.json"), credentials);
    const providers = await createProviders({ TRANSLATION_PROVIDER: "openai", OPENCODE_API_KEY: "test-go-key" }, directory);
    expect(providers.translator?.provider).toBe("chatgpt-subscription");
    expect(providers.translationAuthType).toBe("oauth");
    expect(readFileSync(join(directory, "auth.json"), "utf8")).toBe(credentials);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
  });
  it("accepts a different explicit Go model and rejects typos instead of falling back", async () => {
    const providers = await createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-key", OPENCODE_TRANSLATE_MODEL: "glm-5.3" }, directory);
    expect(providers.translator?.model).toBe("glm-5.3");
    await expect(createProviders({ TRANSLATION_PROVIDER: "opencode" }, directory)).rejects.toThrow("TRANSLATION_PROVIDER");
    await expect(createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-key", OPENCODE_TRANSLATE_MODEL: "bad-model" }, directory)).rejects.toThrow("OPENCODE_TRANSLATE_MODEL");
  });
  it("uses only the supplied environment, not ambient keys from a different process/configuration", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "ambient-go-key");
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
    expect((await createProviders({ TRANSLATION_PROVIDER: "opencode-go" }, directory)).translator).toBeNull();
    expect((await createProviders({ TRANSLATION_PROVIDER: "openai" }, directory)).translator).toBeNull();
  });
});

describe("correction model resolution", () => {
  const oauth = () => JSON.stringify({ version: 1, credentials: { openai: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000 } } });
  const modelsResponse = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("defaults OpenAI correction to gpt-5.6-terra and honors OPENAI_CORRECTION_MODEL", async () => {
    const defaults = await createProviders({ OPENAI_API_KEY: "test-openai-key" }, directory);
    expect(defaults.corrector?.model).toBe("gpt-5.6-terra");
    expect(defaults.correctionModel).toBe("gpt-5.6-terra");
    expect(defaults.correctionIssue).toBeNull();
    expect(defaults.corrector).not.toBe(defaults.translator);
    expect(defaults.translationModel).toBe("gpt-6-luna");
    const custom = await createProviders({ OPENAI_API_KEY: "test-openai-key", OPENAI_CORRECTION_MODEL: " gpt-5.6-sol " }, directory);
    expect(custom.corrector?.model).toBe("gpt-5.6-sol");
    expect(custom.translator?.provider).toBe("openai-api");
    expect(custom.corrector?.provider).toBe("openai-api");
  });

  it("reuses one /v1/models request for translation and correction with ChatGPT login", async () => {
    writeFileSync(join(directory, "auth.json"), oauth());
    vi.mocked(fetch).mockResolvedValue(modelsResponse("gpt-6-luna", "gpt-5.6-terra"));
    const providers = await createProviders({ TRANSLATION_PROVIDER: "openai" }, directory);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(providers.translationModel).toBe("gpt-6-luna");
    expect(providers.corrector?.provider).toBe("chatgpt-subscription");
    expect(providers.corrector?.model).toBe("gpt-5.6-terra");
    expect(providers.correctionIssue).toBeNull();
  });

  it("does not fall back to another model when the account lacks the correction model, but still translates", async () => {
    writeFileSync(join(directory, "auth.json"), oauth());
    vi.mocked(fetch).mockResolvedValue(modelsResponse("gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"));
    const providers = await createProviders({ TRANSLATION_PROVIDER: "openai" }, directory);
    expect(providers.translator?.model).toBe("gpt-6-luna");
    expect(providers.corrector).toBeNull();
    expect(providers.correctionModel).toBe("gpt-5.6-terra");
    expect(providers.correctionIssue).toContain("gpt-5.6-terra");
    expect(providers.correctionIssue).toContain("OPENAI_CORRECTION_MODEL");
  });

  it("does not change the translation fallback when the correction model is unsupported", async () => {
    writeFileSync(join(directory, "auth.json"), oauth());
    vi.mocked(fetch).mockResolvedValue(modelsResponse("gpt-6-sol"));
    const providers = await createProviders({ TRANSLATION_PROVIDER: "openai" }, directory);
    expect(providers.translator?.model).toBe("gpt-6-sol");
    expect(providers.corrector).toBeNull();
  });

  it("does not use a model that the SDK catalog does not know", async () => {
    const providers = await createProviders({ OPENAI_API_KEY: "test-openai-key", OPENAI_CORRECTION_MODEL: "no-such-model" }, directory);
    expect(providers.translator).not.toBeNull();
    expect(providers.corrector).toBeNull();
    expect(providers.correctionModel).toBe("no-such-model");
    expect(providers.correctionIssue).toContain("no-such-model");
  });

  it("explains missing OpenAI authentication for correction too", async () => {
    const providers = await createProviders({}, directory);
    expect(providers.corrector).toBeNull();
    expect(providers.correctionIssue).toContain("OpenAI");
  });

  it("defaults OpenCode Go correction to the translation model and accepts OPENCODE_CORRECTION_MODEL", async () => {
    const same = await createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-go-key", OPENCODE_TRANSLATE_MODEL: "glm-5.3" }, directory);
    expect(same.corrector?.provider).toBe("opencode-go");
    expect(same.corrector?.model).toBe("glm-5.3");
    expect(same.correctionModel).toBe("glm-5.3");
    const other = await createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-go-key", OPENCODE_CORRECTION_MODEL: "glm-5.3" }, directory);
    expect(other.translator?.model).toBe("glm-5.3-flash");
    expect(other.corrector?.model).toBe("glm-5.3");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unknown OpenCode Go correction model without falling back or breaking translation", async () => {
    const providers = await createProviders({ TRANSLATION_PROVIDER: "opencode-go", OPENCODE_API_KEY: "test-go-key", OPENCODE_CORRECTION_MODEL: "bad-model" }, directory);
    expect(providers.translator?.model).toBe("glm-5.3-flash");
    expect(providers.corrector).toBeNull();
    expect(providers.correctionIssue).toContain("bad-model");
    const missingKey = await createProviders({ TRANSLATION_PROVIDER: "opencode-go" }, directory);
    expect(missingKey.corrector).toBeNull();
    expect(missingKey.correctionIssue).toContain("OPENCODE_API_KEY");
  });
});

