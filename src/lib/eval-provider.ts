// AI GM 评测的 Provider 适配器（独立于 src/lib/glm.ts 的新闻/简报功能）。
//
// 协议：不依赖各家 function-calling，使用纯 JSON 动作协议 —— Provider 返回：
// {
//   "action": "get_roster|get_assets|get_market|propose_trade|sign_free_agent|
//              draft_pick|finish_draft|set_strategy|advance_season|start_new_season|do_nothing",
//   "params": { ... },
//   "decision": "公开决策摘要（一句话）",
//   "goals": "目标", "expected": "预期收益", "risks": "风险"
// }
// 服务器负责校验动作是否在该阶段允许、执行受控工具并落库；LLM 永远不决定
// 比赛数值、交易规则或模拟结果。
//
// 隐藏思维链不会被请求或记录 —— 只保存模型主动提交的 decision/goals/expected/risks。

import "server-only";

export const GM_ACTIONS = [
  "get_roster",
  "get_assets",
  "get_market",
  "propose_trade",
  "respond_trade",
  "sign_free_agent",
  "waive_player",
  "draft_pick",
  "finish_draft",
  "set_strategy",
  "advance_season",
  "start_new_season",
  "do_nothing",
] as const;

export type GmAction = (typeof GM_ACTIONS)[number];

/** 各阶段允许的动作（权限白名单 —— 权限测试的依据）。 */
export const STAGE_ALLOWED_ACTIONS: Record<string, GmAction[]> = {
  SEASON: ["get_roster", "get_assets", "get_market", "propose_trade", "respond_trade", "waive_player", "set_strategy", "advance_season", "do_nothing"],
  // Draft-night trades and roster trims are real NBA — both allowed here.
  DRAFT: ["get_roster", "get_assets", "get_market", "propose_trade", "waive_player", "draft_pick", "finish_draft", "do_nothing"],
  FREE_AGENCY: ["get_roster", "get_assets", "get_market", "propose_trade", "sign_free_agent", "waive_player", "start_new_season", "do_nothing"],
  DONE: [],
};

export interface GmActionPayload {
  action: GmAction;
  params: Record<string, unknown>;
  decision?: string;
  goals?: string;
  expected?: string;
  risks?: string;
}

export interface ProviderChatRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ProviderChatResult {
  content: string;
  /** Provider-native reasoning field, used transiently only for action parsing. */
  fallbackContent?: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  error?: string;
}

export interface ProviderConfig {
  provider: "STUB" | "OPENAI_COMPAT";
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
}

const TIMEOUT_MS = 45_000;

/** OpenAI Chat Completions 兼容调用（baseUrl 为完整 …/chat/completions 地址）。 */
async function openAiCompat(cfg: ProviderConfig, req: ProviderChatRequest): Promise<ProviderChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(cfg.baseUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 500,
        // CommandCode's DeepSeek reasoning models can spend a 500-token budget
        // entirely on hidden reasoning unless the effort is bounded.
        ...(cfg.baseUrl?.includes("commandcode.ai") && cfg.model?.startsWith("deepseek/") ? { reasoning_effort: "low" } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      // 错误信息不回显请求头（含 Key）
      return {
        content: "",
        latencyMs: Date.now() - started,
        tokensIn: 0,
        tokensOut: 0,
        costCents: 0,
        error: `Provider HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
      };
    }
    const json = (await res.json().catch(() => null)) as
      | {
          choices?: { message?: { content?: string; reasoning_content?: string; reasoning_details?: { text?: string }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          cost?: number;
        }
      | null;
    const message = json?.choices?.[0]?.message;
    const content = message?.content ?? "";
    const fallbackContent = [message?.reasoning_content, ...(message?.reasoning_details ?? []).map((d) => d.text)].filter(Boolean).join("\n");
    return {
      content,
      fallbackContent: fallbackContent || undefined,
      latencyMs: Date.now() - started,
      tokensIn: json?.usage?.prompt_tokens ?? 0,
      tokensOut: json?.usage?.completion_tokens ?? 0,
      costCents: typeof json?.cost === "number" ? Math.round(json.cost * 100) : 0,
    };
  } catch (e) {
    const err = e as Error;
    return {
      content: "",
      latencyMs: Date.now() - started,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      error: err.name === "AbortError" ? "Provider 超时" : `Provider 请求失败: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析模型回复中的动作 JSON（容忍代码围栏/前后缀文本）。 */
export function parseActionJson(text: string): GmActionPayload | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      action?: string;
      params?: Record<string, unknown>;
      decision?: unknown;
      goals?: unknown;
      expected?: unknown;
      risks?: unknown;
    };
    if (!obj.action || !GM_ACTIONS.includes(obj.action as GmAction)) return null;
    return {
      action: obj.action as GmAction,
      params: (obj.params ?? {}) as Record<string, unknown>,
      decision: typeof obj.decision === "string" ? obj.decision.slice(0, 300) : undefined,
      goals: typeof obj.goals === "string" ? obj.goals.slice(0, 300) : undefined,
      expected: typeof obj.expected === "string" ? obj.expected.slice(0, 300) : undefined,
      risks: typeof obj.risks === "string" ? obj.risks.slice(0, 300) : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stub Provider：确定性脚本化决策（无网络），用于 Provider 不可用时验证整条链路
// ---------------------------------------------------------------------------

interface StubScene {
  stage: string;
  hasSignedThisStage?: boolean;
  lastTurnWasSignAttempt?: boolean;
  tradeAttempted?: boolean;
  strategySet?: boolean;
  seasonsDone: number;
  years: number;
  rosterCount?: number;
  waiveCandidateId?: string | null;
  inboundOfferId?: string | null;
  inboundGood?: boolean;
  ownFaId?: string | null;
  ownFaSalary?: number;
  ownFaSigned?: boolean;
}

/**
 * Stub 决策序列（每个赛季相同，确定性）：
 * SEASON: get_roster → propose_trade(尝试用队内最差首发+次轮换对方一名首发) → set_strategy → advance_season
 * DRAFT: draft_pick（服务器自动选最优）
 * FREE_AGENCY: sign_free_agent（市场最便宜前锋，服务器规则裁决）→ start_new_season
 */
export function stubAction(scene: StubScene): GmActionPayload {
  const base = (decision: string, extra?: Partial<GmActionPayload>): GmActionPayload => ({
    action: "do_nothing",
    params: {},
    decision,
    goals: "验证评测链路（Stub）",
    expected: "确定性脚本行为",
    risks: "无（本地测试）",
    ...extra,
  });

  if (scene.stage === "SEASON") {
    // Answer inbound AI offers first — a pending call waits for nobody.
    if (scene.inboundOfferId) {
      return base(scene.inboundGood ? "接受 AI 主动报价（账面不亏）" : "拒绝 AI 主动报价（筹码不值）", {
        action: "respond_trade",
        params: { offerId: scene.inboundOfferId, accept: scene.inboundGood === true },
      });
    }
    if (!scene.tradeAttempted) {
      return base("用边缘轮换+次轮签尝试换取即战力", {
        action: "propose_trade",
        params: { mode: "stub_best_effort" },
      });
    }
    if (!scene.strategySet) {
      return base("记录球队策略", { action: "set_strategy", params: { text: "Stub 策略：保持薪资灵活，逐年补强轮换深度。" } });
    }
    return base("推进约一个月赛程", { action: "advance_season" });
  }
  if (scene.stage === "DRAFT") {
    return base("选择最佳可用新秀", { action: "draft_pick", params: {} });
  }
  if (scene.stage === "FREE_AGENCY") {
    // 超员先裁员（常规赛开打前名单必须 ≤18）
    if ((scene.rosterCount ?? 0) > 18 && scene.waiveCandidateId) {
      return base("裁掉阵容末端球员以满足名单上限", { action: "waive_player", params: { playerId: scene.waiveCandidateId } });
    }
    // 自家到期球员优先用鸟权续约一次
    if (scene.ownFaId && !scene.ownFaSigned && !scene.lastTurnWasSignAttempt) {
      return base("用鸟权续约自家到期球员", {
        action: "sign_free_agent",
        params: { playerId: scene.ownFaId, years: 3, avgSalary: scene.ownFaSalary },
      });
    }
    // 已签成功，或上一回合已尝试过签约（无目标/被拒）→ 推进新赛季（只尝试一次，避免空转）
    if (!scene.hasSignedThisStage && !scene.lastTurnWasSignAttempt) {
      return base("尝试签下一名自由球员补强", { action: "sign_free_agent", params: { mode: "stub_cheapest" } });
    }
    return base("阵容就绪，开始新赛季", { action: "start_new_season" });
  }
  return base("无操作");
}

export async function providerChat(
  cfg: ProviderConfig,
  req: ProviderChatRequest,
  stubScene?: StubScene,
): Promise<ProviderChatResult & { action: GmActionPayload | null }> {
  if (cfg.provider === "STUB") {
    const action = stubAction(stubScene ?? { stage: "SEASON", seasonsDone: 0, years: 3 });
    return { content: JSON.stringify(action), latencyMs: 1, tokensIn: 0, tokensOut: 0, costCents: 0, action };
  }
  const r = await openAiCompat(cfg, req);
  return { ...r, action: r.error ? null : parseActionJson(r.content) ?? parseActionJson(r.fallbackContent ?? "") };
}
