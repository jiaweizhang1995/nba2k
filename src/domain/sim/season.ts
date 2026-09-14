// Season-level simulation: schedule, day/week advancement, playoffs,
// development, awards. Pure functions over a plain LeagueState — no DB here.

import { rngFor } from "../rng";
import { simulateGame, type SimPlayer, type RotationConfig } from "./game";
import { computeChemistry } from "../chemistry";
import type { SeasonPhase, GameType, Contract } from "../types";

export const SEASON_SIM_VERSION = "SEASON-SIM v2.0";

export interface LeagueTeam {
  id: string;
  abbr: string;
  city: string;
  name: string;
  conference: "EAST" | "WEST";
  division: string;
  wins: number;
  losses: number;
}

export interface LeaguePlayer {
  id: string;
  name: string;
  teamId: string | null;
  lastTeamId: string | null; // team that last held his contract — bird rights
  position: string;
  secondPosition?: string | null;
  age: number;
  yearsPro: number;
  tenure: number;
  ratings: { overall: number; threePoint: number; finishing: number; inside: number; freeThrow: number; playmaking: number; rebounding: number; perimeterD: number; interiorD: number; usageTendency: number; potential: number | null; potentialLow: number | null; potentialHigh: number | null; confidence: number };
  seasonStats: { g: number; mp: number; pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number }[];
  contract: Contract;
  status: string;
  role: string;
  satisfaction: number;
  injury: { description: string; weeksRemaining: number; severity: "MINOR" | "MODERATE" | "SEVERE" } | null;
  development: { trajectory: string; growthLeft: number; lastDelta: number };
  stamina: number;
  lastGameDate: string | null;
}

export interface LeagueGame {
  id: string;
  date: string;
  season: number;
  type: GameType;
  round?: string | null;
  seriesId?: string | null;
  gameNo?: number | null;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  status: "SCHEDULED" | "FINAL";
  box?: unknown | null;
}

export interface SeriesState {
  id: string;
  round: "R1" | "CONF_SEMI" | "CONF_FINAL" | "FINALS";
  conference?: "EAST" | "WEST" | null;
  aTeamId: string;
  bTeamId: string;
  winsA: number;
  winsB: number;
  gamesPlayed: number;
  done: boolean;
  winnerId: string | null;
  nextGameDate: string;
}

export interface PlayoffState {
  series: SeriesState[];
  championTeamId: string | null;
}

export interface LeagueState {
  saveId: string;
  seed: number;
  season: number; // label, e.g. 2027 for 2026-27
  phase: SeasonPhase;
  currentDate: string;
  teams: LeagueTeam[];
  players: LeaguePlayer[];
  games: LeagueGame[];
  playoffs: PlayoffState | null;
  /** Manager-set rotation per team id (starters + minute targets). Optional: absent = auto rotation. */
  rotation?: Record<string, RotationConfig>;
}

export const SEASON_START_MONTH_DAY = "-10-21";
export const SEASON_GAMES_PER_TEAM = 82;
/** Max games vs a single opponent in a regular season. */
export const SEASON_MAX_MEETINGS = 4;
/** Rest days required between a team's consecutive games (1 = no B2B). */
export const SEASON_MIN_REST_DAYS = 2;
/** Max consecutive home or away games before a venue flip is forced. */
export const SEASON_MAX_HOME_AWAY_STREAK = 3;

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic 82-game schedule for 30 teams.
 * Every pair meets twice (58 games); the remaining 24 per team go to 12
 * seeded same-conference rivals (→ 4 meetings), keeping ≤4 vs any opponent.
 * Games are placed greedily day-by-day with hard constraints: no back-to-backs
 * (≥1 rest day), ≤3 consecutive home/away games, one game per team per day.
 */
export function createSchedule(state: LeagueState): LeagueGame[] {
  const rng = rngFor(state.seed, `schedule:${state.season}`);
  const teamIds = state.teams.map((t) => t.id);
  if (teamIds.length % 2 !== 0) throw new Error("schedule requires even team count");

  // --- Build the pairing multiset ---
  const confOf = new Map(state.teams.map((t) => [t.id, t.conference]));
  const pairCount = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const addPair = (a: string, b: string, n: number) => pairCount.set(key(a, b), (pairCount.get(key(a, b)) ?? 0) + n);
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      addPair(teamIds[i], teamIds[j], 2); // base: everyone home & away
    }
  }
  // Extras: +2 games vs 12 of 14 same-conference rivals → 4 meetings, while a
  // seeded 2-regular ring of rivals stays at 2. Every team gets exactly 24
  // extra games (12 rivals × 2), keeping ≤4 meetings vs any opponent.
  for (const conf of ["EAST", "WEST"] as const) {
    const confTeams = rng.shuffle(teamIds.filter((t) => confOf.get(t) === conf));
    const n = confTeams.length; // 15
    for (let i = 0; i < n; i++) {
      for (let d = 2; d <= Math.floor(n / 2); d++) {
        addPair(confTeams[i], confTeams[(i + d) % n], 2);
      }
    }
  }

  // --- Greedy day-by-day placement ---
  const startDate = `${state.season - 1}${SEASON_START_MONTH_DAY}`;
  const lastGameDay = new Map<string, number>(teamIds.map((t) => [t, -99]));
  const homeCount = new Map<string, number>(teamIds.map((t) => [t, 0]));
  const venueRun = new Map<string, { dir: "H" | "A"; len: number }>(teamIds.map((t) => [t, { dir: "H", len: 0 }]));
  const out: LeagueGame[] = [];
  let gi = 0;
  let day = 0;
  let stallDays = 0;
  let gapMin = SEASON_MIN_REST_DAYS;
  let maxStreak = SEASON_MAX_HOME_AWAY_STREAK;

  const canPlay = (t: string, d: number) => lastGameDay.get(t)! <= d - gapMin;
  const venueOk = (t: string, dir: "H" | "A") => {
    const v = venueRun.get(t)!;
    return !(v.dir === dir && v.len >= maxStreak);
  };
  const applyVenue = (t: string, dir: "H" | "A") => {
    const v = venueRun.get(t)!;
    venueRun.set(t, v.dir === dir ? { dir, len: v.len + 1 } : { dir, len: 1 });
    if (dir === "H") homeCount.set(t, homeCount.get(t)! + 1);
  };

  const pairs = [...pairCount.entries()];
  void pairs;
  for (;;) {
    let remainingTotal = 0;
    for (const c of pairCount.values()) remainingTotal += c;
    if (remainingTotal === 0) break;
    // Rebuild the live list each day: decremented counts must be respected.
    const live: [string, number][] = [];
    for (const [pk, c] of pairCount) if (c > 0) live.push([pk, c]);
    const order = rng.shuffle(live);
    let played = 0;
    // Cap games per day so the league doesn't lock into a perfect
    // every-other-day bipartite rhythm (which can deadlock residue pairs).
    const dayCap = 6 + rng.int(0, 6);
    const usedToday = new Set<string>();
    for (const [pk, count] of order) {
      if (count <= 0) continue;
      if (played >= dayCap) break;
      const [a, b] = pk.split("|");
      if (usedToday.has(a) || usedToday.has(b)) continue;
      if (!canPlay(a, day) || !canPlay(b, day)) continue;
      // Direction: the team with fewer home games hosts; respect streak caps.
      let home: string;
      let away: string;
      if (homeCount.get(a)! <= homeCount.get(b)! && venueOk(a, "H") && venueOk(b, "A")) {
        home = a;
        away = b;
      } else if (venueOk(b, "H") && venueOk(a, "A")) {
        home = b;
        away = a;
      } else continue;
      out.push({
        id: `g-${state.season}-${gi++}`,
        date: isoAddDays(startDate, day),
        season: state.season,
        type: "REGULAR",
        homeTeamId: home,
        awayTeamId: away,
        homeScore: null,
        awayScore: null,
        status: "SCHEDULED",
        box: null,
        round: null,
        seriesId: null,
        gameNo: null,
      });
      pairCount.set(pk, count - 1);
      lastGameDay.set(a, day);
      lastGameDay.set(b, day);
      applyVenue(home, "H");
      applyVenue(away, "A");
      usedToday.add(a);
      usedToday.add(b);
      played++;
    }
    if (played === 0) {
      stallDays++;
      // Emergency relax (should never trigger in practice): allow B2B, then
      // loosen venue streaks, so schedule generation always terminates.
      if (stallDays % 10 === 0 && gapMin > 1) gapMin = 1;
      if (stallDays % 25 === 0) maxStreak += 1;
    } else {
      stallDays = 0;
      gapMin = SEASON_MIN_REST_DAYS;
      maxStreak = SEASON_MAX_HOME_AWAY_STREAK;
    }
    day++;
    if (day > 240) {
      // Fallback: place remaining pairs directly at the first date where both
      // teams have rested enough (venue streaks relaxed) — always terminates.
      for (const [pk, count] of [...pairCount.entries()]) {
        for (let k = 0; k < count; k++) {
          const [a, b] = pk.split("|");
          let d = Math.max(lastGameDay.get(a)! + gapMin, lastGameDay.get(b)! + gapMin, day);
          for (; d < day + 400; d++) {
            if (lastGameDay.get(a)! <= d - gapMin && lastGameDay.get(b)! <= d - gapMin) break;
          }
          const home = homeCount.get(a)! <= homeCount.get(b)! ? a : b;
          const away = home === a ? b : a;
          out.push({
            id: `g-${state.season}-${gi++}`,
            date: isoAddDays(startDate, d),
            season: state.season,
            type: "REGULAR",
            homeTeamId: home,
            awayTeamId: away,
            homeScore: null,
            awayScore: null,
            status: "SCHEDULED",
            box: null,
            round: null,
            seriesId: null,
            gameNo: null,
          });
          lastGameDay.set(a, d);
          lastGameDay.set(b, d);
          applyVenue(home, "H");
          applyVenue(away, "A");
          pairCount.set(pk, pairCount.get(pk)! - 1);
        }
      }
      break;
    }
    if (day > 400) throw new Error("schedule generation failed to converge");
  }
  return out;
}

function toSimPlayer(p: LeaguePlayer): SimPlayer {
  return {
    id: p.id,
    name: p.name,
    position: p.position as SimPlayer["position"],
    secondPosition: (p.secondPosition ?? null) as SimPlayer["secondPosition"],
    ratings: {
      overall: p.ratings.overall,
      inside: p.ratings.inside,
      finishing: p.ratings.finishing,
      threePoint: p.ratings.threePoint,
      freeThrow: p.ratings.freeThrow,
      playmaking: p.ratings.playmaking,
      rebounding: p.ratings.rebounding,
      perimeterD: p.ratings.perimeterD,
      interiorD: p.ratings.interiorD,
    },
    usageTendency: p.ratings.usageTendency,
    role: p.role,
    injury: p.injury && p.injury.weeksRemaining > 0 ? { weeksRemaining: p.injury.weeksRemaining, severity: p.injury.severity } : null,
    stamina: p.stamina,
    morale: p.satisfaction,
  };
}

export interface DayReport {
  date: string;
  gamesPlayed: number;
  results: { gameId: string; home: string; away: string; homeScore: number; awayScore: number }[];
  injuries: { playerId: string; name: string; description: string; weeks: number }[];
  notes: string[];
}

/** Advance exactly one calendar day. Returns a report of what happened. */
export function advanceDay(state: LeagueState): DayReport {
  const report: DayReport = { date: state.currentDate, gamesPlayed: 0, results: [], injuries: [], notes: [] };
  if (state.phase === "REGULAR_SEASON") {
    const todays = state.games.filter((g) => g.status === "SCHEDULED" && g.date === state.currentDate);
    for (const g of todays) {
      simAndApply(state, g, report);
    }
    tickDaily(state, report);
    state.currentDate = isoAddDays(state.currentDate, 1);
    maybeEndRegularSeason(state, report);
  } else if (state.phase === "PLAYOFFS") {
    advancePlayoffDay(state, report);
    tickDaily(state, report);
    state.currentDate = isoAddDays(state.currentDate, 1);
  } else if (state.phase === "OFFSEASON" || state.phase === "FREE_AGENCY" || state.phase === "DRAFT") {
    tickDaily(state, report);
    state.currentDate = isoAddDays(state.currentDate, 1);
  }
  return report;
}

function simAndApply(state: LeagueState, g: LeagueGame, report: DayReport) {
  const home = state.teams.find((t) => t.id === g.homeTeamId)!;
  const away = state.teams.find((t) => t.id === g.awayTeamId)!;
  const homePlayers = state.players.filter((p) => p.teamId === home.id && (p.status === "ACTIVE" || p.status === "INJURED"));
  const awayPlayers = state.players.filter((p) => p.teamId === away.id && (p.status === "ACTIVE" || p.status === "INJURED"));
  const backToBackHome = state.games.some((x) => x.status === "FINAL" && x.date === isoAddDays(state.currentDate, -1) && (x.homeTeamId === home.id || x.awayTeamId === home.id));
  const backToBackAway = state.games.some((x) => x.status === "FINAL" && x.date === isoAddDays(state.currentDate, -1) && (x.homeTeamId === away.id || x.awayTeamId === away.id));
  // Roster chemistry feeds the sim: fit/continuity/mood move team efficiency,
  // so a churned roster underperforms its ratings for a while.
  const chemCtx = { season: state.season, gamesPlayed: home.wins + home.losses, lastSeasonWins: null };
  const toChem = (p: LeaguePlayer) => ({
    id: p.id,
    position: p.position as never,
    ratings: p.ratings as never,
    role: p.role as never,
    age: p.age,
    tenure: p.tenure,
    satisfaction: p.satisfaction,
    contractEnd: p.contract.years.length ? p.contract.years[p.contract.years.length - 1].season : state.season,
  });
  // Weekly form drift (deterministic, shared across a team's games that
  // week): real teams run hot and cold — without it, season win% spread
  // comes out too narrow vs. reality.
  const weekNo = Math.floor(Date.parse(g.date) / (7 * 86400000));
  const formOf = (teamId: string) => rngFor(state.seed, `form:${state.season}:${weekNo}:${teamId}`).float(-1, 1);
  const result = simulateGame(
    { id: home.id, name: home.name, players: homePlayers.map(toSimPlayer), config: state.rotation?.[home.id] ?? null, chemistry: computeChemistry(homePlayers.map(toChem), chemCtx).overall, form: formOf(home.id) },
    { id: away.id, name: away.name, players: awayPlayers.map(toSimPlayer), config: state.rotation?.[away.id] ?? null, chemistry: computeChemistry(awayPlayers.map(toChem), chemCtx).overall, form: formOf(away.id) },
    {
      seed: state.seed,
      salt: `game:${g.id}:${g.date}`,
      playoff: g.type === "PLAYOFF",
      backToBackHome,
      backToBackAway,
    },
  );

  g.homeScore = result.homeScore;
  g.awayScore = result.awayScore;
  g.status = "FINAL";
  g.box = result.box;
  if (g.homeScore >= g.awayScore) {
    home.wins++;
    away.losses++;
  } else {
    away.wins++;
    home.losses++;
  }

  // Apply box to player season stats.
  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const l of [...result.box.home, ...result.box.away]) {
    const p = byId.get(l.playerId);
    if (!p) continue;
    let s = p.seasonStats[0];
    if (!s) {
      s = { g: 0, mp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
      p.seasonStats = [s];
    }
    s.g++;
    s.mp += l.mp;
    s.pts += l.pts;
    s.reb += l.reb;
    s.ast += l.ast;
    s.stl += l.stl;
    s.blk += l.blk;
    s.tov += l.tov;
    s.fgm += l.fgm;
    s.fga += l.fga;
    s.tpm += l.tpm;
    s.tpa += l.tpa;
    s.ftm += l.ftm;
    s.fta += l.fta;
    p.lastGameDate = g.date;
    p.stamina = Math.max(0.45, p.stamina - l.mp / 600);
  }

  // Injuries: per team per game, weighted by minutes, age — and fatigue
  // (tired bodies break down more often).
  const injRng = rngFor(state.seed, `injury:${g.id}`);
  for (const teamPlayers of [homePlayers, awayPlayers]) {
    if (!injRng.chance(0.16)) continue;
    const candidates = teamPlayers.filter((p) => p.status === "ACTIVE");
    if (!candidates.length) continue;
    const victim = injRng.weighted(candidates, (p) => (p.age / 26) * Math.pow(Math.max(20, p.ratings.overall) / 55, 1.5) * (1.5 - 0.5 * p.stamina));
    const roll = injRng.next();
    const severity = roll < 0.68 ? "MINOR" : roll < 0.92 ? "MODERATE" : "SEVERE";
    const weeks = severity === "MINOR" ? injRng.int(1, 2) : severity === "MODERATE" ? injRng.int(3, 6) : injRng.int(7, 14);
    const description = injRng.pick(["脚踝扭伤", "腿筋拉伤", "膝盖酸痛", "肩部挫伤", "手指骨折", "腹股沟拉伤", "背部痉挛"]);
    victim.injury = { description, weeksRemaining: weeks, severity };
    victim.status = "INJURED";
    report.injuries.push({ playerId: victim.id, name: victim.name, description, weeks });
  }

  report.gamesPlayed++;
  report.results.push({ gameId: g.id, home: home.abbr, away: away.abbr, homeScore: result.homeScore, awayScore: result.awayScore });
}

function tickDaily(state: LeagueState, report: DayReport) {
  const yesterday = isoAddDays(state.currentDate, -1);
  for (const p of state.players) {
    // Fatigue recovery is proportional, not flat: a day off closes ~42% of
    // the gap instead of a fixed +0.25 that erased a heavy night in one day.
    // Heavy-minutes players now hover below 1.0 across dense stretches and
    // b2b fatigue actually accumulates — which is what makes staminaF and the
    // in-game stamina penalties matter.
    if (p.lastGameDate !== yesterday && p.lastGameDate !== state.currentDate) {
      p.stamina = Math.min(1, p.stamina + (1 - p.stamina) * 0.42);
    }
    // injury countdown
    if (p.injury && p.injury.weeksRemaining > 0) {
      p.injury.weeksRemaining -= 1 / 7; // day-based countdown in weeks
      if (p.injury.weeksRemaining <= 0) {
        p.injury = null;
        if (p.status === "INJURED") p.status = "ACTIVE";
        // Returning from injury: rusty — reduced stamina limits minutes and
        // sharpness until daily recovery rebuilds it (~2 days per 0.5).
        p.stamina = Math.min(p.stamina, 0.55);
        report.notes.push(`${p.name} 伤愈复出（身体状态仅恢复约 55%，建议逐步加回轮换时间）`);
      }
    }
  }
}

function maybeEndRegularSeason(state: LeagueState, report: DayReport) {
  const remaining = state.games.filter((g) => g.status === "SCHEDULED").length;
  if (remaining > 0) return;
  report.notes.push("常规赛结束，进入季后赛");
  startPlayoffs(state, report);
}

function seedConference(state: LeagueState, conf: "EAST" | "WEST"): LeagueTeam[] {
  return state.teams
    .filter((t) => t.conference === conf)
    .sort((a, b) => b.wins - a.wins || (a.abbr < b.abbr ? -1 : 1))
    .slice(0, 8);
}

function startPlayoffs(state: LeagueState, report: DayReport) {
  state.phase = "PLAYOFFS";
  const series: SeriesState[] = [];
  const start = isoAddDays(state.currentDate, 1);
  const mk = (round: SeriesState["round"], conf: "EAST" | "WEST" | null, a: string, b: string, i: number): SeriesState => ({
    id: `s-${state.season}-${round}-${conf ?? "F"}-${i}`,
    round,
    conference: conf,
    aTeamId: a,
    bTeamId: b,
    winsA: 0,
    winsB: 0,
    gamesPlayed: 0,
    done: false,
    winnerId: null,
    nextGameDate: start,
  });
  for (const conf of ["EAST", "WEST"] as const) {
    const seeds = seedConference(state, conf);
    series.push(mk("R1", conf, seeds[0].id, seeds[7].id, 1), mk("R1", conf, seeds[3].id, seeds[4].id, 2), mk("R1", conf, seeds[1].id, seeds[6].id, 3), mk("R1", conf, seeds[2].id, seeds[5].id, 4));
  }
  state.playoffs = { series, championTeamId: null };
  report.notes.push("季后赛对阵已生成");
}

function scheduleSeriesGame(state: LeagueState, s: SeriesState) {
  // Best-of-7: home pattern A,A,B,B,A,B,A by game number.
  const gameNo = s.gamesPlayed + 1;
  const homeFirst = [true, true, false, false, true, false, true][gameNo - 1] ?? true;
  const g: LeagueGame = {
    id: `${s.id}-g${gameNo}`,
    date: s.nextGameDate,
    season: state.season,
    type: "PLAYOFF",
    round: s.round,
    seriesId: s.id,
    gameNo,
    homeTeamId: homeFirst ? s.aTeamId : s.bTeamId,
    awayTeamId: homeFirst ? s.bTeamId : s.aTeamId,
    homeScore: null,
    awayScore: null,
    status: "SCHEDULED",
    box: null,
  };
  state.games.push(g);
  s.nextGameDate = isoAddDays(s.nextGameDate, 2);
}

function advancePlayoffDay(state: LeagueState, report: DayReport) {
  const po = state.playoffs;
  if (!po || po.championTeamId) return;
  const todays = state.games.filter((g) => g.type === "PLAYOFF" && g.status === "SCHEDULED" && g.date === state.currentDate);
  for (const g of todays) {
    const s = po.series.find((x) => x.id === g.seriesId);
    if (!s) continue;
    simAndApply(state, g, report);
    if (g.homeScore == null || g.awayScore == null) continue;
    const aWon = g.homeTeamId === s.aTeamId ? g.homeScore > g.awayScore : g.awayScore > g.homeScore;
    if (aWon) s.winsA++;
    else s.winsB++;
    s.gamesPlayed++;
    if (s.winsA === 4 || s.winsB === 4) {
      s.done = true;
      s.winnerId = s.winsA === 4 ? s.aTeamId : s.bTeamId;
      report.notes.push(`系列赛结束：${teamAbbr(state, s.winnerId)} 晋级/夺冠`);
    }
  }
  // schedule next games for unfinished series
  for (const s of po.series) {
    if (!s.done && !state.games.some((g) => g.seriesId === s.id && g.status === "SCHEDULED")) {
      scheduleSeriesGame(state, s);
    }
  }
  maybeAdvanceRound(state, report);
}

function maybeAdvanceRound(state: LeagueState, report: DayReport) {
  const po = state.playoffs!;

  const nextRoundMap: Record<string, SeriesState["round"]> = { R1: "CONF_SEMI", CONF_SEMI: "CONF_FINAL", CONF_FINAL: "FINALS" };
  for (const round of ["R1", "CONF_SEMI", "CONF_FINAL"] as const) {
    const seriesOfRound = po.series.filter((s) => s.round === round);
    if (seriesOfRound.length === 0 || !seriesOfRound.every((s) => s.done)) continue;
    const next = nextRoundMap[round];
    if (po.series.some((s) => s.round === next)) continue; // next round already created

    const mkSeries = (r: SeriesState["round"], conf: "EAST" | "WEST" | null, a: string, b: string): SeriesState => ({
      id: `s-${state.season}-${r}-${conf ?? "F"}-${po.series.length}`,
      round: r,
      conference: conf,
      aTeamId: a,
      bTeamId: b,
      winsA: 0,
      winsB: 0,
      gamesPlayed: 0,
      done: false,
      winnerId: null,
      nextGameDate: isoAddDays(state.currentDate, 2),
    });

    // Home-court goes to the team with the better regular-season record —
    // bracket order alone doesn't guarantee it (upsets scramble seeds, and
    // the Finals pair is just "whoever won each conference").
    const byRecord = (x: string, y: string): [string, string] => {
      const tx = state.teams.find((t) => t.id === x);
      const ty = state.teams.find((t) => t.id === y);
      const wx = tx?.wins ?? 0;
      const wy = ty?.wins ?? 0;
      return wx > wy || (wx === wy && (tx?.abbr ?? "") < (ty?.abbr ?? "")) ? [x, y] : [y, x];
    };

    if (next === "FINALS") {
      const winners = seriesOfRound.map((s) => s.winnerId!);
      if (winners.length !== 2) return; // need exactly two conference champions
      const [a, b] = byRecord(winners[0], winners[1]);
      po.series.push(mkSeries("FINALS", null, a, b));
      report.notes.push("总决赛对阵确定");
      return;
    }
    // In-conference bracket advancement.
    for (const conf of ["EAST", "WEST"] as const) {
      const confWinners = seriesOfRound.filter((s) => s.conference === conf).map((s) => s.winnerId!);
      for (let i = 0; i + 1 < confWinners.length; i += 2) {
        const [a, b] = byRecord(confWinners[i], confWinners[i + 1]);
        po.series.push(mkSeries(next, conf, a, b));
      }
    }
    report.notes.push(`${next} 对阵确定`);
    return;
  }
  // Finals done?
  const finals = po.series.find((s) => s.round === "FINALS");
  if (finals?.done && finals.winnerId) {
    po.championTeamId = finals.winnerId;
    report.notes.push(`总冠军诞生：${teamName(state, finals.winnerId)}`);
    endSeason(state, report, finals.winnerId);
  }
}

function teamAbbr(state: LeagueState, id: string): string {
  return state.teams.find((t) => t.id === id)?.abbr ?? "?";
}
function teamName(state: LeagueState, id: string): string {
  const t = state.teams.find((x) => x.id === id);
  return t ? `${t.city} ${t.name}` : "?";
}

export function seasonScore(p: LeaguePlayer): number {
  const s = p.seasonStats[0];
  if (!s || s.g < 10) return 0;
  const perG = (v: number) => v / s.g;
  return perG(s.pts) * 1.0 + perG(s.reb) * 1.1 + perG(s.ast) * 1.5 + perG(s.stl) * 2 + perG(s.blk) * 2;
}

function endSeason(state: LeagueState, report: DayReport, championId: string) {
  state.phase = "OFFSEASON";
  const champ = state.teams.find((t) => t.id === championId);
  if (champ) champ.wins = champ.wins; // record already accumulated
  report.notes.push(`赛季 ${state.season - 1}-${String(state.season).slice(2)} 结束，冠军：${teamName(state, championId)}`);
}

/** Standings: sorted by conference then division. */
export function standings(state: LeagueState) {
  const byConf = (conf: "EAST" | "WEST") =>
    state.teams
      .filter((t) => t.conference === conf)
      .map((t) => ({ ...t, winPct: t.wins + t.losses > 0 ? t.wins / (t.wins + t.losses) : 0 }))
      .sort((a, b) => b.winPct - a.winPct || b.wins - a.wins || (a.abbr < b.abbr ? -1 : 1));
  return { EAST: byConf("EAST"), WEST: byConf("WEST") };
}

/**
 * Playing-time effect on young-player development. Real rebuilds feed kids
 * minutes; a 21-year-old glued to the bench stagnates. Returns adjustments
 * to the growth roll: {chance, ceil} — positive when the player actually
 * played, dampening when he sat.
 */
export function devMinutesFactor(games: number, mpg: number): { chance: number; ceil: number } {
  if (games >= 40 && mpg >= 20) return { chance: 0.15, ceil: 1 }; // real rotation run
  if (games < 25 || mpg < 8) return { chance: -0.15, ceil: -1 }; // buried — development stalls
  return { chance: 0, ceil: 0 };
}

/** Offseason development: growth/decline by age & potential. Deterministic. */
export function applyDevelopment(state: LeagueState): { playerId: string; name: string; delta: number }[] {
  const out: { playerId: string; name: string; delta: number }[] = [];
  // Team win% for morale: losing grates on veterans and stars; winning heals.
  const winPctByTeam = new Map(state.teams.map((t) => [t.id, (t.wins + t.losses) > 0 ? t.wins / (t.wins + t.losses) : 0.5]));
  // Per-team overall ranking so we can spot stars buried on the bench.
  const rankInTeam = new Map<string, number>();
  for (const t of state.teams) {
    state.players
      .filter((p) => p.teamId === t.id)
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .forEach((p, i) => rankInTeam.set(p.id, i));
  }
  for (const p of state.players) {
    if (p.status === "RETIRED") continue;
    const rng = rngFor(state.seed, `dev:${state.season}:${p.id}`);
    const overall = p.ratings.overall;
    const pot = p.ratings.potential;
    // Growth budget: explicit potential when scouted (synthetic classes);
    // otherwise the seeded growthLeft estimate — real-data players have no
    // potential, and without this fallback the field is dead data.
    const budget = pot != null
      ? Math.max(0, Math.min(20, pot - overall))
      : Math.max(0, p.development?.growthLeft ?? 0);
    let delta = 0;
    if (p.age <= 28 && budget > 0) {
      const s = p.seasonStats[0];
      const mf = devMinutesFactor(s?.g ?? 0, s && s.g > 0 ? s.mp / s.g : 0);
      delta = rng.chance(0.25 + budget * 0.05 + mf.chance) ? rng.int(1, Math.max(1, Math.round(budget / 2) + mf.ceil)) : rng.int(-1, 1);
    } else if (p.age <= 28) {
      delta = rng.chance(0.4) ? rng.int(0, 2) : rng.int(-1, 0);
    } else if (p.age >= 32) {
      delta = rng.chance(0.75) ? -rng.int(1, p.age >= 35 ? 4 : 2) : 0;
    }
    delta = Math.max(-6, Math.min(5, delta));
    const r = p.ratings;
    const newOverall = Math.max(25, Math.min(99, overall + delta));
    const shift = (v: number) => Math.max(25, Math.min(99, v + delta));
    p.ratings = {
      ...r,
      overall: newOverall,
      inside: shift(r.inside),
      finishing: shift(r.finishing),
      threePoint: shift(r.threePoint),
      freeThrow: shift(r.freeThrow),
      playmaking: shift(r.playmaking),
      rebounding: shift(r.rebounding),
      perimeterD: shift(r.perimeterD),
      interiorD: shift(r.interiorD),
    };
    p.development = {
      trajectory: delta > 0 ? "GROWING" : delta < 0 ? "DECLINING" : "STABLE",
      // potential-driven budgets re-derive each year; growthLeft-driven
      // budgets are consumed — growth spent is growth gone.
      growthLeft: pot != null
        ? Math.max(0, pot - newOverall)
        : Math.max(0, (p.development?.growthLeft ?? 0) - Math.max(0, delta)),
      lastDelta: delta,
    };
    // Morale drift: losing wears on good players (esp. aging vets), a
    // high-overall player stuck on the bench is unhappy, winning repairs.
    if (p.teamId) {
      const winPct = winPctByTeam.get(p.teamId) ?? 0.5;
      const rank = rankInTeam.get(p.id) ?? 9;
      let mood = 0;
      if (winPct >= 0.55) mood += 4;
      else if (winPct <= 0.35) mood -= p.ratings.overall >= 82 || p.age >= 31 ? 8 : 4;
      if (newOverall >= 80 && rank >= 9) mood -= 9; // misused talent
      if (newOverall >= 78 && rank <= 5) mood += 2; // featured role
      if (mood !== 0) p.satisfaction = Math.max(15, Math.min(95, p.satisfaction + mood));
    }
    p.age += 1;
    p.yearsPro += 1;
    p.tenure += 1;
    if (delta !== 0) out.push({ playerId: p.id, name: p.name, delta });
  }
  return out;
}

/**
 * In-season morale drift, applied monthly. Losing grates on stars and vets
 * in real time (not just at the offseason review), winning slowly heals, and
 * a high-overall player buried at the end of the rotation festers. Smaller
 * magnitudes than the annual drift — this is a slow burn.
 */
export function applyMonthlyMorale(state: LeagueState): { playerId: string; name: string; from: number; to: number }[] {
  const out: { playerId: string; name: string; from: number; to: number }[] = [];
  const winPctByTeam = new Map(state.teams.map((t) => [t.id, (t.wins + t.losses) > 0 ? t.wins / (t.wins + t.losses) : 0.5]));
  const rankInTeam = new Map<string, number>();
  for (const t of state.teams) {
    const tp = state.players.filter((p) => p.teamId === t.id && (p.status === "ACTIVE" || p.status === "INJURED"));
    const cfg = state.rotation?.[t.id];
    // With a manager-set rotation, "buried" means buried in the ACTUAL
    // pecking order — benching an 85-overall star makes him unhappy even
    // though he's still the second-best name on the roster sheet.
    if (cfg?.starters?.length) {
      const starterSet = new Set(cfg.starters);
      tp.sort((a, b) =>
        (starterSet.has(b.id) ? 1 : 0) - (starterSet.has(a.id) ? 1 : 0) ||
        (cfg.minutes?.[b.id] ?? 0) - (cfg.minutes?.[a.id] ?? 0) ||
        b.ratings.overall - a.ratings.overall,
      );
    } else {
      tp.sort((a, b) => b.ratings.overall - a.ratings.overall);
    }
    tp.forEach((p, i) => rankInTeam.set(p.id, i));
  }
  for (const p of state.players) {
    if (!p.teamId || (p.status !== "ACTIVE" && p.status !== "INJURED")) continue;
    const winPct = winPctByTeam.get(p.teamId) ?? 0.5;
    const rank = rankInTeam.get(p.id) ?? 9;
    let mood = 0;
    if (winPct >= 0.6) mood += 2;
    else if (winPct <= 0.32) mood -= p.ratings.overall >= 82 || p.age >= 31 ? 4 : 2;
    if (p.ratings.overall >= 80 && rank >= 9) mood -= 3;
    if (mood === 0) continue;
    const from = p.satisfaction;
    const to = Math.max(15, Math.min(95, from + mood));
    if (to !== from) {
      p.satisfaction = to;
      out.push({ playerId: p.id, name: p.name, from, to });
    }
  }
  return out;
}
