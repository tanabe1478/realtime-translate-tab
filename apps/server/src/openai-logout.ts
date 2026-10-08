import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { JsonCredentialStore } from "./credential-store.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../../..");
const models = createModels({ credentials: new JsonCredentialStore(join(repositoryRoot, "data", "auth.json")) });
models.setProvider(openaiProvider());
await models.logout("openai");
console.log("ChatGPTからログアウトしました。");
