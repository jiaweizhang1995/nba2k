// AI GM 评测：独立快照存档 + 受控工具 + 阶段状态机 + 评分 + 回放。
//
// 铁律：
//  - 评测在克隆存档上进行，永不修改用户原始存档
//  - LLM 只能调用本文件白名单内的受控工具；工具内部全部走现有 engine 的
//    规则校验与事务 —— 不能改数据库、不能 God Mode、不能绕过规则
//  - 引擎确定性：同一克隆 + 同一种子 + 同一动作序列 ⇒ 结果相同，
//    因此回放（不调用模型）可以得到相同结果
//  - 只记录模型主动提交的公开决策摘要，不获取隐藏思维链

import fs from "node:fs";
import path from "node:path";
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
import { capSnapshot, seasonMoney } from "@/domain/salary";
import { pickValue } from "@/domain/trade";
import { askingSalaryFor, isRestrictedFa } from "@/domain/freeagency";
import { providerChat, STAGE_ALLOWED_ACTIONS, type GmAction, type GmActionPayload } from "@/lib/eval-provider";
import { decryptKey, encryptKey, maskKey } from "@/lib/eval-crypto";
import {
  advanceSim,
  deadCapHit,
  declineOption,
  executeTrade,
  getAiTradeFeedback,
  getChemistry,
  getDraftBoard,
  getDraftOrder,
  getPhaseState,
  getSave,
  extendContract,
  listInboundOffers,
  listOfferSheets,
  loadLeagueState,
  makeDraftPick,
  respondInboundOffer,
  respondOfferSheet,
  setRotation,
  startFreeAgency,
  startNewSeason,
  submitFaOffer,
  validateTradeOnServer,
  waivePlayer,
} from "./engine";

export const uuid = () => globalThis.crypto.randomUUID();

/** 阶段动作白名单（权限测试依据）。 */
export function isActionAllowed(stage: string, action: GmAction): boolean {
  return (STAGE_ALLOWED_ACTIONS[stage] ?? []).includes(action);
}
const now = () => new Date().toISOString();
const shortId = (full: string) => full.split(":").slice(1).join(":");
const MAX_TURNS = 600;

export const SCORE_VERSION = "GM-BENCH v3";

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
      tx.insert(playersT).values({ ...p, id: `${newId}:${shortId(p.id)}`, saveId: newId, teamId: p.teamId ? `${newId}:${shortId(p.teamId)}` : null, lastTeamId: p.lastTeamId ? `${newId}:${shortId(p.lastTeamId)}` : null }).run();
    }
    for (const k of db.select().from(picksT).where(eq(picksT.saveId, baseSaveId)).all()) {
      tx.insert(picksT).values({ ...k, id: `${newId}:${shortId(k.id)}`, saveId: newId, originalTeamId: `${newId}:${shortId(k.originalTeamId)}`, holderTeamId: `${newId}:${shortId(k.holderTeamId)}` }).run();
    }
    for (const g of db.select().from(gamesT).where(eq(gamesT.saveId, baseSaveId)).all()) {
      tx.insert(gamesT).values({ ...g, id: `${newId}:${shortId(g.id)}`, saveId: newId, homeTeamId: `${newId}:${shortId(g.homeTeamId)}`, awayTeamId: `${newId}:${shortId(g.awayTeamId)}` }).run();
    }
    for (const a of db.select().from(awardsT).where(eq(awardsT.saveId, baseSaveId)).all()) {
      // Award ids are bare uuids (no saveId prefix) — keep them unique with a fresh id.
      tx.insert(awardsT).values({ ...a, id: uuid(), saveId: newId, teamId: a.teamId ? `${newId}:${shortId(a.teamId)}` : null, playerId: a.playerId ? `${newId}:${shortId(a.playerId)}` : null }).run();
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
  provider: "STUB" | "OPENAI_COMPAT" | "AGENT";
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

// ---------------------------------------------------------------------------
// AGENT provider — the CLI agent (or any out-of-process GM) drives the eval
// through a file queue: stepEvaluation returns the observation and waits;
// the agent writes its action JSON to the queue file; the next step consumes
// it. Determinism does not apply — the agent is a real decision-maker.
// ---------------------------------------------------------------------------

const AGENT_QUEUE_DIR = path.join(process.cwd(), "data", "eval-queue");

export function agentQueuePath(evalId: string): string {
  return path.join(AGENT_QUEUE_DIR, `${evalId}.json`);
}

/** Queue an action for an AGENT-provider evaluation. */
export function writeAgentAction(evalId: string, action: GmActionPayload): void {
  fs.mkdirSync(AGENT_QUEUE_DIR, { recursive: true });
  fs.writeFileSync(agentQueuePath(evalId), JSON.stringify(action));
}

function readAgentAction(evalId: string): GmActionPayload | null {
  const p = agentQueuePath(evalId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as GmActionPayload;
  } catch {
    return null;
  }
}

function clearAgentAction(evalId: string): void {
  try {
    fs.unlinkSync(agentQueuePath(evalId));
  } catch {
    /* already gone */
  }
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

function teamRoster(evalRow: { saveId: string; teamFullId: string; season?: number }) {
  const db = getDb();
  const season = evalRow.season ?? getSave(evalRow.saveId)?.season ?? 0;
  const rows = db.select().from(playersT).where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId))).all();
  return rows.map((p) => {
    const endSeason = p.contract.years[p.contract.years.length - 1]?.season ?? season;
    return {
      id: shortId(p.id),
      name: p.name,
      position: p.position,
      age: p.age,
      overall: p.ratings.overall,
      potential: p.ratings.potential,
      yearsPro: p.yearsPro,
      role: p.role,
      salary: p.contract.years[0]?.salary ?? 0,
      endSeason,
      yearsLeft: p.contract.years.length,
      expiring: endSeason <= season,
      // Extendable while ≤2 seasons remain — his camp's asking price/year.
      extendable: p.contract.years.length >= 1 && p.contract.years.length <= 2,
      extensionAsk: p.contract.years.length >= 1 && p.contract.years.length <= 2 ? askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, season) : null,
      injured: !!(p.injury && p.injury.weeksRemaining > 0),
      injuryWeeks: p.injury?.weeksRemaining ?? 0,
      stamina: Math.round(p.stamina * 100),
      gamesPlayed: p.seasonStats.find((s) => s.season === season)?.g ?? 0,
      mpg: (() => {
        const st = p.seasonStats.find((s) => s.season === season);
        return st && st.g > 0 ? Math.round((st.mp / st.g) * 10) / 10 : 0;
      })(),
      ppg: (() => {
        const st = p.seasonStats.find((s) => s.season === season);
        return st && st.g > 0 ? Math.round((st.pts / st.g) * 10) / 10 : 0;
      })(),
      noTrade: p.contract.noTrade,
      // PO on the final year = he can walk this summer; TO = our call.
      option: p.contract.option,
      // TO auto-exercised at rollover — still declinable this offseason.
      optionPending: (getPhaseState(evalRow.saveId)[`toPending:${season}`] as string[] | undefined)?.includes(shortId(p.id)) === true,
      // Morale signal: losing teams and buried talent erode satisfaction;
      // a disgruntled star is a trade-demand waiting to happen.
      morale: p.satisfaction <= 40 ? "UNHAPPY" : p.satisfaction <= 58 ? "UNEASY" : "CONTENT",
    };
  });
}

function capSummaryOf(saveId: string, teamFullId: string) {
  const db = getDb();
  const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, teamFullId))).all();
  return capSnapshot(roster, roster.length, deadCapHit(saveId, shortId(teamFullId)), getSave(saveId)?.season);
}

function toolGetRoster(evalRow: { saveId: string; teamFullId: string; seed: number }): ToolResult {
  const chemistry = getChemistry(evalRow.saveId, shortId(evalRow.teamFullId));
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  const rotation = ((getPhaseState(evalRow.saveId).rotation as Record<string, { starters?: string[]; minutes?: Record<string, number> }> | undefined) ?? {})[shortId(evalRow.teamFullId)] ?? null;
  return {
    summary: `查看阵容：${teamRoster(evalRow).length} 人`,
    data: { roster: teamRoster(evalRow), rotation, chemistry: chemistry.overall, chemistryFactors: chemistry.factors, cap },
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
    .map((p) => ({ id: shortId(p.id), year: p.year, round: p.round, protection: p.protection?.type ?? "NONE" }));
  // Picks of MINE held by other teams — owed obligations the GM must track.
  const owed = db
    .select()
    .from(picksT)
    .where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.originalTeamId, evalRow.teamFullId)))
    .all()
    .filter((p) => p.status === "OWNED" && p.holderTeamId !== evalRow.teamFullId)
    .map((p) => ({ year: p.year, round: p.round, heldBy: shortId(p.holderTeamId), protection: p.protection?.type ?? "NONE" }));
  const cap = capSummaryOf(evalRow.saveId, evalRow.teamFullId);
  const contracts = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId)))
    .all()
    .map((p) => ({ id: shortId(p.id), name: p.name, salary: p.contract.years[0]?.salary ?? 0, endSeason: p.contract.years[p.contract.years.length - 1]?.season ?? null }))
    .sort((a, b) => b.salary - a.salary)
    .slice(0, 8);
  return {
    summary: `查看资产：未来签 ${picks.length} 个，薪资总额 ${cap.totalSalary}M`,
    data: { picks, owedPicks: owed, cap, topContracts: contracts },
    isAction: false,
  };
}

function toolGetMarket(evalRow: { saveId: string; teamFullId: string; seed: number; season: number }, params?: Record<string, unknown>): ToolResult {
  const db = getDb();
  const sheetPlayerIds = new Set(listOfferSheets(evalRow.saveId).map((s) => s.playerId));
  // Scouting view: a specific team's full roster + contract books.
  if (params?.teamId) {
    const fullId = `${evalRow.saveId}:${String(params.teamId)}`;
    const team = db.select().from(teamsT).where(eq(teamsT.id, fullId)).get();
    if (!team) return { summary: "球队不存在", isAction: false };
    const roster = db.select().from(playersT).where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, fullId))).all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .map((p) => ({
        id: shortId(p.id), name: p.name, pos: p.position, age: p.age, ovr: p.ratings.overall, pot: p.ratings.potential,
        salary: p.contract.years[0]?.salary ?? 0, endSeason: p.contract.years[p.contract.years.length - 1]?.season ?? null,
        option: p.contract.option, noTrade: p.contract.noTrade, morale: p.satisfaction <= 40 ? "UNHAPPY" : p.satisfaction <= 58 ? "UNEASY" : "CONTENT",
        injured: !!(p.injury && p.injury.weeksRemaining > 0),
      }));
    const cap = capSummaryOf(evalRow.saveId, fullId);
    const picks = db.select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.holderTeamId, fullId))).all()
      .filter((k) => k.status === "OWNED")
      .map((k) => ({ id: shortId(k.id), year: k.year, round: k.round, protection: k.protection?.type ?? "NONE" }));
    return { summary: `侦察 ${team.abbr}：${roster.length} 人，帽空间 ${cap.capSpace}M`, data: { team: { id: shortId(team.id), abbr: team.abbr, phase: team.aiPhase, record: `${team.wins}-${team.losses}` }, roster, cap: { total: cap.totalSalary, space: cap.capSpace, overTax: cap.overTax, overSecondApron: cap.overSecondApron }, picks }, isAction: false };
  }
  const fas = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.status, "FREE_AGENT")))
    .all()
    .map((p) => ({
      id: shortId(p.id),
      name: p.name,
      position: p.position,
      age: p.age,
      overall: p.ratings.overall,
      potential: p.ratings.potential,
      asking: askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, getSave(evalRow.saveId)?.season),
      askingYears: Math.max(1, Math.min(4, p.age >= 32 ? 2 : 4)),
      // Own expired player: we hold Bird rights and can re-sign over the cap.
      fromMyTeam: p.lastTeamId === evalRow.teamFullId,
      lastTeamAbbr: p.lastTeamId ? shortId(p.lastTeamId) : null,
      // Expired rookie-scale deal → restricted FA: the last team can match.
      restricted: isRestrictedFa(p),
      underOfferSheet: sheetPlayerIds.has(p.id),
    }))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 16);
  const teams = db.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all();
  const sample = teams
    .filter((t) => t.id !== evalRow.teamFullId)
    .map((t) => {
      const roster = db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, t.id)))
        .all()
        .sort((a, b) => b.ratings.overall - a.ratings.overall);
      const cap = capSummaryOf(evalRow.saveId, t.id);
      const top = roster.slice(0, 4).map((p) => ({ id: shortId(p.id), name: p.name, pos: p.position, overall: p.ratings.overall, salary: p.contract.years[0]?.salary ?? 0, morale: p.satisfaction <= 40 ? "UNHAPPY" : "OK" }));
      return { teamId: shortId(t.id), abbr: t.abbr, phase: t.aiPhase, record: `${t.wins}-${t.losses}`, capSpace: cap.capSpace, rosterSize: roster.length, top };
    });
  return { summary: `查看市场：自由球员 ${fas.length} 人（展示前 16），全联盟 ${sample.length} 队`, data: { freeAgents: fas, teams: sample }, isAction: false };
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
  // Negotiated pick protections: the agent may attach top-x protection to
  // first-round picks it's giving away. Protection lives on the pick row and
  // moves with it — apply before valuation, restore if the trade dies.
  const protReq = (params.pickProtections ?? {}) as Record<string, { x?: number }>;
  const protBackup = new Map<string, unknown>();
  const appliedProt: string[] = [];
  const restoreProt = () => {
    for (const [id, old] of protBackup) getDb().update(picksT).set({ protection: old as never }).where(eq(picksT.id, id)).run();
  };
  for (const [sid, spec] of Object.entries(protReq)) {
    if (!givePicks.some((a) => a.id === sid)) continue; // only picks we give
    const row = getDb().select().from(picksT).where(eq(picksT.id, `${evalRow.saveId}:${sid}`)).get();
    const x = Math.max(1, Math.min(14, Math.floor(Number(spec?.x ?? 0))));
    if (!row || row.round !== 1 || !x) continue;
    protBackup.set(row.id, row.protection);
    getDb().update(picksT).set({ protection: { type: "LOTTERY_TOP_X", x, yearShift: 1 } }).where(eq(picksT.id, row.id)).run();
    appliedProt.push(sid);
  }
  const validation = validateTradeOnServer(evalRow.saveId, parties);
  if (!validation.legal) {
    restoreProt();
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
    restoreProt();
    return {
      summary: `规则允许但对方 GM 拒绝：${rejected.map((f) => `${f.teamId}（价值差 ${f.verdict.valueDelta}）：${f.verdict.feedback}`).join("；").slice(0, 200)}`,
      data: { validation, feedback },
      isAction: true,
      legal: true,
    };
  }
  const result = executeTrade(evalRow.saveId, parties, {});
  if (!result.executed) {
    restoreProt();
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
      .filter((p) => p.ratings.overall >= 70)
      .sort((a, b) => a.ratings.overall - b.ratings.overall || a.age - b.age);
    if (!fas.length) return { summary: "自由市场无合适目标（综合 ≥ 55）", isAction: true, legal: true };
    const pickFas = fas[fas.length - 1];
    playerId = shortId(pickFas.id);
    years = 2;
    // Offer ~95% of his real market ask, never below the season's minimum.
    const ask = askingSalaryFor(pickFas.contract, pickFas.yearsPro, pickFas.ratings.overall, pickFas.age, evalRow.season);
    salary = Math.max(seasonMoney(evalRow.season).minimumSalary, Math.round(ask * 0.95 * 10) / 10);
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
  const db = getDb();
  const recentEvents = db
    .select()
    .from(eventsT)
    .where(eq(eventsT.saveId, evalRow.saveId))
    .orderBy(desc(eventsT.at))
    .limit(8)
    .all()
    .map((e) => `${e.category}: ${e.message}`)
    .reverse();
  const fullRoster = teamRoster({ saveId: evalRow.saveId, teamFullId: evalRow.teamFullId, season: state.season }).sort((a, b) => b.overall - a.overall);
  const base = {
    stage,
    allowedActions: STAGE_ALLOWED_ACTIONS[stage] ?? [],
    season: `${state.season - 1}-${String(state.season).slice(2)}`,
    currentDate: state.currentDate,
    myTeam: team ? `${team.city} ${team.name}` : "?",
    record: team ? `${team.wins}胜${team.losses}负` : "?",
    conferenceRank: st.rank,
    seasonsDone: `${evalRow.seasonsDone}/${evalRow.years}`,
    strategy: evalRow.strategy ?? "（未设置）",
    cap: { total: cap.totalSalary, space: cap.capSpace, overTax: cap.overTax, overFirstApron: cap.overFirstApron, overSecondApron: cap.overSecondApron, mleUsed: !!getPhaseState(evalRow.saveId)[`mleUsed:${state.season}`] },
    chemistry: chemistry.overall,
    roster: fullRoster,
    // Players whose contract ends this offseason — they enter the market and
    // we hold Bird rights (re-signable over the cap). Plan before FA opens.
    expiringThisOffseason: fullRoster.filter((p) => p.expiring).map((p) => ({ id: p.id, name: p.name, overall: p.overall, salary: p.salary })),
    inboundOffers: listInboundOffers(evalRow.saveId).map((o) => ({ offerId: o.id, fromTeam: o.fromTeam, theyGive: o.giveNames, theyWant: o.wantNames, expiresOn: o.expiresOn })),
    // Offer sheets on YOUR restricted free agents — match (respond_offer_sheet)
    // or lose him when the sheet expires.
    offerSheets: listOfferSheets(evalRow.saveId).map((s) => ({ sheetId: s.id, playerId: shortId(s.playerId), fromTeam: shortId(s.fromTeamId), salary: s.salary, years: s.years, expiresOn: s.expiresOn })),
    recentEvents,
  };
  if (stage === "DRAFT") {
    const board = getDraftBoard(evalRow.saveId)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, pos: p.position, age: p.age, ovr: p.ratings.overall, upside: p.ratings.potentialHigh, strength: p.scouting.strengths[0] ?? "" }));
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
可用动作（必须逐字使用 action 字段；观察里的 allowedActions 列出当前阶段合法动作）：
- get_roster / get_assets / get_market：查看信息（返回的对象都带 id 字段，动作参数必须使用这些 id，禁止猜测）。get_market 带 params={teamId} 时侦察指定球队的完整阵容、合同与选秀权——谈交易前先侦察对手
- propose_trade：params = { partnerTeamId, givePlayerIds[], givePickIds[], receivePlayerIds[], receivePickIds[], pickProtections? }（partnerTeamId 用球队 teamId，其余用球员/选秀权的 id；pickProtections = {送出的首轮id: {x: N}} 可谈判前 N 顺位保护——保护的签价值打折但更容易成交/绕过选秀权限制）
- respond_trade：params = { offerId, accept }（回应 inboundOffers 里 AI 球队的主动报价；accept=true 接受，false 拒绝；报价有约 4 天有效期 expiresOn，逾期对方撤回）
- respond_offer_sheet：params = { sheetId, match }（回应 offerSheets 里对你受限自由球员的报价单；match=true 按报价单条款留人，false 放人）
- decline_option：params = { playerId }（拒绝执行 roster[].optionPending 球员的球队选项——无死钱，他成为自由球员；仅休赛期）
- extend_contract：params = { playerId, extraYears, avgSalary }（提前续约还剩 ≤2 年合同的我方球员：首年 ≤ 末年薪资140%、年限 ≥2、价格约要价 95%（≤25 岁新星不打折）；锁定他免于进自由市场）
- set_rotation：params = { starters: [5 个球员 id], minutes?: {球员id: 分钟} }（设定首发与上场时间；伤停球员不能首发；轮换深度影响战绩与士气）
- sign_free_agent：params = { playerId, years, avgSalary }（自由市场阶段按报价签约；常规赛期间只能签赛季剩余底薪合同，球员 id 来自 freeAgents[].id；注意 AI 球队也会在赛季中底薪补强伤病阵容——好货不等人）
- waive_player：params = { playerId, stretch? }（裁掉我方球员；剩余合同变为死钱仍占工资帽；stretch=true 按延伸条款摊到 2×剩余年+1 个赛季——当年压力小但拖得久）
- draft_pick：params = { prospectId? }（选秀阶段；prospectId 来自 topProspects[].id，省略则选最优）
- finish_draft：剩余选秀全部自动完成
- set_strategy：params = { text }（记录你的建队策略）
- advance_season：推进赛程——常规赛按月推进（每回合约 30 天，可中途做交易/调整），季后赛一次性推完，阶段变化会暂停并返回最新盘面
- start_new_season：自由市场结束后开启新赛季
- do_nothing：观察一轮
约束：
1. 只输出一个 JSON 对象，格式：{"action":"...","params":{...},"decision":"一句话公开决策摘要","goals":"目标","expected":"预期收益","risks":"风险"}
2. 交易与签约由服务器规则裁决（薪资配平/人数/对方意愿），你只能提议。
3. 不得试图修改数据库、绕过规则或使用上帝模式。
4. 每个决策提交简短的公开摘要/目标/预期/风险；不要输出任何隐藏推理过程。
关键规则：
- 自家合同到期的球员会进入自由市场（freeAgents[].fromMyTeam=true）。你持有鸟权：可超工资帽续约他们（上限为顶薪）；不续约则可能被其他球队签走。roster[].expiring 标记今夏到期者。
- 休赛期阵容可到 20 人，但常规赛开打前必须裁到 18 人以内，否则 start_new_season 会被拒绝。
- 工资帽规则：超帽只能用中产特例（每个休赛期全队仅一次，cap.mleUsed 可查是否已用）或底薪；超第一土豪线失去中产，超第二土豪线只能底薪。超第二土豪线的球队交易时还不能打包送出多名球员，且接收薪资不得超过送出薪资。工资帽、税线、土豪线、中产与底薪额度每年随联盟收入上涨（观察中的 cap 字段返回当季数值，报价低于当季底薪会被直接拒绝）。
- 自由市场是活的：每推进一天，AI 球队就会按市场价签人——好球员先被抢走，拖得越久池子越薄；报价远低于要价会被直接拒绝。
- 裁员后剩余合同变为死钱仍占工资帽——裁大合同要三思。
- roster[].morale 反映球员士气：输球文化和被埋没的天赋会让球星 UNHAPPY——不处理可能贬值甚至逼宫。
- 球员选项年（contract.option=PO）由球员自己决定：市场价远超选项年薪或士气低他会跳出去（成为自由球员，你有鸟权可留），溢价老将多半执行。
- 球队选项年（option=TO）默认自动执行；optionPending=true 表示仍可反悔——用 decline_option 拒绝执行放他进自由市场（无死钱，但失去他）。
- 年轻球员的成长吃真实上场时间：≤24 岁球员每季打 ≥40 场且场均 ≥20 分钟会加速成长，枯坐板凳（<25 场或 <8 分钟）则停滞——练新人还是冲战绩是你每个赛季的真实权衡。
- 新秀合同到期的球员是受限自由球员（freeAgents[].restricted=true）：别队签他你只能匹配报价单（offerSheets，3 天或休赛期结束前决定，match 则按报价条款留人、可超帽），放弃或超期即白白放走；同理你签别队的受限自由球员也可能被母队匹配而落空。
- 交易在 SEASON/DRAFT/FREE_AGENCY 阶段均可提议，但常规赛交易窗口在 2 月 6 日截止日关闭（之后只能等到休赛期）；get_market 可查看全联盟各队的 phase（CONTENDER/PLAYOFF/BUBBLE/REBUILD）、薪资空间与核心球员，用于挑选交易对象。`;

interface StepOutcome {
  status: string;
  stage: string;
  seasonsDone: number;
  done: boolean;
  lastTurn?: { action: string; decision?: string; summary: string; ok: boolean; data?: Record<string, unknown> };
  /** AGENT provider: no queued action — the harness waits for the CLI agent. */
  waiting?: boolean;
  /** The observation the agent should decide on (returned while waiting). */
  observation?: string;
}

// 进程内步进锁：防止多个客户端（页面循环 + API）并发步进同一评测
const stepLocks = new Set<string>();

/**
 * 一键跑完：服务端循环步进直到终态（DONE/ERROR/CANCELLED/PAUSED）或达到
 * maxSteps。供 agent/脚本使用——一次 POST 即可，无需手动轮询 /step。
 * 步进锁与状态机保证中断/并发安全：已暂停或被其他客户端步进的评测立即返回。
 */
export async function runEvaluation(id: string, opts: { maxSteps?: number } = {}): Promise<{ state: StepOutcome; steps: number }> {
  const evalRow = getEvaluationRow(id);
  if (!evalRow) throw new EvalError("NO_EVAL", "评测不存在");
  const maxSteps = Math.min(MAX_TURNS, Math.max(1, opts.maxSteps ?? MAX_TURNS));
  let state: StepOutcome | null = null;
  let steps = 0;
  for (let i = 0; i < maxSteps; i++) {
    state = await stepEvaluation(id);
    steps++;
    if (state.done || state.status !== "RUNNING") break;
    if (state.lastTurn?.action === "busy") break;
  }
  return { state: state!, steps };
}

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
    if (evalRow.provider === "AGENT") {
      // Out-of-process GM: wait for a queued action, or consume it.
      const queued = readAgentAction(id);
      if (!queued) {
        return { status: "RUNNING", stage, seasonsDone: evalRow.seasonsDone, done: false, waiting: true, observation };
      }
      clearAgentAction(id);
      action = queued.action;
      params = queued.params ?? {};
      decision = queued.decision;
      goals = queued.goals;
      expected = queued.expected;
      risks = queued.risks;
      rawResponse = JSON.stringify(queued).slice(0, 2000);
    } else {
    const myPlayers = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, evalRow.teamFullId)))
      .all()
      .sort((a, b) => a.ratings.overall - b.ratings.overall);
    const ownFa = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.status, "FREE_AGENT"), eq(playersT.lastTeamId, evalRow.teamFullId)))
      .all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
    const ownFaSigned = ownFa
      ? db
          .select()
          .from(evalTurnsT)
          .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.action, "sign_free_agent")))
          .all()
          .some((t) => t.ok === true && (t.params as { playerId?: string } | null)?.playerId === shortId(ownFa.id))
      : false;
    const rotationNow = ((getPhaseState(evalRow.saveId).rotation as Record<string, { starters?: string[] }> | undefined) ?? {})[shortId(evalRow.teamFullId)] ?? null;
    const healthyTop5 = myPlayers
      .filter((p) => !(p.status === "INJURED" || (p.injury && p.injury.weeksRemaining > 0)))
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .slice(0, 5)
      .map((p) => shortId(p.id));
    const rosterShorts = new Set(myPlayers.map((p) => shortId(p.id)));
    const needsRotation =
      healthyTop5.length === 5 &&
      (!rotationNow?.starters ||
        rotationNow.starters.some((pid) => !rosterShorts.has(pid)) ||
        rotationNow.starters.some((pid) => !healthyTop5.includes(pid)));
    const stubScene = {
      stage,
      rosterCount: myPlayers.length,
      needsRotation,
      starterIds: healthyTop5,
      waiveCandidateId: myPlayers[0] ? shortId(myPlayers[0].id) : null,
      // Decline the option on a pending TO whose salary outruns his value.
      optionDeclineId: (() => {
        const pending = new Set((getPhaseState(evalRow.saveId)[`toPending:${getSave(evalRow.saveId)?.season ?? 0}`] as string[] | undefined) ?? []);
        if (!pending.size) return null;
        const cand = myPlayers
          .filter((p) => pending.has(shortId(p.id)))
          .sort((a, b) => (b.contract.years[0]?.salary ?? 0) - b.ratings.overall * 0.3 - ((a.contract.years[0]?.salary ?? 0) - a.ratings.overall * 0.3))[0];
        if (!cand) return null;
        const sal = cand.contract.years[0]?.salary ?? 0;
        return sal > 6 && cand.ratings.overall < 74 ? shortId(cand.id) : null;
      })(),
      // Stretch when the cut candidate carries real money — spreading the
      // dead cap is what a sensible GM does with a big dead deal.
      waiveStretch: (() => {
        const c = myPlayers[0];
        if (!c) return false;
        return c.contract.years.reduce((a, y) => a + y.salary, 0) > 15;
      })(),
      ownFaId: ownFa && ownFa.ratings.overall >= 70 ? shortId(ownFa.id) : null,
      ownFaSalary: ownFa ? askingSalaryFor(ownFa.contract, ownFa.yearsPro, ownFa.ratings.overall, ownFa.age, getSave(evalRow.saveId)?.season) : 0,
      ownFaSigned,
      hasSignedThisStage: stage === "FREE_AGENCY" && db.select().from(faOffersT).where(and(eq(faOffersT.saveId, evalRow.saveId))).all().some((o) => o.teamId === evalRow.teamFullId),
      lastTurnWasSignAttempt:
        evalRow.turnIndex > 0 &&
        db
          .select()
          .from(evalTurnsT)
          .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.turnIndex, evalRow.turnIndex)))
          .get()?.action === "sign_free_agent",
      extensionId: (() => {
        // Best extendable contributor (≤2 yrs left) worth locking up.
        const cand = myPlayers
          .filter((p) => p.contract.years.length >= 1 && p.contract.years.length <= 2 && p.ratings.overall >= 74)
          .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
        return cand ? shortId(cand.id) : null;
      })(),
      extensionSalary: (() => {
        const cand = myPlayers
          .filter((p) => p.contract.years.length >= 1 && p.contract.years.length <= 2 && p.ratings.overall >= 74)
          .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
        return cand ? askingSalaryFor(cand.contract, cand.yearsPro, cand.ratings.overall, cand.age, getSave(evalRow.saveId)?.season) : 0;
      })(),
      extensionsTried: db
        .select()
        .from(evalTurnsT)
        .where(and(eq(evalTurnsT.evaluationId, evalRow.id), eq(evalTurnsT.action, "extend_contract")))
        .all().length,
      offerSheetId: (() => {
        const s = listOfferSheets(evalRow.saveId)[0];
        return s ? s.id : null;
      })(),
      offerSheetMatch: (() => {
        const s = listOfferSheets(evalRow.saveId)[0];
        if (!s) return false;
        const ovr = db.select().from(playersT).where(eq(playersT.id, s.playerId)).get()?.ratings.overall ?? 0;
        // Stub policy: match sheets on real contributors — losing an asset for
        // nothing is how rebuilds stall.
        return ovr >= 72;
      })(),
      inboundOfferId: (() => {
        const o = listInboundOffers(evalRow.saveId)[0];
        return o ? o.id : null;
      })(),
      inboundGood: (() => {
        const o = listInboundOffers(evalRow.saveId)[0];
        if (!o) return false;
        const ovrOf = (a: { kind: string; id: string }) =>
          a.kind === "PICK" ? 0 : (db.select().from(playersT).where(eq(playersT.id, a.id)).get()?.ratings.overall ?? 0);
        // Bidirectional: compare what we'd get vs what we'd send. A first
        // counts as ~78 ovr of asset value; picks received count for us.
        const inBest = Math.max(0, ...o.gives.map(ovrOf));
        const outBest = Math.max(0, ...o.wants.map(ovrOf));
        const inPicks = o.gives.filter((a) => a.kind === "PICK").length;
        const outPicks = o.wants.filter((a) => a.kind === "PICK").length;
        // Crude stub judgment: we get the best asset and at least break even
        // on pick flow — a sell-high offer (our vet for a first) reads good
        // when we're bad, bad when contending is crudely ignored here.
        return inBest + inPicks * 6 >= outBest + outPicks * 6;
      })(),
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
    const r = await providerChat(cfg, { system: SYSTEM_PROMPT, messages, maxTokens: 2048 }, stubScene);
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
      // 取最近 3 个回合（而非最近 3 次错误）：中间有成功回合即视为已恢复，
      // 只有真正连续的失败才熔断。
      const recentErrors = db
        .select()
        .from(evalTurnsT)
        .where(eq(evalTurnsT.evaluationId, id))
        .orderBy(desc(evalTurnsT.turnIndex))
        .limit(3)
        .all();
      if (recentErrors.length >= 3 && recentErrors.every((t) => t.action === "provider_error" && !t.ok)) {
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
          toolResult = toolGetMarket({ ...evalCtx }, params);
          break;
        case "propose_trade":
          toolResult = toolProposeTrade({ ...evalCtx }, params);
          break;
        case "respond_trade": {
          const r = respondInboundOffer(evalRow.saveId, String(params.offerId ?? ""), params.accept === true);
          toolResult = {
            summary: r.accepted ? "接受了 AI 球队的交易报价，交易完成" : `报价处理：${(r as { reason?: string }).reason ?? "已拒绝"}`,
            isAction: true,
            legal: true,
          };
          break;
        }
        case "extend_contract": {
          const r = extendContract(evalRow.saveId, String(params.playerId ?? ""), Number(params.extraYears ?? 0), Number(params.avgSalary ?? 0));
          toolResult = {
            summary: r.extended ? "提前续约达成" : `续约被拒：${(r as { reason?: string }).reason ?? "谈判破裂"}`,
            isAction: true,
            legal: r.extended,
          };
          break;
        }
        case "decline_option": {
          const r = declineOption(evalRow.saveId, String(params.playerId ?? ""));
          toolResult = { summary: `拒绝球队选项：${r.declined} 成为自由球员（无死钱）`, isAction: true, legal: true };
          break;
        }
        case "respond_offer_sheet": {
          const r = respondOfferSheet(evalRow.saveId, String(params.sheetId ?? ""), params.match === true);
          toolResult = {
            summary: r.matched ? `匹配报价单：${r.player} 留队` : `放弃匹配：${r.player} 离队`,
            isAction: true,
            legal: true,
          };
          break;
        }
        case "set_rotation": {
          const starters = (params.starters as string[] | undefined) ?? [];
          const minutes = (params.minutes as Record<string, number> | undefined) ?? undefined;
          const r = setRotation(evalRow.saveId, shortId(evalRow.teamFullId), starters, minutes);
          toolResult = { summary: "轮换已更新", data: r as unknown as Record<string, unknown>, isAction: true, legal: true };
          break;
        }
        case "sign_free_agent":
          if (stage !== "FREE_AGENCY" && stage !== "SEASON") throw new EvalError("WRONG_STAGE", "签约仅在自由市场或常规赛阶段");
          toolResult = toolSignFreeAgent({ ...evalCtx }, params);
          break;
        case "waive_player": {
          const r = waivePlayer(evalRow.saveId, String(params.playerId ?? ""), { stretch: params.stretch === true });
          toolResult = { summary: `裁掉 ${r.waived}，死钱 ${r.total.toFixed(1)}M 分 ${r.deadMoney.length} 年计入工资帽`, data: r as unknown as Record<string, unknown>, isAction: true, legal: true };
          break;
        }
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
          const saveNow = getSave(evalRow.saveId)!;
          // In-season the agent advances month by month — mid-season
          // management (deadline trades, fatigue) is where real GM skill
          // shows. Playoffs still complete in one call; stage changes stop
          // the advance so the next observation is fresh.
          const mode =
            saveNow.phase === "REGULAR_SEASON"
              ? "MONTH"
              : saveNow.phase === "PLAYOFFS"
                ? "PLAYOFFS"
                : saveNow.phase === "FREE_AGENCY" || saveNow.phase === "DRAFT"
                  ? "WEEK" // 自由市场/选秀阶段按周推进：市场在 churn，拖太久好球员被签走
                  : "SEASON";
          const r = advanceSim(evalRow.saveId, mode);
          const after = getSave(evalRow.saveId)!;
          const myRow = getDb().select().from(teamsT).where(eq(teamsT.id, evalRow.teamFullId)).get();
          const champTeam = r.champion ? getDb().select().from(teamsT).where(eq(teamsT.id, `${evalRow.saveId}:${r.champion}`)).get() : null;
          toolResult = {
            summary: `推进至 ${after.currentDate}：${r.days} 天 / ${r.gamesPlayed} 场，我方 ${myRow ? `${myRow.wins}胜${myRow.losses}负` : "-"}${r.phaseChanged ? `，进入 ${r.phaseChanged}` : ""}${champTeam ? `，总冠军 ${champTeam.city} ${champTeam.name}` : ""}`,
            data: { days: r.days, games: r.gamesPlayed, date: after.currentDate, record: myRow ? `${myRow.wins}-${myRow.losses}` : null, champion: champTeam ? `${champTeam.city} ${champTeam.name}` : null },
            isAction: true,
            legal: true,
          };
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
    lastTurn: { action, decision, summary: toolResult.summary, ok: executedOk, data: toolResult.data },
  };
}

// ---------------------------------------------------------------------------
// 完成 + 评分（GM-BENCH，当前版本见 SCORE_VERSION）
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
  // Split league noise from GM activity: executed trades carry `parties` in
  // the payload; market summaries and inbound offers don't. "User" trades are
  // executed trades where the evaluated team is a party.
  const userShort = shortId(evalRow.teamFullId);
  const executedTrades = tradeEvents.filter((e) => Array.isArray((e.payload as { parties?: { teamId: string }[] } | null)?.parties));
  const userTrades = executedTrades.filter((e) =>
    ((e.payload as { parties: { teamId: string }[] }).parties ?? []).some((p) => p.teamId === userShort),
  );
  const leagueTrades = executedTrades.length - userTrades.length;
  const seasonsRecorded = Math.max(1, seasons.length);
  const winsPerSeason = totalWins / seasonsRecorded;

  // Roster value delta: top-12 overall sum now vs the base save's snapshot —
  // rewards GMs who actually improve the talent pool, not just ride it.
  const topSum = (sid: string, fullId: string) =>
    db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, sid), eq(playersT.teamId, fullId)))
      .all()
      .filter((p) => p.status === "ACTIVE" || p.status === "INJURED")
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .slice(0, 12)
      .reduce((a, p) => a + p.ratings.overall, 0);
  const baseSave = getSave(evalRow.baseSaveId);
  const baseTeamFullId = baseSave ? `${evalRow.baseSaveId}:${evalRow.teamShortId}` : null;
  const rosterValueStart = baseTeamFullId ? topSum(evalRow.baseSaveId, baseTeamFullId) : null;
  const rosterValueEnd = topSum(evalRow.saveId, evalRow.teamFullId);
  const rosterValueDelta = rosterValueStart != null ? Math.round((rosterValueEnd - rosterValueStart) * 10) / 10 : null;
  const rosterBonus = rosterValueDelta != null ? Math.max(-20, Math.min(20, rosterValueDelta * 0.4)) : 0;

  // --- Process metrics (GM-BENCH v3): results alone reward lucky rings and
  // passive inheritance. These measure whether the GM actually MADE value.

  // Trade P&L: aiFeedback.valueDelta is each AI counterparty's net gain —
  // trades are zero-sum, so the user's take is its negation. Positive = the
  // GM consistently won negotiations (sold high, bought low).
  let tradePnl = 0;
  for (const e of userTrades) {
    const fb = ((e.payload as { aiFeedback?: { valueDelta?: number }[] } | null)?.aiFeedback) ?? [];
    tradePnl -= fb.reduce((a, f) => a + (f.valueDelta ?? 0), 0);
  }
  const tradeBonus = Math.max(-15, Math.min(15, tradePnl * 0.15));

  // Draft record: for every pick the user exercised, did the selection beat
  // its slot's expectation? Value found late counts as much as value at #1.
  const evalSeasonSet = new Set(seasons.map((s) => s.season));
  const userPicks = db
    .select()
    .from(picksT)
    .where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.holderTeamId, evalRow.teamFullId), eq(picksT.status, "EXERCISED")))
    .all()
    .filter((pk) => evalSeasonSet.has(pk.year));
  let draftBonus = 0;
  for (const pk of userPicks) {
    const pickNum = parseInt(pk.resolved ?? "", 10);
    if (!Number.isFinite(pickNum)) continue;
    const drafted = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.draftYear, pk.year), eq(playersT.draftPick, pickNum)))
      .get();
    if (!drafted) continue;
    const expected = pickNum <= 5 ? 80 : pickNum <= 14 ? 77 : pickNum <= 30 ? 74 : 70;
    draftBonus += Math.max(-3, Math.min(3, (drafted.ratings.overall - expected) / 4));
  }
  draftBonus = Math.max(-10, Math.min(10, draftBonus));

  // Signing efficiency: end-state overall vs what the contract's price tier
  // expected. Steals and overpays are symmetric.
  const userSigns = db
    .select()
    .from(faOffersT)
    .where(and(eq(faOffersT.saveId, evalRow.saveId), eq(faOffersT.teamId, evalRow.teamFullId), eq(faOffersT.status, "ACCEPTED")))
    .all();
  let faValueBonus = 0;
  for (const o of userSigns) {
    const p = db.select().from(playersT).where(eq(playersT.id, o.playerId)).get();
    if (!p) continue;
    const expected = o.avgSalary >= 25 ? 84 : o.avgSalary >= 10 ? 78 : o.avgSalary >= 3 ? 72 : 66;
    faValueBonus += Math.max(-3, Math.min(3, (p.ratings.overall - expected) / 4));
  }
  faValueBonus = Math.max(-10, Math.min(10, faValueBonus));

  // Pick capital: draft-pick value held now vs what the franchise started
  // with — stockpiling the future is a real GM skill.
  const pickStock = (sid: string, fullId: string) =>
    db
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, sid), eq(picksT.holderTeamId, fullId), eq(picksT.status, "OWNED")))
      .all()
      .reduce(
        (a, pk) =>
          a +
          pickValue(
            { id: pk.id, year: pk.year, round: pk.round, protection: pk.protection ?? null, holderTeamId: pk.holderTeamId, originalTeamId: pk.originalTeamId, status: pk.status },
            seasons[seasons.length - 1]?.season ?? 2027,
          ).value,
        0,
      );
  const baseTeamFull = baseSave ? `${evalRow.baseSaveId}:${evalRow.teamShortId}` : null;
  const pickCapitalDelta = baseTeamFull ? pickStock(evalRow.saveId, evalRow.teamFullId) - pickStock(evalRow.baseSaveId, baseTeamFull) : 0;
  const pickCapitalBonus = Math.max(-6, Math.min(6, pickCapitalDelta * 0.08));

  // GM-BENCH v3：过程分——交易盈亏/选秀命中/签约性价比/选秀权资产，与结果分并列。
  const score = Math.round(
    winsPerSeason * 1.2 +
      playoffCount * 6 +
      finalsCount * 8 +
      champCount * 25 +
      legalRate * 20 -
      errorRate * 15 +
      (chemistry - 60) * 0.15 +
      rosterBonus +
      tradeBonus +
      draftBonus +
      faValueBonus +
      pickCapitalBonus,
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
    tradeCount: userTrades.length,
    leagueTradeCount: leagueTrades,
    tradeEventCount: tradeEvents.length,
    trades: userTrades.map((t) => t.message).slice(0, 30),
    rosterValueStart,
    rosterValueEnd,
    rosterValueDelta,
    rosterBonus: Math.round(rosterBonus * 10) / 10,
    tradePnl: Math.round(tradePnl * 10) / 10,
    tradeBonus: Math.round(tradeBonus * 10) / 10,
    draftBonus: Math.round(draftBonus * 10) / 10,
    faValueBonus: Math.round(faValueBonus * 10) / 10,
    pickCapitalDelta: Math.round(pickCapitalDelta * 10) / 10,
    pickCapitalBonus: Math.round(pickCapitalBonus * 10) / 10,
    formula:
      "score = winsPerSeason*1.2 + playoffs*6 + finals*8 + champs*25 + legalRate*20 - errorRate*15 + (chem-60)*0.15 + clamp(rosterValueDelta*0.4,±20) + clamp(tradePnl*0.15,±15) + clamp(Σ(draftedOvr-slotExpect)/4,±10) + clamp(Σ(signedOvr-salaryExpect)/4,±10) + clamp(pickCapitalDelta*0.08,±6)",
  };

  db.update(evaluationsT)
    .set({ status: "DONE", stage: "DONE", score: scoreJson as never, finishedAt: now(), updatedAt: now() })
    .where(eq(evaluationsT.id, id))
    .run();
  return { status: "DONE", stage: "DONE", seasonsDone: evalRow.seasonsDone, done: true, lastTurn: { action: "finish", summary: `评测完成，${SCORE_VERSION} 得分 ${score}`, ok: true } };
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
