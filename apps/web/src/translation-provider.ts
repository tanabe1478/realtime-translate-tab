import type { HealthResponse } from "@realtime-translate/contracts";

export function translationProviderLabel(health: HealthResponse | null): string {
  if (!health) return "確認中";
  if (health.translationSelection === "opencode-go") return "OpenCode Go";
  return health.translationAuthType === "oauth" ? "ChatGPT (OpenAI)" : "OpenAI";
}

export function translationAuthLabel(health: HealthResponse | null): string {
  if (!health) return "確認中";
  return health.translationAuthType === "oauth" ? "OpenAIログイン (OAuth)"
    : health.translationAuthType === "api_key" ? "APIキー" : "認証未設定";
}
