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
  /** Proofreading model on the same connection/authentication; null when unsupported (never another model). */
  corrector: ChatGptSubscriptionTranslator | null;
  correctionModel: string;
  correctionIssue: string | null;
}

export const DEFAULT_OPENAI_CORRECTION_MODEL = "gpt-5.6-terra";

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
  correctionModelId: string = DEFAULT_OPENAI_CORRECTION_MODEL,
): Promise<ChatGptTranslatorSetup> {
  const models = createModels({ credentials, authContext: { env: async (name) => env[name], fileExists: async () => false } });
  models.setProvider(openaiProvider());
  const auth = await models.checkAuth("openai").catch(() => undefined);
  if (!auth) return { translator: null, authType: null, corrector: null, correctionModel: correctionModelId, correctionIssue: null };
  const oauth = auth.type === "oauth";
  // One /v1/models request serves both the translation and the correction model.
  const supportedIds = oauth ? await fetchSupportedModelIds(models) : null;
  const model = oauth
    ? await selectSubscriptionModel(models, modelId, supportedIds)
    : models.getModel("openai", modelId);
  if (!model) throw new Error(`Unknown OpenAI translation model: ${modelId}`);
  const provider = oauth ? "chatgpt-subscription" : "openai-api";
  const correction = resolveCorrectionModel(models, correctionModelId, supportedIds);
  return {
    translator: new ChatGptSubscriptionTranslator(models, model, provider),
    authType: auth.type,
    corrector: correction.model ? new ChatGptSubscriptionTranslator(models, correction.model, provider) : null,
    correctionModel: correctionModelId,
    correctionIssue: correction.issue,
  };
}

/** The configured correction model only: no automatic substitution by another model. */
function resolveCorrectionModel(
  models: Models,
  correctionModelId: string,
  supportedIds: ReadonlySet<string> | null,
): { model: Model<Api>; issue: null } | { model: null; issue: string } {
  const catalogModel = models.getModel("openai", correctionModelId);
  if (!catalogModel) {
    return { model: null, issue: `校正モデル${correctionModelId}はインストール済みSDKのカタログにありません。OPENAI_CORRECTION_MODELを確認してください。別のモデルには切り替えません。` };
  }
  if (supportedIds && !supportedIds.has(correctionModelId)) {
    return { model: null, issue: `このOpenAIアカウントでは校正モデル${correctionModelId}を利用できません。OPENAI_CORRECTION_MODELを確認してください。別のモデルには切り替えません。` };
  }
  return { model: catalogModel, issue: null };
}

/** null means "list unavailable": callers use the configured catalog model, as before. */
async function fetchSupportedModelIds(models: Models): Promise<Set<string> | null> {
  try {
    const resolvedAuth = await models.getAuth("openai");
    const token = resolvedAuth?.auth.apiKey;
    if (!token) return null;

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

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
    return supportedIds.size === 0 ? null : supportedIds;
  } catch {
    return null;
  }
}

async function selectSubscriptionModel(models: Models, configuredModelId: string, supportedIds: ReadonlySet<string> | null): Promise<Model<Api> | undefined> {
  if (!supportedIds) return models.getModel("openai", configuredModelId);
  for (const id of [configuredModelId, ...SUBSCRIPTION_MODEL_FALLBACKS]) {
    if (!supportedIds.has(id)) continue;
    const candidate = models.getModel("openai", id);
    if (candidate) return candidate;
  }
  throw new Error("This ChatGPT account did not return a supported translation model");
}

export class ChatGptSubscriptionTranslator extends ModelTranslator {
  constructor(models: Models, model: Model<Api>, provider: "chatgpt-subscription" | "openai-api" = "chatgpt-subscription") {
    super(models, model, provider);
  }
}
