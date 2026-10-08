import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonCredentialStore } from "../src/credential-store.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("JsonCredentialStore", () => {
  it("persists OAuth credentials without exposing secrets from list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rt-auth-"));
    temporaryDirectories.push(directory);
    const store = new JsonCredentialStore(join(directory, "auth.json"));
    await store.modify("openai", async () => ({
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    }));

    expect((await store.read("openai"))?.type).toBe("oauth");
    expect(await store.list()).toEqual([{ providerId: "openai", type: "oauth" }]);

    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
  });
});
