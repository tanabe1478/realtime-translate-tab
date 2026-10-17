import { createModels } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { ModelTranslator } from "./model-translator.js";

export const DEFAULT_OPENCODE_MODEL = "glm-5.3-flash";

/**
 * Endpoints verified against OpenCode's official Go documentation:
 * https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/go.mdx
 * No stored OpenAI credential or ambient API key is consulted here.
 */
export function createOpenCodeGoTranslator(apiKey: string | undefined, modelId = DEFAULT_OPENCODE_MODEL): ModelTranslator | null {
  const key = apiKey?.trim();
  if (!key) return null;
  const models = createModels({ authContext: {
    env: async (name) => name === "OPENCODE_API_KEY" ? key : undefined,
    fileExists: async () => false,
  } });
  models.setProvider(opencodeGoProvider());
  const catalogModel = models.getModel("opencode-go", modelId);
  if (!catalogModel) throw new Error("Unknown OPENCODE_TRANSLATE_MODEL. Choose an OpenCode Go model supported by the installed catalog.");
  const baseUrl = catalogModel.api === "anthropic-messages"
    ? "https://opencode.ai/inference/go/anthropic"
    : "https://opencode.ai/inference/go/openai/v1";
  // The bundled SDK catalog still contains legacy /zen/go URLs. Use the
  // current documented endpoint, keeping API/auth/compatibility model-specific.
  return new ModelTranslator(models, { ...catalogModel, baseUrl }, "opencode-go");
}
