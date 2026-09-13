// Server-only GLM client for the CommandCode OpenAI-compatible endpoint.
//
// SECURITY RULES (enforced by convention + this file being the ONLY place the
// key is read):
//  - the API key is read exclusively from env (COMMANDCODE_API_KEY)
//  - it must never appear in client bundles, logs, README, screenshots or git
//  - the key visible in any chat history MUST be revoked by the user and
//    replaced with a new one; see README "安全提醒"
//
// The client does plain JSON Chat Completions over fetch with a hard timeout.
// The URL is used EXACTLY as configured (no path re-writing), so a full
// `.../v1/chat/completions` address works without double-appending.
// Streaming/tool-calls are intentionally NOT used until verified.

import "server-only";

export interface GlmConfig {
  url: string;
  model: string;
  apiKey: string | null;
  configured: boolean;
  missingEnvVars: string[];
}

export function getGlmConfig(): GlmConfig {
  const url = process.env.COMMANDCODE_CHAT_URL ?? "";
  const model = process.env.COMMANDCODE_MODEL ?? "";
  const apiKey = process.env.COMMANDCODE_API_KEY ?? null;
  const missingEnvVars: string[] = [];
  if (!url) missingEnvVars.push("COMMANDCODE_CHAT_URL");
  if (!model) missingEnvVars.push("COMMANDCODE_MODEL");
  if (!apiKey) missingEnvVars.push("COMMANDCODE_API_KEY");
  return { url, model, apiKey, configured: missingEnvVars.length === 0, missingEnvVars };
}

export type GlmErrorCode =
  | "GLM_NOT_CONFIGURED"
  | "GLM_HTTP_ERROR"
  | "GLM_TIMEOUT"
  | "GLM_BAD_RESPONSE"
  | "GLM_RATE_LIMIT";

export interface GlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GlmResult {
  ok: boolean;
  content: string | null;
  error: { code: GlmErrorCode; message: string } | null;
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** One non-streaming chat completion. Never throws — returns structured errors. */
export async function glmChat(messages: GlmMessage[], opts: { timeoutMs?: number; temperature?: number; maxTokens?: number } = {}): Promise<GlmResult> {
  const cfg = getGlmConfig();
  const started = Date.now();
  if (!cfg.configured) {
    return {
      ok: false,
      content: null,
      error: { code: "GLM_NOT_CONFIGURED", message: `AI 功能未配置：缺少环境变量 ${cfg.missingEnvVars.join(", ")}` },
      elapsedMs: 0,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 700,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const code: GlmErrorCode = res.status === 429 ? "GLM_RATE_LIMIT" : "GLM_HTTP_ERROR";
      // Never echo the request body (contains the key in headers only, but be safe).
      return {
        ok: false,
        content: null,
        error: { code, message: `CommandCode 接口返回 HTTP ${res.status} ${bodyText.slice(0, 200)}` },
        elapsedMs: Date.now() - started,
      };
    }
    const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const content = json?.choices?.[0]?.message?.content ?? null;
    if (content == null) {
      return { ok: false, content: null, error: { code: "GLM_BAD_RESPONSE", message: "CommandCode 响应缺少 choices[0].message.content" }, elapsedMs: Date.now() - started };
    }
    return { ok: true, content, error: null, elapsedMs: Date.now() - started };
  } catch (e) {
    const err = e as Error;
    const isTimeout = err.name === "AbortError";
    return {
      ok: false,
      content: null,
      error: { code: isTimeout ? "GLM_TIMEOUT" : "GLM_BAD_RESPONSE", message: isTimeout ? "AI 请求超时" : `AI 请求失败：${err.message}` },
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the first JSON object from a model reply (tolerates code fences). */
export function parseJsonFromModel<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Availability probe for the settings page (cheap 1-token ping). */
export async function glmHealthCheck(): Promise<{ ok: boolean; message: string; elapsedMs: number }> {
  const r = await glmChat([{ role: "user", content: "回复两个字：在线" }], { maxTokens: 8, timeoutMs: 12_000 });
  return {
    ok: r.ok,
    message: r.ok ? `连接正常（${r.elapsedMs}ms）` : r.error!.message,
    elapsedMs: r.elapsedMs,
  };
}
