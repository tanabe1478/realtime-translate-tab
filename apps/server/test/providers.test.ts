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
