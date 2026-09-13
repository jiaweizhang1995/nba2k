// Chemistry engine — explains WHY a roster performs the way it does.
// Deterministic, purely derived from roster structure. No randomness.

import type { PlayerRatings, Position, PlayerRole, ChemistryResult, ChemistryFactor } from "./types";

export interface ChemPlayer {
  id: string;
  position: Position;
  ratings: PlayerRatings;
  role: PlayerRole;
  age: number;
  tenure: number;
  satisfaction: number;
  contractEnd: number;
}

interface TeamContext {
  season: number;
  gamesPlayed: number;
  lastSeasonWins: number | null; // continuity proxy
}

export const CHEMISTRY_VERSION = "CHEMISTRY v1.1";

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/**
 * Chemistry factors (all 0-100):
 *  - spacing:    floor shooting of the top-9 rotation
 *  - playmaking: creator load balance — one elite creator is fine, three is a conflict
 *  - usage:      total usage demand of top players vs. what a 48-min game can serve
 *  - hierarchy:  clear star vs. two similar stars without role acceptance
 *  - depth:      quality of slots 6-10
 *  - continuity: tenure together (tenure years capped) + same-GM stability
 *  - mood:       average satisfaction, weighted by role importance
 */
export function computeChemistry(players: ChemPlayer[], ctx: TeamContext): ChemistryResult {
  void ctx;
  const factors: ChemistryFactor[] = [];
  if (players.length === 0) {
    return { overall: 0, factors: [{ key: "roster", label: "阵容", score: 0, note: "阵容为空" }] };
  }

  const rotation = [...players]
    .sort((a, b) => b.ratings.overall - a.ratings.overall)
    .slice(0, 9);

  // 1) spacing: three-point rating of rotation, best 5 averaged
  const shooting = rotation.map((p) => p.ratings.threePoint).sort((a, b) => b - a);
  const spacing = avg(shooting.slice(0, 5)) * 0.8 + avg(shooting) * 0.2;
  factors.push({
    key: "spacing",
    label: "投射空间",
    score: Math.round(spacing),
    note:
      spacing < 50
        ? "轮换缺少可靠投手，突破空间会被压缩"
        : spacing > 72
          ? "多准则投手让突破手有充足空间"
          : "投射空间处于联盟平均水平",
  });

  // 2) playmaking: creators = playmaking >= 70; conflict if >3
  const creators = rotation.filter((p) => p.ratings.playmaking >= 70).length;
  const creatorLoad = rotation.map((p) => Math.max(0, p.ratings.playmaking - 55)).reduce((a, b) => a + b, 0);
  const playmaking = Math.min(100, 55 + creatorLoad * 0.5) - (creators > 3 ? (creators - 3) * 12 : 0);
  factors.push({
    key: "playmaking",
    label: "组织负荷",
    score: Math.round(Math.max(10, playmaking)),
    note:
      creators > 3
        ? `轮换中有 ${creators} 名高组织球员，球权分配存在冲突`
        : creators === 0
          ? "没有可靠的进攻发起者，进攻会陷入单打"
          : "组织职责清晰",
  });

  // 3) usage conflict (v1.1): usageTendency is the player's share of team
  // scoring. Realistic top-5 shares land ~0.70-0.82; above ~0.82 the ball
  // simply cannot be shared (a real "too many cooks" roster).
  const usageSum = rotation.slice(0, 5).reduce((a, p) => a + p.ratings.usageTendency, 0);
  const usageScore = Math.max(20, Math.min(100, 100 - Math.max(0, usageSum - 0.82) * 220 - Math.max(0, 0.5 - usageSum) * 80));
  factors.push({
    key: "usage",
    label: "球权冲突",
    score: Math.round(usageScore),
    note:
      usageSum > 0.88
        ? `前五人合计占球队得分 ${(usageSum * 100).toFixed(0)}%，球权分配明显拥挤`
        : usageSum < 0.55
          ? "缺少足够的得分点，进攻过度依赖效率"
          : "得分责任分布合理",
  });

  // 4) hierarchy: gap between #1 and #2 overall
  const o1 = rotation[0].ratings.overall;
  const o2 = rotation[1]?.ratings.overall ?? 40;
  const starCount = rotation.filter((p) => p.role === "STAR").length;
  const hierarchy = starCount >= 3 ? 62 - (starCount - 3) * 15 : o1 - o2 >= 4 ? 88 : o1 - o2 <= 1 && o1 >= 87 ? 66 : 78;
  factors.push({
    key: "hierarchy",
    label: "球星层级",
    score: Math.round(hierarchy),
    note:
      starCount >= 3
        ? `${starCount} 名球员要求 STAR 角色，角色定位重叠`
        : o1 - o2 <= 1 && o1 >= 87
          ? "两名实力接近的球星需要明确谁做第一选择"
          : "进攻层级清晰",
  });

  // 5) depth: slots 6-9 quality
  const bench = rotation.slice(4, 9).map((p) => p.ratings.overall);
  const depth = avg(bench) + 6;
  factors.push({
    key: "depth",
    label: "替补深度",
    score: Math.round(Math.min(100, depth)),
    note: depth < 76 ? "替补质量薄弱，主力疲劳风险高" : depth > 84 ? "替补席能维持阵容强度" : "替补深度合格",
  });

  // 6) continuity: avg tenure, penalized if roster just churned
  const tenure = avg(players.map((p) => Math.min(4, p.tenure)));
  const continuity = Math.min(100, 48 + tenure * 11);
  factors.push({
    key: "continuity",
    label: "阵容连续性",
    score: Math.round(continuity),
    note: tenure < 1 ? "阵容刚刚大改，磨合需要时间" : tenure > 2.5 ? "核心班底磨合成熟" : "阵容连续性一般",
  });

  // 7) mood: satisfaction weighted — stars & starters weigh double
  const weightOf = (r: PlayerRole) => (r === "STAR" || r === "STARTER" ? 2 : 1);
  const mood =
    players.reduce((a, p) => a + p.satisfaction * weightOf(p.role), 0) /
    players.reduce((a, p) => a + weightOf(p.role), 0);
  factors.push({
    key: "mood",
    label: "球员满意度",
    score: Math.round(mood),
    note: mood < 55 ? "多名球员对角色或出场时间不满" : mood > 75 ? "更衣室氛围良好" : "更衣室状态平稳",
  });

  const w: Record<string, number> = {
    spacing: 0.14,
    playmaking: 0.14,
    usage: 0.18,
    hierarchy: 0.16,
    depth: 0.12,
    continuity: 0.12,
    mood: 0.14,
  };
  const overall = Math.round(factors.reduce((a, f) => a + f.score * (w[f.key] ?? 0), 0));
  return { overall: Math.max(0, Math.min(100, overall)), factors };
}

/**
 * Explain how a trade changes chemistry. Returns deltas with reasons — used
 * both in the trade center preview and post-trade news.
 */
export function chemistryDiff(
  before: ChemistryResult,
  after: ChemistryResult,
): { factor: string; label: string; delta: number; note: string }[] {
  return after.factors.map((f) => {
    const b = before.factors.find((x) => x.key === f.key);
    const delta = f.score - (b?.score ?? f.score);
    return { factor: f.key, label: f.label, delta, note: f.note };
  });
}
