import { getGlmConfig, glmHealthCheck } from "@/lib/glm";
import { handleError, ok } from "@/server/api-helpers";

/** GET: config status (key masked, never returned). POST: connectivity probe. */
export async function GET() {
  try {
    const cfg = getGlmConfig();
    return ok({
      configured: cfg.configured,
      missingEnvVars: cfg.missingEnvVars,
      url: cfg.url || null,
      model: cfg.model || null,
      apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-3)}` : null,
      docs: ["https://docs.z.ai/api-reference/llm/chat-completion"],
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST() {
  try {
    const result = await glmHealthCheck();
    return ok({ health: result });
  } catch (e) {
    return handleError(e);
  }
}
