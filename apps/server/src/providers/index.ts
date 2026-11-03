import { join } from "node:path";
import { JsonCredentialStore } from "../credential-store.js";
import { createChatGptTranslator, DEFAULT_OPENAI_CORRECTION_MODEL } from "./chatgpt-subscription.js";
import { LocalWhisperRecognizer } from "./local-whisper.js";
import type { ContextGenerator, SpeechRecognizer, TranscriptCorrector, Translator } from "./types.js";
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
  /** AI proofreading uses the selected translation connection and authentication. */
  corrector: TranscriptCorrector | null;
  correctionModel: string;
  correctionIssue: string | null;
}

const OPENAI_AUTH_ISSUE = "OpenAIの認証が未設定です。`pnpm auth:openai`でログインするかOPENAI_API_KEYを設定して、サーバーを再起動してください。OpenCode Goには切り替えません。";

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
    const correctionModel = env.OPENCODE_CORRECTION_MODEL?.trim() || model;
    let corrector: TranscriptCorrector | null = null;
    let correctionIssue: string | null = null;
    if (!translator) {
      correctionIssue = "OpenCode GoのAPIキーが未設定です。.envのOPENCODE_API_KEYを設定してサーバーを再起動してください。OpenAIには切り替えません。";
    } else if (correctionModel === model) {
      corrector = translator;
    } else {
      try {
        corrector = createOpenCodeGoTranslator(env.OPENCODE_API_KEY, correctionModel, "OPENCODE_CORRECTION_MODEL");
      } catch {
        correctionIssue = `校正モデル${correctionModel}はOpenCode Goのカタログにありません。OPENCODE_CORRECTION_MODELを確認してください。別のモデルには切り替えません。`;
      }
    }
    return {
      recognizer, translator, contextGenerator: translator,
      translationSelection: selection, translationModel: model,
      corrector, correctionModel, correctionIssue,
      translationAuthType: translator ? "api_key" : null,
      translationIssue: translator ? null : "OpenCode GoのAPIキーが未設定です。.envのOPENCODE_API_KEYを設定してサーバーを再起動してください。OpenAIには切り替えません。",
    };
  }
  const credentials = new JsonCredentialStore(join(dataRoot, "auth.json"));
  const model = env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-6-luna";
  const chatGpt = await createChatGptTranslator(credentials, model, env, env.OPENAI_CORRECTION_MODEL?.trim() || DEFAULT_OPENAI_CORRECTION_MODEL);
  return {
    recognizer,
    translator: chatGpt.translator,
    contextGenerator: chatGpt.translator,
    translationAuthType: chatGpt.authType,
    translationSelection: selection,
    translationModel: chatGpt.translator?.model ?? model,
    corrector: chatGpt.corrector,
    correctionModel: chatGpt.corrector?.model ?? chatGpt.correctionModel,
    correctionIssue: chatGpt.corrector ? null : chatGpt.correctionIssue ?? OPENAI_AUTH_ISSUE,
    translationIssue: chatGpt.translator ? null : OPENAI_AUTH_ISSUE,
  };
}

export type { SpeechRecognizer, TranscriptCorrector, Translator } from "./types.js";
