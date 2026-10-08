import { join } from "node:path";
import { JsonCredentialStore } from "../credential-store.js";
import { createChatGptTranslator } from "./chatgpt-subscription.js";
import { LocalWhisperRecognizer } from "./local-whisper.js";
import type { SpeechRecognizer, Translator } from "./types.js";

export interface Providers {
  recognizer: SpeechRecognizer | null;
  translator: Translator | null;
  translationAuthType: "oauth" | "api_key" | null;
}

export async function createProviders(env: NodeJS.ProcessEnv, dataRoot: string): Promise<Providers> {
  const whisperUrl = env.WHISPER_URL === "disabled" ? null : (env.WHISPER_URL || "http://127.0.0.1:8790");
  const recognizer = whisperUrl
    ? new LocalWhisperRecognizer(whisperUrl.replace(/\/$/, ""), env.WHISPER_MODEL || "small")
    : null;

  const credentials = new JsonCredentialStore(join(dataRoot, "auth.json"));
  const chatGpt = await createChatGptTranslator(credentials, env.OPENAI_TRANSLATE_MODEL || "gpt-6-luna");
  return {
    recognizer,
    translator: chatGpt.translator,
    translationAuthType: chatGpt.authType,
  };
}

export type { SpeechRecognizer, Translator } from "./types.js";
