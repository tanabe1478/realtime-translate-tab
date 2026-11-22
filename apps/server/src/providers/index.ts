import { join } from "node:path";
import { JsonCredentialStore } from "../credential-store.js";
import { createChatGptTranslator } from "./chatgpt-subscription.js";
import { LocalWhisperRecognizer } from "./local-whisper.js";
import type { ContextGenerator, SpeechRecognizer, Translator } from "./types.js";
import { createOpenCodeGoTranslator, DEFAULT_OPENCODE_MODEL } from "./opencode-go.js";
import type { TranslationProviderChoice } from "@realtime-translate/contracts";

export interface Providers {
  recognizer: SpeechRecognizer | null;
  translator: Translator | null;
  contextGenerator: ContextGenerator | null;
  translationAuthType: "oauth" | "api_key" | null;
  translationSelection: TranslationProviderChoice;
  translationModel: string;
  translationIssue: string | null;
}

export async function createProviders(env: NodeJS.ProcessEnv, dataRoot: string): Promise<Providers> {
  const whisperUrl = env.WHISPER_URL === "disabled" ? null : (env.WHISPER_URL || "http://127.0.0.1:8790");
  const recognizer = whisperUrl
    ? new LocalWhisperRecognizer(whisperUrl.replace(/\/$/, ""), env.WHISPER_MODEL || "small")
    : null;

  const selection = env.TRANSLATION_PROVIDER?.trim() || "openai";
  if (selection !== "openai" && selection !== "opencode-go") {
    throw new Error("TRANSLATION_PROVIDER must be openai or opencode-go; refusing to select another provider automatically.");
  }
  if (selection === "opencode-go") {
    const model = env.OPENCODE_TRANSLATE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;
    const translator = createOpenCodeGoTranslator(env.OPENCODE_API_KEY, model);
    return {
      recognizer, translator, contextGenerator: translator,
      translationSelection: selection, translationModel: model,
      translationAuthType: translator ? "api_key" : null,
      translationIssue: translator ? null : "OpenCode GoのAPIキーが未設定です。.envのOPENCODE_API_KEYを設定してサーバーを再起動してください。OpenAIには切り替えません。",
    };
  }
  const credentials = new JsonCredentialStore(join(dataRoot, "auth.json"));
  const model = env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-6-luna";
  const chatGpt = await createChatGptTranslator(credentials, model, env);
  return {
    recognizer,
    translator: chatGpt.translator,
    contextGenerator: chatGpt.translator,
    translationAuthType: chatGpt.authType,
    translationSelection: selection,
    translationModel: chatGpt.translator?.model ?? model,
    translationIssue: chatGpt.translator ? null : "OpenAIの認証が未設定です。`pnpm auth:openai`でログインするかOPENAI_API_KEYを設定して、サーバーを再起動してください。OpenCode Goには切り替えません。",
  };
}

export type { SpeechRecognizer, Translator } from "./types.js";
