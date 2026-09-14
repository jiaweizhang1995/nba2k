// AI GM 评测全链路测试：
//   - Provider 适配器（JSON 动作解析 / Stub 确定性 / OpenAI 兼容 mock）
//   - AI 工具权限（阶段白名单 + 越权拒绝）
//   - API Key 脱敏（不进客户端响应/明文数据库）
//   - 相同种子确定性（两次独立评测结果一致）
//   - 评测运行 + 回放（不调用模型得到相同结果）
//   - 3 年 / 5 年结果面板字段

import { describe, expect, it } from "vitest";
import { createSave } from "@/server/engine";
import { importData } from "@/server/import";
import {
  createEvaluation,
  stepEvaluation,
  getEvaluationDetail,
  listEvaluations,
  startReplay,
  isActionAllowed,
  writeAgentAction,
} from "@/server/eval";
import { parseActionJson, stubAction, STAGE_ALLOWED_ACTIONS } from "@/lib/eval-provider";
import { encryptKey, decryptKey, maskKey } from "@/lib/eval-crypto";
import { getDb } from "@/db";
import { teams as teamsT, players as playersT } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { ImportPayload } from "@/data/providers/types";

let baseSaveId: string;
let teamShortId: string;

async function setupBase() {
  if (baseSaveId) return;
  const { saveId } = await createSave({ name: "评测基准", seed: 4321 });
  // 导入小联盟后球队变为 AAA/BBB（原演示球队被替换）
  await importData(saveId, buildTinyPayload());
  baseSaveId = saveId;
  teamShortId = "ATL";
}

// 程序化生成 30 队 × 14 人的测试联盟（支持季后赛与交易配平）
function buildTinyPayload(): ImportPayload {
  const meta = { provider: "CSV_JSON", sourceUrl: "https://example.com/t", retrievedAt: "2026-09-13T00:00:00.000Z", season: 2027, licenseNote: "test" };
  const abbrs = ["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"];
  const east = new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DET","IND","MIA","MIL","NYK","ORL","PHI","TOR","WAS"]);
  const divisions = ["大西洋", "中部", "东南", "西北", "太平洋", "西南"];
  const pos = ["PG", "SG", "SF", "PF", "C"] as const;
  const teams = abbrs.map((abbr, i) => ({
    externalId: abbr,
    abbr,
    city: `城市${i + 1}`,
    name: `队${i + 1}`,
    conference: east.has(abbr) ? "EAST" : "WEST",
    division: divisions[i % 6],
    meta,
  }));
  const players: ImportPayload["players"] = [];
  abbrs.forEach((abbr, ti) => {
    for (let i = 0; i < 14; i++) {
      const overall = 60 - Math.floor(ti / 6) + (i < 3 ? 12 - i * 2 : i < 9 ? 4 : -6); // 强弱分层
      const g = 60 + (i % 10);
      players.push({
        externalId: `${abbr}-${i + 1}`,
        name: `${abbr} 球员${i + 1}`,
        position: pos[i % 5],
        teamAbbr: abbr,
        age: 22 + ((ti + i) % 12),
        heightCm: 195 + (i % 6) * 3,
        weightKg: 90 + (i % 8) * 3,
        draftYear: null,
        yearsPro: 2 + (i % 5),
        potential: i < 2 ? overall + 8 : null,
        potentialLow: i < 2 ? overall + 2 : null,
        potentialHigh: i < 2 ? overall + 14 : null,
        contract: null,
        statLine: {
          season: 2027,
          teamAbbr: abbr,
          g,
          mp: g * 28,
          pts: g * (6 + (overall - 50) * 0.45 + (i < 3 ? 6 : 0)),
          reb: g * (2 + i * 0.3),
          ast: g * (1 + ((i % 5) === 0 ? 3 : 1)),
          stl: g * 0.8,
          blk: g * (0.4 + (i % 5) * 0.2),
          tov: g * 1.4,
          fgm: g * 4.5,
          fga: g * 10,
          tpm: g * 1.6,
          tpa: g * 4.4,
          ftm: g * 1.6,
          fta: g * 2.1,
        },
        meta,
      });
    }
  });
  return { teams, players };
}

async function runToCompletion(evalId: string, maxSteps = 400) {
  let steps = 0;
  for (;;) {
    const state = await stepEvaluation(evalId);
    steps++;
    if (state.done || state.status === "ERROR" || state.status === "CANCELLED") return { steps, state };
    if (steps >= maxSteps) {
      const d = getEvaluationDetail(evalId);
      console.log("MAX_STEPS hit; first 24 turns:", JSON.stringify(d.turns.slice(0, 24).map((t) => [t.turnIndex, t.stage, t.action, (t.resultSummary ?? t.error ?? "").slice(0, 60)])));
      console.log("MAX_STEPS hit; last turns:", JSON.stringify(d.turns.slice(-4).map((t) => [t.turnIndex, t.stage, t.action, (t.resultSummary ?? t.error ?? "").slice(0, 80)])));
      return { steps, state };
    }
  }
}

// ---------------------------------------------------------------------------
// Provider 适配器
// ---------------------------------------------------------------------------

describe("Provider adapter", () => {
  it("parses strict and fenced action JSON; rejects unknown actions", () => {
    expect(parseActionJson('{"action":"get_roster","params":{},"decision":"看阵容"}')?.action).toBe("get_roster");
    expect(parseActionJson('前置文本```json\n{"action":"advance_season"}\n```后缀')?.action).toBe("advance_season");
    expect(parseActionJson('{"action":"get_market","params":{}}\nassistant {"action":"get_market","params":{}}')?.action).toBe("get_market");
    expect(parseActionJson('{"action":"god_mode"}')).toBeNull();
    expect(parseActionJson("完全不是 JSON")).toBeNull();
    expect(parseActionJson("{}")).toBeNull();
  });

  it("stub action sequence is deterministic per scene", () => {
    const a = stubAction({ stage: "SEASON", seasonsDone: 0, years: 3 });
    const b = stubAction({ stage: "SEASON", seasonsDone: 0, years: 3 });
    expect(a.action).toBe(b.action);
    expect(a.action).toBe("propose_trade");
    expect(stubAction({ stage: "DRAFT", seasonsDone: 1, years: 3 }).action).toBe("draft_pick");
    expect(stubAction({ stage: "FREE_AGENCY", seasonsDone: 1, years: 3, hasSignedThisStage: false }).action).toBe("sign_free_agent");
    expect(stubAction({ stage: "FREE_AGENCY", seasonsDone: 1, years: 3, hasSignedThisStage: true }).action).toBe("start_new_season");
  });

  it("OpenAI-compat adapter handles mocked success and HTTP failure", async () => {
    process.env.COMMANDCODE_API_KEY = "";
    const cfg = { provider: "OPENAI_COMPAT" as const, baseUrl: "https://provider.test/v1/chat/completions", model: "test-model", apiKey: "sk-test" };
    const calls: { url: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    // 成功：返回合法动作 JSON
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"get_roster","params":{},"decision":"看一眼"}' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { providerChat } = await import("@/lib/eval-provider");
    const okRes = await providerChat(cfg, { system: "s", messages: [{ role: "user", content: "obs" }] });
    expect(okRes.error).toBeUndefined();
    expect(okRes.action?.action).toBe("get_roster");
    expect(okRes.tokensIn).toBe(100);
    expect(calls[0].url).toBe("https://provider.test/v1/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    // Some reasoning models put the public JSON in reasoning_content.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: '{"action":"get_assets","params":{}}' } }] }), { status: 200 })) as unknown as typeof fetch;
    const fallbackRes = await providerChat(cfg, { system: "s", messages: [{ role: "user", content: "obs" }] });
    expect(fallbackRes.action?.action).toBe("get_assets");
    // 失败：HTTP 500 → 结构化错误，且错误信息不带 Key
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const errRes = await providerChat(cfg, { system: "s", messages: [{ role: "user", content: "obs" }] });
    expect(errRes.error).toContain("500");
    expect(errRes.error).not.toContain("sk-test");
    globalThis.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// API Key 脱敏
// ---------------------------------------------------------------------------

describe("API Key masking & encryption", () => {
  it("mask/encrypt/decrypt round-trip; ciphertext is not plaintext", async () => {
    await setupBase();
    const key = "sk-abcdef1234567890SECRET";
    const masked = maskKey(key);
    expect(masked).toContain("…");
    expect(masked).not.toContain("SECRET");
    const enc = encryptKey(key);
    expect(enc).not.toContain(key);
    expect(decryptKey(enc)).toBe(key);
    expect(decryptKey("tampered." + enc)).toBeNull();
  });

  it("created evaluation never exposes plaintext key via APIs or DB plaintext", async () => {
    await setupBase();
    const { id } = await createEvaluation({
      name: "脱敏测试",
      baseSaveId,
      teamShortId,
      seed: 77,
      years: 3,
      provider: "OPENAI_COMPAT",
      baseUrl: "https://provider.test/v1/chat/completions",
      model: "test-model",
      apiKey: "sk-super-secret-987654321",
    });
    const detail = getEvaluationDetail(id);
    expect(JSON.stringify(detail).includes("sk-super-secret-987654321")).toBe(false);
    const list = listEvaluations();
    expect(JSON.stringify(list).includes("sk-super-secret-987654321")).toBe(false);
    // 明文 Key 不入库：数据库行只有密文与掩码
    const { getDb: getDb2 } = await import("@/db");
    const { evaluations: evaluationsT2 } = await import("@/db/schema");
    const { eq: eq2 } = await import("drizzle-orm");
    const dbRow = getDb2().select().from(evaluationsT2).where(eq2(evaluationsT2.id, id)).get() as unknown as { apiKeyEnc: string; apiKeyMasked: string };
    expect(dbRow.apiKeyEnc).toBeTruthy();
    expect(dbRow.apiKeyEnc.includes("sk-super-secret")).toBe(false);
    expect(dbRow.apiKeyMasked).toContain("…");
    expect(getEvaluationDetail(id).evaluation.apiKeyMasked).toContain("…");
  });
});

// ---------------------------------------------------------------------------
// 工具权限
// ---------------------------------------------------------------------------

describe("AI tool permissions", () => {
  it("stage whitelist is well-formed", () => {
    expect(isActionAllowed("SEASON", "propose_trade")).toBe(true);
    expect(isActionAllowed("SEASON", "draft_pick")).toBe(false);
    expect(isActionAllowed("DRAFT", "sign_free_agent")).toBe(false);
    expect(isActionAllowed("FREE_AGENCY", "start_new_season")).toBe(true);
    for (const [stage, actions] of Object.entries(STAGE_ALLOWED_ACTIONS)) {
      if (stage !== "DONE") expect(actions).toContain("do_nothing");
    }
  });

  it("out-of-stage action is rejected and never executed (integration)", async () => {
    await setupBase();
    const { id } = await createEvaluation({
      name: "越权测试",
      baseSaveId,
      teamShortId,
      seed: 778899,
      years: 3,
      provider: "OPENAI_COMPAT",
      baseUrl: "https://provider.test/v1/chat/completions",
      model: "rogue",
      apiKey: "sk-rogue",
    });
    // 模拟恶意 Provider：在 SEASON 阶段返回选秀动作（不属于该阶段）
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"draft_pick","params":{"prospectId":"p7"}}' } }] }), { status: 200 })) as unknown as typeof fetch;
    try {
      await stepEvaluation(id);
      const detail = getEvaluationDetail(id);
      const turn = detail.turns.at(-1)!;
      expect(turn.action).toBe("draft_pick");
      expect(turn.ok).toBe(false);
      expect(turn.resultSummary ?? "").toContain("不被允许");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("AGENT provider waits for queued actions, executes them once, enforces stage whitelist", async () => {
    await setupBase();
    const { id } = await createEvaluation({
      name: "AGENT 测试",
      baseSaveId,
      teamShortId,
      seed: 8899,
      years: 3,
      provider: "AGENT",
    });
    // 无动作 → 等待，不消耗回合
    const s1 = await stepEvaluation(id);
    expect(s1.waiting).toBe(true);
    expect(s1.observation).toBeTruthy();
    expect(s1.done).toBe(false);
    expect(getEvaluationDetail(id).turns).toHaveLength(0);

    // 越阶段动作 → 拒绝且记回合
    writeAgentAction(id, { action: "draft_pick", params: { prospectId: "x" }, decision: "越权" });
    const s2 = await stepEvaluation(id);
    expect(s2.lastTurn?.action).toBe("draft_pick");
    expect(s2.lastTurn?.ok).toBe(false);
    expect(getEvaluationDetail(id).turns.at(-1)!.ok).toBe(false);

    // 合法动作执行且只消费一次
    writeAgentAction(id, { action: "set_strategy", params: { text: "测试策略" }, decision: "设策略" });
    const s3 = await stepEvaluation(id);
    expect(s3.lastTurn?.ok).toBe(true);
    const s4 = await stepEvaluation(id);
    expect(s4.waiting).toBe(true); // 队列已空
    const turns = getEvaluationDetail(id).turns;
    expect(turns.filter((t) => t.action === "set_strategy")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 完整运行 / 确定性 / 回放 / 结果面板
// ---------------------------------------------------------------------------

describe("Eval run, determinism, replay, panels", () => {
  it("3-year STUB eval completes; same seed reproduces identical results; base save untouched", async () => {
    await setupBase();
    const db = getDb();
    const checksum = () =>
      JSON.stringify([
        db.select().from(teamsT).where(eq(teamsT.saveId, baseSaveId)).all(),
        db.select().from(playersT).where(eq(playersT.saveId, baseSaveId)).all().map((p) => [p.id, p.ratings.overall, p.contract]),
      ]);
    const before = checksum();

    const { id: evalA } = await createEvaluation({ name: "3年-A", baseSaveId, teamShortId, seed: 20260913, years: 3, provider: "STUB" });
    const runA = await runToCompletion(evalA);
    expect(runA.state.status).toBe("DONE");
    const after = checksum();
    expect(after).toBe(before); // 基准存档完全未被修改

    const detailA = getEvaluationDetail(evalA);
    expect(detailA.seasons).toHaveLength(3);
    expect(detailA.evaluation.score?.version).toBe("GM-BENCH v3");

    // 相同种子第二次独立评测 → 结果一致
    const { id: evalB } = await createEvaluation({ name: "3年-B（同种子）", baseSaveId, teamShortId, seed: 20260913, years: 3, provider: "STUB" });
    await runToCompletion(evalB);
    const detailB = getEvaluationDetail(evalB);
    const sig = (d: ReturnType<typeof getEvaluationDetail>) => JSON.stringify(d.seasons.map((s) => [s.season, s.wins, s.losses, s.playoffResult]));
    expect(sig(detailB)).toBe(sig(detailA));
    expect(detailB.evaluation.score?.score).toBe(detailA.evaluation.score?.score);
  }, 600_000);

  it("replay of a completed eval reproduces the same seasons without provider calls", async () => {
    await setupBase();
    const evals = listEvaluations().filter((e) => e.provider === "STUB" && e.status === "DONE" && !e.replayOf);
    const source = evals[0];
    const { id: replayId } = startReplay(source.id);
    const run = await runToCompletion(replayId);
    expect(run.state.status).toBe("DONE");
    const detail = getEvaluationDetail(replayId);
    expect(detail.evaluation.callCount).toBe(0); // 回放不调用模型
    expect(detail.evaluation.score?.replayMatch).toBe(true);
  }, 600_000);

  it("3-year and 5-year result panels expose every required field", async () => {
    await setupBase();
    for (const years of [3, 5] as const) {
      const { id } = await createEvaluation({ name: `面板-${years}年`, baseSaveId, teamShortId, seed: 909090 + years, years, provider: "STUB" });
      await runToCompletion(id);
      const d = getEvaluationDetail(id);
      const sc = d.evaluation.score!;
      expect(sc.version).toBe("GM-BENCH v3");
      // 面板必备字段
      for (const field of ["score", "totalWins", "playoffCount", "champCount", "tradeCount", "legalRate", "errorRate", "callCount", "latencyMsSum", "finalChemistry", "formula", "tradePnl", "tradeBonus", "draftBonus", "faValueBonus", "pickCapitalBonus"] as const) {
        expect(field in sc, `缺少字段 ${field}`).toBe(true);
      }
      expect(d.seasons.length).toBeLessThanOrEqual(years);
      expect(d.seasons.length).toBeGreaterThan(0);
      expect(d.cap).toBeTruthy();
      expect(d.chemistry).toBeTruthy();
      expect(d.tradeEvents).toBeTruthy();
      expect(d.turns.length).toBeGreaterThan(0);
      expect(JSON.stringify(d).includes("apiKeyEnc")).toBe(false);
    }
  }, 900_000);
});
