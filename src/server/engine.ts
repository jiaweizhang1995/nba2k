// Server-side engine: DB orchestration for saves, simulation advancement,
// trades, draft, free agency, God Mode and the audit log.
//
// Rules:
//  - every mutation runs inside a better-sqlite3 transaction
//  - every mutation writes an event row (audit log), God Mode ops flagged
//  - randomness is derived from (save.seed, salt) — never Math.random
//  - client requests never write the DB directly; only these functions

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  saves,
  teams as teamsT,
  players as playersT,
  draftPicks as picksT,
  games as gamesT,
  events as eventsT,
  faOffers as faOffersT,
  dataSources as dataSourcesT,
  awards as awardsT,
  godSnapshots as godSnapshotsT,
  type SaveRow,
} from "@/db/schema";
import { generateDemoLeague, DEMO_PROVIDER, DEMO_LICENSE, demoSource } from "@/data/demo";
import { loadRealPayload } from "@/data/real";
import { importData } from "./import";
import { RATING_VERSION } from "@/domain/ratings";
import { createSchedule, advanceDay, applyDevelopment, seasonScore, type LeagueState, type LeaguePlayer, type LeagueTeam, type LeagueGame } from "@/domain/sim/season";
import { CBA, CBA_VERSION, capSnapshot, round2, maxContractValue, contractEndSeason, salaryForSeason } from "@/domain/salary";
import { validateTrade, generateTradeOffers, TRADE_RULES_VERSION, aiEvaluateTrade, needPremium, playerValue, type TradeTeam, type TradePlayer, type TradePick } from "@/domain/trade";
import { computeChemistry, CHEMISTRY_VERSION } from "@/domain/chemistry";
import { runLottery, aiDraftPick, prospectRookieContract, generateScoutingReport, registerProspectRatings, generateDraftClass, type DraftProspect } from "@/domain/draft";
import { hashSeed, rngFor } from "@/domain/rng";
import { canAfford, evaluateOffer, aiCompetitionLevel, suggestedContract, askingSalaryFor } from "@/domain/freeagency";
import { classifyTeamPhase } from "@/domain/aiGm";
import type { SeasonPhase, TradeParty, DevelopmentState } from "@/domain/types";

const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto.randomUUID();
const stripId = (id: string) => (id.includes(":") ? id.split(":").slice(1).join(":") : id);

// ---------------------------------------------------------------------------
// Save lifecycle
// ---------------------------------------------------------------------------

export async function createSave(input: { name: string; teamId?: string; seed?: number; season?: number }): Promise<{ saveId: string; teamId: string }> {
  const db = getDb();
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const season = input.season ?? 2027; // 2026-27 season
  const saveId = uuid();
  const real = loadRealPayload();

  // Default path: build the league straight from the committed real NBA
  // payload (30 real teams, real rosters/stats/contracts) so every new save
  // is a real league from the first screen — no demo detour.
  if (real && real.teams.length > 0 && real.players.length > 0) {
    const userTeamId = `${saveId}:${input.teamId ?? real.teams[0].externalId}`;

    db.insert(saves)
      .values({
        id: saveId,
        name: input.name || "新存档",
        season,
        phase: "REGULAR_SEASON",
        currentDate: `${season - 1}-10-21`,
        seed,
        godMode: false,
        ruleVersion: CBA_VERSION,
        ratingVersion: RATING_VERSION,
        dataProvider: String(real.players[0]?.meta.provider ?? "UNKNOWN"),
        dataStatus: "IMPORTED",
        phaseState: { userTeamId },
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    try {
      await importData(saveId, real);
    } catch (e) {
      // Roll the stub save back so a failed import never leaves an empty husk.
      try {
        deleteSave(saveId);
      } catch {
        /* already gone */
      }
      throw e;
    }

    classifyTeamPhases(saveId);
    seedDevelopmentEstimates(saveId, seed);

    logEvent(
      saveId,
      "SYSTEM",
      `创建存档「${input.name}」（赛季 ${season - 1}-${String(season).slice(2)}，内置真实 NBA 数据：${real.teams.length} 队 / ${real.players.length} 名球员，种子 ${seed}）`,
      { seed, season, dataStatus: "IMPORTED", teams: real.teams.length, players: real.players.length },
    );
    return { saveId, teamId: userTeamId };
  }

  // Fallback when the payload asset is missing: legacy fictional demo league.
  return db.transaction((tx) => {
    const demo = generateDemoLeague(seed, season);
    const userTeamId = input.teamId ? `${saveId}:${input.teamId}` : `${saveId}:${demo.teams[0].id}`;

    tx.insert(saves)
      .values({
        id: saveId,
        name: input.name || "新存档",
        season,
        phase: "REGULAR_SEASON",
        currentDate: `${season - 1}-10-21`,
        seed,
        godMode: false,
        ruleVersion: CBA_VERSION,
        ratingVersion: RATING_VERSION,
        dataProvider: DEMO_PROVIDER,
        dataStatus: "DEMO",
        phaseState: { userTeamId },
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    for (const t of demo.teams) {
      tx.insert(teamsT)
        .values({
          id: `${saveId}:${t.id}`,
          saveId,
          abbr: t.abbr,
          city: t.city,
          name: t.name,
          conference: t.conference,
          division: t.division,
          colorPrimary: t.colorPrimary,
          wins: 0,
          losses: 0,
          aiPhase: "BUBBLE",
          aiRisk: 0.5,
          source: demoSource(),
        })
        .run();
    }

    for (const p of demo.players) {
      tx.insert(playersT)
        .values({
          id: `${saveId}:${p.id}`,
          saveId,
          name: p.name,
          teamId: p.teamId ? `${saveId}:${p.teamId}` : null,
          position: p.position,
          secondPosition: p.secondPosition,
          age: p.age,
          heightCm: p.heightCm,
          weightKg: p.weightKg,
          draftYear: p.draftYear,
          draftRound: p.draftRound,
          draftPick: p.draftPick,
          yearsPro: p.yearsPro,
          ratings: p.ratings,
          seasonStats: p.seasonStats,
          careerStats: p.status === "ACTIVE" && p.yearsPro > 0 ? [p.seasonStats[0]] : [],
          contract: p.contract,
          status: p.status,
          role: p.role,
          satisfaction: p.satisfaction,
          injury: null,
          development: { trajectory: p.age <= 23 ? "GROWING" : p.age >= 32 ? "DECLINING" : "STABLE", growthLeft: Math.max(0, (p.ratings.potential ?? p.ratings.overall) - p.ratings.overall), lastDelta: 0 },
          tenure: p.yearsPro > 0 ? Math.max(1, Math.min(6, p.yearsPro)) : 0,
          stamina: 1,
          lastGameDate: null,
          source: demoSource(),
        })
        .run();
    }

    // Draft picks: next 7 years, both rounds, randomly shuffled ownership swaps
    // (some picks already traded at save start for flavor).
    for (let year = season; year < season + 7; year++) {
      for (const t of demo.teams) {
        for (const round of [1, 2]) {
          tx.insert(picksT)
            .values({
              id: `${saveId}:pk-${year}-${round}-${t.abbr}`,
              saveId,
              year,
              round,
              originalTeamId: `${saveId}:${t.id}`,
              holderTeamId: `${saveId}:${t.id}`,
              status: year === season ? "OWNED" : "OWNED",
              protection: round === 1 && hashSeed(`prot:${saveId}:${year}:${t.abbr}`) % 10 === 0 ? { type: "LOTTERY_TOP_X", x: 3, yearShift: 1 } : null,
              resolved: null,
            })
            .run();
        }
      }
    }

    // Schedule for the current season
    const state = loadLeagueState(saveId, { includeGames: false });
    const schedule = createSchedule(state);
    for (const g of schedule) {
      tx.insert(gamesT)
        .values({
          id: `${saveId}:${g.id}`,
          saveId,
          date: g.date,
          season: g.season,
          type: g.type,
          round: null,
          seriesId: null,
          gameNo: null,
          homeTeamId: `${saveId}:${g.homeTeamId}`,
          awayTeamId: `${saveId}:${g.awayTeamId}`,
          homeScore: null,
          awayScore: null,
          status: "SCHEDULED",
          box: null,
        })
        .run();
    }

    // Team AI phases from roster quality
    for (const t of demo.teams) {
      const roster = demo.players.filter((p) => p.teamId === t.id && p.status === "ACTIVE");
      const avgOverall = roster.reduce((a, p) => a + p.ratings.overall, 0) / Math.max(1, roster.length);
      const avgAge = roster.reduce((a, p) => a + p.age, 0) / Math.max(1, roster.length);
      const picksOwned = 2;
      const prof = classifyTeamPhase(avgOverall, avgAge, 0, 0, picksOwned);
      tx.update(teamsT).set({ aiPhase: prof.phase, aiRisk: prof.risk }).where(eq(teamsT.id, `${saveId}:${t.id}`)).run();
    }

    tx.insert(dataSourcesT)
      .values({
        id: uuid(),
        saveId,
        provider: DEMO_PROVIDER,
        sourceUrl: null,
        retrievedAt: now(),
        season,
        licenseNote: DEMO_LICENSE,
        status: "DEMO",
        scope: "LEAGUE",
        records: demo.players.length,
      })
      .run();

    tx.insert(eventsT)
      .values({
        id: uuid(),
        saveId,
        at: now(),
        category: "SYSTEM",
        godMode: false,
        actor: "SYSTEM",
        message: `创建存档「${input.name}」（赛季 ${season - 1}-${String(season).slice(2)}，数据源：DEMO/演示数据，种子 ${seed}）`,
        payload: { seed, season, dataStatus: "DEMO" },
      })
      .run();

    return { saveId, teamId: userTeamId };
  });
}

/** Classify each team's competitive window from its roster quality (post-import). */
function classifyTeamPhases(saveId: string) {
  const db = getDb();
  const teams = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
  const players = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
  for (const t of teams) {
    const roster = players.filter((p) => p.teamId === t.id);
    // Season-start strength proxy: core-8 average of players whose ratings
    // come from real observed stats (stat-less players score a neutral 50).
    const rated = roster.filter((p) => p.ratings.confidence > 0);
    const pool = (rated.length >= 5 ? rated : roster)
      .slice()
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .slice(0, 8);
    const avgOverall = pool.reduce((a, p) => a + p.ratings.overall, 0) / Math.max(1, pool.length);
    // classifyTeamPhase keys off win% which is meaningless at 0-0 (every
    // fresh team would land in BUBBLE); tier on roster strength instead.
    const phase = (avgOverall >= 78 ? "CONTENDER" : avgOverall >= 75 ? "PLAYOFF" : avgOverall >= 72 ? "BUBBLE" : "REBUILD") as
      | "CONTENDER"
      | "PLAYOFF"
      | "BUBBLE"
      | "REBUILD";
    const risk = phase === "CONTENDER" ? 0.35 : phase === "PLAYOFF" ? 0.5 : phase === "BUBBLE" ? 0.6 : 0.55;
    db.update(teamsT).set({ aiPhase: phase, aiRisk: risk }).where(eq(teamsT.id, t.id)).run();
  }
}

/**
 * The real payload carries no scout potential values; derive a deterministic
 * growth budget from age so multi-season dynasties keep developing players.
 * These are engine scouting estimates, not official data — young players get
 * room to grow, veterans none, and 32+ decline.
 */
function seedDevelopmentEstimates(saveId: string, seed: number) {
  const db = getDb();
  const players = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
  for (const p of players) {
    const rng = rngFor(seed, `growth:${p.id}`);
    const growthLeft = p.age <= 21 ? rng.int(6, 14) : p.age <= 25 ? rng.int(2, 8) : p.age <= 28 ? rng.int(0, 4) : 0;
    const trajectory: DevelopmentState["trajectory"] = growthLeft > 0 ? "GROWING" : p.age >= 32 ? "DECLINING" : "STABLE";
    db.update(playersT).set({ development: { trajectory, growthLeft, lastDelta: 0 } }).where(eq(playersT.id, p.id)).run();
  }
}

export function listSaves() {
  const db = getDb();
  return db.select().from(saves).orderBy(desc(saves.createdAt)).all();
}

export function getSave(saveId: string): SaveRow | null {
  const db = getDb();
  return db.select().from(saves).where(eq(saves.id, saveId)).get() ?? null;
}

export function deleteSave(saveId: string) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(playersT).where(eq(playersT.saveId, saveId)).run();
    tx.delete(teamsT).where(eq(teamsT.saveId, saveId)).run();
    tx.delete(picksT).where(eq(picksT.saveId, saveId)).run();
    tx.delete(gamesT).where(eq(gamesT.saveId, saveId)).run();
    tx.delete(eventsT).where(eq(eventsT.saveId, saveId)).run();
    tx.delete(faOffersT).where(eq(faOffersT.saveId, saveId)).run();
    tx.delete(dataSourcesT).where(eq(dataSourcesT.saveId, saveId)).run();
    tx.delete(awardsT).where(eq(awardsT.saveId, saveId)).run();
    tx.delete(godSnapshotsT).where(eq(godSnapshotsT.saveId, saveId)).run();
    tx.delete(saves).where(eq(saves.id, saveId)).run();
  });
}

// ---------------------------------------------------------------------------
// State load / persist
// ---------------------------------------------------------------------------

export function loadLeagueState(saveId: string, opts: { includeGames?: boolean } = {}): LeagueState {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
  const playerRows = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
  const includeGames = opts.includeGames !== false;
  const gameRows = includeGames
    ? db.select().from(gamesT).where(and(eq(gamesT.saveId, saveId), eq(gamesT.season, save.season))).all()
    : [];

  const strip = (id: string) => (id?.includes(":") ? id.split(":").slice(1).join(":") : id);

  const teams: LeagueTeam[] = teamRows.map((t) => ({
    id: strip(t.id),
    abbr: t.abbr,
    city: t.city,
    name: t.name,
    conference: t.conference as "EAST" | "WEST",
    division: t.division,
    wins: t.wins,
    losses: t.losses,
  }));

  const players: LeaguePlayer[] = playerRows.map((p) => ({
    id: strip(p.id),
    name: p.name,
    teamId: p.teamId ? strip(p.teamId) : null,
    position: p.position,
    secondPosition: p.secondPosition,
    age: p.age,
    yearsPro: p.yearsPro,
    tenure: p.tenure,
    lastTeamId: p.lastTeamId ? strip(p.lastTeamId) : null,
    ratings: {
      overall: p.ratings.overall,
      threePoint: p.ratings.threePoint,
      finishing: p.ratings.finishing,
      inside: p.ratings.inside,
      freeThrow: p.ratings.freeThrow,
      playmaking: p.ratings.playmaking,
      rebounding: p.ratings.rebounding,
      perimeterD: p.ratings.perimeterD,
      interiorD: p.ratings.interiorD,
      usageTendency: p.ratings.usageTendency,
      potential: p.ratings.potential,
      potentialLow: p.ratings.potentialLow,
      potentialHigh: p.ratings.potentialHigh,
      confidence: p.ratings.confidence,
    },
    seasonStats: p.seasonStats.filter((s) => s.season === save.season).map((s) => ({ g: s.g, mp: s.mp, pts: s.pts, reb: s.reb, ast: s.ast, stl: s.stl, blk: s.blk, tov: s.tov, fgm: s.fgm, fga: s.fga, tpm: s.tpm, tpa: s.tpa, ftm: s.ftm, fta: s.fta })),
    contract: p.contract,
    status: p.status,
    role: p.role,
    satisfaction: p.satisfaction,
    injury: p.injury,
    development: p.development,
    stamina: p.stamina,
    lastGameDate: p.lastGameDate,
  }));

  const games: LeagueGame[] = gameRows.map((g) => ({
    id: strip(g.id),
    date: g.date,
    season: g.season,
    type: g.type as "REGULAR" | "PLAYOFF",
    round: g.round,
    seriesId: g.seriesId,
    gameNo: g.gameNo,
    homeTeamId: strip(g.homeTeamId),
    awayTeamId: strip(g.awayTeamId),
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    status: g.status as "SCHEDULED" | "FINAL",
    box: g.box,
  }));

  return {
    saveId,
    seed: save.seed,
    season: save.season,
    phase: save.phase as SeasonPhase,
    currentDate: save.currentDate,
    teams,
    players,
    games,
    playoffs: ((save.phaseState as Record<string, unknown> | null)?.playoffs as LeagueState["playoffs"]) ?? null,
    rotation: ((save.phaseState as Record<string, unknown> | null)?.rotation as LeagueState["rotation"]) ?? {},
  };
}

/** Persist league state deltas + phase in one transaction. */
export function persistState(state: LeagueState, extra?: { phaseState?: Record<string, unknown> | null }) {
  const db = getDb();
  const save = getSave(state.saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const full = (id: string) => `${state.saveId}:${id}`;

  db.transaction((tx) => {
    for (const t of state.teams) {
      tx.update(teamsT).set({ wins: t.wins, losses: t.losses }).where(eq(teamsT.id, full(t.id))).run();
    }
    const existing = new Map(db.select({ id: playersT.id }).from(playersT).where(eq(playersT.saveId, state.saveId)).all().map((r) => [r.id, true]));
    for (const p of state.players) {
      const rowId = full(p.id);
      if (!existing.has(rowId)) continue;
      const statLine = p.seasonStats[0];
      const seasonStat = statLine ? [{ season: state.season, teamAbbr: "N/A", ...statLine }] : [];
      tx.update(playersT)
        .set({
          teamId: p.teamId ? full(p.teamId) : null,
          age: p.age,
          yearsPro: p.yearsPro,
          // contract must persist too — prepareDraft rewrites it when players
          // re-sign; without this they keep stale expired deals and play free.
          contract: p.contract,
          lastTeamId: p.lastTeamId ? full(p.lastTeamId) : null,
          ratings: {
            overall: p.ratings.overall,
            inside: p.ratings.inside,
            finishing: p.ratings.finishing,
            shooting: p.ratings.threePoint,
            threePoint: p.ratings.threePoint,
            freeThrow: p.ratings.freeThrow,
            playmaking: p.ratings.playmaking,
            rebounding: p.ratings.rebounding,
            perimeterD: p.ratings.perimeterD,
            interiorD: p.ratings.interiorD,
            usageTendency: p.ratings.usageTendency,
            potential: p.ratings.potential,
            potentialLow: p.ratings.potentialLow,
            potentialHigh: p.ratings.potentialHigh,
            confidence: p.ratings.confidence,
            ratingVersion: RATING_VERSION,
          },
          seasonStats: seasonStat,
          status: p.status,
          role: p.role,
          satisfaction: p.satisfaction,
          injury: p.injury,
          development: p.development as DevelopmentState,
          stamina: p.stamina,
          lastGameDate: p.lastGameDate,
        })
        .where(eq(playersT.id, rowId))
        .run();
    }
    for (const g of state.games) {
      const rowId = full(g.id);
      const values = {
        date: g.date,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        status: g.status,
        box: (g.box ?? null) as never,
        round: g.round ?? null,
        seriesId: g.seriesId ?? null,
        gameNo: g.gameNo ?? null,
        type: g.type,
      };
      // Always persist every game in state: played games (results/box) and
      // newly scheduled playoff games alike. Cheap and avoids stale-date bugs.
      const upd = tx.update(gamesT).set(values).where(eq(gamesT.id, rowId)).run();
      if (upd.changes === 0) {
        // Playoff games created in-memory during advancement are new rows.
        tx.insert(gamesT).values({ id: rowId, saveId: state.saveId, season: g.season, homeTeamId: full(g.homeTeamId), awayTeamId: full(g.awayTeamId), ...values }).run();
      }
    }
    const basePhaseState = (save.phaseState as Record<string, unknown> | null) ?? {};
    const phaseState = {
      ...basePhaseState,
      ...(state.playoffs ? { playoffs: state.playoffs } : {}),
      ...(extra?.phaseState ?? {}),
    };
    tx.update(saves)
      .set({
        season: state.season,
        phase: state.phase,
        currentDate: state.currentDate,
        phaseState: phaseState as never,
        updatedAt: now(),
      })
      .where(eq(saves.id, state.saveId))
      .run();
  });
}

// ---------------------------------------------------------------------------
// Simulation advancement
// ---------------------------------------------------------------------------

export type AdvanceMode = "NEXT_GAME" | "DAY" | "WEEK" | "MONTH" | "REGULAR_SEASON" | "PLAYOFFS" | "SEASON";

export interface UserGameSummary {
  gameId: string;
  date: string;
  home: boolean;
  opponent: string; // abbr
  myScore: number;
  oppScore: number;
  win: boolean;
  ot: boolean;
  topPerformers: { name: string; team: string; pts: number; reb: number; ast: number; mp: number }[];
  keyReasons: string[];
}

export interface AdvanceResult {
  days: number;
  gamesPlayed: number;
  results: { date: string; home: string; away: string; homeScore: number; awayScore: number }[];
  injuries: { playerId: string; name: string; description: string; weeks: number }[];
  phaseChanged: SeasonPhase | null;
  champion: string | null;
  notes: string[];
  awards: { type: string; player: string | null; team: string | null }[];
  /** NEXT_GAME 专属：用户球队比赛摘要（结果 → 伤病 → 事件 → 原因的展示顺序在 UI 层） */
  userGames?: UserGameSummary[];
  fatigueChanges?: { name: string; from: number; to: number }[];
}

const shortId = (full: string) => full.split(":").slice(1).join(":");

export function advanceSim(saveId: string, mode: AdvanceMode, marketDiag?: Record<string, number>): AdvanceResult {
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase === "DRAFT" || save.phase === "FREE_AGENCY") {
    // Draft & FA need explicit user actions; advancing days is allowed but minimal.
  }

  const db = getDb();
  let state = loadLeagueState(saveId);
  const phaseState = getPhaseState(saveId);
  const userTeamId = phaseState.userTeamId ? shortId(String(phaseState.userTeamId)) : null;
  const maxDays =
    mode === "NEXT_GAME" ? 10 : mode === "DAY" ? 1 : mode === "WEEK" ? 7 : mode === "MONTH" ? 30 : mode === "REGULAR_SEASON" ? 240 : mode === "PLAYOFFS" ? 120 : 420;

  const result: AdvanceResult = { days: 0, gamesPlayed: 0, results: [], injuries: [], phaseChanged: null, champion: null, notes: [], awards: [], userGames: [], fatigueChanges: [] };
  const startPhase = state.phase;

  // Fatigue snapshot for the user's roster (NEXT_GAME reports stamina deltas).
  const staminaBefore = new Map<string, number>();
  if (mode === "NEXT_GAME" && userTeamId) {
    for (const p of state.players.filter((x) => x.teamId === userTeamId)) staminaBefore.set(p.id, p.stamina);
  }

  // Mid-season trade deadline: the first sim day on/after Feb 6 runs a live
  // AI↔AI market, then the state is reloaded so moved players actually suit
  // up for their new teams for the rest of the season.
  const deadlineDate = `${state.season}-02-06`;
  let deadlineDone = Boolean((phaseState as Record<string, unknown>)[`deadlineMarket:${state.season}`]);

  const playedGameIds: string[] = [];
  for (let i = 0; i < maxDays; i++) {
    if (mode === "REGULAR_SEASON" && state.phase !== "REGULAR_SEASON") break;
    if (mode === "PLAYOFFS" && state.phase !== "PLAYOFFS") break;
    if (mode === "SEASON" && state.phase === "OFFSEASON") break;
    // Granular modes stop at phase boundaries so callers (eval agents) get a
    // fresh observation whenever the league context changes.
    if ((mode === "DAY" || mode === "WEEK" || mode === "MONTH") && state.phase !== startPhase) break;
    const report = advanceDay(state);
    result.days++;
    result.gamesPlayed += report.gamesPlayed;
    result.results.push(...report.results.map((r) => ({ ...r, date: report.date })));
    result.injuries.push(...report.injuries);
    result.notes.push(...report.notes);
    playedGameIds.push(...report.results.map((r) => r.gameId));
    if (!deadlineDone && state.phase === "REGULAR_SEASON" && report.date >= deadlineDate) {
      persistState(state);
      const n = runAiTradeMarket(saveId, marketDiag, { deadline: true });
      if (n > 0) result.notes.push(`交易截止日：联盟完成 ${n} 笔 AI 交易`);
      db.update(saves)
        // Re-read phaseState: runAiTradeMarket may have just written
        // inboundOffers — spreading the stale snapshot would clobber them.
        .set({ phaseState: { ...getPhaseState(saveId), [`deadlineMarket:${state.season}`]: true } as never, updatedAt: now() })
        .where(eq(saves.id, saveId))
        .run();
      deadlineDone = true;
      state = loadLeagueState(saveId);
    }
    if (mode === "NEXT_GAME" && userTeamId) {
      const userPlayed = report.results.some((r) => {
        const g = state.games.find((x) => x.id === r.gameId);
        return g && (g.homeTeamId === userTeamId || g.awayTeamId === userTeamId);
      });
      if (userPlayed) break;
    }
  }
  result.phaseChanged = state.phase !== startPhase ? state.phase : null;

  // User-team game summaries (box score → top performers + key reasons).
  if (userTeamId) {
    const teamsById = new Map(state.teams.map((t) => [t.id, t]));
    for (const gid of playedGameIds) {
      const g = state.games.find((x) => x.id === gid);
      if (!g || g.status !== "FINAL" || (g.homeTeamId !== userTeamId && g.awayTeamId !== userTeamId)) continue;
      const home = g.homeTeamId === userTeamId;
      const box = g.box as { home?: { name: string; teamId: string; pts: number; reb: number; ast: number; mp: number }[]; away?: { name: string; teamId: string; pts: number; reb: number; ast: number; mp: number }[]; notes?: string[] } | null;
      const myScore = (home ? g.homeScore : g.awayScore) ?? 0;
      const oppScore = (home ? g.awayScore : g.homeScore) ?? 0;
      const allLines = [...(box?.home ?? []), ...(box?.away ?? [])];
      const topPerformers = allLines
        .sort((a, b) => b.pts - a.pts)
        .slice(0, 3)
        .map((l) => ({ name: l.name, team: teamsById.get(l.teamId)?.abbr ?? "", pts: l.pts, reb: l.reb, ast: l.ast, mp: l.mp }));
      result.userGames!.push({
        gameId: g.id,
        date: g.date,
        home,
        opponent: teamsById.get(home ? g.awayTeamId : g.homeTeamId)?.abbr ?? "?",
        myScore,
        oppScore,
        win: myScore > oppScore,
        ot: (box?.notes ?? []).some((n) => n.includes("加时")),
        topPerformers,
        keyReasons: (box?.notes ?? []).slice(0, 4),
      });
    }
    for (const p of state.players.filter((x) => x.teamId === userTeamId)) {
      const from = staminaBefore.get(p.id);
      if (from != null && Math.abs(from - p.stamina) >= 0.05) {
        result.fatigueChanges!.push({ name: p.name, from: Math.round(from * 100), to: Math.round(p.stamina * 100) });
      }
    }
    result.fatigueChanges!.sort((a, b) => a.to - b.to);
  }

  // Playoffs may have crowned a champion within the loop — check on every
  // transition into OFFSEASON, not only when the run started in PLAYOFFS.
  const enteringOffseason = startPhase !== "OFFSEASON" && state.phase === "OFFSEASON";
  const champion = enteringOffseason ? findChampion(state) : null;
  result.champion = champion;

  if (enteringOffseason) {
    result.awards = recordAwards(state, champion);
    prepareDraft(state, result);
  }

  persistState(state);
  logEvent(saveId, "SIM", `推进 ${result.days} 天，进行 ${result.gamesPlayed} 场比赛（${startPhase} → ${state.phase}）`, { results: result.results.slice(0, 20), injuries: result.injuries, champion });
  return result;
}

function findChampion(state: LeagueState): string | null {
  const finals = state.games.filter((g) => g.type === "PLAYOFF" && g.round === "FINALS" && g.status === "FINAL");
  if (finals.length === 0) return null;
  const tally = new Map<string, number>();
  for (const g of finals) {
    const winner = (g.homeScore ?? 0) > (g.awayScore ?? 0) ? g.homeTeamId : g.awayTeamId;
    tally.set(winner, (tally.get(winner) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function recordAwards(state: LeagueState, champion: string | null): AdvanceResult["awards"] {
  const db = getDb();
  const out: AdvanceResult["awards"] = [];
  db.transaction((tx) => {
    if (champion) {
      const t = state.teams.find((x) => x.id === champion);
      tx.insert(awardsT).values({ id: uuid(), saveId: state.saveId, season: state.season, type: "CHAMPION", teamId: `${state.saveId}:${champion}`, playerId: null, detail: t ? `${t.city} ${t.name}` : null }).run();
      out.push({ type: "CHAMPION", player: null, team: t ? `${t.city} ${t.name}` : null });
    }
    const qualified = state.players.filter((p) => p.seasonStats[0] && p.seasonStats[0].g >= 40 && p.teamId);
    const best = (fn: (p: LeaguePlayer) => number) => [...qualified].sort((x, y) => fn(y) - fn(x))[0];
    const mvp = best((p) => seasonScore(p) * (state.teams.find((t) => t.id === p.teamId)?.wins ?? 30) / 82);
    if (mvp) {
      tx.insert(awardsT).values({ id: uuid(), saveId: state.saveId, season: state.season, type: "MVP", playerId: `${state.saveId}:${mvp.id}`, teamId: mvp.teamId ? `${state.saveId}:${mvp.teamId}` : null, detail: `赛季评分 ${seasonScore(mvp).toFixed(1)}` }).run();
      out.push({ type: "MVP", player: mvp.name, team: null });
    }
    const dpoy = best((p) => (p.seasonStats[0].blk / p.seasonStats[0].g) * 2 + (p.seasonStats[0].stl / p.seasonStats[0].g) * 1.5 + p.ratings.interiorD * 0.1 + p.ratings.perimeterD * 0.1);
    if (dpoy) {
      tx.insert(awardsT).values({ id: uuid(), saveId: state.saveId, season: state.season, type: "DPOY", playerId: `${state.saveId}:${dpoy.id}`, teamId: dpoy.teamId ? `${state.saveId}:${dpoy.teamId}` : null, detail: null }).run();
      out.push({ type: "DPOY", player: dpoy.name, team: null });
    }
    // ROY is strictly a first-season award: yearsPro is incremented in
    // applyDevelopment which runs after this, so true rookies show 0 here.
    const roy = best((p) => (p.yearsPro === 0 && p.ratings.overall >= 70 ? seasonScore(p) : -1));
    if (roy && roy.yearsPro === 0) {
      tx.insert(awardsT).values({ id: uuid(), saveId: state.saveId, season: state.season, type: "ROY", playerId: `${state.saveId}:${roy.id}`, teamId: roy.teamId ? `${state.saveId}:${roy.teamId}` : null, detail: null }).run();
      out.push({ type: "ROY", player: roy.name, team: null });
    }
  });
  return out;
}

/** Roll into the draft: development, contracts, awards already handled. */
function prepareDraft(state: LeagueState, result: AdvanceResult) {
  // 1) development & aging
  const devDelta = applyDevelopment(state);
  for (const d of devDelta.slice(0, 10)) {
    result.notes.push(`${d.name} 能力变化 ${d.delta > 0 ? "+" : ""}${d.delta}`);
  }

  // 2) expire contracts: AI teams re-sign most of their own expiring players;
  // the rest become free agents. The USER's expiring players all hit the
  // market — re-signing them (with Bird rights, see submitFaOffer) is a real
  // GM decision, not something the engine should auto-resolve.
  const newSeason = state.season + 1;

  // 1.5) retirements: old and washed-up players hang it up — deterministic
  // per player/season. Remaining guaranteed money stays on the books as dead
  // cap (retirement doesn't erase a contract in the NBA).
  {
    const psNow = getPhaseState(state.saveId);
    const deadCap = { ...((psNow.deadCap as Record<string, { season: number; salary: number }[]> | undefined) ?? {}) };
    let retired = 0;
    const retiredNames: string[] = [];
    for (const p of state.players) {
      if (p.status !== "ACTIVE" && p.status !== "INJURED" && p.status !== "FREE_AGENT") continue;
      const chance =
        p.age >= 40 ? 0.75 :
        p.age === 39 ? 0.55 :
        p.age === 38 ? 0.4 :
        p.age === 37 ? 0.25 :
        p.age === 36 ? 0.12 :
        p.ratings.overall < 55 ? 0.3 :
        (p.age >= 33 && p.ratings.overall < 60) ? 0.35 : 0;
      if (chance <= 0) continue;
      const rng = rngFor(state.seed, `retire:${state.season}:${p.id}`);
      if (!rng.chance(chance)) continue;
      if (p.teamId && p.contract.years.length) {
        const owed = p.contract.years.filter((y) => y.season >= newSeason).map((y) => ({ season: y.season, salary: y.salary }));
        if (owed.length) deadCap[p.teamId] = [...(deadCap[p.teamId] ?? []), ...owed];
      }
      p.lastTeamId = p.teamId;
      p.teamId = null;
      p.status = "RETIRED";
      p.contract = { ...p.contract, years: [] };
      retired++;
      retiredNames.push(p.name);
    }
    if (retired > 0) {
      const db = getDb();
      db.update(saves)
        .set({ phaseState: { ...psNow, deadCap } as never, updatedAt: now() })
        .where(eq(saves.id, state.saveId))
        .run();
      result.notes.push(`休赛期退役 ${retired} 人：${retiredNames.slice(0, 6).join("、")}${retired > 6 ? " 等" : ""}`);
    }
  }

  const userShort = (() => {
    const uid = getPhaseState(state.saveId).userTeamId as string | undefined;
    return uid ? stripId(uid) : null;
  })();
  let resigned = 0;
  let enteredFa = 0;
  let userExpired = 0;
  for (const p of state.players) {
    if (p.status === "PROSPECT") continue;
    const end = p.contract.years.length ? p.contract.years[p.contract.years.length - 1].season : 0;
    if (end >= newSeason || !p.teamId) continue;
    if (p.teamId === userShort) {
      // Team-option year on the user's roster: the GM exercises it — the
      // asset stays one more year at the option salary (declining is just
      // waiving, which the agent can still do during FA).
      if (p.contract.option === "TO") {
        const optSalary = p.contract.years[p.contract.years.length - 1]?.salary ?? CBA.minimumSalary;
        p.contract = { ...p.contract, years: [{ season: newSeason, salary: optSalary }], option: null };
        continue;
      }
      p.lastTeamId = p.teamId;
      p.teamId = null;
      p.status = "FREE_AGENT";
      userExpired++;
      continue;
    }
    const rng = rngFor(state.seed, `resign:${state.season}:${p.id}`);
    const overall = p.ratings.overall;
    // Team options: AI exercises them for anyone still worth rostering —
    // cheap controlled years are the whole point of rookie-scale deals.
    if (p.contract.option === "TO") {
      if (overall >= 66 || p.age <= 24) {
        const optSalary = p.contract.years[p.contract.years.length - 1]?.salary ?? CBA.minimumSalary;
        p.contract = { ...p.contract, years: [{ season: newSeason, salary: optSalary }], option: null };
        resigned++;
        continue;
      }
      // declined → free agent
      p.lastTeamId = p.teamId;
      p.teamId = null;
      p.status = "FREE_AGENT";
      enteredFa++;
      continue;
    }
    const keepProb = overall >= 85 ? 0.9 : overall >= 72 ? 0.8 : 0.62;
    if (rng.chance(keepProb)) {
      const newYears = rng.int(2, 4);
      // Re-sign at market value — a star leaving a rookie deal commands real
      // money, not last year's scale number plus a token raise.
      const base = askingSalaryFor(p.contract, p.yearsPro, overall, p.age);
      p.contract = {
        type: overall >= 86 ? "MAX" : "VETERAN",
        years: Array.from({ length: newYears }, (_, i) => ({ season: newSeason + i, salary: Math.round(base * (1 + i * 0.05) * 10) / 10 })),
        birdRights: true,
        noTrade: false,
        option: null,
        signedSeason: state.season,
      };
      resigned++;
    } else {
      p.lastTeamId = p.teamId;
      p.teamId = null;
      p.status = "FREE_AGENT";
      enteredFa++;
    }
  }
  result.notes.push(`休赛期续约 ${resigned} 人，${enteredFa} 人进入自由市场`);
  if (userExpired > 0) {
    result.notes.push(`你的 ${userExpired} 名球员合同到期成为自由球员（可用鸟权超帽续约，不续约将被其他球队签走）`);
  }

  // 3) roll career stats
  for (const p of state.players) {
    const s = p.seasonStats[0];
    if (s && s.g > 0) {
      // career stats are maintained in DB via persist below
    }
    p.seasonStats = [];
    p.stamina = 1;
  }

  // 4) lottery: worst 14 records (non-playoff approximation = worst records overall)
  const order = [...state.teams].sort((a, b) => a.wins - b.wins || (a.abbr < b.abbr ? -1 : 1));
  const worst14 = order.slice(0, 14).map((t) => t.id);
  const lotteryResult = runLottery(state.seed, state.season, [...worst14, ...order.slice(14).map((t) => t.id)]);
  // Draft order: round 1 = lottery order; round 2 = reverse standings.
  // Slot ownership follows the pick rows, not standings — a traded pick's
  // holder picks in the original team's slot (otherwise traded picks never
  // convey and makeDraftPick deadlocks on slots no pick row can fill).
  const db2 = getDb();
  const pickHolder = (round: number, origShort: string): string => {
    const row = db2
      .select({ holder: picksT.holderTeamId })
      .from(picksT)
      .where(and(eq(picksT.saveId, state.saveId), eq(picksT.year, newSeason), eq(picksT.round, round), eq(picksT.originalTeamId, `${state.saveId}:${origShort}`)))
      .get();
    return row ? row.holder.split(":").slice(1).join(":") : origShort;
  };
  const round1 = lotteryResult;
  const round2 = order.map((t) => t.id);
  const draftOrder = [...round1.map((id, i) => ({ pickNumber: i + 1, round: 1, holderTeamId: pickHolder(1, id) })), ...round2.map((id, i) => ({ pickNumber: i + 1, round: 2, holderTeamId: pickHolder(2, id) }))];

  state.phase = "DRAFT";
  state.season = newSeason;
  state.currentDate = `${newSeason - 1}-06-25`;

  persistDraftOrder(state.saveId, draftOrder, lotteryResult, worst14);
  const generated = ensureDraftClass(state.saveId, state.seed, newSeason);
  if (generated > 0) result.notes.push(`已生成 ${generated} 人新秀池`);
  logEvent(state.saveId, "DRAFT", `选秀大会准备就绪：乐透抽签完成（${state.season} 届）`, { lottery: round1.slice(0, 5), prospects: generated });
}

/**
 * Ensure a scoutable draft class exists for the season. Real-data saves ship
 * without prospects — generate a deterministic 60-man class so the draft
 * actually acquires players instead of recording 60 skipped picks.
 */
function ensureDraftClass(saveId: string, seed: number, season: number): number {
  const db = getDb();
  const existing = db
    .select({ id: playersT.id })
    .from(playersT)
    .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "PROSPECT"), eq(playersT.draftYear, season)))
    .all();
  if (existing.length > 0) return 0;

  const prospects = generateDraftClass(seed, season);
  const src = {
    provider: "GENERATED",
    sourceUrl: null,
    retrievedAt: null,
    season: null,
    licenseNote: DEMO_LICENSE,
    status: "DEMO" as const,
    ratingVersion: RATING_VERSION,
  };
  db.transaction((tx) => {
    prospects.forEach((p, i) => {
      const rowId = `${saveId}:pros-${season}-${i + 1}`;
      tx.insert(playersT)
        .values({
          id: rowId,
          saveId,
          name: p.name,
          teamId: null,
          position: p.position,
          secondPosition: p.secondPosition,
          age: p.age,
          heightCm: p.heightCm,
          weightKg: p.weightKg,
          draftYear: season,
          draftRound: null,
          draftPick: null,
          yearsPro: 0,
          ratings: p.ratings,
          seasonStats: [],
          careerStats: [],
          contract: { type: "ROOKIE", years: [], birdRights: false, noTrade: false, option: null, signedSeason: season },
          status: "PROSPECT",
          role: "BENCH",
          satisfaction: 70,
          injury: null,
          development: { trajectory: "GROWING", growthLeft: Math.max(0, (p.ratings.potential ?? p.ratings.overall) - p.ratings.overall), lastDelta: 0 },
          tenure: 0,
          stamina: 1,
          lastGameDate: null,
          baselineStats: null,
          source: src,
        })
        .run();
      registerProspectRatings(rowId, p.ratings);
    });
  });
  return prospects.length;
}

function persistDraftOrder(saveId: string, order: { pickNumber: number; round: number; holderTeamId: string }[], lottery: string[], worst14: string[]) {
  const db = getDb();
  const existing = getPhaseState(saveId);
  db.update(saves)
    .set({ phaseState: { ...existing, draft: { order, lottery, worst14 } } as never, updatedAt: now() })
    .where(eq(saves.id, saveId))
    .run();
}

export function getPhaseState(saveId: string): Record<string, unknown> {
  const save = getSave(saveId);
  return (save?.phaseState as Record<string, unknown>) ?? {};
}

// ---------------------------------------------------------------------------
// Events / audit log
// ---------------------------------------------------------------------------

export function logEvent(saveId: string, category: string, message: string, payload?: Record<string, unknown>, opts: { godMode?: boolean; actor?: string } = {}) {
  const db = getDb();
  db.insert(eventsT)
    .values({
      id: uuid(),
      saveId,
      at: now(),
      category,
      godMode: opts.godMode ?? false,
      actor: opts.actor ?? "USER",
      message,
      payload: payload ?? null,
    })
    .run();
}

export function getEvents(saveId: string, limit = 200, category?: string) {
  const db = getDb();
  const q = db.select().from(eventsT).where(eq(eventsT.saveId, saveId)).orderBy(desc(eventsT.at)).limit(limit);
  const rows = q.all();
  return category ? rows.filter((r) => r.category === category) : rows;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

function toTradeTeam(saveId: string, teamId: string): TradeTeam {
  const db = getDb();
  const team = db.select().from(teamsT).where(eq(teamsT.id, `${saveId}:${teamId}`)).get();
  if (!team) throw new EngineError("NO_TEAM", "球队不存在");
  const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${teamId}`))).all();
  const picks = db.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.holderTeamId, `${saveId}:${teamId}`))).all();
  const tp: TradePlayer[] = roster
    .filter((p) => p.status === "ACTIVE" || p.status === "INJURED")
    .map((p) => ({
      id: p.id.split(":").slice(1).join(":"),
      name: p.name,
      teamId: teamId,
      position: p.position,
      age: p.age,
      yearsPro: p.yearsPro,
      ratings: p.ratings,
      contract: p.contract,
      status: p.status,
      role: p.role,
    }));
  const tk: TradePick[] = picks.map((p) => ({
    id: p.id.split(":").slice(1).join(":"),
    year: p.year,
    round: p.round,
    originalTeamId: p.originalTeamId.split(":").slice(1).join(":"),
    holderTeamId: teamId,
    status: p.status,
    protection: p.protection,
  }));
  return {
    id: teamId,
    abbr: team.abbr,
    players: tp,
    picks: tk,
    aiPhase: team.aiPhase as TradeTeam["aiPhase"],
    aiRisk: team.aiRisk,
    deadMoney: deadCapHit(saveId, teamId),
  };
}

export function validateTradeOnServer(saveId: string, parties: TradeParty[]) {
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const teams = parties.map((p) => toTradeTeam(saveId, p.teamId));
  return validateTrade({ saveId, parties }, teams, save.season, { phase: save.phase, date: save.currentDate });
}

export function getAiTradeFeedback(saveId: string, parties: TradeParty[]) {
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const teams = parties.map((p) => toTradeTeam(saveId, p.teamId));
  const aiParties = parties.filter((p) => p.teamId !== parties[0].teamId);
  return aiParties.map((p) => ({
    teamId: p.teamId,
    verdict: aiEvaluateTrade(p, { saveId, parties }, teams, save.season),
  }));
}

/**
 * 征集报价（NBA 2K 式询价）：用户只指定送出的资产，联盟中每支感兴趣的球队
 * 回报一份具体的、已经过规则校验与对方 GM 意愿评估的报价。确定性：同一存档
 * 种子 + 同一送出包 → 相同报价列表。
 */
export function requestTradeOffers(saveId: string, gives: { kind: "PLAYER" | "PICK"; id: string }[]) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const phaseState = getPhaseState(saveId);
  const userTeamId = phaseState.userTeamId as string | undefined;
  if (!userTeamId) throw new EngineError("NO_TEAM", "请先选择执教球队");
  const userShort = userTeamId.split(":").pop()!;

  const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
  const teams = teamRows.map((t) => toTradeTeam(saveId, t.id.split(":").slice(1).join(":")));
  const userTeam = teams.find((t) => t.id === userShort);
  if (!userTeam) throw new EngineError("NO_TEAM", "球队不存在");

  const players = gives
    .filter((a) => a.kind === "PLAYER")
    .map((a) => {
      const p = userTeam.players.find((x) => x.id === a.id);
      if (!p) throw new EngineError("NOT_OWNED", "送出的球员不在你的阵容中");
      return p;
    });
  const picks = gives
    .filter((a) => a.kind === "PICK")
    .map((a) => {
      const pk = userTeam.picks.find((x) => x.id === a.id);
      if (!pk) throw new EngineError("PICK_NOT_OWNED", "送出的选秀权不归你持有");
      return pk;
    });
  const noTrade = players.filter((p) => p.contract.noTrade);
  if (noTrade.length > 0) {
    throw new EngineError("NO_TRADE_CLAUSE", `包含不可交易球员：${noTrade.map((p) => p.name).join("、")}`);
  }
  if (players.length + picks.length === 0) {
    throw new EngineError("EMPTY_OFFER", "请先选择要送出的球员或选秀权");
  }

  const offers = generateTradeOffers(userShort, { players, picks }, teams, save.season, save.seed, 6, { phase: save.phase, date: save.currentDate });

  const labelFor = (teamShortId: string, a: { kind: "PLAYER" | "PICK"; id: string }) => {
    const t = teams.find((x) => x.id === teamShortId);
    if (!t) return a.id;
    if (a.kind === "PLAYER") return t.players.find((p) => p.id === a.id)?.name ?? a.id;
    const pk = t.picks.find((p) => p.id === a.id);
    return pk ? `${pk.year} ${pk.round === 1 ? "首轮" : "次轮"}签` : a.id;
  };

  logEvent(
    saveId,
    "TRADE",
    `发起询价：送出 ${gives.map((a) => labelFor(userShort, a)).join("、")}；${offers.length} 支球队给出报价`,
    { gives, offerCount: offers.length },
  );

  return {
    offers: offers.map((o) => {
      const t = teams.find((x) => x.id === o.teamId)!;
      return {
        ...o,
        teamLabel: t.abbr,
        givesLabeled: o.gives.map((a) => ({ kind: a.kind, id: a.id, label: labelFor(o.teamId, a) })),
      };
    }),
  };
}

/** Execute a validated trade (or force it via God Mode). */
export function executeTrade(saveId: string, parties: TradeParty[], opts: { godMode?: boolean; force?: boolean; note?: string; allowPostDeadline?: boolean } = {}) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  // Trade window: open during REGULAR_SEASON until the Feb-6 deadline, and
  // again through DRAFT/FREE_AGENCY/OFFSEASON. Closed during PLAYOFFS.
  // AI market trades carry a note and run inside the window, so this only
  // ever bites user/god trades outside it.
  const isAiMarket = opts.note === "AI 交易截止日" || opts.note === "AI 休赛期交易";
  if (!opts.godMode && !isAiMarket && !opts.allowPostDeadline) {
    if (save.phase === "PLAYOFFS") {
      return { executed: false as const, validation: { legal: false, issues: [{ code: "WINDOW", severity: "BLOCKER" as const, message: "季后赛期间交易窗口关闭" }], salaryCheck: [] } };
    }
    if (save.phase === "REGULAR_SEASON" && save.currentDate > `${save.season}-02-06`) {
      return { executed: false as const, validation: { legal: false, issues: [{ code: "WINDOW", severity: "BLOCKER" as const, message: "交易截止日已过（2 月 6 日），本赛季交易窗口关闭" }], salaryCheck: [] } };
    }
  }
  const teams = parties.map((p) => toTradeTeam(saveId, p.teamId));
  // The deadline market fires on the first sim day on/after Feb 6 — validate
  // it as-of the deadline so the WINDOW rule doesn't kill legitimate market
  // trades (they already ran inside the real window).
  const validationNow = isAiMarket || opts.allowPostDeadline
    ? { phase: save.phase, date: `${save.season}-02-06` }
    : { phase: save.phase, date: save.currentDate };
  const validation = validateTrade({ saveId, parties }, teams, save.season, validationNow);
  if (!validation.legal && !(opts.godMode && opts.force)) {
    return { executed: false as const, validation };
  }
  if (opts.godMode && !validation.legal) {
    logEvent(saveId, "GOD", `GOD MODE：跳过交易规则校验强制成交`, { validation: validation.issues }, { godMode: true });
  }

  const aiFeedback = getAiTradeFeedback(saveId, parties);

  db.transaction((tx) => {
    // Each asset a party gives goes to exactly one receiving party. Build the
    // assignment map first (assetId -> new owning teamId).
    const assignments = new Map<string, string>();
    for (const party of parties) {
      for (const asset of party.receives) {
        const from = parties.find((p) => p.gives.some((g) => g.id === asset.id));
        if (from && from.teamId !== party.teamId) assignments.set(asset.id, party.teamId);
        else if (from) {
          // Team gave the asset to itself (e.g. pick swap flavor) — keep owner.
          assignments.set(asset.id, party.teamId);
        }
      }
    }
    for (const [assetId, teamId] of assignments) {
      tx.update(playersT).set({ teamId: `${saveId}:${teamId}` }).where(eq(playersT.id, `${saveId}:${assetId}`)).run();
      tx.update(picksT).set({ holderTeamId: `${saveId}:${teamId}` }).where(eq(picksT.id, `${saveId}:${assetId}`)).run();
    }

    // Roles & satisfaction adjustments after trade
    for (const party of parties) {
      const roster = tx.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${party.teamId}`))).all();
      const sorted = [...roster].sort((a, b) => b.ratings.overall - a.ratings.overall);
      sorted.forEach((p, i) => {
        const role = i === 0 && p.ratings.overall >= 86 ? "STAR" : i === 1 && p.ratings.overall >= 84 ? "STAR" : i < 5 ? "STARTER" : i === 5 && p.ratings.overall >= 79 ? "SIXTH_MAN" : i < 10 ? "ROTATION" : "BENCH";
        const newSat = Math.max(20, Math.min(95, p.satisfaction - (p.role !== role ? 6 : 0)));
        tx.update(playersT).set({ role, satisfaction: newSat }).where(eq(playersT.id, p.id)).run();
      });
    }
  });

  const summary = parties
    .map((p) => {
      const t = teams.find((x) => x.id === p.teamId)!;
      const names = p.gives.map((a) => a.kind === "PLAYER" ? teams.find((x) => x.id === p.teamId)?.players.find((pl) => pl.id === a.id)?.name : teams.find((x) => x.id === p.teamId)?.picks.find((pk) => pk.id === a.id)?.year + " 年签").filter(Boolean);
      return `${t.abbr} 送出 ${names.join("、") || "无"}`;
    })
    .join("；");
  logEvent(saveId, "TRADE", `交易完成：${summary}${opts.note ? `（${opts.note}）` : ""}`, { parties, validation, aiFeedback }, { godMode: opts.godMode });
  return { executed: true as const, validation, aiFeedback };
}

// ---------------------------------------------------------------------------
// Chemistry
// ---------------------------------------------------------------------------

export function getChemistry(saveId: string, teamId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${teamId}`))).all();
  const chemPlayers = roster.filter((p) => p.status === "ACTIVE" || p.status === "INJURED").map((p) => ({
    id: p.id,
    position: p.position as never,
    ratings: p.ratings,
    role: p.role as never,
    age: p.age,
    tenure: p.tenure,
    satisfaction: p.satisfaction,
    contractEnd: p.contract.years.length ? p.contract.years[p.contract.years.length - 1].season : save.season,
  }));
  const team = db.select().from(teamsT).where(eq(teamsT.id, `${saveId}:${teamId}`)).get();
  return computeChemistry(chemPlayers, { season: save.season, gamesPlayed: (team?.wins ?? 0) + (team?.losses ?? 0), lastSeasonWins: null });
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export function getDraftBoard(saveId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  // Self-heal saves that entered the draft before classes were generated
  // (e.g. the 5-year playthrough save): materialize the class lazily.
  if (save.phase === "DRAFT") ensureDraftClass(saveId, save.seed, save.season);
  const prospects = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.status, "PROSPECT"), eq(playersT.draftYear, save.season))).all();
  return prospects.map((p) => ({
    id: p.id.split(":").slice(1).join(":"),
    name: p.name,
    position: p.position,
    age: p.age,
    heightCm: p.heightCm,
    weightKg: p.weightKg,
    ratings: p.ratings,
    scouting: generateScoutingReport(p.id, save.seed),
    source: p.source,
  }));
}

export function getDraftOrder(saveId: string) {
  const ps = getPhaseState(saveId);
  const draft = ps.draft as { order?: { pickNumber: number; round: number; holderTeamId: string }[]; lottery?: string[]; worst14?: string[] } | undefined;
  return draft?.order ?? [];
}

/** One draft pick: user team chooses a prospect; AI teams auto-pick when simulated. */
export function makeDraftPick(saveId: string, opts: { prospectId?: string; simulateAll?: boolean; godMode?: boolean }) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase !== "DRAFT") throw new EngineError("WRONG_PHASE", "当前不在选秀阶段");
  ensureDraftClass(saveId, save.seed, save.season);
  const order = getDraftOrder(saveId);
  const donePicks = db.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.year, save.season), eq(picksT.status, "EXERCISED"))).all();
  const doneCount = donePicks.length;
  const nextSlot = order[doneCount];
  if (!nextSlot) throw new EngineError("DRAFT_DONE", "本届选秀已完成");

  const picked: { pickNumber: number; round: number; teamId: string; prospect: string | null }[] = [];

  const performPick = (slot: { pickNumber: number; round: number; holderTeamId: string }, prospectId: string | null) => {
    const teamId = slot.holderTeamId;
    const prospects = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.status, "PROSPECT"), eq(playersT.draftYear, save.season))).all();
    let chosen = prospectId ? prospects.find((p) => p.id === `${saveId}:${prospectId}`) : null;
    if (!chosen) {
      const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${teamId}`))).all();
      const avail = prospects.map((p) => ({
        id: p.id.split(":").slice(1).join(":"),
        name: p.name,
        position: p.position,
        age: p.age,
        heightCm: p.heightCm,
        weightKg: p.weightKg,
        ratings: p.ratings,
        scouting: generateScoutingReport(p.id, save.seed),
        draftYear: p.draftYear ?? save.season,
      })) as DraftProspect[];
      for (const a of avail) registerProspectRatings(`${saveId}:${a.id}`, a.ratings as never);
      const best = aiDraftPick(avail, roster.map((r) => r.position), save.seed, `aidraft:${save.season}:${slot.pickNumber}`);
      chosen = prospects.find((p) => p.id === `${saveId}:${best?.id}`);
    }
    if (!chosen) {
      // No prospect available (real-data saves ship without a scout-rated
      // draft class): record the pick as skipped so the draft still completes
      // and the offseason can advance — never fabricate a player.
      db.transaction((tx) => {
        const pickRow = tx.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.year, save.season), eq(picksT.round, slot.round), eq(picksT.holderTeamId, `${saveId}:${teamId}`), eq(picksT.status, "OWNED"))).all();
        const target = pickRow[0];
        if (target) tx.update(picksT).set({ status: "EXERCISED", resolved: `${slot.pickNumber}` }).where(eq(picksT.id, target.id)).run();
      });
      picked.push({ pickNumber: slot.pickNumber, round: slot.round, teamId, prospect: null });
      return;
    }
    const contract = prospectRookieContract(slot.pickNumber, slot.round, save.season);
    db.transaction((tx) => {
      tx.update(playersT)
        .set({
          teamId: `${saveId}:${teamId}`,
          status: "ACTIVE",
          role: "BENCH",
          contract: {
            type: contract.type,
            years: contract.years,
            birdRights: contract.birdRights,
            noTrade: contract.noTrade,
            option: contract.option,
            signedSeason: contract.signedSeason,
          },
          tenure: 0,
        })
        .where(eq(playersT.id, chosen!.id))
        .run();
      const pickRow = tx.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.year, save.season), eq(picksT.round, slot.round), eq(picksT.holderTeamId, `${saveId}:${teamId}`), eq(picksT.status, "OWNED"))).all();
      const target = pickRow[0];
      if (target) tx.update(picksT).set({ status: "EXERCISED", resolved: `${slot.pickNumber}` }).where(eq(picksT.id, target.id)).run();
    });
    picked.push({ pickNumber: slot.pickNumber, round: slot.round, teamId, prospect: chosen.name });
  };

  if (opts.simulateAll) {
    // If the next slot belongs to the user's team, they must pick manually
    // unless godMode. Simulate the rest of the draft.
    let idx = doneCount;
    while (idx < order.length) {
      performPick(order[idx], null);
      idx++;
    }
  } else {
    performPick(nextSlot, opts.prospectId ?? null);
  }

  logEvent(saveId, "DRAFT", `选秀：${picked.map((p) => `第 ${p.round} 轮第 ${p.pickNumber} 顺位 → ${p.prospect ?? "跳过"}`).join("；")}`, { picked }, { godMode: opts.godMode });

  // Finish draft when all exercised
  const remaining = db.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.year, save.season), eq(picksT.status, "OWNED"))).all();
  if (remaining.length === 0) {
    startFreeAgency(saveId);
  }
  return picked;
}

/** Move from DRAFT to FREE_AGENCY: undrafted prospects hit the market. */
export function startFreeAgency(saveId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  db.transaction((tx) => {
    const undrafted = tx.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.status, "PROSPECT"))).all();
    for (const p of undrafted) {
      if ((p.draftYear ?? 0) <= save.season) {
        tx.update(playersT).set({ status: "FREE_AGENT", teamId: null }).where(eq(playersT.id, p.id)).run();
      }
    }
    // Teams below the league minimum roster size get filler-tier signings only
    // (low-overall players on minimum deals). Quality free agents stay in the
    // pool so the user gets a real market window; AI market-rate signings run
    // in startNewSeason once that window closes. The pool is re-queried every
    // iteration (a stale in-memory array would loop forever on one player).
    const FILLER_MAX_OVERALL = 72;
    const teams = tx.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
    for (const t of teams) {
      for (;;) {
        const roster = tx.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, t.id))).all();
        if (roster.length >= 13) break;
        const pool = tx
          .select()
          .from(playersT)
          .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
          .all()
          .filter((p) => p.teamId === null && p.ratings.overall < FILLER_MAX_OVERALL);
        if (!pool.length) break;
        const pick = pool.sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
        tx.update(playersT)
          .set({
            teamId: t.id,
            lastTeamId: t.id,
            status: "ACTIVE",
            role: "BENCH",
            contract: {
              type: "MINIMUM",
              years: [
                { season: save.season, salary: CBA.minimumSalary },
                { season: save.season + 1, salary: CBA.minimumSalary },
              ],
              birdRights: false,
              noTrade: false,
              option: null,
              signedSeason: save.season,
            },
          })
          .where(eq(playersT.id, pick.id))
          .run();
      }
    }
  });
  db.update(saves).set({ phase: "FREE_AGENCY", currentDate: `${save.season - 1}-07-01`, updatedAt: now() }).where(eq(saves.id, saveId)).run();
  logEvent(saveId, "FA", "自由市场开启：未签约球员进入市场，各队开始补强", {});
}

/**
 * Re-derive every team's competitive phase from last season's standings +
 * roster profile. Without this a team that tanked for three years still
 * carried its year-zero CONTENDER tag and evaluated trades accordingly.
 */
function updateAiPhases(saveId: string) {
  const db = getDb();
  const save = getSave(saveId)!;
  const season = save.season;
  for (const t of db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all()) {
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, t.id)))
      .all()
      .filter((p) => p.status === "ACTIVE" || p.status === "INJURED");
    const picksOwned = db
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, saveId), eq(picksT.holderTeamId, t.id)))
      .all()
      .filter((p) => p.status === "OWNED" && p.year > season && p.round === 1).length;
    const avgOverall = roster.reduce((a, p) => a + p.ratings.overall, 0) / Math.max(1, roster.length);
    const avgAge = roster.reduce((a, p) => a + p.age, 0) / Math.max(1, roster.length);
    const profile = classifyTeamPhase(avgOverall, avgAge, t.wins, t.wins + t.losses, picksOwned);
    db.update(teamsT).set({ aiPhase: profile.phase, aiRisk: profile.risk }).where(eq(teamsT.id, t.id)).run();
  }
}

/**
 * Offseason AI↔AI trade market: rebuilders shop veterans to contenders for
 * youth and picks. Every deal must pass the full rule validator and satisfy
 * BOTH teams' GM verdicts — same bar a user trade faces. Deterministic for a
 * given save seed + season; each team deals at most once per offseason.
 */
export function runAiTradeMarket(saveId: string, diag?: Record<string, number>, opts?: { deadline?: boolean }) {
  const bump = (k: string) => { if (diag) diag[k] = (diag[k] ?? 0) + 1; };
  const deadline = opts?.deadline === true;
  const db = getDb();
  const save = getSave(saveId)!;
  const season = save.season;
  const ps = getPhaseState(saveId);
  const userFullId = (ps.userTeamId as string | undefined) ?? null;
  const shortOf = (full: string) => full.split(":").slice(1).join(":");

  const teamRows = db
    .select()
    .from(teamsT)
    .where(eq(teamsT.saveId, saveId))
    .all()
    .filter((t) => t.id !== userFullId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const winPct = (t: { wins: number; losses: number }) => (t.wins + t.losses > 0 ? t.wins / (t.wins + t.losses) : 0.5);
  // Deadline mode classifies by live standings — aiPhase is only refreshed
  // at season rollover, so mid-season we read the table directly.
  const sellers = deadline
    ? teamRows.filter((t) => winPct(t) < 0.4).sort((a, b) => winPct(a) - winPct(b))
    : teamRows.filter((t) => t.aiPhase === "REBUILD").sort((a, b) => winPct(a) - winPct(b));
  const buyers = deadline
    ? teamRows.filter((t) => winPct(t) >= 0.55).sort((a, b) => winPct(b) - winPct(a))
    : teamRows.filter((t) => t.aiPhase === "CONTENDER" || t.aiPhase === "PLAYOFF").sort((a, b) => winPct(b) - winPct(a));
  if (!sellers.length || !buyers.length) return 0;
  const tradeCap = deadline ? 4 : 6;

  const used = new Set<string>();
  let trades = 0;

  for (const sRow of sellers) {
    if (trades >= tradeCap) break;
    if (used.has(sRow.id)) continue;
    const seller = toTradeTeam(saveId, shortOf(sRow.id));
    const vets = seller.players
      .filter((p) => p.age >= 26 && p.ratings.overall >= 72 && !p.contract.noTrade && contractEndSeason(p.contract) >= season)
      .sort((a, b) => playerValue(b, season).value - playerValue(a, season).value)
      .slice(0, 3);
    if (!vets.length) { bump("no_vets"); continue; }

    vetLoop:
    for (const vet of vets) {
    for (const bRow of buyers) {
      if (used.has(bRow.id) || bRow.id === sRow.id) continue;
      const buyer = toTradeTeam(saveId, shortOf(bRow.id));
      // Contenders don't buy what they don't need — require the vet to
      // actually improve their lineup at his position.
      if (needPremium(buyer, vet) <= 0) { bump("no_need"); continue; }

      const movable = buyer.players
        .filter((p) => !p.contract.noTrade)
        .sort((a, b) => playerValue(a, season).value - playerValue(b, season).value);
      const firsts = buyer.picks
        .filter((pk) => pk.status === "OWNED" && pk.round === 1 && pk.originalTeamId === buyer.id && pk.year > season && pk.year <= season + CBA.pickTradeYears && (!pk.protection || pk.protection.type === "NONE"))
        .sort((a, b) => a.year - b.year);
      if (!movable.length) continue;

      // Salary matching is what kills most AI deals in the real league too:
      // the buyer must send out roughly vet_salary/1.25+ before it can take
      // the vet back. Build cheapest-value combos that clear each plausible
      // floor and let validateTrade be the authority.
      const vetSalary = salaryForSeason(vet.contract, 0);
      const packages: { players: TradePlayer[]; picks: TradePick[] }[] = [];
      const seen = new Set<string>();
      const pushCombo = (combo: TradePlayer[]) => {
        if (!combo.length) return;
        const key = combo.map((p) => p.id).sort().join(",");
        if (seen.has(key)) return;
        seen.add(key);
        // A rebuilding team doesn't give away a genuine superstar (86+)
        // without at least one first-round pick coming back.
        const starTax = vet.ratings.overall >= 86;
        if (!starTax) packages.push({ players: combo, picks: [] });
        if (firsts[0]) packages.push({ players: combo, picks: [firsts[0]] });
      };
      const sellerSlack = Math.min(5, Math.max(0, CBA.maxRosterSize - seller.players.length + 1));
      // N-for-1 also drains the BUYER below the minimum — cap package size.
      const buyerSlack = Math.max(0, buyer.players.length - CBA.minRosterSize + 1);
      const maxPkg = Math.min(sellerSlack, buyerSlack);
      if (maxPkg <= 0) { bump("no_package"); continue; }
      // Salary matching needs actual salary — cheapest-value pieces are
      // usually $0 filler contracts. Anchor on the buyer's mid-salary movable
      // pieces first, then pad with cheap youngs.
      const movableBySalary = [...movable].sort((a, b) => salaryForSeason(b.contract, 0) - salaryForSeason(a.contract, 0));
      for (const floor of [vetSalary / CBA.tradeBand2 - 0.2, vetSalary / CBA.tradeBand1 - 0.2]) {
        // Strategy A: salary anchor + cheap value pieces.
        const combo: TradePlayer[] = [];
        let sal = 0;
        for (const p of movableBySalary) {
          if (sal >= floor || combo.length >= maxPkg) break;
          if (p.ratings.overall >= vet.ratings.overall) continue;
          if (salaryForSeason(p.contract, 0) > vetSalary) continue;
          combo.push(p);
          sal += salaryForSeason(p.contract, 0);
        }
        if (sal >= floor - 0.3) pushCombo(combo);

        // Strategy B: anchor on one mid-salary player close to the vet's
        // number, then pad with cheap youngs — mirrors real matching deals.
        const anchor = [...movable]
          // Never anchor on someone at/above the vet's level — no contender
          // ships its own star to acquire a worse player.
          .filter((p) => p.ratings.overall < vet.ratings.overall && salaryForSeason(p.contract, 0) <= vetSalary)
          .sort((a, b) => Math.abs(vetSalary * 0.85 - salaryForSeason(a.contract, 0)) - Math.abs(vetSalary * 0.85 - salaryForSeason(b.contract, 0)))[0];
        if (anchor) {
          const comboB: TradePlayer[] = [anchor];
          let salB = salaryForSeason(anchor.contract, 0);
          for (const p of movable) {
            if (salB >= floor || comboB.length >= maxPkg) break;
            if (p.id === anchor.id) continue;
            if (p.ratings.overall >= vet.ratings.overall) continue;
            comboB.push(p);
            salB += salaryForSeason(p.contract, 0);
          }
          if (salB >= floor - 0.3) pushCombo(comboB);
        }
      }
      if (!packages.length) { bump("no_package"); continue; }

      let dealt = false;
      for (const pkg of packages) {
        const parties: TradeParty[] = [
          { teamId: seller.id, gives: [{ kind: "PLAYER", id: vet.id }], receives: [...pkg.players.map((p) => ({ kind: "PLAYER" as const, id: p.id })), ...pkg.picks.map((p) => ({ kind: "PICK" as const, id: p.id }))] },
          { teamId: buyer.id, gives: [...pkg.players.map((p) => ({ kind: "PLAYER" as const, id: p.id })), ...pkg.picks.map((p) => ({ kind: "PICK" as const, id: p.id }))], receives: [{ kind: "PLAYER", id: vet.id }] },
        ];
        const teams = [seller, buyer];
        const validation = validateTrade({ saveId, parties }, teams, season);
        if (!validation.legal) { bump("illegal"); continue; }
        const sellerOk = aiEvaluateTrade(parties[0], { saveId, parties }, teams, season).accept;
        const buyerOk = aiEvaluateTrade(parties[1], { saveId, parties }, teams, season).accept;
        if (!sellerOk) { bump("seller_reject"); continue; }
        if (!buyerOk) { bump("buyer_reject"); continue; }
        const exec = executeTrade(saveId, parties, { note: deadline ? "AI 交易截止日" : "AI 休赛期交易" });
        if (exec.executed) {
          used.add(sRow.id);
          used.add(bRow.id);
          trades++;
          dealt = true;
          break;
        }
      }
      if (dealt) break vetLoop;
    }
    }
  }
  if (trades > 0) {
    logEvent(saveId, "TRADE", deadline ? `交易截止日：AI 球队完成 ${trades} 笔交易` : `休赛期 AI 交易市场：${trades} 笔交易达成`, { trades });
  }

  // Inbound offer: a seller that didn't deal rings up the USER. Real GMs get
  // calls — evaluating an inbound offer is part of the job. Deterministic,
  // at most one pending offer at a time.
  if (deadline && userFullId) {
    const rng = rngFor(save.seed, `inbound:${season}`);
    if (!rng.chance(0.8)) bump("offer_no_call");
    else {
      const user = toTradeTeam(saveId, shortOf(userFullId));
      const psNow = getPhaseState(saveId);
      let offerMade = false;
      for (const sRow of sellers) {
        if (used.has(sRow.id) || offerMade) continue;
        const seller = toTradeTeam(saveId, shortOf(sRow.id));
        const sellerVets = seller.players
          .filter((p) => p.age >= 26 && p.ratings.overall >= 72 && !p.contract.noTrade && contractEndSeason(p.contract) >= season && needPremium(user, p) > 0)
          .sort((a, b) => playerValue(b, season).value - playerValue(a, season).value);
        if (!sellerVets.length) { bump("offer_no_vet"); continue; }
        // The ask: user's salary-matched pieces (+ a 1st if needed). Never ask
        // for the user's top-3 players. Try each vet — the best one may be
        // too expensive for the user's movable salary to match.
        const userByOverall = [...user.players].sort((a, b) => b.ratings.overall - a.ratings.overall);
        const untouchable = new Set(userByOverall.slice(0, 3).map((p) => p.id));
        const movable = user.players
          .filter((p) => !untouchable.has(p.id) && !p.contract.noTrade)
          // matching salary comes first — cheap-value pieces are $0 fillers
          .sort((a, b) => salaryForSeason(b.contract, 0) - salaryForSeason(a.contract, 0) || playerValue(a, season).value - playerValue(b, season).value);
        const userSnap = capSnapshot(user.players.map((p) => ({ contract: p.contract })), user.players.length, user.deadMoney ?? 0);
        const sellerSnap = capSnapshot(seller.players.map((p) => ({ contract: p.contract })), seller.players.length, seller.deadMoney ?? 0);
        const sellerSlack = Math.max(0, CBA.maxRosterSize - seller.players.length + 1);
        const userSlack = Math.max(0, user.players.length - CBA.minRosterSize + 1);
        const askCap = Math.min(4, sellerSlack, userSlack);
        // Min outgoing salary that legally matches `incoming` for the user,
        // and max incoming salary the seller can take back for `outgoing` —
        // both mirroring salaryMatching()'s bands. A deal needs
        // userFloor <= askTotal <= sellerCeiling.
        const minOutgoingFor = (incoming: number) => {
          if (userSnap.overSecondApron) return incoming - 0.1;
          const smallBand = (incoming - 0.1) / CBA.tradeBand1;
          if (smallBand <= 9.8 || !userSnap.overCap) return smallBand;
          return (incoming - 0.1) / CBA.tradeBand2;
        };
        const maxIncomingFor = (outgoing: number) => {
          if (!sellerSnap.overCap) return Infinity;
          if (sellerSnap.overSecondApron) return outgoing + 0.1;
          return outgoing <= 9.8 ? outgoing * CBA.tradeBand1 + 0.1 : outgoing * CBA.tradeBand2 + 0.1;
        };
        // The richest vet whose salary the user's movable contracts can
        // possibly match — cheaper vets get tried in descending value order.
        const movableTotal = movable.slice(0, askCap).reduce((s, p) => s + salaryForSeason(p.contract, 0), 0);
        const maxAffordable = userSnap.overSecondApron ? movableTotal + 0.1 : movableTotal <= 9.8 || !userSnap.overCap ? movableTotal * CBA.tradeBand1 + 0.1 : movableTotal * CBA.tradeBand2 + 0.1;
        const affordable = sellerVets.filter((v) => {
          const vSal = salaryForSeason(v.contract, 0);
          return vSal <= maxAffordable && minOutgoingFor(vSal) <= maxIncomingFor(vSal);
        });
        if (!affordable.length) { bump("offer_unaffordable"); continue; }
        for (const vet of affordable.slice(0, 4)) {
        const vetSalary = salaryForSeason(vet.contract, 0);
        const bandFloor = minOutgoingFor(vetSalary);
        const bandCeiling = maxIncomingFor(vetSalary);
        // Fill the package inside [floor, ceiling]: expensive pieces that would
        // overshoot the seller's ceiling get skipped for cheaper ones.
        const asks: TradePlayer[] = [];
        let sal = 0;
        for (const p of movable) {
          if (asks.length >= askCap || sal >= bandFloor) break;
          const pSal = salaryForSeason(p.contract, 0);
          if (sal + pSal > bandCeiling) continue;
          asks.push(p);
          sal += pSal;
        }
        const userFirst = user.picks
          .filter((pk) => pk.status === "OWNED" && pk.round === 1 && pk.originalTeamId === user.id && pk.year > season && pk.year <= season + CBA.pickTradeYears && (!pk.protection || pk.protection.type === "NONE"))
          .sort((a, b) => a.year - b.year)[0];
        const parties: TradeParty[] = [
          { teamId: seller.id, gives: [{ kind: "PLAYER", id: vet.id }], receives: [...asks.map((p) => ({ kind: "PLAYER" as const, id: p.id })), ...(userFirst ? [{ kind: "PICK" as const, id: userFirst.id }] : [])] },
          { teamId: user.id, gives: [...asks.map((p) => ({ kind: "PLAYER" as const, id: p.id })), ...(userFirst ? [{ kind: "PICK" as const, id: userFirst.id }] : [])], receives: [{ kind: "PLAYER", id: vet.id }] },
        ];
        if (!asks.length || sal < bandFloor) { bump(`offer_no_asks:${sal.toFixed(0)}<${bandFloor.toFixed(0)}`); continue; }
        const validation = validateTrade({ saveId, parties }, [seller, user], season);
        if (!validation.legal) {
          bump("offer_illegal");
          for (const i of validation.issues.filter((x) => x.severity === "BLOCKER")) bump(`offer_illegal:${i.code}`);
          continue;
        }
        // The seller offered it — verify they'd actually accept their own ask.
        if (!aiEvaluateTrade(parties[0], { saveId, parties }, [seller, user], season).accept) { bump("offer_seller_reject"); continue; }
        bump("offer_created");
        const offer = {
          id: uuid(),
          fromTeam: seller.abbr,
          playerId: vet.id,
          asks: [...asks.map((p) => ({ kind: "PLAYER" as const, id: p.id })), ...(userFirst ? [{ kind: "PICK" as const, id: userFirst.id }] : [])],
        };
        db.update(saves)
          .set({ phaseState: { ...psNow, inboundOffers: [offer] } as never, updatedAt: now() })
          .where(eq(saves.id, saveId))
          .run();
        logEvent(saveId, "TRADE", `交易报价：${seller.abbr} 想用 ${vet.name} 换你的 ${asks.map((p) => p.name).join("、")}${userFirst ? " + 一枚首轮签" : ""}`, { offerId: offer.id });
        offerMade = true;
        break;
        }
      }
    }
  }
  return trades;
}

interface InboundOffer {
  id: string;
  fromTeam: string;
  playerId: string;
  asks: { kind: "PLAYER" | "PICK"; id: string }[];
}

export function listInboundOffers(saveId: string): (InboundOffer & { playerName: string; askNames: string[] })[] {
  const db = getDb();
  const ps = getPhaseState(saveId);
  const offers = (ps.inboundOffers as InboundOffer[] | undefined) ?? [];
  const full = (id: string) => (id.includes(":") ? id : `${saveId}:${id}`);
  return offers.map((o) => {
    const p = db.select().from(playersT).where(eq(playersT.id, full(o.playerId))).get();
    const askNames = o.asks.map((a) => {
      if (a.kind === "PICK") {
        const pk = db.select().from(picksT).where(eq(picksT.id, full(a.id))).get();
        return pk ? `${pk.year} 年${pk.round === 1 ? "首轮" : "次轮"}签` : "选秀权";
      }
      return db.select().from(playersT).where(eq(playersT.id, full(a.id))).get()?.name ?? a.id;
    });
    return { ...o, playerName: p?.name ?? "?", askNames };
  });
}

/** The user answers an inbound AI offer. Accept → full validation + execution. */
export function respondInboundOffer(saveId: string, offerId: string, accept: boolean) {
  const db = getDb();
  const ps = getPhaseState(saveId);
  const offers = (ps.inboundOffers as InboundOffer[] | undefined) ?? [];
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) throw new EngineError("NO_OFFER", "该报价不存在或已过期");
  const userShort = String(ps.userTeamId ?? "").split(":").pop()!;
  const season = getSave(saveId)!.season;

  const clear = () =>
    db.update(saves)
      .set({ phaseState: { ...ps, inboundOffers: offers.filter((o) => o.id !== offerId) } as never, updatedAt: now() })
      .where(eq(saves.id, saveId))
      .run();

  if (!accept) {
    clear();
    logEvent(saveId, "TRADE", `拒绝了 ${offer.fromTeam} 的交易报价`, { offerId });
    return { accepted: false as const };
  }
  const seller = toTradeTeam(saveId, offer.fromTeam);
  const user = toTradeTeam(saveId, userShort);
  const parties: TradeParty[] = [
    { teamId: seller.id, gives: [{ kind: "PLAYER", id: offer.playerId }], receives: offer.asks },
    { teamId: user.id, gives: offer.asks, receives: [{ kind: "PLAYER", id: offer.playerId }] },
  ];
  const saveNow = getSave(saveId)!;
  // The offer was struck at the deadline — validate it as-of that date so the
  // WINDOW rule doesn't retroactively kill a live offer the GM is answering.
  const validation = validateTrade({ saveId, parties }, [seller, user], season, { phase: saveNow.phase, date: `${season}-02-06` });
  if (!validation.legal) {
    clear();
    const msg = validation.issues.find((i) => i.severity === "BLOCKER")?.message ?? "交易不再合法";
    logEvent(saveId, "TRADE", `接受报价失败：${msg}`, { offerId });
    return { accepted: false as const, reason: msg };
  }
  // The offer was legal when made at the deadline; the GM answers the call
  // after the sim has rolled past Feb 6, so the window check is bypassed —
  // rule validation above still gates the actual exchange.
  const exec = executeTrade(saveId, parties, { note: "接受 AI 报价", allowPostDeadline: true });
  clear();
  if (exec.executed) {
    return { accepted: true as const };
  }
  return { accepted: false as const, reason: "执行失败" };
}

/** Start the next regular season. */
export function startNewSeason(saveId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase !== "FREE_AGENCY") throw new EngineError("WRONG_PHASE", "自由市场尚未结束");

  const ps = getPhaseState(saveId);
  const userTeamFullId = (ps.userTeamId as string | undefined) ?? null;

  // Cut-down day: the offseason allows 20, but opening night requires the
  // regulation 18. An over-limit roster is the GM's problem — refuse to start.
  if (userTeamFullId) {
    const userCount = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, userTeamFullId)))
      .all()
      .filter((p) => p.status === "ACTIVE" || p.status === "INJURED").length;
    if (userCount > CBA.maxRosterSize) {
      throw new EngineError("ROSTER_MAX", `常规赛名单最多 ${CBA.maxRosterSize} 人（当前 ${userCount} 人）——先裁掉 ${userCount - CBA.maxRosterSize} 名球员`);
    }
  }

  // AI teams' competitive phase is re-evaluated from last season's standings
  // every year — a tanking team stops behaving like a contender. Must run
  // before the transaction resets wins/losses.
  updateAiPhases(saveId);
  // Offseason trade market between AI teams: rebuilders shop veterans to
  // contenders for youth + picks. Keeps the league dynamic between seasons.
  runAiTradeMarket(saveId);

  db.transaction((tx) => {
    // archive career stats
    const players = tx.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
    for (const p of players) {
      const seasonStat = p.seasonStats.find((s) => s.season === save.season);
      const career = [...p.careerStats];
      if (seasonStat && seasonStat.g > 0) {
        const idx = career.findIndex((c) => c.season === save.season);
        if (idx >= 0) career[idx] = seasonStat;
        else career.push(seasonStat);
      }
      tx.update(playersT).set({ careerStats: career.slice(-10) }).where(eq(playersT.id, p.id)).run();
    }

    // reset team records
    tx.update(teamsT).set({ wins: 0, losses: 0 }).where(eq(teamsT.saveId, saveId)).run();

    // Under-manned user roster gets league-minimum bodies so the season can
    // start — the GM pays for neglect in quality, not in a deadlock.
    if (userTeamFullId) {
      for (;;) {
        const roster = tx.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, userTeamFullId))).all()
          .filter((p) => p.status === "ACTIVE" || p.status === "INJURED");
        if (roster.length >= CBA.minRosterSize) break;
        const pool = tx
          .select()
          .from(playersT)
          .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
          .all()
          .filter((p) => p.teamId === null)
          .sort((a, b) => a.ratings.overall - b.ratings.overall); // cheapest bodies first
        if (!pool.length) break;
        const pick = pool[0];
        tx.update(playersT)
          .set({
            teamId: userTeamFullId,
            lastTeamId: userTeamFullId,
            status: "ACTIVE",
            role: "BENCH",
            contract: {
              type: "MINIMUM",
              years: [{ season: save.season, salary: CBA.minimumSalary }],
              birdRights: false,
              noTrade: false,
              option: null,
              signedSeason: save.season,
            },
          })
          .where(eq(playersT.id, pick.id))
          .run();
        logEvent(saveId, "FA", `阵容不足 ${CBA.minRosterSize} 人，自动底薪签下 ${pick.name}`, { playerId: pick.id });
      }
    }

    // AI roster completion: once the user's free-agency window closes, AI
    // teams fill up to the target roster size at honest market value — cap
    // space first, then the mid-level, and only low-tier players take the
    // minimum. Stars that nobody can afford stay unsigned instead of being
    // sniped for 1.2M. 15-man rosters also keep the trade market fluid.
    const AI_ROSTER_TARGET = 15;
    const MLE = 12.8;
    const APRON_FILLER_MAX = 74; // above the second apron only low-tier players take the minimum
    const aiTeams = tx.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all().filter((t) => t.id !== userTeamFullId);
    let aiSigned = 0;
    for (const t of aiTeams) {
      // One mid-level exception per offseason — over-cap teams can't spam
      // MLE-sized deals (real rule: the MLE is a single annual exception).
      let mleUsed = false;
      for (;;) {
        const roster = tx.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, t.id))).all();
        if (roster.length >= AI_ROSTER_TARGET) break;
        const pool = tx
          .select()
          .from(playersT)
          .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
          .all()
          .filter((p) => p.teamId === null)
          .sort((a, b) => b.ratings.overall - a.ratings.overall);
        if (!pool.length) break;
        const snap = capSnapshot(roster, roster.length);
        let signed = false;
        for (const c of pool) {
          const asking = askingSalaryFor(c.contract, c.yearsPro, c.ratings.overall, c.age);
          const offer = suggestedContract(
            {
              id: c.id,
              name: c.name,
              position: c.position,
              age: c.age,
              ratings: { overall: c.ratings.overall, potential: c.ratings.potential },
              status: "FREE_AGENT",
              askingSalary: asking,
              askingYears: Math.max(1, Math.min(4, c.age >= 32 ? 2 : 4)),
              contract: c.contract,
            },
            save.season,
          );
          let salary: number | null = null;
          if (!snap.overCap) salary = Math.min(offer.avgSalary, snap.capSpace);
          else if (!snap.overSecondApron && !mleUsed) salary = Math.min(offer.avgSalary, MLE);
          else if (c.ratings.overall < APRON_FILLER_MAX) salary = CBA.minimumSalary;
          if (salary == null || salary < CBA.minimumSalary) continue;
          const years = Math.max(1, Math.min(CBA.maxContractYears, c.age >= 32 ? 2 : 3));
          tx.update(playersT)
            .set({
              teamId: t.id,
              lastTeamId: t.id,
              status: "ACTIVE",
              role: "BENCH",
              contract: {
                type: salary >= 30 ? "MAX" : salary <= CBA.minimumSalary + 0.01 ? "MINIMUM" : "VETERAN",
                years: Array.from({ length: years }, (_, i) => ({ season: save.season + i, salary: round2(salary) })),
                birdRights: false,
                noTrade: false,
                option: null,
                signedSeason: save.season,
              },
            })
            .where(eq(playersT.id, c.id))
            .run();
          if (snap.overCap && salary > CBA.minimumSalary + 0.01) mleUsed = true;
          signed = true;
          aiSigned++;
          break;
        }
        if (!signed) break;
      }
    }
    if (aiSigned > 0) {
      logEvent(saveId, "FA", `自由市场收官：AI 球队按市场价补强 ${aiSigned} 人次`, { signings: aiSigned });
    }

    // update AI phases from last season records
    // (records already reset — compute from standings before reset is skipped for simplicity)

    // generate schedule for the new season（prepareDraft 已滚动 label：此处不再 +1）
    const state = loadLeagueState(saveId, { includeGames: false });
    state.season = save.season;
    const schedule = createSchedule(state);
    for (const g of schedule) {
      tx.insert(gamesT)
        .values({
          id: `${saveId}:${g.id}`,
          saveId,
          date: g.date,
          season: g.season,
          type: g.type,
          homeTeamId: `${saveId}:${g.homeTeamId}`,
          awayTeamId: `${saveId}:${g.awayTeamId}`,
          homeScore: null,
          awayScore: null,
          status: "SCHEDULED",
          box: null,
        })
        .run();
    }

    // clear FA offers
    tx.delete(faOffersT).where(eq(faOffersT.saveId, saveId)).run();

    // phaseState 里存着 userTeamId/rotation 等用户配置，不能整体清空——
    // 只丢弃与旧赛季推进相关的瞬时状态（playoffs/draft 等）。
    const prevPs = (save.phaseState as Record<string, unknown> | null) ?? {};
    const carried: Record<string, unknown> = {};
    if (prevPs.userTeamId) carried.userTeamId = prevPs.userTeamId;
    // Dead money survives the season rollover — prune only fully-expired
    // entries (those below the new season), keep the rest on the books.
    if (prevPs.deadCap) {
      const live: Record<string, { season: number; salary: number }[]> = {};
      for (const [tid, entries] of Object.entries(prevPs.deadCap as Record<string, { season: number; salary: number }[]>)) {
        const kept = (entries ?? []).filter((e) => e.season >= save.season);
        if (kept.length) live[tid] = kept;
      }
      if (Object.keys(live).length) carried.deadCap = live;
    }

    tx.update(saves)
      .set({ season: save.season, phase: "REGULAR_SEASON", currentDate: `${save.season - 1}-10-21`, phaseState: carried as never, updatedAt: now() })
      .where(eq(saves.id, saveId))
      .run();
  });
  logEvent(saveId, "SYSTEM", `新赛季 ${save.season - 1}-${String(save.season).slice(2)} 开始`, {});
}

// ---------------------------------------------------------------------------
// Free agency offers
// ---------------------------------------------------------------------------

export function submitFaOffer(saveId: string, playerId: string, years: number, avgSalary: number) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase !== "FREE_AGENCY") throw new EngineError("WRONG_PHASE", "当前不在自由市场阶段");
  const player = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
  if (!player || player.status !== "FREE_AGENT") throw new EngineError("NOT_FA", "该球员不是自由球员");

  // Determine user's team (single-GM game: the save's chosen team = first team? Store in phaseState.userTeamId)
  const ps = getPhaseState(saveId);
  const userTeamId = (ps.userTeamId as string) ?? null;
  if (!userTeamId) throw new EngineError("NO_USER_TEAM", "存档未选择球队");
  const userShort = userTeamId.includes(":") ? userTeamId.split(":").pop()! : userTeamId;

  const team = toTradeTeam(saveId, userShort);
  const rosterAfter = team.players.length + 1;
  // Bird rights: re-signing a player who finished his contract with us is
  // allowed over the cap (and aprons), up to his max-contract tier. Roster
  // size limits still apply.
  const isBird = player.lastTeamId === `${saveId}:${userShort}`;
  const mleKey = `mleUsed:${save.season}`;
  const mleUsed = !!ps[mleKey];
  const afford = isBird
    ? rosterAfter > CBA.offseasonRosterMax
      ? { ok: false, reason: `签约后人数超过休赛期上限 ${CBA.offseasonRosterMax}` }
      : avgSalary <= maxContractValue(player.yearsPro, 1).firstYear
        ? { ok: true, reason: "使用鸟权续约（超帽签下自家自由球员）" }
        : { ok: false, reason: `鸟权续约上限为顶薪 ${maxContractValue(player.yearsPro, 1).firstYear.toFixed(1)}M/年` }
    : canAfford(team, avgSalary, rosterAfter, team.deadMoney ?? 0, mleUsed);

  // AI competition
  const faPlayer = {
    id: player.id,
    name: player.name,
    position: player.position,
    age: player.age,
    ratings: { overall: player.ratings.overall, potential: player.ratings.potential },
    status: "FREE_AGENT" as const,
    askingSalary: askingSalaryFor(player.contract, player.yearsPro, player.ratings.overall, player.age),
    askingYears: Math.max(1, Math.min(4, player.age >= 32 ? 2 : 4)),
    contract: player.contract,
  };
  const competition = aiCompetitionLevel(faPlayer, save.seed, save.season);
  // 盐值不含时间：同一存档+种子+同一报价必须得到同一结果（回放确定性）
  const evalResult = evaluateOffer(faPlayer, { years, avgSalary }, team, save.seed, `fa:${save.season}:${playerId}`, competition);

  const recordOffer = (status: "ACCEPTED" | "REJECTED", note?: string) =>
    db
      .insert(faOffersT)
      .values({ id: uuid(), saveId, playerId: `${saveId}:${playerId}`, teamId: `${saveId}:${userShort}`, years, avgSalary, status, createdAt: now(), note: note ?? null })
      .run();

  if (!afford.ok) {
    recordOffer("REJECTED", afford.reason);
    return { accepted: false as const, reason: afford.reason, interest: evalResult.interest };
  }
  if (!evalResult.accept) {
    recordOffer("REJECTED", evalResult.reasons.join("；").slice(0, 200));
    logEvent(saveId, "FA", `报价被拒：${player.name}（${avgSalary.toFixed(1)}M × ${years} 年，兴趣度 ${evalResult.interest}/100）`, { playerId, years, avgSalary, reasons: evalResult.reasons });
    return { accepted: false as const, reason: evalResult.reasons.join("；"), interest: evalResult.interest };
  }

  db.transaction((tx) => {
    recordOffer("ACCEPTED");
    tx.update(playersT)
      .set({
        teamId: `${saveId}:${userShort}`,
        lastTeamId: `${saveId}:${userShort}`,
        status: "ACTIVE",
        role: "BENCH",
        contract: {
          type: avgSalary >= 30 ? "MAX" : "VETERAN",
          years: Array.from({ length: years }, (_, i) => ({ season: save.season + i, salary: Math.round(avgSalary * 100) / 100 })),
          birdRights: false,
          noTrade: false,
          option: null,
          signedSeason: save.season,
        },
      })
      .where(eq(playersT.id, `${saveId}:${playerId}`))
      .run();
  });
  // Consume the team's one mid-level exception when this signing used it:
  // over-cap, above minimum, not Bird. Minimum/cap-space/Bird signings don't.
  if (!isBird && afford.reason === "使用中产特例（上限 12.80M）") {
    db.update(saves)
      .set({ phaseState: { ...getPhaseState(saveId), [mleKey]: true } as never, updatedAt: now() })
      .where(eq(saves.id, saveId))
      .run();
  }
  logEvent(saveId, "FA", `签约成功：${player.name} ${avgSalary.toFixed(1)}M × ${years} 年`, { playerId, years, avgSalary, reasons: evalResult.reasons });
  return { accepted: true as const, interest: evalResult.interest, reasons: evalResult.reasons };
}

// ---------------------------------------------------------------------------
// Waivers & dead money
// ---------------------------------------------------------------------------

type DeadCapEntry = { season: number; salary: number };

function deadCapTable(saveId: string): Record<string, DeadCapEntry[]> {
  const ps = getPhaseState(saveId);
  return ((ps.deadCap as Record<string, DeadCapEntry[]>) ?? {}) as Record<string, DeadCapEntry[]>;
}

/** Dead-money cap hit for a team in the save's current season (short team id). */
export function deadCapHit(saveId: string, teamShortId: string): number {
  const save = getSave(saveId);
  if (!save) return 0;
  const entries = deadCapTable(saveId)[teamShortId] ?? [];
  return round2(entries.filter((e) => e.season === save.season).reduce((a, e) => a + e.salary, 0));
}

/** All remaining dead-cap obligations for a team (short team id). */
export function deadCapEntries(saveId: string, teamShortId: string): DeadCapEntry[] {
  return deadCapTable(saveId)[teamShortId] ?? [];
}

/**
 * Waive a player from the user's roster. The player becomes a free agent and
 * every remaining guaranteed year stays on the books as dead money — the cap
 * snapshot counts it via deadCapHit, so waiving a big contract frees a roster
 * spot but never frees the money.
 */
export function waivePlayer(saveId: string, playerId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const ps = getPhaseState(saveId);
  const userTeamId = (ps.userTeamId as string) ?? null;
  if (!userTeamId) throw new EngineError("NO_USER_TEAM", "存档未选择球队");
  const userShort = userTeamId.includes(":") ? userTeamId.split(":").pop()! : userTeamId;

  const player = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
  if (!player || player.teamId !== `${saveId}:${userShort}`) {
    throw new EngineError("NOT_OWNED", "该球员不在你的阵容中");
  }
  const roster = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
    .all();
  if (roster.length - 1 < CBA.minRosterSize) {
    throw new EngineError("ROSTER_MIN", `裁员后人数将低于下限 ${CBA.minRosterSize} 人`);
  }

  const deadEntries: DeadCapEntry[] = player.contract.years
    .filter((y) => y.season >= save.season)
    .map((y) => ({ season: y.season, salary: y.salary }));
  const total = round2(deadEntries.reduce((a, e) => a + e.salary, 0));

  db.transaction((tx) => {
    tx.update(playersT).set({ teamId: null, lastTeamId: null, status: "FREE_AGENT", role: "BENCH" }).where(eq(playersT.id, player.id)).run();
    const cur = deadCapTable(saveId);
    cur[userShort] = [...(cur[userShort] ?? []), ...deadEntries];
    tx.update(saves).set({ phaseState: { ...ps, deadCap: cur } as never, updatedAt: now() }).where(eq(saves.id, saveId)).run();
  });
  logEvent(saveId, "ROSTER", `裁掉 ${player.name}：剩余 ${deadEntries.length} 年合同共 ${total.toFixed(1)}M 计入死钱`, { playerId, deadEntries, total });
  return { waived: player.name, deadMoney: deadEntries, total };
}

// ---------------------------------------------------------------------------
// God Mode
// ---------------------------------------------------------------------------

export function setGodMode(saveId: string, enabled: boolean) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  db.update(saves).set({ godMode: enabled, updatedAt: now() }).where(eq(saves.id, saveId)).run();
  logEvent(saveId, "GOD", enabled ? "GOD MODE 已开启：所有上帝操作将被记录并可撤销" : "GOD MODE 已关闭", {}, { godMode: true });
  return { godMode: enabled };
}

async function snapshotForUndo(saveId: string, label: string) {
  const db = getDb();
  const state = {
    teams: db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all(),
    players: db.select().from(playersT).where(eq(playersT.saveId, saveId)).all(),
    picks: db.select().from(picksT).where(eq(picksT.saveId, saveId)).all(),
    save: getSave(saveId),
  };
  db.insert(godSnapshotsT).values({ id: uuid(), saveId, at: now(), label, snapshot: state as never }).run();
  // keep last 5
  const all = db.select().from(godSnapshotsT).where(eq(godSnapshotsT.saveId, saveId)).orderBy(desc(godSnapshotsT.at), desc(sql`rowid`)).all();
  for (const old of all.slice(5)) db.delete(godSnapshotsT).where(eq(godSnapshotsT.id, old.id)).run();
}

export function godOp(saveId: string, op: string, params: Record<string, unknown>) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (!save.godMode) throw new EngineError("GOD_OFF", "GOD MODE 未开启");

  // "undo" reads its target snapshot below; snapshotting first would make the
  // undo op see its own snapshot as the latest one.
  if (op !== "undo") snapshotForUndo(saveId, op);

  switch (op) {
    case "setRating": {
      const playerId = String(params.playerId);
      const field = String(params.field);
      const value = Number(params.value);
      const p = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
      if (!p) throw new EngineError("NO_PLAYER", "球员不存在");
      const ratings = { ...p.ratings };
      if (field === "potential") ratings.potential = value;
      else if (field in ratings) (ratings as unknown as Record<string, number>)[field] = Math.max(25, Math.min(99, value));
      db.update(playersT).set({ ratings }).where(eq(playersT.id, `${saveId}:${playerId}`)).run();
      logEvent(saveId, "GOD", `GOD MODE：修改 ${p.name} 的 ${field} → ${value}`, { playerId, field, value }, { godMode: true });
      return { ok: true };
    }
    case "setAge":
    case "setSatisfaction": {
      const playerId = String(params.playerId);
      const value = Number(params.value);
      const p = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
      if (!p) throw new EngineError("NO_PLAYER", "球员不存在");
      if (op === "setAge") db.update(playersT).set({ age: Math.max(18, Math.min(45, value)) }).where(eq(playersT.id, `${saveId}:${playerId}`)).run();
      else db.update(playersT).set({ satisfaction: Math.max(0, Math.min(100, value)) }).where(eq(playersT.id, `${saveId}:${playerId}`)).run();
      logEvent(saveId, "GOD", `GOD MODE：修改 ${p.name} 的 ${op === "setAge" ? "年龄" : "满意度"} → ${value}`, { playerId, value }, { godMode: true });
      return { ok: true };
    }
    case "setContract": {
      const playerId = String(params.playerId);
      const years = Math.max(0, Math.min(6, Number(params.years)));
      const salary = Math.max(0, Number(params.salary));
      const p = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
      if (!p) throw new EngineError("NO_PLAYER", "球员不存在");
      db.update(playersT)
        .set({
          contract: {
            type: "VETERAN",
            years: Array.from({ length: years }, (_, i) => ({ season: save.season + i, salary })),
            birdRights: false,
            noTrade: false,
            option: null,
            signedSeason: save.season,
          },
        })
        .where(eq(playersT.id, `${saveId}:${playerId}`))
        .run();
      logEvent(saveId, "GOD", `GOD MODE：修改 ${p.name} 合同 → ${salary}M × ${years} 年`, { playerId, years, salary }, { godMode: true });
      return { ok: true };
    }
    case "setInjury": {
      const playerId = String(params.playerId);
      const weeks = Math.max(0, Math.min(52, Number(params.weeks)));
      const p = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
      if (!p) throw new EngineError("NO_PLAYER", "球员不存在");
      db.update(playersT)
        .set({
          injury: weeks > 0 ? { description: String(params.description ?? "强制伤停"), weeksRemaining: weeks, severity: weeks > 6 ? "SEVERE" : weeks > 2 ? "MODERATE" : "MINOR" } : null,
          status: weeks > 0 ? "INJURED" : "ACTIVE",
        })
        .where(eq(playersT.id, `${saveId}:${playerId}`))
        .run();
      logEvent(saveId, "GOD", `GOD MODE：设置 ${p.name} 伤情 → ${weeks} 周`, { playerId, weeks }, { godMode: true });
      return { ok: true };
    }
    case "transferPlayer": {
      const playerId = String(params.playerId);
      const toTeamId = String(params.teamId);
      const p = db.select().from(playersT).where(eq(playersT.id, `${saveId}:${playerId}`)).get();
      if (!p) throw new EngineError("NO_PLAYER", "球员不存在");
      db.update(playersT).set({ teamId: `${saveId}:${toTeamId}` }).where(eq(playersT.id, `${saveId}:${playerId}`)).run();
      logEvent(saveId, "GOD", `GOD MODE：强制转移 ${p.name} → ${toTeamId}`, { playerId, toTeamId }, { godMode: true });
      return { ok: true };
    }
    case "grantPick": {
      const toTeamId = String(params.teamId);
      const year = Number(params.year);
      const round = Number(params.round) === 2 ? 2 : 1;
      db.insert(picksT)
        .values({ id: `${saveId}:pk-god-${year}-${round}-${Date.now()}`, saveId, year, round, originalTeamId: `${saveId}:${toTeamId}`, holderTeamId: `${saveId}:${toTeamId}`, status: "OWNED", protection: null, resolved: null })
        .run();
      logEvent(saveId, "GOD", `GOD MODE：授予 ${toTeamId} ${year} 年首轮签`, params, { godMode: true });
      return { ok: true };
    }
    case "skipToPhase": {
      const target = String(params.phase);
      const allowed = ["REGULAR_SEASON", "PLAYOFFS", "OFFSEASON", "DRAFT", "FREE_AGENCY"];
      if (!allowed.includes(target)) throw new EngineError("BAD_PHASE", "未知阶段");
      // Fast path: run advanceSim until the phase changes (max 400 days).
      let guard = 0;
      while (getSave(saveId)!.phase !== target && guard < 400) {
        advanceSim(saveId, "DAY");
        guard++;
        if (getSave(saveId)!.phase === "FREE_AGENCY" && target !== "FREE_AGENCY") break;
      }
      logEvent(saveId, "GOD", `GOD MODE：跳转阶段 → ${target}（推进 ${guard} 天）`, { target }, { godMode: true });
      return { ok: true, days: guard };
    }
    case "undo": {
      const latest = db.select().from(godSnapshotsT).where(eq(godSnapshotsT.saveId, saveId)).orderBy(desc(godSnapshotsT.at), desc(sql`rowid`)).get();
      if (!latest) throw new EngineError("NO_SNAPSHOT", "没有可撤销的操作");
      const snap = latest.snapshot as { teams: Record<string, unknown>[]; players: Record<string, unknown>[]; picks: Record<string, unknown>[]; save: Record<string, unknown> };
      db.transaction((tx) => {
        for (const t of snap.teams) tx.update(teamsT).set(t as never).where(eq(teamsT.id, String(t.id))).run();
        for (const p of snap.players) tx.update(playersT).set(p as never).where(eq(playersT.id, String(p.id))).run();
        for (const p of snap.picks) tx.update(picksT).set(p as never).where(eq(picksT.id, String(p.id))).run();
      });
      db.delete(godSnapshotsT).where(eq(godSnapshotsT.id, latest.id)).run();
      logEvent(saveId, "GOD", `GOD MODE：撤销操作「${latest.label}」（快照 ${latest.at}）`, { label: latest.label }, { godMode: true });
      return { ok: true };
    }
    default:
      throw new EngineError("UNKNOWN_OP", `未知的 God 操作：${op}`);
  }
}

// ---------------------------------------------------------------------------
// Assets / league views
// ---------------------------------------------------------------------------

export function getTeamAssets(saveId: string, teamId: string) {
  const db = getDb();
  const roster = db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${teamId}`))).all();
  const picks = db.select().from(picksT).where(and(eq(picksT.saveId, saveId), eq(picksT.holderTeamId, `${saveId}:${teamId}`))).all();
  const snap = capSnapshot(roster, roster.length, deadCapHit(saveId, teamId));
  return {
    cap: snap,
    deadCap: deadCapEntries(saveId, teamId),
    picks: picks.map((p) => ({ id: p.id.split(":").slice(1).join(":"), year: p.year, round: p.round, status: p.status, protection: p.protection, originalTeamId: p.originalTeamId.split(":").slice(1).join(":") })),
    contracts: roster.map((p) => ({ id: p.id.split(":").slice(1).join(":"), name: p.name, contract: p.contract, overall: p.ratings.overall })),
    versions: { cba: CBA_VERSION, rating: RATING_VERSION, chemistry: CHEMISTRY_VERSION, trade: TRADE_RULES_VERSION },
  };
}

export function getLeagueOverview(saveId: string) {
  const db = getDb();
  const save = getSave(saveId)!;
  const short = (tid: string) => tid.split(":").slice(1).join(":");
  const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all().map((t) => ({ ...t, id: short(t.id) }));
  const east = teamRows.filter((t) => t.conference === "EAST").sort((a, b) => b.wins - a.wins || a.abbr.localeCompare(b.abbr));
  const west = teamRows.filter((t) => t.conference === "WEST").sort((a, b) => b.wins - a.wins || a.abbr.localeCompare(b.abbr));
  const statLeaders = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all()
    .filter((p) => (p.seasonStats.find((s) => s.season === save.season)?.g ?? 0) >= 10)
    .map((p) => {
      const s = p.seasonStats.find((x) => x.season === save.season)!;
      return { id: p.id, name: p.name, teamId: p.teamId, g: s.g, ppg: s.pts / s.g, rpg: s.reb / s.g, apg: s.ast / s.g, spg: s.stl / s.g, bpg: s.blk / s.g };
    });
  const awardRows = db.select().from(awardsT).where(eq(awardsT.saveId, saveId)).all();
  return { east, west, leaders: statLeaders.sort((a, b) => b.ppg - a.ppg).slice(0, 20), awards: awardRows };
}

export function getUpcomingGames(saveId: string, limit = 20) {
  const db = getDb();
  return db.select().from(gamesT).where(and(eq(gamesT.saveId, saveId), eq(gamesT.status, "SCHEDULED"))).orderBy(gamesT.date).limit(limit).all();
}

export function getRecentGames(saveId: string, limit = 20) {
  const db = getDb();
  return db.select().from(gamesT).where(and(eq(gamesT.saveId, saveId), eq(gamesT.status, "FINAL"))).orderBy(desc(gamesT.date)).limit(limit).all();
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
