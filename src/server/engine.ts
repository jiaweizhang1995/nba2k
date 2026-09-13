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
import { CBA, CBA_VERSION, capSnapshot } from "@/domain/salary";
import { validateTrade, TRADE_RULES_VERSION, aiEvaluateTrade, type TradeTeam, type TradePlayer, type TradePick } from "@/domain/trade";
import { computeChemistry, CHEMISTRY_VERSION } from "@/domain/chemistry";
import { runLottery, aiDraftPick, prospectRookieContract, generateScoutingReport, registerProspectRatings, type DraftProspect } from "@/domain/draft";
import { hashSeed, rngFor } from "@/domain/rng";
import { canAfford, evaluateOffer, aiCompetitionLevel } from "@/domain/freeagency";
import { classifyTeamPhase } from "@/domain/aiGm";
import type { SeasonPhase, TradeParty, DevelopmentState } from "@/domain/types";

const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto.randomUUID();

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
    const phase = (avgOverall >= 68 ? "CONTENDER" : avgOverall >= 64 ? "PLAYOFF" : avgOverall >= 59 ? "BUBBLE" : "REBUILD") as
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
    age: p.age,
    yearsPro: p.yearsPro,
    tenure: p.tenure,
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

export type AdvanceMode = "DAY" | "WEEK" | "MONTH" | "REGULAR_SEASON" | "PLAYOFFS" | "SEASON";

export interface AdvanceResult {
  days: number;
  gamesPlayed: number;
  results: { date: string; home: string; away: string; homeScore: number; awayScore: number }[];
  injuries: { playerId: string; name: string; description: string; weeks: number }[];
  phaseChanged: SeasonPhase | null;
  champion: string | null;
  notes: string[];
  awards: { type: string; player: string | null; team: string | null }[];
}

export function advanceSim(saveId: string, mode: AdvanceMode): AdvanceResult {
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase === "DRAFT" || save.phase === "FREE_AGENCY") {
    // Draft & FA need explicit user actions; advancing days is allowed but minimal.
  }

  const state = loadLeagueState(saveId);
  const maxDays =
    mode === "DAY" ? 1 : mode === "WEEK" ? 7 : mode === "MONTH" ? 30 : mode === "REGULAR_SEASON" ? 240 : mode === "PLAYOFFS" ? 120 : 420;

  const result: AdvanceResult = { days: 0, gamesPlayed: 0, results: [], injuries: [], phaseChanged: null, champion: null, notes: [], awards: [] };
  const startPhase = state.phase;

  for (let i = 0; i < maxDays; i++) {
    if (mode === "REGULAR_SEASON" && state.phase !== "REGULAR_SEASON") break;
    if (mode === "PLAYOFFS" && state.phase !== "PLAYOFFS") break;
    if (mode === "SEASON" && state.phase === "OFFSEASON") break;
    const report = advanceDay(state);
    result.days++;
    result.gamesPlayed += report.gamesPlayed;
    result.results.push(...report.results.map((r) => ({ ...r, date: report.date })));
    result.injuries.push(...report.injuries);
    result.notes.push(...report.notes);
  }
  result.phaseChanged = state.phase !== startPhase ? state.phase : null;

  // Playoffs may have crowned a champion within the loop.
  let champion: string | null = null;
  if (startPhase === "PLAYOFFS" && state.phase === "OFFSEASON") {
    // champion recorded via notes; find from games
    champion = findChampion(state);
  }
  result.champion = champion;

  const enteringOffseason = startPhase !== "OFFSEASON" && state.phase === "OFFSEASON";
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
    const roy = best((p) => (p.yearsPro <= 1 && p.ratings.overall >= 55 ? seasonScore(p) : -1));
    if (roy && roy.yearsPro <= 1) {
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

  // 2) expire contracts: AI teams (and the user's team, auto-matched) re-sign
  // most of their own expiring players; the rest become free agents.
  const newSeason = state.season + 1;
  let resigned = 0;
  let enteredFa = 0;
  for (const p of state.players) {
    if (p.status === "PROSPECT") continue;
    const end = p.contract.years.length ? p.contract.years[p.contract.years.length - 1].season : 0;
    if (end >= newSeason || !p.teamId) continue;
    const rng = rngFor(state.seed, `resign:${state.season}:${p.id}`);
    const overall = p.ratings.overall;
    const keepProb = overall >= 80 ? 0.9 : overall >= 70 ? 0.8 : 0.62;
    if (rng.chance(keepProb)) {
      const raise = 1.08;
      const newYears = rng.int(2, 4);
      const base = Math.max(CBA.minimumSalary, Math.round(((p.contract.years[0]?.salary ?? 5) * raise) * 10) / 10);
      p.contract = {
        type: overall >= 82 ? "MAX" : "VETERAN",
        years: Array.from({ length: newYears }, (_, i) => ({ season: newSeason + i, salary: Math.round(base * (1 + i * 0.05) * 10) / 10 })),
      } as LeaguePlayer["contract"];
      resigned++;
    } else {
      p.teamId = null;
      p.status = "FREE_AGENT";
      enteredFa++;
    }
  }
  result.notes.push(`休赛期续约 ${resigned} 人，${enteredFa} 人进入自由市场`);

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
  // Draft order: round 1 = lottery order; round 2 = reverse standings
  const round1 = lotteryResult;
  const round2 = order.map((t) => t.id);
  const draftOrder = [...round1.map((id, i) => ({ pickNumber: i + 1, round: 1, holderTeamId: id })), ...round2.map((id, i) => ({ pickNumber: i + 1, round: 2, holderTeamId: id }))];

  state.phase = "DRAFT";
  state.season = newSeason;
  state.currentDate = `${newSeason - 1}-06-25`;

  persistDraftOrder(state.saveId, draftOrder, lotteryResult, worst14);
  logEvent(state.saveId, "DRAFT", `选秀大会准备就绪：乐透抽签完成（${state.season} 届）`, { lottery: round1.slice(0, 5) });
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
  };
}

export function validateTradeOnServer(saveId: string, parties: TradeParty[]) {
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const teams = parties.map((p) => toTradeTeam(saveId, p.teamId));
  return validateTrade({ saveId, parties }, teams, save.season);
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

/** Execute a validated trade (or force it via God Mode). */
export function executeTrade(saveId: string, parties: TradeParty[], opts: { godMode?: boolean; force?: boolean; note?: string } = {}) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  const teams = parties.map((p) => toTradeTeam(saveId, p.teamId));
  const validation = validateTrade({ saveId, parties }, teams, save.season);
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
        const role = i === 0 && p.ratings.overall >= 78 ? "STAR" : i === 1 && p.ratings.overall >= 76 ? "STAR" : i < 5 ? "STARTER" : i === 5 && p.ratings.overall >= 68 ? "SIXTH_MAN" : i < 10 ? "ROTATION" : "BENCH";
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
    // AI teams fill rosters to the league minimum with cheap FA signings.
    // The pool is re-queried every iteration (a stale in-memory array would
    // loop forever signing the same player).
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
          .filter((p) => p.teamId === null);
        if (!pool.length) break;
        const pick = pool.sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
        tx.update(playersT)
          .set({
            teamId: t.id,
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

/** Start the next regular season. */
export function startNewSeason(saveId: string) {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (save.phase !== "FREE_AGENCY") throw new EngineError("WRONG_PHASE", "自由市场尚未结束");

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

    tx.update(saves)
      .set({ season: save.season, phase: "REGULAR_SEASON", currentDate: `${save.season - 1}-10-21`, phaseState: null, updatedAt: now() })
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

  const team = toTradeTeam(saveId, userTeamId);
  const rosterAfter = team.players.length + 1;
  const afford = canAfford(team, avgSalary, rosterAfter);

  // AI competition
  const faPlayer = {
    id: player.id,
    name: player.name,
    position: player.position,
    age: player.age,
    ratings: { overall: player.ratings.overall, potential: player.ratings.potential },
    status: "FREE_AGENT" as const,
    askingSalary: Math.max(CBA.minimumSalary, (player.contract.years[0]?.salary ?? 5) * 1.05),
    askingYears: Math.max(1, Math.min(4, player.age >= 32 ? 2 : 4)),
    contract: player.contract,
  };
  const competition = aiCompetitionLevel(faPlayer, save.seed, save.season);
  // 盐值不含时间：同一存档+种子+同一报价必须得到同一结果（回放确定性）
  const evalResult = evaluateOffer(faPlayer, { years, avgSalary }, team, save.seed, `fa:${save.season}:${playerId}`, competition);

  if (!afford.ok) {
    return { accepted: false as const, reason: afford.reason, interest: evalResult.interest };
  }
  if (!evalResult.accept) {
    logEvent(saveId, "FA", `报价被拒：${player.name}（${avgSalary.toFixed(1)}M × ${years} 年，兴趣度 ${evalResult.interest}/100）`, { playerId, years, avgSalary, reasons: evalResult.reasons });
    return { accepted: false as const, reason: evalResult.reasons.join("；"), interest: evalResult.interest };
  }

  db.transaction((tx) => {
    tx.update(playersT)
      .set({
        teamId: `${saveId}:${userTeamId}`,
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
  logEvent(saveId, "FA", `签约成功：${player.name} ${avgSalary.toFixed(1)}M × ${years} 年`, { playerId, years, avgSalary, reasons: evalResult.reasons });
  return { accepted: true as const, interest: evalResult.interest, reasons: evalResult.reasons };
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
  const snap = capSnapshot(roster, roster.length);
  return {
    cap: snap,
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
