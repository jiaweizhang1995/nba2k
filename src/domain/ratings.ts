// Explainable 0-100 player ratings computed from observed statistics.
//
// RATING-ENGINE v1.0 — these are NOT official video-game ratings and not
// affiliated with any league. Every sub-rating is a deterministic transform of
// per-minute production and efficiency from a single stat line. `confidence`
// reflects sample size so users can see how much data backs a number.
//
// All formulas are intentionally simple, documented, and versioned: bump
// RATING_VERSION when changing them.

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

export const RATING_VERSION_V11 = "RATING-ENGINE v1.1";

export function computeRatingsFromPerGame(
  line: PerGameSeasonLine,
  position: Position,
  age: number,
  scouting?: { potential?: number | null; potentialLow?: number | null; potentialHigh?: number | null },
): PlayerRatings {
  const fg = line.fgPct ?? 0.45;
  const tp = line.tpPct ?? 0.35;
  const ft = line.ftPct ?? 0.75;
  const posBonusIns = position === "C" ? 12 : position === "PF" ? 7 : position === "SF" ? 2 : 0;
  const posBonusIntD = position === "C" ? 8 : position === "PF" ? 4 : 0;

  const inside = clamp(45 + (fg - 0.47) * 220 + posBonusIns);
  const finishing = clamp(55 + (fg - 0.47) * 300);
  const shooting = clamp(55 + (tp - 0.355) * 280);
  const freeThrow = clamp(30 + (ft - 0.6) * 180);
  const playmaking = clamp(55 + (line.apg - 3.2) * 5.5);
  const rebounding = clamp(55 + (line.rpg - 4.2) * 5.2);
  const perimeterD = clamp(55 + (line.spg - 0.9) * 14);
  const interiorD = clamp(55 + (line.bpg - 0.5) * 13 + posBonusIntD);

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
  // Scoring load + minutes bump: heavy, efficient scorers rate higher.
  const bump = (line.ppg - 9) * 1.15 + (line.mpg - 24) * 0.55;
  const overall = clamp(blend + bump);

  // Fallback usage from scoring load; importData refines it to the player's
  // share of team scoring after the roster is known.
  const usageTendency = Math.max(0.06, Math.min(0.42, line.ppg / 30));
  const confidence = Math.min(1, line.g / 40);

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
    ratingVersion: RATING_VERSION_V11,
  };
}

// Shared position weights (extracted from v1.0).
const POSITION_WEIGHTS: Record<Position, { fin: number; sho: number; ft: number; ins: number; play: number; reb: number; pD: number; iD: number }> = {
  PG: { ins: 0.08, fin: 0.14, sho: 0.16, ft: 0.06, play: 0.24, reb: 0.06, pD: 0.14, iD: 0.12 },
  SG: { ins: 0.1, fin: 0.18, sho: 0.2, ft: 0.06, play: 0.14, reb: 0.08, pD: 0.16, iD: 0.08 },
  SF: { ins: 0.12, fin: 0.18, sho: 0.16, ft: 0.06, play: 0.12, reb: 0.12, pD: 0.14, iD: 0.1 },
  PF: { ins: 0.16, fin: 0.14, sho: 0.1, ft: 0.06, play: 0.08, reb: 0.2, pD: 0.1, iD: 0.16 },
  C: { ins: 0.2, fin: 0.14, sho: 0.06, ft: 0.06, play: 0.06, reb: 0.24, pD: 0.08, iD: 0.16 },
};
