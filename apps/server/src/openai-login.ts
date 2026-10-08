import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createModels, type AuthInteraction, type AuthPrompt } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { JsonCredentialStore } from "./credential-store.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../../..");
const dataRoot = join(repositoryRoot, "data");
const credentials = new JsonCredentialStore(join(dataRoot, "auth.json"));
const models = createModels({ credentials });
models.setProvider(openaiProvider());
const readline = createInterface({ input, output });

const interaction: AuthInteraction = {
  notify(event) {
    if (event.type === "auth_url") {
      console.log("\nブラウザで次のURLを開き、ChatGPTへサインインしてください:\n");
      console.log(event.url);
      if (event.instructions) console.log(`\n${event.instructions}`);
    } else if (event.type === "device_code") {
      console.log(`\n${event.verificationUri}\nコード: ${event.userCode}`);
    } else if (event.type === "progress" || event.type === "info") {
      console.log(event.message);
      if (event.type === "info") for (const link of event.links ?? []) console.log(`${link.label ?? "詳細"}: ${link.url}`);
    }
  },
  prompt(prompt) {
    return promptUser(prompt);
  },
};

try {
  console.log("ChatGPT subscription OAuthを開始します。APIキーは不要です。");
  const deviceId = await getDeviceId();
  await models.login("openai", "oauth", interaction, { getDeviceId: () => deviceId });
  console.log("\nログインに成功しました。`pnpm dev:local`でアプリを起動できます。");
} catch (error) {
  console.error(`\nログインに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  readline.close();
}

async function promptUser(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
    const answer = await readline.question("> ", { signal: prompt.signal });
    const index = Number(answer) - 1;
    return prompt.options[index]?.id ?? answer.trim();
  }
  return readline.question(`\n${prompt.message}\n> `, { signal: prompt.signal });
}

async function getDeviceId(): Promise<string> {
  const path = join(dataRoot, "device-id");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dataRoot, { recursive: true });
    const id = randomUUID();
    await writeFile(path, `${id}\n`, { encoding: "utf8", mode: 0o600 });
    return id;
  }
}
