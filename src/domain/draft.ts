// Draft engine: scouting reports, lottery, draft flow. Deterministic.

import { rngFor } from "./rng";
import { rookieScaleSalary, CBA, round2 } from "./salary";
import type { ScoutingReport } from "./types";

export const DRAFT_RULES_VERSION = `${CBA.version} / DRAFT-RULES v1.0`;

export interface DraftProspect {
  id: string;
  name: string;
  position: string;
  age: number;
  heightCm: number;
  weightKg: number;
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
    usageTendency: number;
    potential: number | null;
    potentialLow: number | null;
    potentialHigh: number | null;
    confidence: number;
  };
  scouting: ScoutingReport;
  draftYear: number;
}

export interface DraftOrderSlot {
  pickNumber: number;
  round: number;
  holderTeamId: string;
  originalTeamId: string;
  lotteryOddsPct: number | null; // for round-1 lottery slots
}

const STRENGTH_POOL: Record<string, string[]> = {
  high3: ["稳定的外线投射", "接球投能力出色", "出手速度快"],
  highPlay: ["视野开阔", "挡拆决策成熟", "控场节奏好"],
  highFin: ["篮下终结手感柔和", "攻框冲击力强", "转换进攻威胁大"],
  highReb: ["篮板嗅觉敏锐", "卡位扎实", "二次进攻积极"],
  highDef: ["横移出色", "护筐威慑力大", "防守判断准确"],
  low3: ["外线投射仍需打磨", "三分稳定性不足"],
  lowPlay: ["组织能力有限", "决策偶尔犹豫"],
  lowDef: ["防守端容易失位", "对抗后防守下滑"],
  young: ["身体条件出色", "上限取决于技能打磨"],
};

const COMPARISONS = ["技术型前锋", "传统护筐中锋", "双能卫", "3D侧翼", "组织前锋", "得分第一后卫", "蓝领内线"];

/** Deterministic scouting report from ratings + seed. */
export function generateScoutingReport(prospectId: string, seed: number): ScoutingReport {
  const rng = rngFor(seed, `scout:${prospectId}`);
  const r = prospectRatingsCache.get(prospectId);
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  if (r) {
    if (r.threePoint >= 65) strengths.push(...rng.shuffle(STRENGTH_POOL.high3).slice(0, 2));
    if (r.playmaking >= 65) strengths.push(...rng.shuffle(STRENGTH_POOL.highPlay).slice(0, 2));
    if (r.finishing >= 65) strengths.push(...rng.shuffle(STRENGTH_POOL.highFin).slice(0, 1));
    if (r.rebounding >= 65) strengths.push(...rng.shuffle(STRENGTH_POOL.highReb).slice(0, 1));
    if (r.perimeterD >= 65 || r.interiorD >= 65) strengths.push(...rng.shuffle(STRENGTH_POOL.highDef).slice(0, 1));
    if (r.threePoint < 50) weaknesses.push(...rng.shuffle(STRENGTH_POOL.low3).slice(0, 1));
    if (r.playmaking < 50) weaknesses.push(...rng.shuffle(STRENGTH_POOL.lowPlay).slice(0, 1));
    if (r.perimeterD < 50 && r.interiorD < 50) weaknesses.push(...rng.shuffle(STRENGTH_POOL.lowDef).slice(0, 1));
  }
  if (strengths.length === 0) strengths.push(...rng.shuffle(STRENGTH_POOL.young).slice(0, 2));
  return {
    strengths,
    weaknesses,
    comparison: rng.pick(COMPARISONS),
    floor: r?.potentialLow ?? 40,
    ceiling: r?.potentialHigh ?? 75,
    note: `球探报告基于试训与比赛观察生成，floor/ceiling 为估计区间，不是确定值。`,
  };
}

// Simple registry so generateScoutingReport can inspect ratings; set by caller.
const prospectRatingsCache = new Map<string, DraftProspect["ratings"]>();
export function registerProspectRatings(id: string, ratings: DraftProspect["ratings"]) {
  prospectRatingsCache.set(id, ratings);
}
export function clearProspectCache() {
  prospectRatingsCache.clear();
}

/** Lottery odds for the top picks (reverse-standings weighted, top 4 flattened). */
export function lotteryOdds(worstToBest: string[]): { teamId: string; oddsPct: number }[] {
  // Fictional league lottery: combinatorial weights, flattened top-4 like real lotteries.
  const combos = [140, 140, 140, 125, 105, 80, 60, 45, 30, 20, 15, 10, 7, 3];
  const total = combos.reduce((a, b) => a + b, 0);
  return worstToBest.slice(0, 14).map((teamId, i) => ({ teamId, oddsPct: Math.round((combos[i] / total) * 1000) / 10 }));
}

/** Run the lottery: returns ordered teamIds for picks 1..14. */
export function runLottery(seed: number, season: number, worstToBest: string[]): string[] {
  const rng = rngFor(seed, `lottery:${season}`);
  const odds = lotteryOdds(worstToBest);
  const pool: { teamId: string; weight: number }[] = odds.map((o) => ({ teamId: o.teamId, weight: 1 }));
  // Weighted sampling without replacement, 4 flattened "jackpot" draws.
  const result: string[] = [];
  const remaining = [...odds.map((o) => o.teamId)];
  const weights = [...odds.map((o) => Math.max(1, o.oddsPct))];
  for (let i = 0; i < Math.min(14, remaining.length); i++) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    result.push(remaining[idx]);
    remaining.splice(idx, 1);
    weights.splice(idx, 1);
  }
  // Any remaining non-lottery teams appended in worst-to-best order.
  for (const t of worstToBest) if (!result.includes(t)) result.push(t);
  // Teams outside top-14 (playoff teams) appended by reverse record.
  for (const t of worstToBest.slice(14)) if (!result.includes(t)) result.push(t);
  void pool;
  return result;
}

/** AI drafts the best fit available for a team (needs: position depth + best player). */
export function aiDraftPick(
  available: DraftProspect[],
  teamRosterPositions: string[],
  seed: number,
  salt: string,
): DraftProspect | null {
  if (available.length === 0) return null;
  const rng = rngFor(seed, salt);
  const posCount = new Map<string, number>();
  for (const pos of teamRosterPositions) posCount.set(pos, (posCount.get(pos) ?? 0) + 1);
  const scored = available.map((p) => {
    const need = 1 / (1 + (posCount.get(p.position) ?? 0) * 0.35);
    const upside = (p.ratings.potentialHigh ?? p.ratings.overall) * 0.35 + p.ratings.overall * 0.65;
    return { p, score: upside * need + rng.float(-4, 4) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].p;
}

export function prospectRookieContract(pickNumber: number, round: number, season: number) {
  const first = rookieScaleSalary(pickNumber, round);
  const years = round === 1 ? [season, season + 1, season + 2, season + 3].map((s, i) => ({ season: s, salary: round2(first * (1 - i * 0.05)) })) : [season, season + 1].map((s) => ({ season: s, salary: CBA.rookieScale.round2Min }));
  const option = round === 1 ? ("TO" as const) : null;
  return { type: "ROOKIE" as const, years, birdRights: false, noTrade: false, option, signedSeason: season };
}
