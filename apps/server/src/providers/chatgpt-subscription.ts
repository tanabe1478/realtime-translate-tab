import {
  createModels,
  type Api,
  type CredentialStore,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ModelTranslator } from "./model-translator.js";

export interface ChatGptTranslatorSetup {
  translator: ChatGptSubscriptionTranslator | null;
  authType: "oauth" | "api_key" | null;
}

const SUBSCRIPTION_MODEL_FALLBACKS = [
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
] as const;

export async function createChatGptTranslator(
  credentials: CredentialStore,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatGptTranslatorSetup> {
  const models = createModels({ credentials, authContext: { env: async (name) => env[name], fileExists: async () => false } });
  models.setProvider(openaiProvider());
  const auth = await models.checkAuth("openai").catch(() => undefined);
  if (!auth) return { translator: null, authType: null };
  const model = auth.type === "oauth"
    ? await selectSubscriptionModel(models, modelId)
    : models.getModel("openai", modelId);
  if (!model) throw new Error(`Unknown OpenAI translation model: ${modelId}`);
  return {
    translator: new ChatGptSubscriptionTranslator(models, model, auth.type === "oauth" ? "chatgpt-subscription" : "openai-api"),
    authType: auth.type,
  };
}

async function selectSubscriptionModel(models: Models, configuredModelId: string): Promise<Model<Api> | undefined> {
  try {
    const resolvedAuth = await models.getAuth("openai");
    const token = resolvedAuth?.auth.apiKey;
    if (!token) return models.getModel("openai", configuredModelId);

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return models.getModel("openai", configuredModelId);

    const body = await response.json() as {
      models?: Array<{ slug?: unknown; supported_in_api?: unknown }>;
      data?: Array<{ id?: unknown }>;
    };
    const supportedIds = new Set<string>();
    for (const entry of body.models ?? []) {
      if (typeof entry.slug === "string" && entry.supported_in_api !== false) supportedIds.add(entry.slug);
    }
    for (const entry of body.data ?? []) {
      if (typeof entry.id === "string") supportedIds.add(entry.id);
    }
    if (supportedIds.size === 0) return models.getModel("openai", configuredModelId);

    for (const id of [configuredModelId, ...SUBSCRIPTION_MODEL_FALLBACKS]) {
      if (!supportedIds.has(id)) continue;
      const candidate = models.getModel("openai", id);
      if (candidate) return candidate;
    }
    throw new Error("This ChatGPT account did not return a supported translation model");
  } catch (error) {
    if (error instanceof Error && error.message.includes("did not return")) throw error;
    return models.getModel("openai", configuredModelId);
  }
}

export class ChatGptSubscriptionTranslator extends ModelTranslator {
  constructor(models: Models, model: Model<Api>, provider: "chatgpt-subscription" | "openai-api" = "chatgpt-subscription") {
    super(models, model, provider);
  }
}
