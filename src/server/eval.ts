// AI GM 评测：独立快照存档 + 受控工具 + 阶段状态机 + 评分 + 回放。
//
// 铁律：
//  - 评测在克隆存档上进行，永不修改用户原始存档
//  - LLM 只能调用本文件白名单内的受控工具；工具内部全部走现有 engine 的
//    规则校验与事务 —— 不能改数据库、不能 God Mode、不能绕过规则
//  - 引擎确定性：同一克隆 + 同一种子 + 同一动作序列 ⇒ 结果相同，
//    因此回放（不调用模型）可以得到相同结果
//  - 只记录模型主动提交的公开决策摘要，不获取隐藏思维链

import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  awards as awardsT,
  evalSeasons as evalSeasonsT,
  evalTurns as evalTurnsT,
  evaluations as evaluationsT,
  events as eventsT,
  faOffers as faOffersT,
  games as gamesT,
  draftPicks as picksT,
  players as playersT,
  saves as savesT,
  teams as teamsT,
} from "@/db/schema";
import { capSnapshot } from "@/domain/salary";
import { providerChat, STAGE_ALLOWED_ACTIONS, type GmAction } from "@/lib/eval-provider";
import { decryptKey, encryptKey, maskKey } from "@/lib/eval-crypto";
import {
  advanceSim,
  executeTrade,
  getAiTradeFeedback,
  getChemistry,
  getDraftBoard,
  getDraftOrder,
  getSave,
  loadLeagueState,
  makeDraftPick,
  startFreeAgency,
  startNewSeason,
  submitFaOffer,
  validateTradeOnServer,
} from "./engine";

export const uuid = () => globalThis.crypto.randomUUID();

/** 阶段动作白名单（权限测试依据）。 */
export function isActionAllowed(stage: string, action: GmAction): boolean {
  return (STAGE_ALLOWED_ACTIONS[stage] ?? []).includes(action);
}
const now = () => new Date().toISOString();
const shortId = (full: string) => full.split(":").slice(1).join(":");
const MAX_TURNS = 600;

export const SCORE_VERSION = "GM-BENCH v1";

export class EvalError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 快照克隆
// ---------------------------------------------------------------------------

function cloneSaveForEval(baseSaveId: string, seed: number, teamShortId: string, evalName: string): { saveId: string; teamFullId: string } {
  const db = getDb();
  const base = getSave(baseSaveId);
  if (!base) throw new EvalError("NO_BASE_SAVE", "基准存档不存在");
  if (base.phase !== "REGULAR_SEASON") throw new EvalError("BAD_PHASE", "基准存档需处于常规赛阶段才能创建评测快照");
  const newId = uuid();
  const teamFullId = `${newId}:${teamShortId}`;

  db.transaction((tx) => {
    tx.insert(savesT)
      .values({
        ...base,
        id: newId,
        name: `[AI评测] ${evalName}`,
        seed,
        isEval: true,
        phase: "REGULAR_SEASON",
        phaseState: { userTeamId: teamFullId },
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    for (const t of db.select().from(teamsT).where(eq(teamsT.saveId, baseSaveId)).all()) {
      tx.insert(teamsT).values({ ...t, id: `${newId}:${shortId(t.id)}`, saveId: newId }).run();
    }
    for (const p of db.select().from(playersT).where(eq(playersT.saveId, baseSaveId)).all()) {
      tx.insert(playersT).values({ ...p, id: `${newId}:${shortId(p.id)}`, saveId: newId, teamId: p.teamId ? `${newId}:${shortId(p.teamId)}` : null }).run();
    }
    for (const k of db.select().from(picksT).where(eq(picksT.saveId, baseSaveId)).all()) {
      tx.insert(picksT).values({ ...k, id: `${newId}:${shortId(k.id)}`, saveId: newId, originalTeamId: `${newId}:${shortId(k.originalTeamId)}`, holderTeamId: `${newId}:${shortId(k.holderTeamId)}` }).run();
    }
    for (const g of db.select().from(gamesT).where(eq(gamesT.saveId, baseSaveId)).all()) {
      tx.insert(gamesT).values({ ...g, id: `${newId}:${shortId(g.id)}`, saveId: newId, homeTeamId: `${newId}:${shortId(g.homeTeamId)}`, awayTeamId: `${newId}:${shortId(g.awayTeamId)}` }).run();
    }
    for (const a of db.select().from(awardsT).where(eq(awardsT.saveId, baseSaveId)).all()) {
      tx.insert(awardsT).values({ ...a, id: `${newId}:${shortId(a.id)}`, saveId: newId, teamId: a.teamId ? `${newId}:${shortId(a.teamId)}` : null, playerId: a.playerId ? `${newId}:${shortId(a.playerId)}` : null }).run();
    }
    // faOffers / events / dataSources 为历史记录，评测世界无需携带
  });

  return { saveId: newId, teamFullId };
}

// ---------------------------------------------------------------------------
// 创建 / 查询
// ---------------------------------------------------------------------------

export async function createEvaluation(input: {
  name?: string;
  baseSaveId: string;
  teamShortId: string;
  seed: number;
  years: 3 | 5;
  provider: "STUB" | "OPENAI_COMPAT";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<{ id: string }> {
  if (input.provider === "OPENAI_COMPAT") {
    if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) throw new EvalError("BAD_URL", "Provider URL 必须是 http(s) 完整地址（…/chat/completions）");
    if (!input.model) throw new EvalError("NO_MODEL", "缺少模型名");
    if (!input.apiKey) throw new EvalError("NO_KEY", "缺少 API Key");
  }
  // 校验球队存在于基准存档
  const db = getDb();
  const baseTeam = db.select().from(teamsT).where(and(eq(teamsT.saveId, input.baseSaveId), eq(teamsT.id, `${input.baseSaveId}:${input.teamShortId}`))).get();
  if (!baseTeam) throw new EvalError("NO_TEAM", "所选球队不在基准存档中");

  const { saveId, teamFullId } = cloneSaveForEval(input.baseSaveId, input.seed, input.teamShortId, input.name || "评测");
  const id = uuid();
  db.insert(evaluationsT)
    .values({
      id,
      name: input.name || `评测 ${new Date().toLocaleString("zh-CN")}`,
      baseSaveId: input.baseSaveId,
      saveId,
      provider: input.provider,
      baseUrl: input.provider === "OPENAI_COMPAT" ? input.baseUrl ?? null : null,
      model: input.provider === "OPENAI_COMPAT" ? input.model ?? null : "stub-gm-v1",
      apiKeyMasked: input.apiKey ? maskKey(input.apiKey) : null,
      apiKeyEnc: input.apiKey ? encryptForEval(input.apiKey) : null,
      teamShortId: input.teamShortId,
      teamFullId,
      seed: input.seed,
      years: input.years,
      status: "PENDING",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return { id };
}

function encryptForEval(key: string): string {
  return encryptKey(key);
}
function decryptForEval(enc: string): string | null {
  return decryptKey(enc);
}

export function listEvaluations() {
  return getDb()
    .select({
      id: evaluationsT.id,
      name: evaluationsT.name,
      provider: evaluationsT.provider,
      model: evaluationsT.model,
      apiKeyMasked: evaluationsT.apiKeyMasked,
      teamShortId: evaluationsT.teamShortId,
      seed: evaluationsT.seed,
      years: evaluationsT.years,
      status: evaluationsT.status,
      stage: evaluationsT.stage,
      seasonsDone: evaluationsT.seasonsDone,
      callCount: evaluationsT.callCount,
      errorCount: evaluationsT.errorCount,
      score: evaluationsT.score,
      replayOf: evaluationsT.replayOf,
      createdAt: evaluationsT.createdAt,
    })
    .from(evaluationsT)
    .orderBy(desc(evaluationsT.createdAt))
    .all();
}

export function getEvaluationRow(id: string) {
  return getDb().select().from(evaluationsT).where(eq(evaluationsT.id, id)).get() ?? null;
}

// ---------------------------------------------------------------------------
// 受控工具（白名单执行；全部复用现有 engine 规则）
// ---------------------------------------------------------------------------

interface ToolResult {
  summary: string;
  data?: Record<string, unknown>;
  isAction?: boolean;
  legal?: boolean;
  stageChanged?: "DRAFT" | "FREE_AGENCY" | "SEASON" | "DONE";
}

function teamRoster(evalRow: { saveId: string; teamFullId: string }) {
  const db = getDb();
  const rows = db.select().from(playersT).where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId))).all();
  return rows.map((p) => ({
    name: p.name,
    position: p.position,
    age: p.age,
    overall: p.ratings.overall,
    role: p.role,
    salary: p.contract.years[0]?.salary ?? 0,
    yearsLeft: p.contract.years.length,
  }));
}

function capSummaryOf(saveId: string, teamFullId: string) {
  const db = getDb();
  const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, teamFullId))).all();
  return capSnapshot(roster, roster.length);
}

function toolGetRoster(evalRow: { saveId: string; teamFullId: string; seed: number }): ToolResult {
  const chemistry = getChemistry(evalRow.saveId, shortId(evalRow.teamFullId));
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  return {
    summary: `查看阵容：${teamRoster(evalRow).length} 人`,
    data: { roster: teamRoster(evalRow), chemistry: chemistry.overall, chemistryFactors: chemistry.factors, cap },
    isAction: false,
  };
}

function toolGetAssets(evalRow: { saveId: string; teamFullId: string; seed: number; season: number }): ToolResult {
  const db = getDb();
  const picks = db
    .select()
    .from(picksT)
    .where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.holderTeamId, evalRow.teamFullId)))
    .all()
    .filter((p) => p.status === "OWNED")
    .map((p) => ({ year: p.year, round: p.round, protection: p.protection?.type ?? "NONE" }));
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  const contracts = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId)))
    .all()
    .map((p) => ({ name: p.name, salary: p.contract.years[0]?.salary ?? 0, endSeason: p.contract.years[p.contract.years.length - 1]?.season ?? null }))
    .sort((a, b) => b.salary - a.salary)
    .slice(0, 8);
  return {
    summary: `查看资产：未来签 ${picks.length} 个，薪资总额 ${cap.totalSalary}M`,
    data: { picks, cap, topContracts: contracts },
    isAction: false,
  };
}

function toolGetMarket(evalRow: { saveId: string; teamFullId: string; seed: number; season: number }): ToolResult {
  const db = getDb();
  const fas = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.status, "FREE_AGENT")))
    .all()
    .map((p) => ({ name: p.name, position: p.position, age: p.age, overall: p.ratings.overall, asking: Math.max(1.2, (p.contract.years[0]?.salary ?? 5) * 1.05) }))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 12);
  const teams = db.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all();
  const sample = teams
    .filter((t) => t.id !== evalRow.teamFullId)
    .slice(0, 6)
    .map((t) => {
      const roster = db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, t.id)))
        .all()
        .sort((a, b) => b.ratings.overall - a.ratings.overall)
        .slice(0, 4)
        .map((p) => ({ name: p.name, overall: p.ratings.overall, salary: p.contract.years[0]?.salary ?? 0 }));
      const cap = capSummaryOf(evalRow.saveId, t.id);
      return { team: `${t.city} ${t.name}`, abbr: t.abbr, capSpace: cap.capSpace, rosterSample: roster };
    });
  return { summary: `查看市场：自由球员 ${fas.length} 人（展示前 12），球队样本 ${sample.length}`, data: { freeAgents: fas, teams: sample }, isAction: false };
}

function toolProposeTrade(
  evalRow: { id: string; saveId: string; teamFullId: string; teamShortId: string; seed: number; season: number },
  params: Record<string, unknown>,
): ToolResult {
  const db0 = getDb();
  if (params.mode === "stub_best_effort") {
    // Stub 确定性候选：送出我方综合最低的替补 + 我方最远年次轮签，
    // 换取交易伙伴薪资最接近的那名球员（规则由服务器裁决）。
    const teams = db0.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all().filter((t) => t.id !== evalRow.teamFullId);
    if (!teams.length) return { summary: "无交易伙伴", isAction: true, legal: false };
    const partner = teams[0];
    const mine = db0
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId)))
      .all()
      .filter((p) => p.role !== "STAR" && p.contract.years.length > 0)
      .sort((a, b) => a.ratings.overall - b.ratings.overall);
    const giveP = mine[0];
    if (!giveP) return { summary: "无可交易的边缘球员", isAction: true, legal: false };
    const giveSalary = giveP.contract.years[0]?.salary ?? 0;
    const picks = db0
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.holderTeamId, evalRow.teamFullId)))
      .all()
      .filter((k) => k.status === "OWNED" && k.round === 2)
      .sort((a, b) => b.year - a.year);
    const givePick = picks[0];
    const theirs = db0
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, partner.id)))
      .all()
      .filter((p) => p.role !== "STAR" && p.contract.years.length > 0)
      .sort((a, b) => Math.abs((a.contract.years[0]?.salary ?? 0) - giveSalary) - Math.abs((b.contract.years[0]?.salary ?? 0) - giveSalary));
    const recvP = theirs[0];
    if (!recvP) return { summary: "对方无可匹配球员", isAction: true, legal: false };
    const newParams: Record<string, unknown> = {
      partnerTeamId: shortId(partner.id),
      givePlayerIds: [shortId(giveP.id)],
      receivePlayerIds: [shortId(recvP.id)],
      ...(givePick ? { givePickIds: [shortId(givePick.id)] } : {}),
    };
    const inner = toolProposeTrade(evalRow, newParams);
    return { ...inner, summary: `[Stub 尝试] ${inner.summary}` };
  }
  const partner = String(params.partnerTeamId ?? "");
  if (!partner) throw new EvalError("BAD_PARAMS", "propose_trade 需要 partnerTeamId");
  const toIds = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const givePlayers = toIds(params.givePlayerIds).map((id) => ({ kind: "PLAYER" as const, id }));
  const givePicks = toIds(params.givePickIds).map((id) => ({ kind: "PICK" as const, id }));
  const recvPlayers = toIds(params.receivePlayerIds).map((id) => ({ kind: "PLAYER" as const, id }));
  const recvPicks = toIds(params.receivePickIds).map((id) => ({ kind: "PICK" as const, id }));
  const parties = [
    { teamId: evalRow.teamShortId, gives: [...givePlayers, ...givePicks], receives: [...recvPlayers, ...recvPicks] },
    { teamId: partner, gives: [...recvPlayers, ...recvPicks], receives: [...givePlayers, ...givePicks] },
  ];
  const validation = validateTradeOnServer(evalRow.saveId, parties);
  if (!validation.legal) {
    return {
      summary: `交易被规则拒绝：${validation.issues.map((i) => i.message).join("；").slice(0, 200)}`,
      data: { validation },
      isAction: true,
      legal: false,
    };
  }
  const feedback = getAiTradeFeedback(evalRow.saveId, parties);
  const rejected = feedback.filter((f) => !f.verdict.accept);
  if (rejected.length > 0) {
    return {
      summary: `规则允许但对方 GM 拒绝：${rejected.map((f) => `${f.teamId}（价值差 ${f.verdict.valueDelta}）：${f.verdict.feedback}`).join("；").slice(0, 200)}`,
      data: { validation, feedback },
      isAction: true,
      legal: true,
    };
  }
  const result = executeTrade(evalRow.saveId, parties, {});
  if (!result.executed) {
    return { summary: "交易执行失败", data: { validation }, isAction: true, legal: false };
  }
  const names = parties[0].gives.map((a) => a.id).join(",");
  return {
    summary: `交易完成：送出 ${names}，获得 ${parties[0].receives.map((a) => a.id).join(",")}`,
    data: { validation, feedback },
    isAction: true,
    legal: true,
  };
}

function toolSignFreeAgent(
  evalRow: { id: string; saveId: string; teamFullId: string; teamShortId: string; seed: number; season: number },
  params: Record<string, unknown>,
): ToolResult {
  let playerId: string | null = params.playerId ? String(params.playerId) : null;
  let years = Number(params.years ?? 2);
  let salary = Number(params.avgSalary ?? 0);
  const db = getDb();
  if (params.mode === "stub_cheapest" || !playerId) {
    // Stub 确定性选择：综合最高的自由球员，出价 = 要价 * 0.95（服务器规则裁决）
    const fas = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.status, "FREE_AGENT")))
      .all()
      .filter((p) => p.ratings.overall >= 55)
      .sort((a, b) => a.ratings.overall - b.ratings.overall || a.age - b.age);
    if (!fas.length) return { summary: "自由市场无合适目标（综合 ≥ 55）", isAction: true, legal: true };
    const pickFas = fas[fas.length - 1];
    playerId = shortId(pickFas.id);
    years = 2;
    salary = Math.max(1.3, Math.round(((pickFas.contract.years[0]?.salary ?? 5) * 1.05) * 10) / 10);
  }
  const r = submitFaOffer(evalRow.saveId, playerId, years, salary);
  if (r.accepted) {
    return { summary: `签约成功（兴趣度 ${r.interest}）`, data: r, isAction: true, legal: true };
  }
  return { summary: `报价被拒：${r.reason?.slice(0, 160)}`, data: r, isAction: true, legal: true };
}

/** 推进选秀：轮到他人时按 AI 最优代打，轮到自己时选指定/最优新秀。 */
function toolDraftPick(evalRow: { id: string; saveId: string; teamFullId: string; teamShortId: string; seed: number; season: number }, params: Record<string, unknown>): ToolResult {
  const prospectId = params.prospectId ? String(params.prospectId) : undefined;
  const order = getDraftOrder(evalRow.saveId);
  const donePicks = getDb().select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.year, evalRow.season), eq(picksT.status, "EXERCISED"))).all().length;
  const next = order[donePicks];
  if (!next) return { summary: "选秀已完成", isAction: true, legal: true };
  if (shortId(next.holderTeamId) === evalRow.teamShortId) {
    const picked = makeDraftPick(evalRow.saveId, { prospectId });
    return { summary: `我方选择：${picked.map((p) => `第${p.round}轮${p.pickNumber}顺位 → ${p.prospect}`).join("；") || "无"}`, data: { picks: picked }, isAction: true, legal: true };
  }
  // 他人签位：按 AI 最优代打一轮（保持与游戏一致），然后回到我方
  const before = donePicks;
  for (let guard = 0; guard < 64; guard++) {
    const doneNow = getDb().select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.year, evalRow.season), eq(picksT.status, "EXERCISED"))).all().length;
    const slot = order[doneNow];
    if (!slot) break;
    if (shortId(slot.holderTeamId) === evalRow.teamShortId) break;
    makeDraftPick(evalRow.saveId, {});
  }
  return { summary: `他人签位已按 AI 最优完成（${getDb().select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.year, evalRow.season), eq(picksT.status, "EXERCISED"))).all().length - before} 顺位），等待我方选择`, isAction: true, legal: true };
}

function toolFinishDraft(evalRow: { saveId: string; teamFullId: string; season: number }): ToolResult {
  const picked = makeDraftPick(evalRow.saveId, { simulateAll: true });
  return { summary: `剩余选秀自动完成（${picked.length} 顺位）`, data: { picks: picked }, isAction: true, legal: true };
}

/** 记录刚完成赛季的战绩/季后赛/冠军。 */
function recordSeason(evalRow: { id: string; saveId: string; teamFullId: string; seed: number; season: number }): { wins: number; losses: number; playoffResult: string; championName: string | null } {
  const db = getDb();
  // 完成的赛季 label = 当前（即将开打的）label - 1（prepareDraft 在选秀入口已滚动）
  const doneSeason = evalRow.season - 1;
  // 常规赛战绩只统计 REGULAR 场次（季后赛胜场另计入 playoffResult）
  const regGames = db
    .select()
    .from(gamesT)
    .where(and(eq(gamesT.saveId, evalRow.saveId), eq(gamesT.season, doneSeason), eq(gamesT.type, "REGULAR"), eq(gamesT.status, "FINAL")))
    .all();
  let regWins = 0;
  let regLosses = 0;
  for (const g of regGames) {
    if (g.homeTeamId !== evalRow.teamFullId && g.awayTeamId !== evalRow.teamFullId) continue;
    const homeWon = (g.homeScore ?? 0) > (g.awayScore ?? 0);
    const iAmHome = g.homeTeamId === evalRow.teamFullId;
    if (homeWon === iAmHome) regWins++;
    else regLosses++;
  }
  const roundsOrder = ["R1", "CONF_SEMI", "CONF_FINAL", "FINALS"];
  let playoffResult = "DNQ";
  for (let i = 0; i < roundsOrder.length; i++) {
    const round = roundsOrder[i];
    const played = db
      .select()
      .from(gamesT)
      .where(and(eq(gamesT.saveId, evalRow.saveId), eq(gamesT.season, doneSeason), eq(gamesT.type, "PLAYOFF"), eq(gamesT.round, round), eq(gamesT.status, "FINAL")))
      .all();
    if (played.some((g) => g.homeTeamId === evalRow.teamFullId || g.awayTeamId === evalRow.teamFullId)) {
      playoffResult = round === "FINALS" ? "FINALS_LOSS" : round;
    }
  }
  const champion = db.select().from(awardsT).where(and(eq(awardsT.saveId, evalRow.saveId), eq(awardsT.season, doneSeason), eq(awardsT.type, "CHAMPION"))).get();
  if (champion && champion.teamId === evalRow.teamFullId) playoffResult = "CHAMPION";
  const row = {
    id: uuid(),
    evaluationId: evalRow.id,
    season: doneSeason,
    wins: regWins,
    losses: regLosses,
    playoffResult,
    championTeamId: champion?.teamId ?? null,
    championName: champion?.detail ?? null,
    note: null,
  };
  db.insert(evalSeasonsT).values(row).run();
  return { wins: row.wins, losses: row.losses, playoffResult, championName: row.championName };
}

// ---------------------------------------------------------------------------
// 观察构建 + 单步状态机
// ---------------------------------------------------------------------------

function buildObservation(evalRow: { saveId: string; teamFullId: string; teamShortId: string; seed: number; season: number; years: number; seasonsDone: number; strategy: string | null }, stage: string): string {
  const state = loadLeagueState(evalRow.saveId, { includeGames: false });
  const team = state.teams.find((t) => t.id === evalRow.teamShortId);
  const st = standingsRank(state, evalRow.teamShortId);
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  const chemistry = getChemistry(evalRow.saveId, evalRow.teamShortId);
  const base = {
    stage,
    season: `${state.season - 1}-${String(state.season).slice(2)}`,
    currentDate: state.currentDate,
    myTeam: team ? `${team.city} ${team.name}` : "?",
    record: team ? `${team.wins}胜${team.losses}负` : "?",
    conferenceRank: st.rank,
    seasonsDone: `${evalRow.seasonsDone}/${evalRow.years}`,
    strategy: evalRow.strategy ?? "（未设置）",
    cap: { total: cap.totalSalary, space: cap.capSpace, overTax: cap.overTax },
    chemistry: chemistry.overall,
    rosterTop: teamRoster({ saveId: evalRow.saveId, teamFullId: evalRow.teamFullId })
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 8),
  };
  if (stage === "DRAFT") {
    const board = getDraftBoard(evalRow.saveId)
      .slice(0, 10)
      .map((p) => ({ name: p.name, pos: p.position, age: p.age, ovr: p.ratings.overall, upside: p.ratings.potentialHigh, strength: p.scouting.strengths[0] ?? "" }));
    const order = getDraftOrder(evalRow.saveId);
    const donePicks = getDb().select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.year, state.season), eq(picksT.status, "EXERCISED"))).all().length;
    const mine = order.findIndex((o, i) => i >= donePicks && shortId(o.holderTeamId) === evalRow.teamShortId);
    return JSON.stringify({ ...base, draft: { nextPick: donePicks + 1, myNextPick: mine >= 0 ? mine + 1 : null, topProspects: board } });
  }
  if (stage === "FREE_AGENCY") {
    const market = toolGetMarket({ ...evalRow });
    return JSON.stringify({ ...base, freeAgents: (market.data as { freeAgents: unknown }).freeAgents, capSpace: cap.capSpace });
  }
  return JSON.stringify(base);
}

function standingsRank(state: ReturnType<typeof loadLeagueState>, teamShortId: string): { rank: number } {
  const conf = state.teams.find((t) => t.id === teamShortId)?.conference ?? "EAST";
  const sorted = state.teams
    .filter((t) => t.conference === conf)
    .sort((a, b) => b.wins - a.wins || b.wins / Math.max(1, b.wins + b.losses) - a.wins / Math.max(1, a.wins + a.losses));
  return { rank: sorted.findIndex((t) => t.id === teamShortId) + 1 };
}

const SYSTEM_PROMPT = `你是篮球经理模拟游戏《HARDWOOD GM》中的球队总经理 AI。你通过返回严格 JSON 动作来运营球队。
可用动作（必须逐字使用 action 字段）：
- get_roster / get_assets / get_market：查看信息
- propose_trade：params = { partnerTeamId, givePlayerIds[], givePickIds[], receivePlayerIds[], receivePickIds[] }（所有 id 为服务器提供）
- sign_free_agent：params = { playerId, years, avgSalary }（自由市场阶段）
- draft_pick：params = { prospectId? }（选秀阶段；省略则选最优）
- finish_draft：剩余选秀全部自动完成
- set_strategy：params = { text }（记录你的建队策略）
- advance_season：推进当前赛季到结束（常规赛+季后赛）
- start_new_season：自由市场结束后开启新赛季
- do_nothing：观察一轮
约束：
1. 只输出一个 JSON 对象，格式：{"action":"...","params":{...},"decision":"一句话公开决策摘要","goals":"目标","expected":"预期收益","risks":"风险"}
2. 交易与签约由服务器规则裁决（薪资配平/人数/对方意愿），你只能提议。
3. 不得试图修改数据库、绕过规则或使用上帝模式。
4. 每个决策提交简短的公开摘要/目标/预期/风险；不要输出任何隐藏推理过程。`;

interface StepOutcome {
  status: string;
  stage: string;
  seasonsDone: number;
  done: boolean;
  lastTurn?: { action: string; decision?: string; summary: string; ok: boolean };
}

// 进程内步进锁：防止多个客户端（页面循环 + API）并发步进同一评测
const stepLocks = new Set<string>();

export async function stepEvaluation(id: string): Promise<StepOutcome> {
  if (stepLocks.has(id)) {
    const cur = getEvaluationRow(id);
    return { status: cur?.status ?? "RUNNING", stage: cur?.stage ?? "SEASON", seasonsDone: cur?.seasonsDone ?? 0, done: false, lastTurn: { action: "busy", summary: "该评测正在步进中（并发请求被忽略）", ok: false } };
  }
  stepLocks.add(id);
  try {
    return await stepEvaluationInner(id);
  } finally {
    stepLocks.delete(id);
  }
}

async function stepEvaluationInner(id: string): Promise<StepOutcome> {
  const db = getDb();
  const evalRow = getEvaluationRow(id);
  if (!evalRow) throw new EvalError("NO_EVAL", "评测不存在");
  if (evalRow.status === "DONE") return { status: evalRow.status, stage: evalRow.stage, seasonsDone: evalRow.seasonsDone, done: true };
  if (evalRow.status === "PAUSED") return { status: evalRow.status, stage: evalRow.stage, seasonsDone: evalRow.seasonsDone, done: false };
  if (evalRow.status === "CANCELLED") return { status: evalRow.status, stage: evalRow.stage, seasonsDone: evalRow.seasonsDone, done: true };
  if (evalRow.turnIndex >= MAX_TURNS) {
    db.update(evaluationsT).set({ status: "ERROR", error: `超过最大轮次 ${MAX_TURNS}`, updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
    return { status: "ERROR", stage: evalRow.stage, seasonsDone: evalRow.seasonsDone, done: true };
  }
  if (evalRow.status === "PENDING") {
    db.update(evaluationsT).set({ status: "RUNNING", updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
  }

  const evalCtx = {
    id: evalRow.id,
    saveId: evalRow.saveId,
    teamFullId: evalRow.teamFullId,
    teamShortId: evalRow.teamShortId,
    seed: evalRow.seed,
    season: getSave(evalRow.saveId)!.season,
    years: evalRow.years,
    seasonsDone: evalRow.seasonsDone,
    strategy: evalRow.strategy,
  };
  let stage = evalRow.stage;

  // 阶段校正（引擎阶段可能已被上一步推进）
  const saveRow = getSave(evalRow.saveId)!;
  if (stage === "SEASON" && saveRow.phase === "DRAFT") stage = "DRAFT";
  if (stage === "SEASON" && saveRow.phase === "FREE_AGENCY") stage = "FREE_AGENCY";
  if (stage === "DRAFT" && saveRow.phase === "FREE_AGENCY") stage = "FREE_AGENCY";

  // DRAFT 无新秀可选拆（真实名单存档没有新秀池）→ 直接进入自由市场
  if (stage === "DRAFT" && getDraftBoard(evalRow.saveId).length === 0) {
    startFreeAgency(evalRow.saveId);
    stage = "FREE_AGENCY";
  }

  const turnIndex = evalRow.turnIndex + 1;
  const apiKey = evalRow.apiKeyEnc ? decryptForEval(evalRow.apiKeyEnc) : null;

  // 回放模式：直接取源评测的记录动作，不调用 Provider
  let action: GmAction;
  let params: Record<string, unknown>;
  let decision: string | undefined;
  let goals: string | undefined;
  let expected: string | undefined;
  let risks: string | undefined;
  let latencyMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costCents = 0;
  let rawResponse: string | undefined;

  if (evalRow.replayOf) {
    const srcTurn = db
      .select()
      .from(evalTurnsT)
      .where(and(eq(evalTurnsT.evaluationId, evalRow.replayOf), eq(evalTurnsT.turnIndex, turnIndex)))
      .get();
    if (!srcTurn) {
      // 源动作序列耗尽：视为完成
      const done = finishEvaluation(evalRow.id);
      compareReplayWithSource(id);
      return done;
    }
    action = srcTurn.action as GmAction;
    params = (srcTurn.params ?? {}) as Record<string, unknown>;
    decision = srcTurn.decision ?? undefined;
  } else {
    const observation = buildObservation(evalCtx, stage);
    const stubScene = {
      stage,
      hasSignedThisStage: stage === "FREE_AGENCY" && db.select().from(faOffersT).where(and(eq(faOffersT.saveId, evalRow.saveId))).all().some((o) => o.teamId === evalRow.teamFullId),
      lastTurnWasSignAttempt:
        evalRow.turnIndex > 0 &&
        db
          .select()
          .from(evalTurnsT)
          .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.turnIndex, evalRow.turnIndex)))
          .get()?.action === "sign_free_agent",
      tradeAttempted:
        db
          .select()
          .from(evalTurnsT)
          .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.action, "propose_trade")))
          .all().length > 0,
      strategySet:
        db
          .select()
          .from(evalTurnsT)
          .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.action, "set_strategy")))
          .all().length > 0,
      seasonsDone: evalRow.seasonsDone,
      years: evalRow.years,
    };
    const cfg = { provider: evalRow.provider as "STUB" | "OPENAI_COMPAT", baseUrl: evalRow.baseUrl, model: evalRow.model, apiKey };
    const messages = [{ role: "assistant" as const, content: `上一回合结束，当前观察：\n${observation}` }];
    if (evalRow.turnIndex === 0) messages.unshift({ role: "assistant", content: "评测开始。" });
    // DeepSeek may include the public decision fields after its reasoning; leave
    // enough output budget for one complete action object.
    const r = await providerChat(cfg, { system: SYSTEM_PROMPT, messages, maxTokens: 1200 }, stubScene);
    latencyMs = r.latencyMs;
    tokensIn = r.tokensIn;
    tokensOut = r.tokensOut;
    costCents = r.costCents;
    rawResponse = r.content.slice(0, 2000);
    if (r.error || !r.action) {
      // Provider 错误 / 无法解析：记录错误并 no-op（不中断评测）
      db.insert(evalTurnsT)
        .values({
          id: uuid(), evaluationId: id, turnIndex, stage, at: now(), action: "provider_error", params: null,
          resultSummary: "Provider 调用失败或回复不可解析", ok: false, latencyMs, tokensIn, tokensOut, costCents,
          error: r.error ?? "回复中未找到合法动作 JSON", rawResponse,
        })
        .run();
      db.update(evaluationsT)
        .set({ turnIndex, callCount: evalRow.callCount + 1, errorCount: evalRow.errorCount + 1, latencyMsSum: evalRow.latencyMsSum + latencyMs, tokensIn: evalRow.tokensIn + tokensIn, tokensOut: evalRow.tokensOut + tokensOut, costCents: evalRow.costCents + costCents, updatedAt: now() })
        .where(eq(evaluationsT.id, id))
        .run();
      // 连续 3 次 Provider 失败 → 熔断为 ERROR（避免空转 600 轮）
      const recentErrors = db
        .select()
        .from(evalTurnsT)
        .where(and(eq(evalTurnsT.evaluationId, id), eq(evalTurnsT.action, "provider_error")))
        .orderBy(desc(evalTurnsT.turnIndex))
        .limit(3)
        .all();
      if (recentErrors.length >= 3 && recentErrors.every((t) => !t.ok)) {
        db.update(evaluationsT)
          .set({ status: "ERROR", error: `Provider 连续失败：${(r.error ?? "解析失败").slice(0, 200)}`, updatedAt: now() })
          .where(eq(evaluationsT.id, id))
          .run();
        return { status: "ERROR", stage, seasonsDone: evalRow.seasonsDone, done: true, lastTurn: { action: "provider_error", summary: r.error ?? "解析失败", ok: false } };
      }
      return { status: "RUNNING", stage, seasonsDone: evalRow.seasonsDone, done: false, lastTurn: { action: "provider_error", summary: r.error ?? "解析失败", ok: false } };
    }
    action = r.action!.action;
    params = r.action!.params;
    decision = r.action!.decision;
    goals = r.action!.goals;
    expected = r.action!.expected;
    risks = r.action!.risks;
  }

  // 权限白名单：阶段不允许的动作直接拒绝（不执行）
  const allowed = STAGE_ALLOWED_ACTIONS[stage] ?? [];
  let toolResult: ToolResult;
  let executedOk = true;
  if (!allowed.includes(action)) {
    toolResult = { summary: `动作 ${action} 在 ${stage} 阶段不被允许（允许：${allowed.join(", ")}）`, isAction: true, legal: false };
    executedOk = false;
  } else {
    try {
      switch (action) {
        case "get_roster":
          toolResult = toolGetRoster({ ...evalCtx });
          break;
        case "get_assets":
          toolResult = toolGetAssets({ ...evalCtx });
          break;
        case "get_market":
          toolResult = toolGetMarket({ ...evalCtx });
          break;
        case "propose_trade":
          toolResult = toolProposeTrade({ ...evalCtx }, params);
          break;
        case "sign_free_agent":
          if (stage !== "FREE_AGENCY") throw new EvalError("WRONG_STAGE", "签约仅在自由市场阶段");
          toolResult = toolSignFreeAgent({ ...evalCtx }, params);
          break;
        case "draft_pick":
          toolResult = toolDraftPick({ ...evalCtx }, params);
          break;
        case "finish_draft":
          toolResult = toolFinishDraft({ saveId: evalRow.saveId, teamFullId: evalRow.teamFullId, season: evalCtx.season });
          break;
        case "set_strategy":
          db.update(evaluationsT).set({ strategy: String(params.text ?? "").slice(0, 500), updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
          toolResult = { summary: `策略已记录：${String(params.text ?? "").slice(0, 80)}`, isAction: false };
          break;
        case "advance_season": {
          const r = advanceSim(evalRow.saveId, "SEASON");
          toolResult = { summary: `赛季推进完成：${r.days} 天 / ${r.gamesPlayed} 场${r.phaseChanged ? `，进入 ${r.phaseChanged}` : ""}`, data: { days: r.days, games: r.gamesPlayed }, isAction: true, legal: true };
          break;
        }
        case "start_new_season": {
          const rec = recordSeason({ ...evalCtx });
          startNewSeason(evalRow.saveId);
          const seasonsDone = evalRow.seasonsDone + 1;
          db.update(evaluationsT).set({ seasonsDone, updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
          if (seasonsDone >= evalRow.years) {
            db.insert(evalTurnsT)
              .values({
                id: uuid(), evaluationId: id, turnIndex, stage, at: now(), action, params, decision, goals, expected, risks,
                resultSummary: `第 ${seasonsDone} 赛季完成（${rec.wins}胜${rec.losses}负，季后赛 ${rec.playoffResult}），评测结束`, ok: true, legal: 1,
                latencyMs, tokensIn, tokensOut, costCents, rawResponse,
              })
              .run();
            db.update(evaluationsT).set({ turnIndex, stage: "DONE", updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
            const done = finishEvaluation(id);
            if (evalRow.replayOf) compareReplayWithSource(id);
            return done;
          }
          toolResult = { summary: `第 ${seasonsDone} 赛季完成（${rec.wins}胜${rec.losses}负，季后赛 ${rec.playoffResult}${rec.championName ? `，总冠军 ${rec.championName}` : ""}），进入新赛季`, isAction: true, legal: true };
          break;
        }
        case "do_nothing":
          toolResult = { summary: "观察一轮（无操作）", isAction: false };
          break;
        default:
          toolResult = { summary: `未知动作 ${action}`, isAction: true, legal: false };
          executedOk = false;
      }
    } catch (e) {
      const err = e as Error;
      toolResult = { summary: `工具执行失败：${err.message.slice(0, 200)}`, isAction: true, legal: false };
      executedOk = false;
    }
  }

  // 记录回合
  db.insert(evalTurnsT)
    .values({
      id: uuid(),
      evaluationId: id,
      turnIndex,
      stage,
      at: now(),
      action,
      params,
      decision,
      goals,
      expected,
      risks,
      resultSummary: toolResult.summary.slice(0, 400),
      ok: executedOk,
      legal: toolResult.isAction ? (toolResult.legal === true ? 1 : 0) : null,
      latencyMs,
      tokensIn,
      tokensOut,
      costCents,
      error: executedOk ? null : toolResult.summary.slice(0, 300),
      rawResponse,
    })
    .run();

  // 统计累加
  const isAction = toolResult.isAction === true;
  const isLegal = toolResult.isAction ? toolResult.legal === true : null;
  db.update(evaluationsT)
    .set({
      turnIndex,
      stage,
      callCount: evalRow.callCount + (evalRow.replayOf ? 0 : 1),
      actionCount: evalRow.actionCount + (isAction ? 1 : 0),
      legalCount: evalRow.legalCount + (isAction && isLegal ? 1 : 0),
      errorCount: evalRow.errorCount + (executedOk ? 0 : 1),
      latencyMsSum: evalRow.latencyMsSum + latencyMs,
      tokensIn: evalRow.tokensIn + tokensIn,
      tokensOut: evalRow.tokensOut + tokensOut,
      costCents: evalRow.costCents + costCents,
      updatedAt: now(),
    })
    .where(eq(evaluationsT.id, id))
    .run();

  // 阶段推进（引擎阶段变化时同步 stage）
  const saveAfter = getSave(evalRow.saveId)!;
  let newStage = stage;
  if (stage === "SEASON" && saveAfter.phase === "DRAFT") newStage = "DRAFT";
  else if (stage === "SEASON" && saveAfter.phase === "FREE_AGENCY") newStage = "FREE_AGENCY";
  else if (stage === "DRAFT" && saveAfter.phase === "FREE_AGENCY") newStage = "FREE_AGENCY";
  else if (stage === "FREE_AGENCY" && saveAfter.phase === "REGULAR_SEASON") newStage = "SEASON";
  if (newStage !== stage) db.update(evaluationsT).set({ stage: newStage, updatedAt: now() }).where(eq(evaluationsT.id, id)).run();

  return {
    status: "RUNNING",
    stage: newStage,
    seasonsDone: evalRow.seasonsDone,
    done: false,
    lastTurn: { action, decision, summary: toolResult.summary, ok: executedOk },
  };
}

// ---------------------------------------------------------------------------
// 完成 + 评分（GM-BENCH v1）
// ---------------------------------------------------------------------------

export function finishEvaluation(id: string): StepOutcome {
  const db = getDb();
  const evalRow = getEvaluationRow(id)!;
  const seasons = db.select().from(evalSeasonsT).where(eq(evalSeasonsT.evaluationId, id)).all().sort((a, b) => a.season - b.season);
  const totalWins = seasons.reduce((a, s) => a + s.wins, 0);
  const totalLosses = seasons.reduce((a, s) => a + s.losses, 0);
  const playoffCount = seasons.filter((s) => s.playoffResult !== "DNQ").length;
  const finalsCount = seasons.filter((s) => s.playoffResult === "FINALS_LOSS" || s.playoffResult === "CHAMPION").length;
  const champCount = seasons.filter((s) => s.playoffResult === "CHAMPION").length;
  const actionCount = evalRow.actionCount;
  const legalRate = actionCount > 0 ? evalRow.legalCount / actionCount : 1;
  const errorRate = evalRow.callCount > 0 ? evalRow.errorCount / evalRow.callCount : 0;
  const chemistry = getChemistry(evalRow.saveId, shortId(evalRow.teamFullId)).overall;
  const tradeEvents = db.select().from(eventsT).where(and(eq(eventsT.saveId, evalRow.saveId), eq(eventsT.category, "TRADE"))).all();
  const seasonsRecorded = Math.max(1, seasons.length);
  const winsPerSeason = totalWins / seasonsRecorded;

  // GM-BENCH v1：版本化公式（改动必须升版本）
  const score = Math.round(
    winsPerSeason * 1.2 +
      playoffCount * 6 +
      finalsCount * 8 +
      champCount * 25 +
      legalRate * 20 -
      errorRate * 15 +
      (chemistry - 60) * 0.15,
  );

  const scoreJson = {
    version: SCORE_VERSION,
    score,
    totalWins,
    totalLosses,
    winsPerSeason: Math.round(winsPerSeason * 10) / 10,
    seasonsRecorded: seasons.length,
    playoffCount,
    finalsCount,
    champCount,
    legalRate: Math.round(legalRate * 1000) / 1000,
    errorRate: Math.round(errorRate * 1000) / 1000,
    actionCount,
    callCount: evalRow.callCount,
    errorCount: evalRow.errorCount,
    latencyMsSum: evalRow.latencyMsSum,
    tokensIn: evalRow.tokensIn,
    tokensOut: evalRow.tokensOut,
    costCents: evalRow.costCents,
    finalChemistry: chemistry,
    tradeCount: tradeEvents.length,
    trades: tradeEvents.map((t) => t.message).slice(0, 30),
    formula: "score = winsPerSeason*1.2 + playoffs*6 + finals*8 + champs*25 + legalRate*20 - errorRate*15 + (chem-60)*0.15",
  };

  db.update(evaluationsT)
    .set({ status: "DONE", stage: "DONE", score: scoreJson as never, finishedAt: now(), updatedAt: now() })
    .where(eq(evaluationsT.id, id))
    .run();
  return { status: "DONE", stage: "DONE", seasonsDone: evalRow.seasonsDone, done: true, lastTurn: { action: "finish", summary: `评测完成，GM-BENCH v1 得分 ${score}`, ok: true } };
}

// ---------------------------------------------------------------------------
// 控制与回放
// ---------------------------------------------------------------------------

export function controlEvaluation(id: string, action: "start" | "pause" | "cancel") {
  const db = getDb();
  const evalRow = getEvaluationRow(id);
  if (!evalRow) throw new EvalError("NO_EVAL", "评测不存在");
  if (action === "pause" && evalRow.status === "RUNNING") {
    db.update(evaluationsT).set({ status: "PAUSED", updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
  } else if (action === "start" && (evalRow.status === "PAUSED" || evalRow.status === "PENDING")) {
    db.update(evaluationsT).set({ status: "RUNNING", updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
  } else if (action === "cancel" && evalRow.status !== "DONE") {
    db.update(evaluationsT).set({ status: "CANCELLED", finishedAt: now(), updatedAt: now() }).where(eq(evaluationsT.id, id)).run();
  } else {
    throw new EvalError("BAD_TRANSITION", `当前状态 ${evalRow.status} 不允许 ${action}`);
  }
  return getEvaluationRow(id)!.status;
}

/** 创建回放评测：重新克隆基准存档（同种子），按记录动作序列重放，不调用模型。 */
export function startReplay(sourceEvalId: string): { id: string } {
  const src = getEvaluationRow(sourceEvalId);
  if (!src) throw new EvalError("NO_EVAL", "源评测不存在");
  if (src.status !== "DONE") throw new EvalError("NOT_DONE", "源评测尚未完成，无法回放");
  const { saveId } = cloneSaveForEval(src.baseSaveId, src.seed, src.teamShortId, `${src.name} 回放`);
  const id = uuid();
  getDb()
    .insert(evaluationsT)
    .values({
      id,
      name: `${src.name} · 回放`,
      baseSaveId: src.baseSaveId,
      saveId,
      provider: src.provider,
      baseUrl: src.baseUrl,
      model: src.model,
      apiKeyMasked: null,
      apiKeyEnc: null,
      teamShortId: src.teamShortId,
      teamFullId: `${saveId}:${src.teamShortId}`,
      seed: src.seed,
      years: src.years,
      status: "PENDING",
      stage: "SEASON",
      seasonsDone: 0,
      turnIndex: 0,
      strategy: src.strategy,
      replayOf: src.id,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return { id };
}

/** 回放完成时与源结果对比（写入 score.replayMatch）。 */
export function compareReplayWithSource(replayId: string): { match: boolean } {
  const replay = getEvaluationRow(replayId);
  if (!replay?.replayOf) throw new EvalError("NOT_REPLAY", "不是回放评测");
  const src = getEvaluationRow(replay.replayOf)!;
  const srcSeasons = getDb().select().from(evalSeasonsT).where(eq(evalSeasonsT.evaluationId, src.id)).all().sort((a, b) => a.season - b.season);
  const replaySeasons = getDb().select().from(evalSeasonsT).where(eq(evalSeasonsT.evaluationId, replay.id)).all().sort((a, b) => a.season - b.season);
  const sig = (rows: typeof srcSeasons) => JSON.stringify(rows.map((r) => [r.wins, r.losses, r.playoffResult]));
  const match = sig(srcSeasons) === sig(replaySeasons);
  const baseScore = (replay.score ?? {}) as Record<string, unknown>;
  const score = { ...baseScore, replayOf: src.id, sourceScore: (src.score ?? {}).score, replayMatch: match };
  getDb().update(evaluationsT).set({ score: score as never, updatedAt: now() }).where(eq(evaluationsT.id, replayId)).run();
  return { match };
}

/** 评测详情（含面板数据）。 */
export function getEvaluationDetail(id: string) {
  const evalRow = getEvaluationRow(id);
  if (!evalRow) throw new EvalError("NO_EVAL", "评测不存在");
  const db = getDb();
  const turns = db.select().from(evalTurnsT).where(eq(evalTurnsT.evaluationId, id)).orderBy(asc(evalTurnsT.turnIndex)).all();
  const seasons = db.select().from(evalSeasonsT).where(eq(evalSeasonsT.evaluationId, id)).all().sort((a, b) => a.season - b.season);
  const tradeEvents = db.select().from(eventsT).where(and(eq(eventsT.saveId, evalRow.saveId), eq(eventsT.category, "TRADE"))).all();
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  const chemistry = getChemistry(id && evalRow.saveId, shortId(evalRow.teamFullId));
  const team = db.select().from(teamsT).where(eq(teamsT.id, evalRow.teamFullId)).get();
  const { apiKeyEnc: _enc, ...safeEval } = evalRow;
  void _enc;
  return { evaluation: safeEval, turns, seasons, tradeEvents, cap, chemistry, team, done: evalRow.status === "DONE" };
}
