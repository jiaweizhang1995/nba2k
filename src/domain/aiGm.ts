// AI GM brain: team phase classification, risk profiles, roster management
// decisions in offseason (re-signings, AI signings). Rule-based only.

import type { TeamPhase } from "./types";

export interface AiGmProfile {
  phase: TeamPhase;
  risk: number; // 0-1: higher = more willing to gamble on upside
  description: string;
}

export function classifyTeamPhase(avgOverall: number, avgAge: number, wins: number, gamesPlayed: number, picksOwned: number): AiGmProfile {
  const winPct = gamesPlayed > 0 ? wins / gamesPlayed : 0.5;
  if (winPct >= 0.62 && avgOverall >= 66) {
    return { phase: "CONTENDER", risk: 0.35, description: "争冠期：赢在当下，愿意为即战力付出代价" };
  }
  if (winPct >= 0.52) {
    return { phase: "PLAYOFF", risk: 0.5, description: "季后赛球队：平衡现在与未来" };
  }
  // A young team winning <41% is tanking, not "on the bubble" — youth is a
  // reason to keep rebuilding, not evidence of competitiveness.
  if (winPct >= 0.41) {
    return { phase: "BUBBLE", risk: 0.6, description: "附加赛边缘：寻找突破口，适度冒险" };
  }
  const pickHoarder = picksOwned >= 4;
  return {
    phase: "REBUILD",
    risk: pickHoarder ? 0.7 : 0.55,
    description: pickHoarder ? "重建期：囤积选秀权，出售老将" : "重建期：清理薪资，换取未来资产",
  };
}

/** Role assignment by overall ranking within roster. */
export function assignRoles(sortedOverall: { id: string; overall: number }[]): Record<string, string> {
  const out: Record<string, string> = {};
  sortedOverall.forEach((p, i) => {
    if (i === 0 && p.overall >= 86) out[p.id] = "STAR";
    else if (i === 1 && p.overall >= 84) out[p.id] = "STAR";
    else if (i < 5) out[p.id] = "STARTER";
    else if (i === 5 && p.overall >= 79) out[p.id] = "SIXTH_MAN";
    else if (i < 10) out[p.id] = "ROTATION";
    else out[p.id] = "BENCH";
  });
  return out;
}
