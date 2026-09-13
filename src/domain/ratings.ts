// Explainable 0-100 player ratings computed from observed statistics.
//
// RATING-ENGINE v1.0 — these are NOT official video-game ratings and not
// affiliated with any league. Every sub-rating is a deterministic transform of
// per-minute production and efficiency from a single stat line. `confidence`
// reflects sample size so users can see how much data backs a number.
//
// All formulas are intentionally simple, documented, and versioned: bump
// RATING_VERSION when changing them.

import { rngFor } from "./rng";
import type { SeasonStatLine, PlayerRatings, Position } from "./types";

export const RATING_VERSION = "RATING-ENGINE v1.0";

const clamp = (v: number, lo = 25, hi = 99) => Math.max(lo, Math.min(hi, v));

function safeDiv(a: number, b: number, fallback = 0): number {
  return b > 0 ? a / b : fallback;
}

function per36(value: number, mp: number): number {
  return mp > 0 ? (value / mp) * 36 : 0;
}

/**
 * Compute ratings from one stat line (usually the most recent season).
 *
 * Sub-rating mapping (all scaled so ~league-average demo production lands in
 * the 45-60 band, elite production in the 80s):
 *  - inside      : share of shots taken near the basket proxy = (FGA - 3PA) rate & FG%
 *  - finishing   : FG% overall + points per shot
 *  - shooting    : 3P% and 3PA volume
 *  - freeThrow   : FT%
 *  - playmaking  : AST per 36 + AST/TO ratio
 *  - rebounding  : REB per 36
 *  - perimeterD  : STL per 36
 *  - interiorD   : BLK per 36
 *  - overall     : position-weighted blend + usage/efficiency bump
 */
export function computeRatings(
  line: SeasonStatLine,
  position: Position,
  age: number,
  scouting?: { potential?: number | null; potentialLow?: number | null; potentialHigh?: number | null },
): PlayerRatings {
  const mp = Math.max(1, line.mp);
  const fga = line.fga;
  const fgm = line.fgm;
  const tpa = line.tpa;
  const tpm = line.tpm;
  const fta = line.fta;
  const ftm = line.ftm;

  const fgPct = safeDiv(fgm, fga, 0.44);
  const tpPct = safeDiv(tpm, tpa, 0.3);
  const ftPct = safeDiv(ftm, fta, 0.72);
  const tpRate = safeDiv(tpa, fga, 0.2); // share of attempts from three
  const twoRate = 1 - tpRate;
  const ptsPerShot = safeDiv(line.pts, fga + 0.44 * fta, 1.0);
  const ast36 = per36(line.ast, mp);
  const astTo = safeDiv(line.ast, line.tov, 1.5);
  const reb36 = per36(line.reb, mp);
  const stl36 = per36(line.stl, mp);
  const blk36 = per36(line.blk, mp);
  const ppg = safeDiv(line.pts, Math.max(1, line.g), 0);
  const mpg = safeDiv(mp, Math.max(1, line.g), 0);

  // Calibration: league-average production maps to ~55; elite to 85+.
  const inside = clamp(50 + (fgPct - 0.45) * 200 + (twoRate - 0.65) * 30);
  const finishing = clamp(55 + (fgPct - 0.45) * 300 + (ptsPerShot - 1.0) * 40);
  const shooting = clamp(55 + (tpPct - 0.35) * 280 + (tpRate - 0.35) * 40);
  const freeThrow = clamp(30 + (ftPct - 0.6) * 180);
  const playmaking = clamp(55 + (ast36 - 5) * 4 + (astTo - 2) * 6);
  const rebounding = clamp(55 + (reb36 - 9) * 4.5);
  const perimeterD = clamp(55 + (stl36 - 1.8) * 10);
  const interiorD = clamp(55 + (blk36 - 1.2) * 10);

  // Position weights for the overall blend.
  const weights: Record<Position, { fin: number; sho: number; ft: number; ins: number; play: number; reb: number; pD: number; iD: number }> = {
    PG: { ins: 0.08, fin: 0.14, sho: 0.16, ft: 0.06, play: 0.24, reb: 0.06, pD: 0.14, iD: 0.12 },
    SG: { ins: 0.1, fin: 0.18, sho: 0.2, ft: 0.06, play: 0.14, reb: 0.08, pD: 0.16, iD: 0.08 },
    SF: { ins: 0.12, fin: 0.18, sho: 0.16, ft: 0.06, play: 0.12, reb: 0.12, pD: 0.14, iD: 0.1 },
    PF: { ins: 0.16, fin: 0.14, sho: 0.1, ft: 0.06, play: 0.08, reb: 0.2, pD: 0.1, iD: 0.16 },
    C: { ins: 0.2, fin: 0.14, sho: 0.06, ft: 0.06, play: 0.06, reb: 0.24, pD: 0.08, iD: 0.16 },
  };
  const w = weights[position] ?? weights.SF;
  const blend =
    w.ins * inside +
    w.fin * finishing +
    w.sho * shooting +
    w.ft * freeThrow +
    w.play * playmaking +
    w.reb * rebounding +
    w.pD * perimeterD +
    w.iD * interiorD;

  // Load & production bump: heavy-usage efficient scorers rate higher.
  const usageBump = (mpg - 24) * 0.55 + (ppg - 12) * 0.9;
  // FGA per 36 minutes: star ~18, starter ~12, bench ~6 → tendency 0.30/0.20/0.10.
  const fgaPer36 = safeDiv(fga, mp, 0) * 36;
  const usageTendency = Math.max(0.05, Math.min(0.4, fgaPer36 / 60));

  const overall = clamp(blend + usageBump);

  // Age curve: scouting numbers are what the player is TODAY; overall reflects
  // today. Potential is stored separately and shown with its interval.
  const confidence = Math.min(1, mp / 1500);

  return {
    overall: Math.round(overall),
    inside: Math.round(inside),
    finishing: Math.round(finishing),
    shooting: Math.round(shooting),
    threePoint: Math.round(shooting),
    freeThrow: Math.round(freeThrow),
    playmaking: Math.round(playmaking),
    rebounding: Math.round(rebounding),
    perimeterD: Math.round(perimeterD),
    interiorD: Math.round(interiorD),
    usageTendency: Math.round(usageTendency * 100) / 100,
    potential: scouting?.potential ?? null,
    potentialLow: scouting?.potentialLow ?? null,
    potentialHigh: scouting?.potentialHigh ?? null,
    confidence: Math.round(confidence * 100) / 100,
    ratingVersion: RATING_VERSION,
  };
}


// ---------------------------------------------------------------------------
// v1.2: no observed statistics → deterministic market-value estimate.
// The salary is a live public fact (ESPN contract data): the market has
// already priced the player. This keeps rookies and quiet role players from
// sitting at a flat 50 while staying honest — confidence stays low and the
// ratingVersion marks these numbers as estimates.
// ---------------------------------------------------------------------------

export const RATING_VERSION_V13_EST = "RATING-ENGINE v1.3-EST";

/** Log-interpolated salary → overall curve (2026-27 market, millions/yr). */
const SALARY_CURVE: [number, number][] = [
  [1.2, 68],
  [2.5, 70],
  [5, 72],
  [9, 74],
  [14, 76.5],
  [20, 79],
  [28, 82],
  [38, 85.5],
  [50, 88],
  [62, 89],
];

function salaryToOverall(salaryM: number): number {
  const pts = SALARY_CURVE;
  if (salaryM <= pts[0][0]) return pts[0][1];
  if (salaryM >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (salaryM <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = (Math.log(salaryM) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
      return y0 + (y1 - y0) * t;
    }
  }
  return 55;
}

const ARCHETYPE_OFFSETS: Record<Position, { inside: number; finishing: number; threePoint: number; freeThrow: number; playmaking: number; rebounding: number; perimeterD: number; interiorD: number }> = {
  PG: { inside: -4, finishing: 0, threePoint: 1, freeThrow: 2, playmaking: 8, rebounding: -7, perimeterD: 0, interiorD: -5 },
  SG: { inside: -2, finishing: 1, threePoint: 4, freeThrow: 2, playmaking: 1, rebounding: -5, perimeterD: 1, interiorD: -5 },
  SF: { inside: 0, finishing: 0, threePoint: 1, freeThrow: 0, playmaking: -1, rebounding: -1, perimeterD: 1, interiorD: -2 },
  PF: { inside: 3, finishing: 0, threePoint: -3, freeThrow: -2, playmaking: -5, rebounding: 5, perimeterD: -2, interiorD: 4 },
  C: { inside: 6, finishing: 1, threePoint: -12, freeThrow: -5, playmaking: -8, rebounding: 9, perimeterD: -7, interiorD: 9 },
};

export function estimateRatingsFromSalary(
  salaryM: number | null,
  position: Position,
  age: number,
  playerId: string,
  scouting?: { potential?: number | null; potentialLow?: number | null; potentialHigh?: number | null },
): PlayerRatings {
  const rng = rngFor(playerId, "market-estimate");
  let overall = salaryM && salaryM > 0 ? salaryToOverall(salaryM) : 47;
  // Age shaping: young prospects get upside headroom, old deals discount.
  if (age <= 21) overall += 1;
  if (age >= 35) overall -= 2;
  overall = clamp(Math.round(overall));
  const arch = ARCHETYPE_OFFSETS[position] ?? ARCHETYPE_OFFSETS.SF;
  const jitter = () => rng.int(-2, 2);
  const sub = (off: number) => clamp(Math.round(overall + off + jitter()));
  const usageTendency = overall >= 82 ? 0.27 : overall >= 72 ? 0.21 : overall >= 62 ? 0.15 : 0.11;
  return {
    overall,
    inside: sub(arch.inside),
    finishing: sub(arch.finishing),
    threePoint: sub(arch.threePoint),
    shooting: sub(arch.threePoint),
    freeThrow: sub(arch.freeThrow),
    playmaking: sub(arch.playmaking),
    rebounding: sub(arch.rebounding),
    perimeterD: sub(arch.perimeterD),
    interiorD: sub(arch.interiorD),
    usageTendency,
    potential: scouting?.potential ?? null,
    potentialLow: scouting?.potentialLow ?? null,
    potentialHigh: scouting?.potentialHigh ?? null,
    confidence: 0.15,
    ratingVersion: RATING_VERSION_V13_EST,
  };
}


/**
 * Blend a stats-based rating with the market estimate. When the observed
 * sample is tiny (few minutes), the stat formula produces wild numbers
 * (e.g. a 2-mpg emergency call-up rates 25); the market has already priced
 * these players, so weight the estimate by (1 - confidence/0.6).
 * Mutates/returns an equal-shifted copy so sub-ratings stay consistent.
 */
export function blendWithMarketEstimate(
  r: PlayerRatings,
  salaryM: number | null,
  position: Position,
  age: number,
  playerId: string,
  sampleMpg = 99,
): PlayerRatings {
  if (!salaryM || salaryM <= 0) return r;
  const market = estimateRatingsFromSalary(salaryM, position, age, playerId);
  // Trust stats by on-court load: 20+ mpg = a real rotation slot, 5-8 mpg =
  // garbage-time samples the stat formula over-punishes.
  const trust = Math.max(0, Math.min(1, sampleMpg / 20));
  const blended = Math.round(r.overall * trust + market.overall * (1 - trust));
  const shift = blended - r.overall;
  if (shift === 0) return r;
  const shiftSub = (v: number) => clamp(v + shift);
  return {
    ...r,
    overall: clamp(blended),
    inside: shiftSub(r.inside),
    finishing: shiftSub(r.finishing),
    threePoint: shiftSub(r.threePoint),
    shooting: shiftSub(r.shooting),
    freeThrow: shiftSub(r.freeThrow),
    playmaking: shiftSub(r.playmaking),
    rebounding: shiftSub(r.rebounding),
    perimeterD: shiftSub(r.perimeterD),
    interiorD: shiftSub(r.interiorD),
  };
}

/** Human-readable explanation of how the overall was derived. */
export function ratingExplanation(r: PlayerRatings, line: SeasonStatLine | undefined): string[] {
  const notes: string[] = [];
  notes.push(`评分引擎 ${r.ratingVersion}，基于最近赛季观测统计计算，非任何官方评分。`);
  if (line) {
    const mpg = safeDiv(line.mp, Math.max(1, line.g), 0).toFixed(1);
    notes.push(`样本：${line.g} 场 / 场均 ${mpg} 分钟，置信度 ${(r.confidence * 100).toFixed(0)}%（出场时间越少，评分越不可靠）。`);
    const tpPct = safeDiv(line.tpm, line.tpa, 0).toFixed(3);
    const fgPct = safeDiv(line.fgm, line.fga, 0).toFixed(3);
    notes.push(`投射输入：FG% ${fgPct}、3P% ${tpPct}（3P出手占比 ${(safeDiv(line.tpa, line.fga, 0) * 100).toFixed(0)}%）、FT% ${safeDiv(line.ftm, line.fta, 0).toFixed(3)}。`);
    notes.push(`组织输入：场均助攻 ${safeDiv(line.ast, Math.max(1, line.g), 0).toFixed(1)}，助攻失误比 ${safeDiv(line.ast, line.tov, 0).toFixed(2)}。篮板输入：场均 ${safeDiv(line.reb, Math.max(1, line.g), 0).toFixed(1)}。`);
  }
  if (r.potential != null) {
    notes.push(`潜力为球探估计区间 [${r.potentialLow ?? "?"} – ${r.potentialHigh ?? "?"}]，非确定值。`);
  } else {
    notes.push("潜力数据缺失：该球员没有可用的球探报告。");
  }
  return notes;
}

// ---------------------------------------------------------------------------
// v1.1: ratings directly from real observed per-game season statistics.
// Used when the data source provides per-game lines (e.g. Wikipedia career
// tables) instead of full counting totals. Same blending philosophy as v1.0,
// recalibrated so real NBA production maps to real NBA quality tiers.
// ---------------------------------------------------------------------------

export interface PerGameSeasonLine {
  season: number;
  teamRow: string; // team label as printed in the source (may be "2TM")
  g: number;
  gs: number | null;
  mpg: number;
  fgPct: number | null; // 0-1
  tpPct: number | null; // 0-1
  ftPct: number | null; // 0-1
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  ppg: number;
}

export const RATING_VERSION_V13 = "RATING-ENGINE v1.3";

/**
 * Position-relative benchmarks (per-game, 2025-26 NBA levels). A center's 10
 * rebounds is routine; a guard's 10 rebounds is elite — sub-ratings are
 * measured against the position's own distribution, not league absolutes.
 * This is what keeps rim-running bigs (Walker Kessler) from out-rating
 * two-way stars purely on rebounds + FG%.
 */
const POS_BASE: Record<Position, { reb: number; rebSlope: number; blk: number; blkSlope: number; stl: number; stlSlope: number; fg: number; apg: number }> = {
  PG: { reb: 3.4, rebSlope: 5.5, blk: 0.3, blkSlope: 15, stl: 0.9, stlSlope: 11, fg: 0.455, apg: 4.2 },
  SG: { reb: 3.8, rebSlope: 5.0, blk: 0.35, blkSlope: 14, stl: 0.9, stlSlope: 11, fg: 0.455, apg: 2.6 },
  SF: { reb: 4.8, rebSlope: 4.4, blk: 0.5, blkSlope: 12, stl: 0.85, stlSlope: 11, fg: 0.47, apg: 2.5 },
  PF: { reb: 6.6, rebSlope: 3.8, blk: 0.75, blkSlope: 9.5, stl: 0.75, stlSlope: 12, fg: 0.50, apg: 2.2 },
  C: { reb: 8.4, rebSlope: 3.3, blk: 1.15, blkSlope: 8, stl: 0.6, stlSlope: 14, fg: 0.55, apg: 1.8 },
};

/**
 * v1.3 core: raw overall from observed stats. NOT directly shown —
 * computeRatingsFromPerGame rescales the output onto the league rating
 * distribution (see CALIBRATION_ANCHORS).
 */
export function computeRatingsFromPerGameRaw(
  line: PerGameSeasonLine,
  position: Position,
  age: number,
): { overall: number; inside: number; finishing: number; shooting: number; freeThrow: number; playmaking: number; rebounding: number; perimeterD: number; interiorD: number; usageTendency: number } {
  const fg = line.fgPct ?? 0.45;
  const tp = line.tpPct ?? 0.35;
  const ft = line.ftPct ?? 0.75;
  const base = POS_BASE[position] ?? POS_BASE.SF;

  const inside = clamp(50 + (fg - base.fg) * 170);
  const finishing = clamp(55 + (fg - base.fg) * 210 + (line.ppg / Math.max(1, line.mpg) - 0.55) * 18);
  const shooting = clamp(55 + (tp - 0.355) * 230);
  const freeThrow = clamp(30 + (ft - 0.6) * 180);
  const playmaking = clamp(55 + (line.apg - base.apg) * 5.2);
  const rebounding = clamp(55 + (line.rpg - base.reb) * base.rebSlope);
  const perimeterD = clamp(55 + (line.spg - base.stl) * base.stlSlope);
  const interiorD = clamp(55 + (line.bpg - base.blk) * base.blkSlope);

  const w = POSITION_WEIGHTS[position] ?? POSITION_WEIGHTS.SF;
  const blend =
    w.ins * inside +
    w.fin * finishing +
    w.sho * shooting +
    w.ft * freeThrow +
    w.play * playmaking +
    w.reb * rebounding +
    w.pD * perimeterD +
    w.iD * interiorD;
  // Scoring load: primary scorers rate higher, with diminishing returns so a
  // 22-ppg option on a good team lands closer to a 26-ppg option than the raw
  // volume gap suggests (matches how the real game rates roles).
  const load = line.ppg - 9;
  const bump = (load > 12 ? 12 + (load - 12) * 0.65 : load) * 1.25 + (line.mpg - 24) * 0.5;
  // 年龄微调：同样新秀赛季的产出，19 岁比 24 岁更被看好；34 岁老将的
  // 产出折扣一点（现实中 2K 评分也对年龄敏感）。
  const ageAdj = age <= 21 ? 1.5 : age <= 23 ? 0.5 : age >= 34 ? -1.5 : age >= 31 ? -0.5 : 0;
  const overall = clamp(blend + bump + ageAdj);

  const usageTendency = Math.max(0.06, Math.min(0.42, line.ppg / 30));
  return { overall, inside, finishing, shooting, freeThrow, playmaking, rebounding, perimeterD, interiorD, usageTendency };
}

/**
 * League-distribution calibration anchors [rawOverall, leagueOverall],
 * fitted (2026-09-13) against the real NBA 2K27 base ratings of 414 current
 * players (source: 2KDB.net 2K27 database, "27 NBA" base cards). The real
 * game rates the league on a 68-89 band with a ~74.5 average; our raw stat
 * formula spans 25-99, so this monotone piecewise-linear map translates raw
 * output onto that band while preserving ordering.
 */
export const CALIBRATION_ANCHORS: [number, number][] = [
  [25, 68],
  [28, 71],
  [31, 71],
  [34, 71],
  [37, 71.5],
  [40, 72],
  [43, 72.5],
  [46, 74],
  [49, 75],
  [52, 75],
  [55, 75],
  [58, 77.5],
  [61, 78],
  [64, 78],
  [67, 81],
  [70, 81],
  [73, 84],
  [76, 84.5],
  [79, 84.5],
  [82, 87],
  [85, 87],
  [88, 89],
  [91, 89],
  [97, 89],
];

function calibrateOverall(raw: number): number {
  const a = CALIBRATION_ANCHORS;
  if (raw <= a[0][0]) {
    // Below the anchor range: compress toward the 68 floor, never below.
    return Math.round(a[0][1] - Math.max(0, a[0][0] - raw) * 0.3);
  }
  for (let i = 1; i < a.length; i++) {
    if (raw <= a[i][0]) {
      const [x0, y0] = a[i - 1];
      const [x1, y1] = a[i];
      const t = (raw - x0) / (x1 - x0);
      return Math.round(y0 + (y1 - y0) * t);
    }
  }
  return Math.round(a[a.length - 1][1] + Math.min(4, (raw - a[a.length - 1][0]) * 0.25));
}

export function computeRatingsFromPerGame(
  line: PerGameSeasonLine,
  position: Position,
  age: number,
  scouting?: { potential?: number | null; potentialLow?: number | null; potentialHigh?: number | null },
): PlayerRatings {
  const raw = computeRatingsFromPerGameRaw(line, position, age);
  // Only the OVERALL is calibrated onto the league band (68-89, like the real
  // game). Sub-ratings keep their absolute scale — exactly how the real game
  // works: a 68-OVR bench player still has attributes spanning 25-97, and the
  // simulation engine's difference-based math (shooter vs defender) reads the
  // absolute attribute values.
  const calibrated = calibrateOverall(raw.overall);
  const confidence = Math.min(1, line.g / 40);

  const round = (v: number) => Math.round(v);
  return {
    overall: calibrated,
    inside: round(raw.inside),
    finishing: round(raw.finishing),
    shooting: round(raw.shooting),
    threePoint: round(raw.shooting),
    freeThrow: round(raw.freeThrow),
    playmaking: round(raw.playmaking),
    rebounding: round(raw.rebounding),
    perimeterD: round(raw.perimeterD),
    interiorD: round(raw.interiorD),
    usageTendency: Math.round(raw.usageTendency * 100) / 100,
    potential: scouting?.potential ?? null,
    potentialLow: scouting?.potentialLow ?? null,
    potentialHigh: scouting?.potentialHigh ?? null,
    confidence,
    ratingVersion: RATING_VERSION_V13,
  };
}

// v1.1 (uncalibrated) is kept exported for the calibration-fitting script.
export const RATING_VERSION_V11 = "RATING-ENGINE v1.1";

// Shared position weights (extracted from v1.0).
const POSITION_WEIGHTS: Record<Position, { fin: number; sho: number; ft: number; ins: number; play: number; reb: number; pD: number; iD: number }> = {
  PG: { ins: 0.08, fin: 0.14, sho: 0.16, ft: 0.06, play: 0.24, reb: 0.06, pD: 0.14, iD: 0.12 },
  SG: { ins: 0.1, fin: 0.18, sho: 0.2, ft: 0.06, play: 0.14, reb: 0.08, pD: 0.16, iD: 0.08 },
  SF: { ins: 0.12, fin: 0.18, sho: 0.16, ft: 0.06, play: 0.12, reb: 0.12, pD: 0.14, iD: 0.1 },
  PF: { ins: 0.16, fin: 0.14, sho: 0.1, ft: 0.06, play: 0.08, reb: 0.2, pD: 0.1, iD: 0.16 },
  C: { ins: 0.2, fin: 0.14, sho: 0.06, ft: 0.06, play: 0.06, reb: 0.24, pD: 0.08, iD: 0.16 },
};
