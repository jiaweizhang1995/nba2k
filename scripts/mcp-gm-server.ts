/**
 * nba-gm MCP server — Devin 通过结构化工具调用直接游玩《NBA2K》真实存档，
 * 不经过评测层（无回合上限、无克隆隔离）。动作直调
 * src/server/engine.ts 的规则函数，与 Web UI 同源。
 *
 *   - gm_observe / gm_saves / gm_use / gm_teams / gm_roster / gm_find /
 *     gm_picks / gm_resolve / gm_events / gm_status：纯读，随时可调。
 *   - gm_act：阶段校验 + 名字→稳定ID 解析 + engine 执行 + 返回新鲜观察。
 *   - gm_auto：连续推进直到决策检查点（来报价/轮到我选秀/阶段切换）。
 *
 * 稳定 ID：params 可直接写观察里的短 id，也可写人名/球队缩写/"LAL 2027 R1"，
 * 服务端解析为稳定 ID；解析失败报错附候选，不执行。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Contract } from "../src/domain/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, "data", ".gm-current.json");
const shortId = (full: string) => (full.includes(":") ? full.split(":").slice(1).join(":") : full);
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 1) }] });
const errJson = (message: string, extra?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 1) }],
  isError: true,
});

type PlayerRow = {
  id: string;
  name: string;
  teamId: string | null;
  lastTeamId: string | null;
  status: string;
  position: string;
  age: number;
  yearsPro: number;
  draftYear: number | null;
  ratings: { overall: number; potential: number };
  seasonStats: { season: number; g: number; mp: number; pts: number }[];
  contract: Contract;
  satisfaction: number;
  injury: { weeksRemaining: number } | null;
};

interface Indexes {
  playerById: Map<string, PlayerRow>;
  playersByName: Map<string, PlayerRow[]>;
  teamByAbbr: Map<string, { id: string; abbr: string; city: string; name: string }>;
  pickIds: Set<string>;
}

type FieldKind = "player" | "team" | "pick" | "playerKeys" | "pickKeys" | "pass";
const ID_FIELDS: Record<string, string> = {
  partnerTeamId: "team",
  teamId: "team",
  playerId: "player",
  prospectId: "player",
  givePlayerIds: "player[]",
  receivePlayerIds: "player[]",
  starters: "player[]",
  givePickIds: "pick[]",
  receivePickIds: "pick[]",
  gives: "assetKeys[]",
  minutes: "playerKeys",
  pickProtections: "pickKeys",
  offerId: "pass",
  sheetId: "pass",
};

/** 各存档阶段允许的动作（前置过滤；引擎仍是规则真相）。 */
const PHASE_ACTIONS: Record<string, string[]> = {
  REGULAR_SEASON: ["propose_trade", "preview_trade", "respond_trade", "request_offers", "extend_contract", "set_rotation", "sign_free_agent", "waive_player", "advance", "do_nothing"],
  PLAYOFFS: ["extend_contract", "set_rotation", "advance", "do_nothing"],
  DRAFT: ["propose_trade", "preview_trade", "respond_trade", "request_offers", "extend_contract", "decline_option", "exercise_option", "set_rotation", "waive_player", "draft_pick", "finish_draft", "do_nothing"],
  FREE_AGENCY: ["propose_trade", "preview_trade", "respond_trade", "request_offers", "respond_offer_sheet", "decline_option", "exercise_option", "set_rotation", "sign_free_agent", "waive_player", "advance", "start_new_season", "do_nothing"],
  OFFSEASON: ["propose_trade", "preview_trade", "request_offers", "set_rotation", "waive_player", "start_new_season", "do_nothing"],
};

const moraleOf = (s: number) => (s <= 40 ? "UNHAPPY" : s <= 58 ? "UNEASY" : "CONTENT");

async function main() {
  // 项目内模块在加载时就读 cwd（db 路径），先 chdir 再 import。
  process.chdir(ROOT);
  const { getDb } = await import("../src/db/index");
  const { players: playersT, teams: teamsT, draftPicks: picksT, saves: savesT, awards: awardsT } = await import("../src/db/schema");
  const engine = await import("../src/server/engine");
  const { askingSalaryFor, isRestrictedFa } = await import("../src/domain/freeagency");
  const { capSnapshot, CBA } = await import("../src/domain/salary");

  // -------------------------------------------------------------------------
  // 存档选择与状态
  // -------------------------------------------------------------------------

  function setCurrentSave(saveId: string) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ saveId, at: new Date().toISOString() }));
  }

  function currentSaveId(): string | null {
    try {
      const { saveId } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { saveId?: string };
      if (saveId && engine.getSave(saveId)) return saveId;
    } catch {
      /* no state file */
    }
    return null;
  }

  /** 显式 saveId > 当前存档 > 最近更新的存档。 */
  function resolveSaveId(arg?: string): string {
    if (arg) {
      if (engine.getSave(arg)) return arg;
      throw new Error(`存档不存在：${arg}`);
    }
    const cur = currentSaveId();
    if (cur) return cur;
    const latest = getDb().select().from(savesT).orderBy(desc(savesT.updatedAt)).get();
    if (!latest) throw new Error("没有可用存档——先 gm_new 或 gm_use 指定 saveId");
    return latest.id;
  }

  function saveCtx(saveId: string) {
    const save = engine.getSave(saveId);
    if (!save) throw new Error(`存档不存在：${saveId}`);
    const ps = engine.getPhaseState(saveId);
    const teamFullId = String(ps.userTeamId ?? "");
    return { save, saveId, teamFullId, teamShortId: teamFullId ? shortId(teamFullId) : "", season: save.season, phase: save.phase };
  }

  // -------------------------------------------------------------------------
  // 名字 → 稳定 ID 解析
  // -------------------------------------------------------------------------

  function loadIndexes(saveId: string): Indexes {
    const db = getDb();
    const players = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all() as unknown as PlayerRow[];
    const playerById = new Map<string, PlayerRow>();
    const playersByName = new Map<string, PlayerRow[]>();
    for (const p of players) {
      playerById.set(shortId(p.id), p);
      const k = norm(p.name);
      const arr = playersByName.get(k) ?? [];
      arr.push(p);
      playersByName.set(k, arr);
    }
    const teamByAbbr = new Map<string, { id: string; abbr: string; city: string; name: string }>();
    for (const t of db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all()) {
      teamByAbbr.set(t.abbr.toUpperCase(), { id: t.id, abbr: t.abbr, city: t.city, name: t.name });
    }
    const pickIds = new Set(db.select().from(picksT).where(eq(picksT.saveId, saveId)).all().map((k) => shortId(k.id)));
    return { playerById, playersByName, teamByAbbr, pickIds };
  }

  const playerLabel = (p: PlayerRow) => `${p.name}（${p.teamId ? shortId(p.teamId) : p.status} ${p.ratings.overall}ovr）`;

  function findPlayers(ix: Indexes, input: string): PlayerRow[] {
    const exact = ix.playersByName.get(norm(input));
    if (exact?.length) return exact;
    const k = norm(input);
    if (k.length < 3) return [];
    const hits: PlayerRow[] = [];
    for (const [name, arr] of ix.playersByName) {
      if (name.includes(k)) hits.push(...arr);
    }
    return hits;
  }

  function resolvePlayer(ix: Indexes, input: string): { id?: string; candidates?: string[] } {
    if (ix.playerById.has(input)) return { id: input };
    const hits = findPlayers(ix, input);
    if (hits.length === 1) return { id: shortId(hits[0].id) };
    if (hits.length > 1) return { candidates: hits.slice(0, 8).map((p) => `${shortId(p.id)} = ${playerLabel(p)}`) };
    return { candidates: [] };
  }

  function resolveTeam(ix: Indexes, input: string): { id?: string; candidates?: string[] } {
    const up = input.toUpperCase();
    if (ix.teamByAbbr.has(up)) return { id: ix.teamByAbbr.get(up)!.abbr };
    const k = norm(input);
    if (k.length < 2) return { candidates: [] };
    const hits = [...ix.teamByAbbr.values()].filter((t) => norm(t.abbr) === k || norm(t.name) === k || norm(`${t.city}${t.name}`) === k);
    if (hits.length === 1) return { id: hits[0].abbr };
    const loose = hits.length ? hits : [...ix.teamByAbbr.values()].filter((t) => norm(`${t.city}${t.name}`).includes(k) || norm(t.name).includes(k));
    return { candidates: loose.slice(0, 8).map((t) => `${t.abbr} = ${t.city} ${t.name}`) };
  }

  function resolvePick(ix: Indexes, input: string): { id?: string; candidates?: string[] } {
    if (ix.pickIds.has(input)) return { id: input };
    const m = input.match(/([a-z]{3})\D*(\d{4})\D*(?:r|round|-)?(\d)/i);
    if (m) {
      const abbr = m[1].toUpperCase();
      const guess = `pk-${m[2]}-${m[3]}-${abbr}`;
      if (ix.pickIds.has(guess)) return { id: guess };
      const similar = [...ix.pickIds].filter((p) => p.endsWith(`-${abbr}`)).slice(0, 8);
      return { candidates: similar };
    }
    if (!input.trim()) return { candidates: [] };
    return { candidates: [...ix.pickIds].filter((p) => p.includes(input)).slice(0, 8) };
  }

  function resolveOne(ix: Indexes, kind: FieldKind, v: unknown): { v?: unknown; candidates?: string[] } {
    if (typeof v !== "string" || kind === "pass") return { v };
    const r = kind === "team" ? resolveTeam(ix, v) : kind === "pick" ? resolvePick(ix, v) : resolvePlayer(ix, v);
    if (r.id) return { v: r.id };
    return { candidates: r.candidates ?? [] };
  }

  /** 把 params 里的名字/描述解析成稳定 ID；未知字段原样透传。 */
  function resolveParams(saveId: string, params: Record<string, unknown>) {
    const ix = loadIndexes(saveId);
    const out: Record<string, unknown> = {};
    const errors: { field: string; input: unknown; candidates?: string[] }[] = [];
    for (const [key, val] of Object.entries(params)) {
      const kind = ID_FIELDS[key];
      if (!kind || kind === "pass") {
        out[key] = val;
        continue;
      }
      if (kind === "assetKeys[]") {
        // request_offers 的 gives: [{kind:"PLAYER"|"PICK", id}]
        out[key] = (Array.isArray(val) ? val : [val]).map((a) => {
          const asset = a as { kind?: string; id?: unknown };
          const base = asset?.kind === "PICK" ? "pick" : "player";
          const r = resolveOne(ix, base, asset?.id);
          if (r.candidates) errors.push({ field: key, input: asset?.id, candidates: r.candidates });
          return { ...asset, id: r.v ?? asset?.id };
        });
        continue;
      }
      if (kind.endsWith("[]")) {
        const base = kind.slice(0, -2) as FieldKind;
        out[key] = (Array.isArray(val) ? val : [val]).map((v) => {
          const r = resolveOne(ix, base, v);
          if (r.candidates) errors.push({ field: key, input: v, candidates: r.candidates });
          return r.v ?? v;
        });
        continue;
      }
      if (kind === "playerKeys" || kind === "pickKeys") {
        const base = kind === "playerKeys" ? "player" : "pick";
        const rec: Record<string, unknown> = {};
        for (const [k2, v2] of Object.entries(val as Record<string, unknown>)) {
          const r = resolveOne(ix, base, k2);
          if (r.candidates) errors.push({ field: key, input: k2, candidates: r.candidates });
          rec[(r.v as string) ?? k2] = v2;
        }
        out[key] = rec;
        continue;
      }
      const r = resolveOne(ix, kind as FieldKind, val);
      if (r.candidates) errors.push({ field: key, input: val, candidates: r.candidates });
      out[key] = r.v ?? val;
    }
    return { params: out, errors };
  }

  // -------------------------------------------------------------------------
  // 侦察视图（直读存档，与 Web UI 同源数据）
  // -------------------------------------------------------------------------

  /** Dec-15 rule 的展示版：本赛季新签的球员在 12/15 前锁死（休赛期一律锁）。 */
  function tradeLockOf(p: PlayerRow, season: number, phase: string, date: string): string | null {
    if (p.contract.noTrade) return "NO_TRADE_CLAUSE";
    if (p.contract.signedSeason !== season) return null;
    const dec15 = `${season - 1}-12-15`;
    if (phase === "FREE_AGENCY" || phase === "DRAFT" || phase === "OFFSEASON") return `LOCKED_UNTIL_${dec15}`;
    if (phase === "REGULAR_SEASON" && date < dec15) return `LOCKED_UNTIL_${dec15}`;
    return null;
  }

  function rosterView(saveId: string, teamFullId: string, season: number, phase = "", date = "") {
    const db = getDb();
    // 与交易校验器同口径：只算 ACTIVE/INJURED——游离状态行（如仍挂在队名下的
    // FREE_AGENT）不进展示，否则"阵容人数"会和 ROSTER_MIN 校验对不上。
    const rows = (db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, teamFullId))).all() as unknown as PlayerRow[])
      .filter((p) => p.status === "ACTIVE" || p.status === "INJURED");
    const optPending = (engine.getPhaseState(saveId)[`toPending:${season}`] as string[] | undefined) ?? [];
    return rows
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .map((p) => {
        const endSeason = p.contract.years[p.contract.years.length - 1]?.season ?? season;
        const st = p.seasonStats.find((s) => s.season === season);
        return {
          id: shortId(p.id),
          name: p.name,
          pos: p.position,
          age: p.age,
          ovr: p.ratings.overall,
          pot: p.ratings.potential,
          salary: p.contract.years[0]?.salary ?? 0,
          yearsLeft: p.contract.years.length,
          endSeason,
          expiring: endSeason <= season,
          extensionAsk: p.contract.years.length <= 2 ? askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, season) : null,
          option: p.contract.option ?? null,
          optionPending: optPending.includes(shortId(p.id)),
          noTrade: !!p.contract.noTrade,
          tradeLock: tradeLockOf(p, season, phase, date),
          morale: moraleOf(p.satisfaction),
          injured: !!(p.injury && p.injury.weeksRemaining > 0),
          mpg: st && st.g > 0 ? Math.round((st.mp / st.g) * 10) / 10 : 0,
          ppg: st && st.g > 0 ? Math.round((st.pts / st.g) * 10) / 10 : 0,
        };
      });
  }

  function capOf(saveId: string, teamFullId: string) {
    const db = getDb();
    // 同上：与 toTradeTeam 一致只计 ACTIVE/INJURED，保证展示的薪资/人数与
    // 交易校验使用的数字一致。
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, teamFullId)))
      .all()
      .filter((p) => p.status === "ACTIVE" || p.status === "INJURED");
    return capSnapshot(roster, roster.length, engine.deadCapHit(saveId, shortId(teamFullId)), engine.getSave(saveId)?.season);
  }

  /** Stepien/窗口探测：模拟"送出该签、换空气"的最小交易，让域校验器自己说能不能动。 */
  function pickTradeBlock(saveId: string, teamShortId: string, partnerShortId: string, pick: { id: string; year: number; round: number; from: string; protection: string }, season: number): string | null {
    if (pick.year > season + CBA.pickTradeYears) return `超出可交易窗口（仅未来 ${CBA.pickTradeYears} 年）`;
    // Stepien 只约束自家首轮（无保护）：跑一遍真实校验拿准确结论
    if (pick.round === 1 && pick.from === teamShortId && pick.protection === "NONE" && pick.year > season) {
      const probe = engine.validateTradeOnServer(saveId, [
        { teamId: teamShortId, gives: [{ kind: "PICK", id: pick.id }], receives: [] },
        { teamId: partnerShortId, gives: [], receives: [{ kind: "PICK", id: pick.id }] },
      ]);
      const blocker = probe.issues.find((i) => i.severity === "BLOCKER");
      return blocker ? blocker.message : null;
    }
    return null;
  }

  function picksView(saveId: string, teamFullId: string, season: number) {
    const db = getDb();
    const teamShortId = shortId(teamFullId);
    const partner = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all().find((t) => t.id !== teamFullId);
    const held = db
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, saveId), eq(picksT.holderTeamId, teamFullId)))
      .all()
      .filter((k) => k.status === "OWNED")
      .map((k) => ({ id: shortId(k.id), year: k.year, round: k.round, from: shortId(k.originalTeamId), protection: k.protection?.type ?? "NONE" }));
    const heldAnnotated = held.map((k) => {
      const block = partner ? pickTradeBlock(saveId, teamShortId, shortId(partner.id), k, season) : null;
      return { ...k, tradeable: !block, tradeBlock: block };
    });
    const owed = db
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, saveId), eq(picksT.originalTeamId, teamFullId)))
      .all()
      .filter((k) => k.status === "OWNED" && k.holderTeamId !== teamFullId)
      .map((k) => ({ year: k.year, round: k.round, heldBy: shortId(k.holderTeamId), protection: k.protection?.type ?? "NONE" }));
    return { held: heldAnnotated, owed };
  }

  // -------------------------------------------------------------------------
  // 观察构建（直连存档）
  // -------------------------------------------------------------------------

  function buildObs(saveId: string): Record<string, unknown> {
    const ctx = saveCtx(saveId);
    const state = engine.loadLeagueState(saveId, { includeGames: false });
    const db = getDb();
    const team = state.teams.find((t) => t.id === ctx.teamShortId);
    const conf = team?.conference ?? "EAST";
    const sorted = state.teams
      .filter((t) => t.conference === conf)
      .sort((a, b) => b.wins - a.wins || b.wins / Math.max(1, b.wins + b.losses) - a.wins / Math.max(1, a.wins + a.losses));
    const rank = sorted.findIndex((t) => t.id === ctx.teamShortId) + 1;
    const cap = ctx.teamFullId ? capOf(saveId, ctx.teamFullId) : null;
    const chemistry = ctx.teamShortId ? engine.getChemistry(saveId, ctx.teamShortId) : null;
    const roster = ctx.teamFullId ? rosterView(saveId, ctx.teamFullId, state.season, ctx.phase, state.currentDate) : [];
    const recentEvents = engine
      .getEvents(saveId, 8)
      .map((e) => `${e.category}: ${e.message}`)
      .reverse();
    const base: Record<string, unknown> = {
      phase: ctx.phase,
      allowedActions: PHASE_ACTIONS[ctx.phase] ?? [],
      season: `${state.season - 1}-${String(state.season).slice(2)}`,
      currentDate: state.currentDate,
      myTeam: team ? `${team.city} ${team.name}` : "?",
      myTeamId: ctx.teamShortId,
      record: team ? `${team.wins}胜${team.losses}负` : "?",
      conferenceRank: rank || null,
      cap: cap ? { total: cap.totalSalary, space: cap.capSpace, overTax: cap.overTax, overFirstApron: cap.overFirstApron, overSecondApron: cap.overSecondApron, mleUsed: !!engine.getPhaseState(saveId)[`mleUsed:${state.season}`] } : null,
      chemistry: chemistry?.overall ?? null,
      roster,
      expiringThisOffseason: roster.filter((p) => p.expiring).map((p) => ({ id: p.id, name: p.name, ovr: p.ovr, salary: p.salary })),
      inboundOffers: engine.listInboundOffers(saveId).map((o) => ({ offerId: o.id, fromTeam: o.fromTeam, theyGive: o.giveNames, theyWant: o.wantNames, expiresOn: o.expiresOn })),
      offerSheets: engine.listOfferSheets(saveId).map((s) => ({ sheetId: s.id, playerId: shortId(s.playerId), fromTeam: shortId(s.fromTeamId), salary: s.salary, years: s.years, expiresOn: s.expiresOn })),
      recentEvents,
    };
    if (ctx.phase === "PLAYOFFS" && state.playoffs) {
      const ROUND_ORDER = ["R1", "CONF_SEMI", "CONF_FINAL", "FINALS"];
      const abbr = (id: string) => state.teams.find((t) => t.id === id)?.abbr ?? "?";
      const series = state.playoffs.series.map((s) => ({
        round: s.round,
        conf: s.conference,
        a: abbr(s.aTeamId),
        b: abbr(s.bTeamId),
        score: `${s.winsA}-${s.winsB}`,
        done: s.done,
        winner: s.winnerId ? abbr(s.winnerId) : null,
        mine: s.aTeamId === ctx.teamShortId || s.bTeamId === ctx.teamShortId,
      }));
      const active = series.filter((s) => !s.done);
      const currentRound = active.sort((x, y) => ROUND_ORDER.indexOf(x.round) - ROUND_ORDER.indexOf(y.round))[0]?.round ?? null;
      const mySeries = series.filter((s) => s.mine);
      base.playoffs = {
        currentRound,
        myStatus: mySeries.length === 0 ? "NOT_IN" : mySeries.some((s) => !s.done) ? "ALIVE" : "ELIMINATED",
        series,
        hint: 'advance 默认每轮一停；advance {scope:"ALL"} 直接打完整个季后赛',
      };
    }
    if (ctx.phase === "DRAFT") {
      const board = engine.getDraftBoard(saveId).slice(0, 10).map((p) => ({ id: p.id, name: p.name, pos: p.position, age: p.age, ovr: p.ratings.overall, upside: p.ratings.potentialHigh, strength: p.scouting.strengths[0] ?? "" }));
      const order = engine.getDraftOrder(saveId);
      // prepareDraft 已把 save.season 滚到即将开打的赛季，被执行的签属于上一季
      const donePicks = db.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.year, state.season - 1), eq(picksT.status, "EXERCISED"))).all().length;
      const mine = order.findIndex((o, i) => i >= donePicks && shortId(o.holderTeamId) === ctx.teamShortId);
      base.draft = { nextPick: donePicks + 1, myNextPick: mine >= 0 ? mine + 1 : null, topProspects: board };
    }
    if (ctx.phase === "FREE_AGENCY") {
      const sheetPlayerIds = new Set(engine.listOfferSheets(saveId).map((s) => s.playerId));
      base.freeAgents = (db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT"))).all() as unknown as PlayerRow[])
        .map((p) => ({
          id: shortId(p.id),
          name: p.name,
          pos: p.position,
          age: p.age,
          ovr: p.ratings.overall,
          asking: askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, state.season),
          askingYears: Math.max(1, Math.min(4, p.age >= 32 ? 2 : 4)),
          fromMyTeam: p.lastTeamId === ctx.teamFullId,
          lastTeamAbbr: p.lastTeamId ? shortId(p.lastTeamId) : null,
          restricted: isRestrictedFa(p as never),
          underOfferSheet: sheetPlayerIds.has(p.id),
        }))
        .sort((a, b) => b.ovr - a.ovr)
        .slice(0, 20);
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // 动作执行（直调 engine；返回值 + 新鲜观察）
  // -------------------------------------------------------------------------

  function toAssets(v: unknown): { kind: "PLAYER" | "PICK"; id: string }[] {
    return (Array.isArray(v) ? v : []).map((id) => ({ kind: String(id).startsWith("pk-") ? ("PICK" as const) : ("PLAYER" as const), id: String(id) }));
  }

  /** 从 params 构建双方交易包裹（我方 = parties[0]）。 */
  function buildTradeParties(teamShortId: string, p: Record<string, unknown>) {
    const partner = String(p.partnerTeamId ?? "");
    const givePicks = toAssets(p.givePickIds);
    return {
      partner,
      givePicks,
      parties: [
        { teamId: teamShortId, gives: [...toAssets(p.givePlayerIds), ...givePicks], receives: [...toAssets(p.receivePlayerIds), ...toAssets(p.receivePickIds)] },
        { teamId: partner, gives: [...toAssets(p.receivePlayerIds), ...toAssets(p.receivePickIds)], receives: [...toAssets(p.givePlayerIds), ...givePicks] },
      ],
    };
  }

  /**
   * 把 pickProtections 里的前 N 顺位保护临时写入库（估值/校验需要看到保护），
   * 返回恢复函数——调用方负责在评估结束后 restore（谈崩不残留）。
   */
  function applyPickProtections(saveId: string, givePicks: { id: string }[], pickProtections: unknown): () => void {
    const protReq = (pickProtections ?? {}) as Record<string, { x?: number }>;
    const backup = new Map<string, unknown>();
    for (const [sid, spec] of Object.entries(protReq)) {
      if (!givePicks.some((a) => a.id === sid)) continue;
      const row = getDb().select().from(picksT).where(eq(picksT.id, `${saveId}:${sid}`)).get();
      const x = Math.max(1, Math.min(14, Math.floor(Number(spec?.x ?? 0))));
      if (!row || row.round !== 1 || !x) continue;
      backup.set(row.id, row.protection);
      getDb().update(picksT).set({ protection: { type: "LOTTERY_TOP_X", x, yearShift: 1 } }).where(eq(picksT.id, row.id)).run();
    }
    return () => {
      for (const [id, old] of backup) getDb().update(picksT).set({ protection: old as never }).where(eq(picksT.id, id)).run();
    };
  }

  function draftPickFlow(ctx: ReturnType<typeof saveCtx>, prospectId?: string) {
    const db = getDb();
    const order = engine.getDraftOrder(ctx.saveId);
    const pickYear = ctx.season - 1;
    const doneCount = () => db.select().from(picksT).where(and(eq(picksT.saveId, ctx.saveId), eq(picksT.year, pickYear), eq(picksT.status, "EXERCISED"))).all().length;
    const next = order[doneCount()];
    if (!next) return { summary: "选秀已完成", ok: true };
    if (shortId(next.holderTeamId) === ctx.teamShortId) {
      const picked = engine.makeDraftPick(ctx.saveId, { prospectId });
      return { summary: `我方选择：${picked.map((p) => `第${p.round}轮${p.pickNumber}顺位 → ${p.prospect}`).join("；") || "无"}`, data: { picks: picked as unknown as Record<string, unknown> }, ok: true };
    }
    const before = doneCount();
    for (let guard = 0; guard < 64; guard++) {
      const slot = order[doneCount()];
      if (!slot || shortId(slot.holderTeamId) === ctx.teamShortId) break;
      engine.makeDraftPick(ctx.saveId, {});
    }
    return { summary: `他人签位已按 AI 最优完成（${doneCount() - before} 顺位），等待我方选择`, ok: true };
  }

  function executeAction(ctx: ReturnType<typeof saveCtx>, action: string, p: Record<string, unknown>): { summary: string; data?: Record<string, unknown>; ok: boolean } {
    const { saveId, teamShortId } = ctx;
    switch (action) {
      case "propose_trade": {
        const { partner, givePicks, parties } = buildTradeParties(teamShortId, p);
        if (!partner) return { summary: "propose_trade 需要 partnerTeamId", ok: false };
        const restoreProt = applyPickProtections(saveId, givePicks, p.pickProtections);
        const validation = engine.validateTradeOnServer(saveId, parties);
        if (!validation.legal) {
          restoreProt();
          return { summary: `交易被规则拒绝：${validation.issues.map((i) => i.message).join("；").slice(0, 200)}`, data: { validation }, ok: false };
        }
        const feedback = engine.getAiTradeFeedback(saveId, parties);
        const rejected = feedback.filter((f) => !f.verdict.accept);
        if (rejected.length > 0) {
          restoreProt();
          return { summary: `规则允许但对方 GM 拒绝：${rejected.map((f) => `${f.teamId}（价值差 ${f.verdict.valueDelta}）：${f.verdict.feedback}`).join("；").slice(0, 200)}`, data: { validation, feedback }, ok: true };
        }
        const result = engine.executeTrade(saveId, parties, {});
        if (!result.executed) {
          restoreProt();
          return { summary: "交易执行失败", data: { validation }, ok: false };
        }
        return { summary: `交易完成：送出 ${parties[0].gives.map((a) => a.id).join(",")}，获得 ${parties[0].receives.map((a) => a.id).join(",")}`, data: { validation, feedback }, ok: true };
      }
      case "preview_trade": {
        // 干跑：完整规则校验 + 对方 GM 估值反馈，不执行、不写事件流。
        const { partner, givePicks, parties } = buildTradeParties(teamShortId, p);
        if (!partner) return { summary: "preview_trade 需要 partnerTeamId", ok: false };
        const restoreProt = applyPickProtections(saveId, givePicks, p.pickProtections);
        try {
          const validation = engine.validateTradeOnServer(saveId, parties);
          const feedback = validation.legal ? engine.getAiTradeFeedback(saveId, parties) : [];
          const rejected = feedback.filter((f) => !f.verdict.accept);
          const summary = !validation.legal
            ? `预览：规则不通过——${validation.issues.map((i) => i.message).join("；").slice(0, 200)}`
            : rejected.length
              ? `预览：规则通过，但对方拒绝——${rejected.map((f) => `${f.teamId}（价值差 ${f.verdict.valueDelta}）`).join("；").slice(0, 200)}`
              : "预览：规则通过，对方 GM 接受——可安全执行 propose_trade";
          return { summary, data: { validation, feedback, parties }, ok: true };
        } finally {
          restoreProt();
        }
      }
      case "respond_trade": {
        const r = engine.respondInboundOffer(saveId, String(p.offerId), p.accept === true);
        const summary = p.accept === true ? (r.accepted ? "已接受对方报价，交易完成" : `接受失败：${r.reason ?? "执行失败"}`) : "已拒绝对方报价";
        return { summary, data: r as unknown as Record<string, unknown>, ok: p.accept === true ? r.accepted : true };
      }
      case "request_offers": {
        const gives = (Array.isArray(p.gives) ? p.gives : []) as { kind: string; id: string }[];
        const r = engine.requestTradeOffers(saveId, gives.map((g) => ({ kind: g.kind === "PICK" ? ("PICK" as const) : ("PLAYER" as const), id: String(g.id) })));
        return { summary: `询价完成：${r.offers.length} 支球队给出报价`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "extend_contract": {
        const ey = Number(p.extraYears);
        const av = Number(p.avgSalary);
        if (!Number.isInteger(ey) || !Number.isFinite(av)) {
          return { summary: `extend_contract 需要整数 extraYears 与数值 avgSalary（收到 extraYears=${String(p.extraYears)}, avgSalary=${String(p.avgSalary)}）`, ok: false };
        }
        const r = engine.extendContract(saveId, String(p.playerId), ey, av);
        return { summary: r.extended ? `续约成功（要价 ${r.asking}M/年）` : `续约被拒：${r.reason}`, data: r as unknown as Record<string, unknown>, ok: r.extended };
      }
      case "set_rotation":
        return { summary: "轮换已更新", data: engine.setRotation(saveId, teamShortId, (p.starters as string[]) ?? [], (p.minutes as Record<string, number>) ?? undefined) as unknown as Record<string, unknown>, ok: true };
      case "sign_free_agent": {
        const r = engine.submitFaOffer(saveId, String(p.playerId), Number(p.years ?? 2), Number(p.avgSalary ?? 0));
        return { summary: r.accepted ? `签约成功（兴趣度 ${r.interest}）` : `报价被拒：${r.reason?.slice(0, 160)}`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "waive_player": {
        const r = engine.waivePlayer(saveId, String(p.playerId), { stretch: p.stretch === true });
        return { summary: `已裁掉 ${r.waived}（死钱 ${r.total}M）`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "decline_option": {
        const r = engine.declineOption(saveId, String(p.playerId));
        return { summary: `已拒绝执行 ${r.declined} 的球队选项`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "exercise_option": {
        const r = engine.exerciseOption(saveId, String(p.playerId));
        return { summary: `已执行 ${r.exercised} 的球队选项——不再可拒绝`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "draft_pick":
        return draftPickFlow(ctx, p.prospectId ? String(p.prospectId) : undefined);
      case "finish_draft": {
        const picked = engine.makeDraftPick(saveId, { simulateAll: true });
        return { summary: `剩余选秀自动完成（${picked.length} 顺位）`, data: { picks: picked as unknown as Record<string, unknown> }, ok: true };
      }
      case "respond_offer_sheet": {
        const r = engine.respondOfferSheet(saveId, String(p.sheetId), p.match === true);
        return { summary: r.matched ? `已匹配报价单，留下 ${r.player}` : `放弃匹配，${r.player} 离队`, data: r as unknown as Record<string, unknown>, ok: true };
      }
      case "advance": {
        const scope = String(p.scope ?? "").toUpperCase();
        if (scope && scope !== "ROUND" && scope !== "ALL") {
          return { summary: `scope 只接受 "ROUND"（默认）或 "ALL"，收到 ${scope}`, ok: false };
        }
        const mode = ctx.phase === "REGULAR_SEASON" ? "MONTH" : ctx.phase === "PLAYOFFS" ? (scope === "ALL" ? "PLAYOFFS" : "PLAYOFF_ROUND") : "WEEK";
        const r = engine.advanceSim(saveId, mode as never);
        const after = engine.getSave(saveId)!;
        return { summary: `推进至 ${after.currentDate}：${r.days} 天 / ${r.gamesPlayed} 场${r.phaseChanged ? `，进入 ${r.phaseChanged}` : ""}${r.champion ? `，总冠军 ${r.champion}` : ""}`, data: { days: r.days, games: r.gamesPlayed, notes: r.notes.slice(0, 8) } as unknown as Record<string, unknown>, ok: true };
      }
      case "start_new_season":
        engine.startNewSeason(saveId);
        return { summary: `新赛季开启：${engine.getSave(saveId)?.currentDate}`, ok: true };
      case "do_nothing":
        return { summary: "观察一轮（无操作）", ok: true };
      default:
        return { summary: `未知动作 ${action}`, ok: false };
    }
  }

  function doAct(saveId: string, action: string, rawParams: Record<string, unknown>, note?: string) {
    const ctx = saveCtx(saveId);
    const allowed = PHASE_ACTIONS[ctx.phase] ?? [];
    if (!allowed.includes(action)) {
      return { error: `当前阶段 ${ctx.phase} 不允许动作 ${action}`, allowedActions: allowed, observation: buildObs(saveId) };
    }
    const { params, errors } = resolveParams(saveId, rawParams);
    if (errors.length) return { error: "ID 解析失败，未执行", errors };
    let out: { summary: string; data?: Record<string, unknown>; ok: boolean };
    try {
      out = executeAction(ctx, action, params);
    } catch (e) {
      return { error: `执行失败：${(e as Error).message}` };
    }
    if (note) engine.logEvent(saveId, "AGENT", note.slice(0, 300), { action, params });
    if (!out.ok) {
      // 失败动作不附完整观察（省 token）——validation/feedback 里已含全部诊断。
      return { ok: false, action, summary: out.summary, data: out.data, hint: "动作未执行成功；需要最新盘面请调 gm_observe" };
    }
    return { ok: out.ok, action, summary: out.summary, data: out.data, observation: buildObs(saveId) };
  }

  // -------------------------------------------------------------------------
  // MCP server
  // -------------------------------------------------------------------------

  const server = new McpServer({ name: "nba-gm", version: "2.0.0" });
  const FREE = "（纯读取，随时可调）";

  server.registerTool(
    "gm_new",
    {
      description: "开新存档：指定球队缩写。返回 saveId 与首份观察，并记为当前对局。",
      inputSchema: {
        team: z.string().describe("球队缩写，如 LAL/BOS/CHI"),
        name: z.string().optional().describe("存档名，默认 agent-play-<队>"),
        seed: z.number().optional().describe("不传则随机；固定 seed 可复现"),
      },
    },
    async ({ team, name, seed }) => {
      try {
        const t = team.toUpperCase();
        const sd = seed ?? Math.floor(Math.random() * 2 ** 31);
        const save = await engine.createSave({ name: name ?? `agent-play-${t}`, teamId: t, seed: sd });
        setCurrentSave(save.saveId);
        return json({ saveId: save.saveId, seed: sd, observation: buildObs(save.saveId) });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_saves",
    {
      description: `列出全部存档：id/名称/赛季/阶段/日期。gm_use 的 saveId 从这里取。${FREE}`,
      inputSchema: {},
    },
    async () => {
      try {
        const rows = getDb().select().from(savesT).orderBy(desc(savesT.updatedAt)).all();
        return json({
          free: true,
          saves: rows.map((s) => ({ saveId: s.id, name: s.name, season: s.season, phase: s.phase, currentDate: s.currentDate, updatedAt: s.updatedAt })),
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_use",
    {
      description: `不带参数：列出存档与当前对局。带 saveId：切换当前对局（跨会话接续）。${FREE}`,
      inputSchema: { saveId: z.string().optional() },
    },
    async ({ saveId }) => {
      try {
        if (saveId) {
          const id = resolveSaveId(saveId);
          setCurrentSave(id);
          const s = engine.getSave(id)!;
          return json({ current: id, name: s.name, phase: s.phase, currentDate: s.currentDate });
        }
        const rows = getDb().select().from(savesT).orderBy(desc(savesT.updatedAt)).limit(10).all();
        return json({ current: currentSaveId(), recent: rows.map((s) => ({ saveId: s.id, name: s.name, phase: s.phase, currentDate: s.currentDate })) });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_delete",
    {
      description: "删除存档（不可恢复，需 confirm:true）。",
      inputSchema: { saveId: z.string(), confirm: z.boolean().describe("必须 confirm:true") },
    },
    async ({ saveId, confirm }) => {
      try {
        if (confirm !== true) return errJson("删除不可恢复，需 confirm:true");
        const id = resolveSaveId(saveId);
        const s = engine.getSave(id)!;
        engine.deleteSave(id);
        try {
          const cur = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { saveId?: string };
          if (cur.saveId === id) setCurrentSave("");
        } catch {
          /* no state file */
        }
        return json({ deleted: id, name: s.name });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_observe",
    {
      description: `当前盘面：阶段、allowedActions、阵容、帽空间、inbound 报价、RFA 报价单、事件流；DRAFT/FA 阶段附带选秀板或自由球员池。${FREE}`,
      inputSchema: { saveId: z.string().optional() },
    },
    async ({ saveId }) => {
      try {
        return json({ saveId: resolveSaveId(saveId), observation: buildObs(resolveSaveId(saveId)) });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_act",
    {
      description:
        '执行一个 GM 动作：先做阶段白名单与 ID 解析校验（失败不执行），合法则直调引擎并返回结果 + 新鲜观察。params 里的球员/球队/选秀权可以写观察中的 id，也可以直接写名字（"Collin Sexton"、"LAL"、"LAL 2027 R1"）。动作清单见观察的 allowedActions；note 可选，会写入游戏事件流作为决策记录。',
      inputSchema: {
        action: z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
        note: z.string().optional().describe("一句话决策说明，写入游戏事件流"),
        saveId: z.string().optional(),
      },
    },
    async ({ action, params, note, saveId }) => {
      try {
        const r = doAct(resolveSaveId(saveId), action, params ?? {}, note);
        if ("error" in r) return errJson(r.error as string, r as Record<string, unknown>);
        return json(r);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_auto",
    {
      description:
        "托管推进：连续执行直到决策检查点才停——收到 inbound 报价/RFA 报价单、轮到我方选秀、阶段切换（DRAFT/FREE_AGENCY/PLAYOFFS 等）、季后赛一轮打完。返回每步日志 + 停下时的完整观察。常规赛每月一次 advance，季后赛默认每轮一停（playoffMode:all 一次打完），选秀期自动空过他人签位。",
      inputSchema: {
        saveId: z.string().optional(),
        maxSteps: z.number().int().min(1).max(60).default(30),
        autoPick: z.boolean().default(false).describe("轮到我方签位也自动选板上最优（默认停下等用户）"),
        finishFa: z.boolean().default(false).describe("进入自由市场直接 start_new_season 收官（默认停下等用户）"),
        playoffMode: z.enum(["round", "all"]).default("round").describe("季后赛推进粒度：round=每轮一停（默认），all=一次打完整个季后赛"),
        note: z.string().optional().describe("托管动作写入事件流的决策说明"),
      },
    },
    async ({ saveId, maxSteps, autoPick, finishFa, playoffMode, note }) => {
      try {
        const id = resolveSaveId(saveId);
        const log: string[] = [];
        let stopReason = "达到 maxSteps 上限";
        let lastObs: Record<string, unknown> | null = null;
        let startPhase: string | null = null;
        let fails = 0;
        for (let i = 0; i < maxSteps; i++) {
          const obs = buildObs(id);
          lastObs = obs;
          startPhase ??= obs.phase as string;
          if (obs.phase !== startPhase) {
            stopReason = `阶段切换 ${startPhase} → ${obs.phase}`;
            break;
          }
          const offers = obs.inboundOffers as unknown[] | undefined;
          if (offers?.length) {
            stopReason = `收到 ${offers.length} 份 inbound 报价（约 4 天过期）`;
            break;
          }
          const sheets = obs.offerSheets as unknown[] | undefined;
          if (sheets?.length) {
            stopReason = `收到 ${sheets.length} 份 RFA 报价单`;
            break;
          }
          let act: { action: string; params: Record<string, unknown> } | null = null;
          if (obs.phase === "REGULAR_SEASON") act = { action: "advance", params: {} };
          else if (obs.phase === "PLAYOFFS") act = { action: "advance", params: playoffMode === "all" ? { scope: "ALL" } : {} };
          else if (obs.phase === "DRAFT") {
            // myNextPick is OUR slot number, not the draft's position — the check
            // only means "on the clock" when it matches nextPick. Testing it alone
            // fired the moment the board existed, so the draft could never be
            // skipped through to our pick.
            const draft = obs.draft as { myNextPick?: number | null; nextPick?: number | null } | undefined;
            const onTheClock = draft?.myNextPick != null && draft.nextPick === draft.myNextPick;
            if (onTheClock && !autoPick) {
              stopReason = `轮到我方选秀（第 ${draft!.myNextPick} 顺位）`;
              break;
            }
            act = { action: "draft_pick", params: {} };
          } else if (obs.phase === "FREE_AGENCY") {
            if (!finishFa) {
              stopReason = "进入自由市场阶段（需用户决策签约/续约）";
              break;
            }
            act = { action: "start_new_season", params: {} };
          } else {
            stopReason = `未覆盖的阶段 ${obs.phase}`;
            break;
          }
          const r = doAct(id, act.action, act.params, note ?? `托管推进：${act.action}`);
          const ok = "error" in r ? false : r.ok !== false;
          const msg = "summary" in r ? r.summary : "error" in r ? r.error : "";
          log.push(`${act.action} ${ok ? "✓" : "✗"} ${(msg ?? "").slice(0, 90)}`);
          if (!ok && ++fails >= 2) {
            stopReason = "连续两次执行失败";
            break;
          }
          if (ok) fails = 0;
          if (ok && obs.phase === "PLAYOFFS" && playoffMode === "round") {
            stopReason = "季后赛本轮完成（playoffMode:round 每轮一停；playoffMode:all 可一次打完）";
            break;
          }
        }
        return json({ steps: log.length, stopReason, log, saveId: id, observation: lastObs ? buildObs(id) : null });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_status",
    {
      description: `存档概况：战绩/阶段/日期/化学反应/帽状况 + 近 5 场赛果 + 未来 5 场赛程 + 历届冠军记录。${FREE}`,
      inputSchema: { saveId: z.string().optional() },
    },
    async ({ saveId }) => {
      try {
        const id = resolveSaveId(saveId);
        const ctx = saveCtx(id);
        const db = getDb();
        const champs = db.select().from(awardsT).where(and(eq(awardsT.saveId, id), eq(awardsT.type, "CHAMPION"))).all().map((a) => ({ season: a.season, champion: a.detail }));
        const myChamps = db.select().from(awardsT).where(and(eq(awardsT.saveId, id), eq(awardsT.type, "CHAMPION"), eq(awardsT.teamId, ctx.teamFullId))).all().map((a) => a.season);
        const recent = engine.getRecentGames(id, 30).filter((g) => g.homeTeamId === ctx.teamFullId || g.awayTeamId === ctx.teamFullId).slice(0, 5).map((g) => `${g.date}: ${shortId(g.awayTeamId)}@${shortId(g.homeTeamId)} ${g.awayScore}-${g.homeScore}`);
        const upcoming = engine.getUpcomingGames(id, 30).filter((g) => g.homeTeamId === ctx.teamFullId || g.awayTeamId === ctx.teamFullId).slice(0, 5).map((g) => `${g.date}: ${shortId(g.awayTeamId)}@${shortId(g.homeTeamId)}`);
        const team = engine.loadLeagueState(id, { includeGames: false }).teams.find((t) => t.id === ctx.teamShortId);
        return json({
          free: true,
          saveId: id,
          name: ctx.save.name,
          phase: ctx.phase,
          currentDate: ctx.save.currentDate,
          team: team ? `${team.city} ${team.name}` : ctx.teamShortId,
          record: team ? `${team.wins}-${team.losses}` : null,
          chemistry: engine.getChemistry(id, ctx.teamShortId).overall,
          recentGames: recent,
          upcomingGames: upcoming,
          championships: champs,
          myChampionships: myChamps,
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 侦察工具（直读存档）
  // -------------------------------------------------------------------------

  server.registerTool(
    "gm_teams",
    {
      description: `全联盟概况：各队 phase（CONTENDER/REBUILD 等）、战绩、帽空间、阵容人数、前 4 核心——挑交易对象用。${FREE}`,
      inputSchema: { saveId: z.string().optional() },
    },
    async ({ saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const db = getDb();
        const out = db
          .select()
          .from(teamsT)
          .where(eq(teamsT.saveId, ctx.saveId))
          .all()
          .map((t) => {
            const roster = rosterView(ctx.saveId, t.id, ctx.season, ctx.phase, ctx.save.currentDate);
            const cap = capOf(ctx.saveId, t.id);
            return {
              teamId: shortId(t.id),
              team: `${t.city} ${t.name}`,
              mine: t.id === ctx.teamFullId,
              phase: t.aiPhase,
              record: `${t.wins}-${t.losses}`,
              capSpace: cap.capSpace,
              overSecondApron: cap.overSecondApron,
              rosterSize: roster.length,
              top: roster.slice(0, 4).map((p) => `${p.name}(${p.ovr})`),
            };
          });
        return json({ free: true, teams: out });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_roster",
    {
      description: `指定队（默认我方）完整阵容 + 合同细节 + 选秀权库存 + 帽状况。谈交易前侦察对手用这个。${FREE}`,
      inputSchema: { teamId: z.string().optional().describe("球队缩写如 LAL；默认我方"), saveId: z.string().optional() },
    },
    async ({ teamId, saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const ix = loadIndexes(ctx.saveId);
        const abbr = teamId ? resolveTeam(ix, teamId).id : ctx.teamShortId;
        if (!abbr) return errJson(`球队解析失败：${teamId}`);
        const fullId = `${ctx.saveId}:${abbr}`;
        const cap = capOf(ctx.saveId, fullId);
        return json({
          free: true,
          teamId: abbr,
          roster: rosterView(ctx.saveId, fullId, ctx.season, ctx.phase, ctx.save.currentDate),
          cap: { total: cap.totalSalary, space: cap.capSpace, overTax: cap.overTax, overFirstApron: cap.overFirstApron, overSecondApron: cap.overSecondApron },
          picks: picksView(ctx.saveId, fullId, ctx.season),
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_find",
    {
      description: `按名字搜球员（含自由球员/探子），返回稳定 ID 与关键信息。${FREE}`,
      inputSchema: { query: z.string(), saveId: z.string().optional() },
    },
    async ({ query, saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const ix = loadIndexes(ctx.saveId);
        const hits = findPlayers(ix, query).slice(0, 15);
        return json({
          free: true,
          hits: hits.map((p) => ({
            id: shortId(p.id),
            name: p.name,
            team: p.teamId ? shortId(p.teamId) : null,
            status: p.status,
            pos: p.position,
            age: p.age,
            ovr: p.ratings.overall,
            pot: p.ratings.potential,
            salary: p.contract.years[0]?.salary ?? 0,
            yearsLeft: p.contract.years.length,
            restricted: p.status === "FREE_AGENT" ? isRestrictedFa(p as never) : undefined,
          })),
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_pool",
    {
      description: `浏览球员池：自由球员/本届新秀/各队在册，支持位置、OVR 下限、薪资上限过滤与分页——补全观察里被截断的 FA/选秀名单。${FREE}`,
      inputSchema: {
        status: z.enum(["FA", "PROSPECT", "ROSTERED", "ALL"]).default("ALL").describe("FA=自由球员 PROSPECT=本届新秀 ROSTERED=各队在册 ALL=全部"),
        pos: z.string().optional().describe("PG/SG/SF/PF/C"),
        minOvr: z.number().optional(),
        maxSalary: z.number().optional().describe("首年薪资上限（M）"),
        limit: z.number().int().min(1).max(60).default(20),
        offset: z.number().int().min(0).default(0),
        saveId: z.string().optional(),
      },
    },
    async ({ status, pos, minOvr, maxSalary, limit, offset, saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const rows = getDb().select().from(playersT).where(eq(playersT.saveId, ctx.saveId)).all() as unknown as PlayerRow[];
        const sheetIds = new Set(engine.listOfferSheets(ctx.saveId).map((s) => s.playerId));
        const filtered = rows
          .filter((p) => {
            if (status === "FA" && p.status !== "FREE_AGENT") return false;
            if (status === "PROSPECT" && !(p.status === "PROSPECT" && p.draftYear === ctx.season)) return false;
            if (status === "ROSTERED" && !(p.teamId && (p.status === "ACTIVE" || p.status === "INJURED"))) return false;
            if (pos && p.position !== pos.toUpperCase()) return false;
            if (minOvr != null && p.ratings.overall < minOvr) return false;
            if (maxSalary != null && (p.contract.years[0]?.salary ?? 0) > maxSalary) return false;
            return true;
          })
          .sort((a, b) => b.ratings.overall - a.ratings.overall);
        return json({
          free: true,
          total: filtered.length,
          players: filtered.slice(offset, offset + limit).map((p) => ({
            id: shortId(p.id),
            name: p.name,
            team: p.teamId ? shortId(p.teamId) : null,
            status: p.status,
            pos: p.position,
            age: p.age,
            ovr: p.ratings.overall,
            pot: p.ratings.potential,
            salary: p.contract.years[0]?.salary ?? 0,
            yearsLeft: p.contract.years.length,
            ...(p.status === "FREE_AGENT"
              ? {
                  asking: askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, ctx.season),
                  restricted: isRestrictedFa(p as never),
                  underOfferSheet: sheetIds.has(p.id),
                  fromMyTeam: p.lastTeamId === ctx.teamFullId,
                }
              : {}),
          })),
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_picks",
    {
      description: `选秀权库存：持有中的签（含别队质押给我的）与我欠出的签。${FREE}`,
      inputSchema: { teamId: z.string().optional(), saveId: z.string().optional() },
    },
    async ({ teamId, saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const ix = loadIndexes(ctx.saveId);
        const abbr = teamId ? resolveTeam(ix, teamId).id : ctx.teamShortId;
        if (!abbr) return errJson(`球队解析失败：${teamId}`);
        return json({ free: true, teamId: abbr, ...picksView(ctx.saveId, `${ctx.saveId}:${abbr}`, ctx.season) });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_resolve",
    {
      description: `名字 → 稳定 ID 解析预览（gm_act 内建同款逻辑，提交前可先试水）。${FREE}`,
      inputSchema: { names: z.array(z.string()), saveId: z.string().optional() },
    },
    async ({ names, saveId }) => {
      try {
        const ctx = saveCtx(resolveSaveId(saveId));
        const ix = loadIndexes(ctx.saveId);
        const out = names.map((n) => {
          const p = resolvePlayer(ix, n);
          if (p.id) return { input: n, kind: "player", id: p.id };
          const t = resolveTeam(ix, n);
          if (t.id) return { input: n, kind: "team", id: t.id };
          const k = resolvePick(ix, n);
          if (k.id) return { input: n, kind: "pick", id: k.id };
          return { input: n, candidates: [...(p.candidates ?? []), ...(t.candidates ?? []), ...(k.candidates ?? [])].slice(0, 8) };
        });
        return json({ free: true, resolved: out });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "gm_events",
    {
      description: `游戏事件流：选秀/交易/签约/伤病/阶段切换的滚动日志，可分类过滤。${FREE}`,
      inputSchema: { limit: z.number().int().min(1).max(100).default(20), category: z.string().optional().describe("如 TRADE/DRAFT/FA/INJURY/AGENT"), saveId: z.string().optional() },
    },
    async ({ limit, category, saveId }) => {
      try {
        const id = resolveSaveId(saveId);
        const evs = engine.getEvents(id, limit, category).map((e) => ({ at: e.at, category: e.category, message: e.message }));
        return json({ free: true, events: evs.reverse() });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`[nba-gm] MCP server ready (root=${ROOT})`);
}

main().catch((e) => {
  console.error("[nba-gm] fatal:", e);
  process.exit(1);
});
