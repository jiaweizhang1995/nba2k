// Draft engine: scouting reports, lottery, draft flow. Deterministic.

import { rngFor } from "./rng";
import { rookieScaleSalary, CBA, round2, seasonMoney } from "./salary";
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

/** Deterministic scouting report from ratings + seed.
 *
 * `ratings` is accepted explicitly because the module cache is an optimization,
 * not persisted save state. A freshly started process must show the same report
 * as the process that generated the draft class.
 */
export function generateScoutingReport(prospectId: string, seed: number, ratings?: DraftProspect["ratings"]): ScoutingReport {
  const rng = rngFor(seed, `scout:${prospectId}`);
  const r = ratings ?? prospectRatingsCache.get(prospectId);
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

/**
 * Run the lottery. `lotteryPool` is the non-playoff teams ordered worst→best
 * by record (up to 14); `playoffTeams` is the playoff field ordered
 * worst→best (they pick 15+). Only picks 1–4 are drawn — weighted sampling
 * without replacement — and the rest of the pool keeps its standings order
 * (picks 5–14), matching the real lottery's structure.
 * Returns the full round-1 order (lottery order + playoff teams by record).
 */
export function runLottery(seed: number, season: number, lotteryPool: string[], playoffTeams: string[] = []): string[] {
  const rng = rngFor(seed, `lottery:${season}`);
  const odds = lotteryOdds(lotteryPool);
  const remaining = odds.map((o) => o.teamId);
  const weights = odds.map((o) => Math.max(1, o.oddsPct));
  const drawn: string[] = [];
  for (let i = 0; i < Math.min(4, remaining.length); i++) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    drawn.push(remaining[idx]);
    remaining.splice(idx, 1);
    weights.splice(idx, 1);
  }
  // Picks 5–14: undrawn lottery teams keep their standings order.
  const round1 = [...drawn, ...remaining];
  // Any pool team past slot 14 (over-supplied pool) then playoff teams by record.
  for (const t of lotteryPool.slice(round1.length)) if (!round1.includes(t)) round1.push(t);
  for (const t of playoffTeams) if (!round1.includes(t)) round1.push(t);
  return round1;
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
  const first = rookieScaleSalary(pickNumber, round, season);
  const r2 = round2(CBA.rookieScale.round2Min * (seasonMoney(season).salaryCap / CBA.salaryCap));
  // Rookie scale ASCENDS year over year — the old code decayed 5%/yr, which
  // made rookie deals cheaper at the end instead of pricier.
  const years = round === 1 ? [season, season + 1, season + 2, season + 3].map((s, i) => ({ season: s, salary: round2(first * (1 + i * 0.05)) })) : [season, season + 1].map((s) => ({ season: s, salary: r2 }));
  const option = round === 1 ? ("TO" as const) : null;
  return { type: "ROOKIE" as const, years, birdRights: false, noTrade: false, option, signedSeason: season };
}

// ---------------------------------------------------------------------------
// Synthetic draft class generation
// ---------------------------------------------------------------------------
// Real-data saves ship without prospects, so the draft would be meaningless.
// We generate a deterministic class per season from (saveSeed, season).

const PROSPECT_FIRST = [
  "Jalen", "Marcus", "Trey", "DeShawn", "Malik", "Andre", "Kobe", "Tyrese", "Jaden", "Cameron",
  "Isaiah", "Devin", "Zion", "Caleb", "Micah", "Darius", "Jaylen", "Terrence", "Xavier", "Brice",
  "Nikola", "Luka", "Paolo", "Victor", "Alperen", "Deni", "Franz", "Moritz", "Jakob", "Domantas",
];
const PROSPECT_LAST = [
  "Carter", "Jennings", "Whitmore", "Boone", "Ellison", "Marsh", "Vance", "Okoye", "Petrov", "Soric",
  "Dubois", "Moreau", "Kowalski", "Lindqvist", "Fernandez", "Silva", "Adeyemi", "Tanaka", "Rossi", "Muller",
  "Hawkins", "Beasley", "Crawford", "Dorsey", "Emerson", "Faulkner", "Griggs", "Holloway", "Irwin", "Jeffers",
];
const CLASS_POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
const CLASS_HEIGHT: Record<(typeof CLASS_POSITIONS)[number], [number, number]> = { PG: [183, 196], SG: [191, 201], SF: [196, 208], PF: [203, 213], C: [208, 221] };
const CLASS_WEIGHT: Record<(typeof CLASS_POSITIONS)[number], [number, number]> = { PG: [79, 93], SG: [86, 100], SF: [93, 109], PF: [100, 118], C: [107, 125] };

export interface ProspectSeed {
  name: string;
  position: (typeof CLASS_POSITIONS)[number];
  secondPosition: (typeof CLASS_POSITIONS)[number] | null;
  age: number;
  heightCm: number;
  weightKg: number;
  draftYear: number;
  ratings: {
    overall: number;
    inside: number;
    finishing: number;
    shooting: number;
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
    ratingVersion: string;
  };
}

/**
 * Deterministic draft class for a season. Talent is top-heavy like a real
 * class: a few blue-chippers, a first-round tier, then long-tail depth.
 */
export function generateDraftClass(seed: number, season: number, count = 60): ProspectSeed[] {
  const rng = rngFor(seed, `draft-class:${season}`);
  const used = new Set<string>();
  const prospects: ProspectSeed[] = [];

  // Pre-roll class quality so a season can be strong or weak overall. Floor
  // is raised so even a "weak" class still has draftable talent — a real
  // class never has zero players worth a first-round pick.
  const classStrength = rng.float(0.9, 1.14);
  // ~18% of classes carry a generational talent — a consensus #1 whose
  // floor is already star-level. Real drafts have LeBron/Wemby years.
  const generationalIdx = rng.chance(0.18) ? rng.int(0, 2) : -1;

  for (let i = 0; i < count; i++) {
    let name = `${PROSPECT_FIRST[rng.int(0, PROSPECT_FIRST.length - 1)]} ${PROSPECT_LAST[rng.int(0, PROSPECT_LAST.length - 1)]}`;
    while (used.has(name)) name = `${PROSPECT_FIRST[rng.int(0, PROSPECT_FIRST.length - 1)]} ${PROSPECT_LAST[rng.int(0, PROSPECT_LAST.length - 1)]}`;
    used.add(name);

    const position = CLASS_POSITIONS[i % CLASS_POSITIONS.length];
    const tier = rng.next();
    let overall = Math.round(
      (tier < 0.08 ? rng.int(70, 76) : tier < 0.3 ? rng.int(64, 69) : tier < 0.65 ? rng.int(57, 63) : rng.int(50, 56)) * classStrength,
    );
    const age = i === generationalIdx ? rng.int(18, 19) : tier < 0.4 ? rng.int(19, 20) : rng.int(19, 22);
    if (i === generationalIdx) overall = rng.int(78, 83);
    const potential = Math.min(99, overall + rng.int(4, age <= 20 ? 20 : 12));
    const [h0, h1] = CLASS_HEIGHT[position];
    const [w0, w1] = CLASS_WEIGHT[position];
    const heightCm = rng.int(h0, h1);
    const weightKg = rng.int(w0, w1);

    const bias = (b: number) => Math.max(30, Math.min(95, overall + b + rng.int(-8, 8)));
    const isBig = position === "PF" || position === "C";
    const isGuard = position === "PG" || position === "SG";
    const ratings: ProspectSeed["ratings"] = {
      overall,
      inside: bias(isBig ? 8 : -6),
      finishing: bias(isGuard ? 4 : 0),
      shooting: bias(isGuard ? 6 : -4),
      threePoint: bias(position === "PG" ? 4 : position === "SG" ? 8 : isBig ? -10 : 0),
      freeThrow: bias(isGuard ? 8 : isBig ? -6 : 0),
      playmaking: bias(position === "PG" ? 12 : isBig ? -8 : 0),
      rebounding: bias(isBig ? 10 : -6),
      perimeterD: bias(isGuard ? 6 : -4),
      interiorD: bias(position === "C" ? 12 : position === "PF" ? 6 : -8),
      usageTendency: round2(rng.float(0.15, 0.45)),
      potential,
      potentialLow: i === generationalIdx ? overall - rng.int(2, 5) : Math.max(overall + 1, potential - rng.int(4, 12)),
      potentialHigh: Math.min(99, potential + rng.int(2, 8)),
      // Consensus visibility: blue-chippers are scouted hard (high confidence);
      // deep-draft prospects stay foggy — finding value late is the skill.
      confidence: round2(i === generationalIdx ? rng.float(0.6, 0.75) : tier < 0.08 ? rng.float(0.5, 0.7) : tier < 0.3 ? rng.float(0.32, 0.5) : rng.float(0.2, 0.4)),
      ratingVersion: "synthetic-class-v1",
    };

    const secondPosition = rng.next() < 0.3 ? CLASS_POSITIONS[rng.int(0, 4)] : null;
    prospects.push({ name, position, secondPosition, age, heightCm, weightKg, draftYear: season, ratings });
  }
  return prospects;
}
