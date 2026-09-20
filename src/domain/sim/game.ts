// Possession-based basketball simulation engine.
// GAME-SIM v2.0: lineup rotations, possession allocation, pace, shot mix,
// fouls & free throws, offensive rebounds, clutch usage, garbage time,
// overtime, and home edge as small probability shifts (no fixed +N points).
// Deterministic given (seed, salt): same inputs → identical box scores.

import { rngFor, PRNG } from "../rng";
import { assignStarters } from "../positions";
import type { BoxPlayerLine, BoxScoreJson, Position } from "../types";

export const GAME_SIM_VERSION = "GAME-SIM v2.1";

export interface SimPlayer {
  id: string;
  name: string;
  position: Position;
  secondPosition?: Position | null;
  ratings: {
    overall: number;
    inside: number;
    finishing: number;
    threePoint: number;
    freeThrow: number;
    playmaking: number;
    rebounding: number;
    perimeterD: number;
    interiorD: number;
  };
  usageTendency: number;
  role: string;
  injury: { weeksRemaining: number; severity: string } | null;
  stamina: number; // 0-1, 1 = fresh; low stamina cuts minutes & performance
  morale?: number; // 0-100 satisfaction; locker-room mood moves team efficiency
}

/** Manager-set rotation for one team: 5 starters + optional per-player minute targets. */
export interface RotationConfig {
  starters: string[];
  minutes?: Record<string, number>;
}

export interface SimTeam {
  id: string;
  name: string;
  players: SimPlayer[];
  config?: RotationConfig | null;
  /** 0-100 roster chemistry (fit, continuity, mood) — nudges team efficiency. */
  chemistry?: number;
  /** -1..1 weekly form drift — correlated cross-game noise so wins aren't
   * purely a function of static ratings (season win% spread depends on it). */
  form?: number;
}

export interface BuildRotationOpts {
  backToBack?: boolean;
  playoff?: boolean;
}

interface Slot {
  player: SimPlayer;
  plan: number; // target minutes for this game
  played: number; // burned seconds
  fouls: number;
  out: boolean; // fouled out
}

// Real-rotation shape: stars live at 36-38, starters 32-34, and the bench
// tail is emergency-only — 8-9 man rotations like the actual league.
const ROLE_BASE_MINUTES: Record<string, number> = {
  STAR: 39,
  STARTER: 34,
  SIXTH_MAN: 24,
  ROTATION: 9,
  BENCH: 1.5,
  STASH: 0,
};

// Non-starters take minutes off a fixed ladder (6th man ~23, then falls off a
// cliff) instead of per-role bases — real rotations are ranked, not labeled.
const BENCH_LADDER = [23, 15, 11, 8, 5, 3, 2];

const QUARTER_SECONDS = 12 * 60;
const OT_SECONDS = 5 * 60;
const MIN = 48 * 5; // 240 player-minutes per team per game

export const FOULS_TO_FOUL_OUT = 6;

/**
 * Minutes plan for one game. Role/config driven — overall rating never forces
 * a minimum. Stamina, back-to-back and playoffs shape the distribution; the
 * plan always sums to exactly MIN (240).
 */
export function buildRotation(team: SimTeam, rng: PRNG, opts: BuildRotationOpts = {}): Slot[] {
  const avail = team.players.filter((p) => !p.injury || p.injury.weeksRemaining <= 0);
  if (avail.length < 5) return [];
  const playoff = !!opts.playoff;

  // Starters: manager config wins when valid; otherwise best role+overall.
  let starterIds: string[] | null = null;
  const cfg = team.config;
  if (cfg?.starters?.length === 5) {
    const uniq = new Set(cfg.starters);
    if (uniq.size === 5 && cfg.starters.every((id) => avail.some((p) => p.id === id))) starterIds = cfg.starters;
  }
  if (!starterIds) {
    // No manager config: fill the five lineup slots (PG→C) — scarcest eligible
    // position first, natural position preferred over flex, best overall wins.
    starterIds = assignStarters(avail)
      .filter((p): p is SimPlayer => !!p)
      .map((p) => p.id);
  }
  const starterSet = new Set(starterIds);

  const b2b = !!opts.backToBack;

  // Manager-set minutes own their share of the 240-minute budget first; the
  // rest of the roster is normalized into whatever budget remains. This makes
  // "limit a star to 24" or "shorten the rotation" actually stick.
  let budget = MIN;
  for (const p of avail) {
    const userMin = cfg?.minutes?.[p.id];
    if (userMin != null && userMin > 0) budget -= userMin;
  }
  if (budget < 0) {
    // Over-allocated: scale the requested minutes back to a legal game length.
    const k = MIN / (MIN - budget);
    for (const p of avail) {
      const userMin = cfg?.minutes?.[p.id];
      if (userMin != null && userMin > 0 && cfg?.minutes) cfg.minutes[p.id] = Math.round(userMin * k * 10) / 10;
    }
    budget = 0;
  }

  // Bench ordering for the ladder: role first (a real SIXTH_MAN tops it),
  // then overall. Manager-assigned minutes are excluded — they own their slot.
  const benchPool = avail
    .filter((p) => !starterSet.has(p.id) && !(cfg?.minutes?.[p.id] != null && cfg.minutes[p.id] > 0))
    .sort((a, b) => (ROLE_BASE_MINUTES[b.role] ?? 12) - (ROLE_BASE_MINUTES[a.role] ?? 12) || b.ratings.overall - a.ratings.overall);
  const benchIdx = new Map<string, number>(benchPool.map((p, i) => [p.id, i]));

  const slots: Slot[] = avail.map((p) => {
    const isStarter = starterSet.has(p.id);
    const userMin = cfg?.minutes?.[p.id];
    if (userMin != null && userMin > 0) {
      return { player: p, plan: userMin, played: 0, fouls: 0, out: false };
    }
    const bi = benchIdx.get(p.id);
    let base = isStarter ? Math.max(ROLE_BASE_MINUTES[p.role] ?? 12, 32.5) : bi != null && bi < BENCH_LADDER.length ? BENCH_LADDER[bi] : 1.5;
    // A STAR squeezed out of the starting five (two same-position stars, or a
    // midseason acquisition behind an entrenched starter) still plays real
    // starter minutes — think Booker behind SGA or a super-sixth-man.
    if (!isStarter && (p.role === "STAR" || p.ratings.overall >= 84)) base = Math.max(base, 28);
    // Playoff rotations tighten: more for the top, less for the deep bench.
    if (playoff) base = isStarter ? base + 1.5 : bi === 0 ? base + 1 : base * 0.75;
    // Fatigue = load management: starters lose minutes faster than bench
    // players, so a tired team spreads the load (and gets worse). Stars carry
    // their minutes deeper into fatigue than ordinary starters do.
    const staminaF = p.role === "STAR" ? 0.92 + 0.08 * p.stamina : isStarter ? 0.87 + 0.13 * p.stamina : 0.93 + 0.07 * p.stamina;
    // Back-to-backs push the same direction: stars get lighter nights.
    const b2bF = b2b ? (isStarter ? 0.94 : 1.0) : 1;
    const plan = base * staminaF * b2bF;
    return { player: p, plan: Math.max(0, plan), played: 0, fouls: 0, out: false };
  });

  // Distribute the remaining budget across auto-assigned players only.
  const autoSlots = slots.filter((s) => !(cfg?.minutes?.[s.player.id] != null && cfg.minutes[s.player.id] > 0));
  const totalPlan = autoSlots.reduce((a, s) => a + s.plan, 0);
  const autoBudget = Math.max(0, budget);
  if (autoSlots.length === 0) {
    /* manager assigned all minutes */
  } else if (totalPlan <= 0) {
    for (const s of autoSlots) s.plan = autoBudget / autoSlots.length;
  } else {
    const scale = autoBudget / totalPlan;
    for (const s of autoSlots) s.plan *= scale;
  }
  const sum = slots.reduce((a, s) => a + s.plan, 0);
  if (sum > 0) for (const s of slots) s.plan = (s.plan / sum) * MIN;
  // Rounding to 0.1 then re-balance the residual onto the heaviest slot.
  for (const s of slots) s.plan = Math.round(s.plan * 10) / 10;
  const residual = Math.round((MIN - slots.reduce((a, s) => a + s.plan, 0)) * 10) / 10;
  if (slots.length > 0) slots[0].plan = Math.round(Math.max(0, slots[0].plan + residual) * 10) / 10;
  slots.sort((a, b) => b.plan - a.plan);
  return slots;
}

export interface GameSimResult {
  homeScore: number;
  awayScore: number;
  box: BoxScoreJson;
  notes: string[];
  otPeriods: number;
}

function emptyLine(p: SimPlayer): BoxPlayerLine {
  return {
    playerId: p.id,
    name: p.name,
    teamId: "",
    mp: 0,
    pts: 0,
    reb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    tov: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
  };
}

function efg(fgm: number, tpm: number, fga: number): number {
  return fga > 0 ? (fgm + 0.5 * tpm) / fga : 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface SideState {
  team: SimTeam;
  slots: Slot[];
  score: number;
  lines: Map<string, BoxPlayerLine>;
  teamFouls: number; // this quarter
  possessionsLeft: number; // current period
  onCourt: Slot[];
}

const lineOf = (side: SideState, p: SimPlayer) => {
  let l = side.lines.get(p.id);
  if (!l) {
    l = emptyLine(p);
    l.teamId = side.team.id;
    side.lines.set(p.id, l);
  }
  return l;
};

/** In-game freshness: heavy early minutes degrade late-game execution. */
function tire(slot: Slot): number {
  const mins = slot.played / 60;
  return clamp(1 - Math.max(0, mins - 26) * 0.008, 0.88, 1);
}

function courtWeight(slot: Slot, ctx: { garbage: boolean; starter: boolean; playoff: boolean }): number {
  const remaining = Math.max(0, slot.plan * 60 - slot.played);
  if (remaining <= 0 || slot.out) return 0;
  let w = remaining;
  if (ctx.garbage) w *= slot.player.role === "STAR" || ctx.starter ? 0.35 : 2.4;
  return w;
}

function pickCourt(slots: Slot[], rng: PRNG, ctx: { garbage: boolean; playoff: boolean }): Slot[] {
  const picked: Slot[] = [];
  const pool = [...slots];
  for (let i = 0; i < 5 && pool.length > 0; i++) {
    const weights = pool.map((s) => courtWeight(s, { garbage: ctx.garbage, starter: picked.length === 0, playoff: ctx.playoff }));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      // Everyone exhausted (heavy OT): fall back to non-fouled players.
      const alive = pool.filter((s) => !s.out);
      if (!alive.length) break;
      picked.push(alive[Math.floor(rng.next() * alive.length)]);
      pool.splice(pool.indexOf(picked[picked.length - 1]), 1);
      continue;
    }
    let r = rng.next() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    idx = Math.min(idx, pool.length - 1);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

export function simulateGame(
  home: SimTeam,
  away: SimTeam,
  opts: { seed: number | string; salt: string; neutral?: boolean; backToBackHome?: boolean; backToBackAway?: boolean; playoff?: boolean },
): GameSimResult {
  const rng = rngFor(opts.seed, opts.salt);
  const homeSlots = buildRotation(home, rng, { backToBack: opts.backToBackHome, playoff: opts.playoff });
  const awaySlots = buildRotation(away, rng, { backToBack: opts.backToBackAway, playoff: opts.playoff });
  if (homeSlots.length < 5 || awaySlots.length < 5) {
    const homeShort = homeSlots.length < 5;
    const note = `${homeShort ? home.name : away.name} 可用球员不足 5 人，比赛按规则判定`;
    return {
      homeScore: homeShort ? 80 : 100,
      awayScore: homeShort ? 100 : 80,
      box: { home: [], away: [], homeTotals: { pts: 0, reb: 0, ast: 0 }, awayTotals: { pts: 0, reb: 0, ast: 0 }, notes: [note] },
      notes: [note],
      otPeriods: 0,
    };
  }

  const mkSide = (team: SimTeam, slots: Slot[]): SideState => ({
    team,
    slots,
    score: 0,
    lines: new Map(),
    teamFouls: 0,
    possessionsLeft: 0,
    onCourt: [],
  });
  const H = mkSide(home, homeSlots);
  const A = mkSide(away, awaySlots);

  // Team quality (minutes-weighted rotation averages) drive pace & efficiency.
  // Offense includes `inside` so post scoring counts; overall is blended in so
  // the production/impact captured by OVR (usage bump, real value beyond the
  // six box-score subs) actually reaches the scoreboard.
  const teamSkill = (slots: Slot[], side: "off" | "def") => {
    let num = 0;
    let den = 0;
    for (const s of slots) {
      const r = s.player.ratings;
      const v =
        side === "off"
          ? (r.inside + r.finishing + r.threePoint + r.playmaking) / 4
          : (r.perimeterD + r.interiorD + r.rebounding) / 3;
      num += v * s.plan;
      den += s.plan;
    }
    return den > 0 ? num / den : 55;
  };
  const teamOvr = (slots: Slot[]) => {
    let num = 0;
    let den = 0;
    for (const s of slots) { num += s.player.ratings.overall * s.plan; den += s.plan; }
    return den > 0 ? num / den : 70;
  };
  // Star power: a team's three best players decide games more than the
  // depth-average does (real rotations shorten when it matters). Mean OVR of
  // the three highest-rated players in the rotation.
  const star3 = (slots: Slot[]) => {
    const top = [...slots].sort((a, b) => b.player.ratings.overall - a.player.ratings.overall).slice(0, 3);
    return top.length ? top.reduce((a, s) => a + s.player.ratings.overall, 0) / top.length : 70;
  };
  // Locker-room morale: minutes-weighted satisfaction nudges team efficiency
  // (a miserable locker room plays a few points worse, a happy one sharper).
  const teamMorale = (slots: Slot[]) => {
    let num = 0, den = 0;
    for (const s of slots) { num += (s.player.morale ?? 60) * s.plan; den += s.plan; }
    return den > 0 ? num / den : 60;
  };
  const moraleBoost = (slots: Slot[]) => 1 + (teamMorale(slots) - 60) * 0.0012; // ±~5% at extremes
  // Roster chemistry is a structural multiplier on top of raw morale: a
  // well-fitting, settled rotation executes a couple percent better than its
  // talent says; a chucked-together one plays worse. ±~3% at the extremes.
  const chemBoost = (team: SimTeam) => 1 + ((team.chemistry ?? 62) - 62) * 0.0008;
  // Weekly form: hot weeks and cold weeks exist — ±2% efficiency, shared
  // across a team's games that week so streaks correlate.
  const formBoost = (team: SimTeam) => 1 + (team.form ?? 0) * 0.02;
  const hOff = teamSkill(homeSlots, "off") * moraleBoost(homeSlots) * chemBoost(home) * formBoost(home);
  const hDef = teamSkill(homeSlots, "def") * moraleBoost(homeSlots) * chemBoost(home) * formBoost(home);
  const aOff = teamSkill(awaySlots, "off") * moraleBoost(awaySlots) * chemBoost(away) * formBoost(away);
  const aDef = teamSkill(awaySlots, "def") * moraleBoost(awaySlots) * chemBoost(away) * formBoost(away);
  // Matchup edge: a team's collective quality must move *possession outcomes*,
  // not just pace — otherwise roster strength never converts into wins and
  // standings become noise (observed corr(top3 OVR, win%) ≈ 0.4). Applied per
  // shot/turnover below so a real edge is worth ~±7 net points across the
  // league spread (best ~+8, worst ~-8 like the actual NBA).
  const hOvr = teamOvr(homeSlots);
  const aOvr = teamOvr(awaySlots);
  // Saturate: even a huge talent gap shouldn't make a game a foregone
  // conclusion — real upsets stay ~20% no matter the mismatch.
  const EDGE_CAP = 8;
  const hEdge = clamp(hOff - aDef + (hOvr - aOvr) * 1.4 + (star3(homeSlots) - star3(awaySlots)) * 0.8, -EDGE_CAP, EDGE_CAP);
  const aEdge = clamp(aOff - hDef + (aOvr - hOvr) * 1.4 + (star3(awaySlots) - star3(homeSlots)) * 0.8, -EDGE_CAP, EDGE_CAP);

  // Pace: possessions per team per 48 min (NBA-like ≈ 100). Both teams' styles
  // meet in the middle; back-to-backs slow down; better offenses push a bit.
  const pace48 = clamp(102.5 + (hOff + aOff - hDef - aDef) * 0.06 + rng.float(-2.5, 2.5) - (opts.backToBackHome ? 1.2 : 0) - (opts.backToBackAway ? 1.2 : 0), 90, 110);
  const possessionSeconds = (periodSeconds: number, periodPossessions: number) => periodSeconds / Math.max(1, periodPossessions);

  const hca = opts.neutral ? 0 : opts.playoff ? 1.25 : 1; // multiplier on small probability shifts

  const burn = (side: SideState, secs: number) => {
    for (const s of side.onCourt) s.played += secs;
  };

  /** Refresh on-court units (substitutions). */
  const sub = (side: SideState, garbage: boolean) => {
    side.onCourt = pickCourt(side.slots, rng, { garbage, playoff: !!opts.playoff });
  };

  const ballHandler = (side: SideState, clutch: boolean, margin: number): Slot => {
    if (side.onCourt.length === 0 || side.onCourt.every((s) => s.out)) sub(side, false);
    const pool = side.onCourt.filter((s) => !s.out);
    const weighted = pool.map((s) => {
      const p = s.player;
      // Star-driven usage: overall + real scoring share concentrate attempts.
      // An 89-OVR high-usage player should dwarf an end-of-bench body ~3-4x.
      let w = Math.max(0.5, (p.ratings.overall - 66) * 0.24) + p.usageTendency * 13;
      if (clutch && (p.role === "STAR" || p.ratings.overall >= 85)) w *= 1.7; // stars demand the ball late
      if (!clutch && Math.abs(margin) > 22) w *= 0.8; // stars rest mentally in blowouts
      w *= tire(s) * (0.9 + 0.1 * p.stamina);
      return w;
    });
    const idx = rng.weightedIndex(weighted);
    return pool[idx] ?? side.slots[0];
  };

  const defendWeighted = (side: SideState, key: "perimeterD" | "interiorD"): Slot => {
    if (side.onCourt.length === 0 || side.onCourt.every((s) => s.out)) sub(side, false);
    const pool = side.onCourt.filter((s) => !s.out);
    return pool[rng.weightedIndex(pool.map((s) => Math.max(1, s.player.ratings[key] - 30)))] ?? side.slots[0];
  };

  // Fouls run the other way: the WEAKER defenders are the ones who reach.
  // ~3x spread across the league's defensive range, capped so stars on poor
  // defenders still pick up a few.
  const foulWeighted = (side: SideState, key: "perimeterD" | "interiorD"): Slot => {
    if (side.onCourt.length === 0 || side.onCourt.every((s) => s.out)) sub(side, false);
    const pool = side.onCourt.filter((s) => !s.out);
    return pool[rng.weightedIndex(pool.map((s) => Math.max(0.2, 1 + (65 - s.player.ratings[key]) * 0.02)))] ?? side.slots[0];
  };
  // Team-level foul propensity: bad defensive units foul more often (~±15%).
  const foulPropensity = (def: SideState) => {
    const pool = def.onCourt.filter((s) => !s.out);
    if (!pool.length) return 1;
    const avgDef = pool.reduce((a, s) => a + (s.player.ratings.perimeterD + s.player.ratings.interiorD) / 2, 0) / pool.length;
    return clamp(1 + (62 - avgDef) * 0.006, 0.85, 1.2);
  };

  // Court position matters as much as rebounding skill — bigs live near the
  // rim. Linear weight: rating already encodes position-relative dominance,
  // squaring it double-counts (a 90-rated C would grab half of all boards).
  const REB_POS_BIAS: Record<Position, number> = { PG: 0.6, SG: 0.8, SF: 0.95, PF: 1.3, C: 1.5 };
  const reboundWeighted = (side: SideState): Slot => {
    const pool = side.onCourt.filter((s) => !s.out);
    return pool[rng.weightedIndex(pool.map((s) => Math.max(1, (s.player.ratings.rebounding - 22) * (REB_POS_BIAS[s.player.position] ?? 1))))] ?? side.slots[0];
  };

  /** One offensive possession for `off` against `def`. Returns oreb extends? */
  const possession = (off: SideState, def: SideState, ctx: { clutch: boolean; garbage: boolean; period: "REG" | "OT"; homeIsOff: boolean }) => {
    const shooterSlot = ballHandler(off, ctx.clutch, off.score - def.score);
    const shooter = shooterSlot.player;
    const line = lineOf(off, shooter);
    const r = shooter.ratings;
    const hcaOff = ctx.homeIsOff ? hca : 0;

    // Turnover: playmaking vs defensive pressure; tired & raw handlers leak more.
    const edge = ctx.homeIsOff ? hEdge : aEdge;
    const defPressure = def.onCourt.filter((s) => !s.out).reduce((a, s) => a + s.player.ratings.perimeterD, 0) / Math.max(1, def.onCourt.filter((s) => !s.out).length);
    let tovP = clamp(
      0.128 + (62 - r.playmaking) * 0.0018 + (defPressure - 60) * 0.0007 - edge * 0.0014 - (r.playmaking > 82 ? 0.012 : 0) + (1 - tire(shooterSlot)) * 0.05 + (1 - shooter.stamina) * 0.08 - (ctx.clutch ? 0.008 : 0),
      0.05,
      0.26,
    );
    if (ctx.homeIsOff) tovP -= 0.005 * hca;
    else tovP += 0.006 * hca;
    if (rng.chance(tovP)) {
      line.tov++;
      if (rng.chance(0.62)) lineOf(def, defendWeighted(def, "perimeterD").player).stl++;
      return false;
    }

    // Shot selection: three-point rate from rating + position bias.
    const pos3: Record<Position, number> = { PG: 0.055, SG: 0.05, SF: 0.015, PF: -0.05, C: -0.13 };
    const threeP = clamp(0.355 + (r.threePoint - 55) * 0.0065 + (pos3[shooter.position] ?? 0) + (ctx.clutch && r.threePoint >= 75 ? 0.02 : 0), 0.02, 0.66);
    const isThree = rng.chance(threeP);

    // Shooting foul (in the act): slightly higher at home — a *probability* shift, never free points.
    const foulP = ((isThree ? 0.055 : 0.11) + 0.008 * hcaOff) * foulPropensity(def);
    if (rng.chance(foulP)) {
      const fouler = foulWeighted(def, isThree ? "perimeterD" : "interiorD").player;
      lineOf(def, fouler);
      foulerSlotFoul(def, fouler, ctx);
      line.fta += isThree ? 3 : 2;
      for (let i = 0; i < (isThree ? 3 : 2); i++) {
        if (rng.chance(clamp(r.freeThrow / 100 + (ctx.homeIsOff ? 0.01 : 0), 0.45, 0.97))) {
          line.ftm++;
          line.pts++;
          off.score++;
        }
      }
      return false;
    }

    // Field goal attempt.
    line.fga++;
    if (isThree) line.tpa++;
    const defQ =
      def.onCourt.filter((s) => !s.out).reduce((a, s) => a + (isThree ? s.player.ratings.perimeterD : (s.player.ratings.interiorD + s.player.ratings.perimeterD) / 2), 0) /
      Math.max(1, def.onCourt.filter((s) => !s.out).length);
    // Skill-sourced swing on a single shot saturates: even a superstar vs a
    // blown coverage only buys ~+5pp. Capping the combined individual+team
    // term keeps blowout margins realistic without blurring mid-table order.
    let makeP: number;
    if (isThree) {
      const skillSwing = clamp((r.threePoint - defQ) * 0.0055 + edge * 0.0028, -0.05, 0.055);
      makeP = clamp(0.315 + skillSwing + 0.006 * hcaOff - (1 - tire(shooterSlot)) * 0.03 - (1 - shooter.stamina) * 0.09, 0.2, 0.55);
    } else {
      const finish = (r.finishing + r.inside) / 2;
      const skillSwing = clamp((finish - defQ) * 0.005 + edge * 0.0032, -0.05, 0.055);
      makeP = clamp(0.505 + skillSwing + 0.007 * hcaOff - (1 - tire(shooterSlot)) * 0.03 - (1 - shooter.stamina) * 0.09, 0.36, 0.70);
    }
    makeP += rng.gauss(0, 0.012);

    if (rng.chance(makeP)) {
      line.fgm++;
      line.pts += isThree ? 3 : 2;
      if (isThree) line.tpm++;
      off.score += isThree ? 3 : 2;
      // Assist: ball-movement chance shaped by team playmaking, credited mostly
      // to the real creators — squared weight so the Jokic/Luka types rack up
      // assists instead of spreading them evenly across the floor.
      const helpers = off.onCourt.filter((s) => !s.out && s.player.id !== shooter.id);
      const helper = helpers[rng.weightedIndex(helpers.map((s) => Math.max(1, Math.pow(s.player.ratings.playmaking - 28, 2))))] ?? helpers[0];
      if (helper) {
        const astP = clamp(0.36 + helper.player.ratings.playmaking * 0.0042 - shooter.usageTendency * 0.15, 0.22, 0.8);
        if (rng.chance(astP)) lineOf(off, helper.player).ast++;
      }
      return false;
    }

    // Miss: block? then rebound battle (offensive board extends the possession).
    if (!isThree && rng.chance(0.18)) {
      lineOf(def, defendWeighted(def, "interiorD").player).blk++;
    }
    const offRebW = off.onCourt.filter((s) => !s.out).reduce((a, s) => a + s.player.ratings.rebounding * s.player.ratings.rebounding, 0);
    const defRebW = def.onCourt.filter((s) => !s.out).reduce((a, s) => a + s.player.ratings.rebounding * s.player.ratings.rebounding, 0);
    const orebP = clamp(0.23 + ((offRebW - defRebW) / Math.max(1, offRebW + defRebW)) * 0.24, 0.12, 0.38);
    if (rng.chance(orebP)) {
      lineOf(off, reboundWeighted(off).player).reb++;
      return true; // second-chance possession: immediate re-run without TO check
    }
    lineOf(def, reboundWeighted(def).player).reb++;
    return false;
  };

  // Non-shooting fouls: after 5 team fouls in a quarter the offense shoots bonus FTs.
  const foulerSlotFoul = (def: SideState, foulerPlayer: SimPlayer, ctx: { clutch: boolean; garbage: boolean; period: "REG" | "OT"; homeIsOff: boolean }) => {
    const slot = def.slots.find((s) => s.player.id === foulerPlayer.id);
    if (!slot) return;
    slot.fouls++;
    def.teamFouls++;
    if (slot.fouls >= FOULS_TO_FOUL_OUT) {
      slot.out = true;
      sub(def, ctx.garbage); // fouled out → immediate replacement
    }
    void ctx;
  };

  const nonShootingFoulCheck = (off: SideState, def: SideState, ctx: { clutch: boolean; garbage: boolean; period: "REG" | "OT"; homeIsOff: boolean }) => {
    if (!rng.chance(0.055 * foulPropensity(def))) return;
    const foulerSlot = foulWeighted(def, "interiorD");
    foulerSlotFoul(def, foulerSlot.player, ctx);
    // Bonus FTs start on the 5th team foul of the quarter (NBA rule).
    if (def.teamFouls >= 5) {
      // Bonus: two shots for the best free-throw shooter on the floor.
      const eligible = off.onCourt.filter((s) => !s.out);
      const shooter = eligible[rng.weightedIndex(eligible.map((s) => Math.max(1, s.player.ratings.freeThrow - 35)))];
      if (!shooter) return;
      const line = lineOf(off, shooter.player);
      line.fta += 2;
      for (let i = 0; i < 2; i++) {
        if (rng.chance(clamp(shooter.player.ratings.freeThrow / 100, 0.45, 0.97))) {
          line.ftm++;
          line.pts++;
          off.score++;
        }
      }
    }
  };

  /** Simulate one period (quarter or OT). `late` = 4th quarter or OT (clutch window). */
  const playPeriod = (seconds: number, isOT: boolean, late: boolean): number => {
    // Period possession counts.
    const share = seconds / (48 * 60);
    let hPoss = Math.max(3, Math.round(pace48 * share + rng.float(-1.5, 1.5)));
    let aPoss = Math.max(3, Math.round(pace48 * share + rng.float(-1.5, 1.5)));
    if (isOT) {
      hPoss = Math.max(4, Math.round(10.4 + rng.float(-1.2, 1.2)));
      aPoss = Math.max(4, Math.round(10.4 + rng.float(-1.2, 1.2)));
    }
    H.teamFouls = 0;
    A.teamFouls = 0;
    H.possessionsLeft = hPoss;
    A.possessionsLeft = aPoss;
    const total = hPoss + aPoss;
    const dur = possessionSeconds(seconds, total);
    sub(H, false);
    sub(A, false);

    let alt = rng.chance(0.5); // opening tap
    let sinceSub = 0;
    while (H.possessionsLeft > 0 || A.possessionsLeft > 0) {
      // Alternate possessions; a team out of possessions passes.
      let offSide: SideState;
      if (H.possessionsLeft <= 0) offSide = A;
      else if (A.possessionsLeft <= 0) offSide = H;
      else {
        offSide = alt ? H : A;
        if (rng.chance(0.18)) offSide = offSide === H ? A : H; // live-ball noise
      }
      const defSide = offSide === H ? A : H;
      const margin = H.score - A.score;
      const toGo = H.possessionsLeft + A.possessionsLeft;
      const clutch = late && (isOT ? Math.abs(margin) <= (opts.playoff ? 10 : 7) : toGo <= 10 && Math.abs(margin) <= (opts.playoff ? 8 : 5));
      const garbage = late && !isOT && !clutch && Math.abs(margin) > 20 && toGo <= 30;
      const ctx = { clutch, garbage, period: isOT ? ("OT" as const) : ("REG" as const), homeIsOff: offSide === H };

      let extended = true;
      let guard = 0;
      while (extended && guard < 3) {
        extended = possession(offSide, defSide, ctx);
        guard++;
        if (extended && rng.chance(0.3)) extended = false; // many boards become putback looks
      }
      nonShootingFoulCheck(offSide, defSide, ctx);
      offSide.possessionsLeft--;
      burn(H, dur);
      burn(A, dur);
      alt = offSide === A; // next possession goes to the other team
      sinceSub++;
      if (sinceSub >= 6) {
        sinceSub = 0;
        sub(H, garbage);
        sub(A, garbage);
      }
    }
    // Dead-clock correction keeps player minutes conserved when short rosters
    // leave fewer than 5 bodies on the floor.
    const secsPlayed = total * dur;
    const scale = seconds / Math.max(1, secsPlayed);
    if (Math.abs(scale - 1) > 1e-9) {
      for (const s of [...H.slots, ...A.slots]) s.played *= scale;
    }
    return H.score - A.score;
  };

  for (let q = 0; q < 4; q++) playPeriod(QUARTER_SECONDS, false, q === 3);

  // Overtime: loop until a winner (ties are practically impossible; cap for safety).
  let ot = 0;
  while (H.score === A.score && ot < 8) {
    ot++;
    playPeriod(OT_SECONDS, true, true);
  }
  if (H.score === A.score) {
    // Deterministic decider (probability ≈ 0 to ever reach here).
    const hero = ballHandler(H, true, 0);
    lineOf(H, hero.player).fta++;
    if (rng.chance(hero.player.ratings.freeThrow / 100)) {
      lineOf(H, hero.player).ftm++;
      lineOf(H, hero.player).pts++;
      H.score++;
    }
  }

  // Convert burned seconds to box minutes; scale to exact 240 + 25/OT.
  const targetMin = MIN + ot * 25;
  for (const side of [H, A]) {
    const sidePlayed = side.slots.reduce((a, s) => a + s.played, 0);
    const f = (targetMin * 60) / Math.max(1, sidePlayed);
    for (const s of side.slots) {
      const l = lineOf(side, s.player);
      l.mp = Math.round(((s.played * f) / 60) * 10) / 10;
    }
  }

  const boxLines = [...H.lines.values(), ...A.lines.values()].filter((l) => l.mp > 0 || l.fga > 0 || l.fta > 0 || l.tov > 0);
  const homeLines = boxLines.filter((l) => l.teamId === home.id).sort((a, b) => b.mp - a.mp);
  const awayLines = boxLines.filter((l) => l.teamId === away.id).sort((a, b) => b.mp - a.mp);
  const sum = (arr: BoxPlayerLine[], k: keyof BoxPlayerLine) => arr.reduce((a, l) => a + (l[k] as number), 0);

  // ---- "Why" notes: translated basketball conclusions, not raw engine data.
  const notes: string[] = [];
  const top = (arr: BoxPlayerLine[]) => [...arr].sort((a, b) => b.pts - a.pts)[0];
  const topH = top(homeLines);
  const topA = top(awayLines);
  if (topH) notes.push(`${home.name} 得分最多：${topH.name} ${topH.pts} 分 ${topH.reb} 板 ${topH.ast} 助`);
  if (topA) notes.push(`${away.name} 得分最多：${topA.name} ${topA.pts} 分 ${topA.reb} 板 ${topA.ast} 助`);
  const efgH = efg(sum(homeLines, "fgm"), sum(homeLines, "tpm"), sum(homeLines, "fga"));
  const efgA = efg(sum(awayLines, "fgm"), sum(awayLines, "tpm"), sum(awayLines, "fga"));
  if (Math.abs(efgH - efgA) > 0.03) {
    notes.push(
      `决定性因素 — 有效命中率：${home.name} ${(efgH * 100).toFixed(1)}% vs ${away.name} ${(efgA * 100).toFixed(1)}%`,
    );
  }
  const tovH = sum(homeLines, "tov");
  const tovA = sum(awayLines, "tov");
  if (tovH <= tovA - 4) notes.push(`${home.name} 控制失误（${tovH} 次 vs ${tovA} 次），多出大量进攻机会`);
  else if (tovA <= tovH - 4) notes.push(`${away.name} 控制失误（${tovA} 次 vs ${tovH} 次），多出大量进攻机会`);
  const ftaH = sum(homeLines, "fta");
  const ftaA = sum(awayLines, "fta");
  if (ftaH >= ftaA + 8) notes.push(`${home.name} 冲击篮筐更凶，获得罚球优势（${ftaH} 罚 vs ${ftaA} 罚）`);
  else if (ftaA >= ftaH + 8) notes.push(`${away.name} 冲击篮筐更凶，获得罚球优势（${ftaA} 罚 vs ${ftaH} 罚）`);
  const benchPts = (lines: BoxPlayerLine[], side: SideState) =>
    lines
      .filter((l) => {
        const s = side.slots.find((x) => x.player.id === l.playerId);
        return s ? s.plan < 20 : false;
      })
      .reduce((a, l) => a + l.pts, 0);
  const bH = benchPts(homeLines, H);
  const bA = benchPts(awayLines, A);
  if (Math.abs(bH - bA) >= 12) notes.push(`替补火力差距明显：${home.name} ${bH} 分 vs ${away.name} ${bA} 分`);
  const margin = Math.abs(H.score - A.score);
  if (margin <= 3) notes.push(`比赛悬念保持到最后一刻${ot > 0 ? `（${ot} 个加时）` : ""}，关键回合由高使用率球员主导`);
  else if (margin > 25) notes.push(`分差过大进入垃圾时间，双方大量使用替补`);
  if (ot > 0) notes.push(`常规时间战平，比赛进入 ${ot} 个加时`);

  return {
    homeScore: H.score,
    awayScore: A.score,
    box: {
      home: homeLines,
      away: awayLines,
      homeTotals: { pts: H.score, reb: sum(homeLines, "reb"), ast: sum(homeLines, "ast") },
      awayTotals: { pts: A.score, reb: sum(awayLines, "reb"), ast: sum(awayLines, "ast") },
      notes,
    },
    notes,
    otPeriods: ot,
  };
}
