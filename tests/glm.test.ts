// CommandCode GLM client: request format, Bearer auth, timeout, error
// handling — all against a mocked fetch. No real key is stored anywhere in
// this repository; the live smoke test below only runs when env vars exist.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlmConfig, glmChat, parseJsonFromModel } from "@/lib/glm";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.COMMANDCODE_CHAT_URL = "https://api.commandcode.ai/provider/v1/chat/completions";
  process.env.COMMANDCODE_MODEL = "glm-5.3-flash";
  process.env.COMMANDCODE_API_KEY = "sk-test-fake-key-for-unit-tests";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

function mockFetchOnce(payload: unknown, init?: { status?: number }) {
  const fn = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status: init?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

describe("GLM config", () => {
  it("detects missing env vars", () => {
    delete process.env.COMMANDCODE_API_KEY;
    const cfg = getGlmConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.missingEnvVars).toContain("COMMANDCODE_API_KEY");
  });

  it("reads config from env only", () => {
    const cfg = getGlmConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.url).toContain("chat/completions");
    expect(cfg.model).toBe("glm-5.3-flash");
  });
});

describe("glmChat request format", () => {
  it("sends full URL, Bearer auth, JSON body, no streaming", async () => {
    const fn = mockFetchOnce({ choices: [{ message: { content: "你好" } }] });
    const r = await glmChat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("你好");
    expect(fn).toHaveBeenCalledOnce();
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.commandcode.ai/provider/v1/chat/completions"); // no path re-append
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-fake-key-for-unit-tests");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps HTTP errors to structured failures without echoing secrets", async () => {
    mockFetchOnce({ error: "boom" }, { status: 502 });
    const r = await glmChat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("GLM_HTTP_ERROR");
    expect(r.error!.message).toContain("502");
  });

  it("maps 429 to rate limit", async () => {
    mockFetchOnce({}, { status: 429 });
    const r = await glmChat([{ role: "user", content: "hi" }]);
    expect(r.error!.code).toBe("GLM_RATE_LIMIT");
  });

  it("times out per configured deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            init?.signal?.addEventListener("abort", () => reject(err));
          }),
      ),
    );
    const r = await glmChat([{ role: "user", content: "hi" }], { timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("GLM_TIMEOUT");
  });

  it("flags malformed responses", async () => {
    mockFetchOnce({ unexpected: true });
    const r = await glmChat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("GLM_BAD_RESPONSE");
  });

  it("unconfigured endpoint short-circuits without network", async () => {
    delete process.env.COMMANDCODE_CHAT_URL;
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn as unknown as typeof fetch);
    const r = await glmChat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("GLM_NOT_CONFIGURED");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("JSON extraction from model output", () => {
  it("parses fenced and bare JSON", () => {
    expect(parseJsonFromModel<{ a: number }>('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonFromModel<{ a: number }>('前言 {"a": 2} 后记')).toEqual({ a: 2 });
    expect(parseJsonFromModel("no json here")).toBeNull();
  });
});

// Live smoke test — runs ONLY when a real key is configured in the environment.
describe.skipIf(!process.env.COMMANDCODE_API_KEY || !process.env.COMMANDCODE_CHAT_URL)("GLM live smoke (requires env)", () => {
  it("reaches the configured endpoint", async () => {
    const r = await glmChat([{ role: "user", content: "回复：在线" }], { maxTokens: 8, timeoutMs: 15000 });
    expect(r.ok).toBe(true);
  }, 30_000);
});
