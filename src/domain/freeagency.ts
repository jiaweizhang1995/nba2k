// Free agency: offer evaluation, AI competition, signing rules. Deterministic.

import { rngFor } from "./rng";
import { CBA, capSnapshot, round2, maxContractValue } from "./salary";
import type { Contract } from "./types";
import type { TradeTeam } from "./trade";

export const FA_RULES_VERSION = `${CBA.version} / FA-RULES v1.0`;

export interface FaPlayer {
  id: string;
  name: string;
  position: string;
  age: number;
  ratings: { overall: number; potential: number | null };
  status: "FREE_AGENT";
  askingSalary: number; // per-year ask
  askingYears: number;
  contract: Contract;
}

export interface OfferInput {
  years: number;
  avgSalary: number;
}

export interface FaEvaluation {
  interest: number; // 0-100
  accept: boolean;
  reasons: string[];
}

/** Does the team have room or an exception to pay this? */
export function canAfford(team: TradeTeam, avgSalary: number, rosterAfter: number): { ok: boolean; reason: string } {
  const snap = capSnapshot(team.players.map((p) => ({ contract: p.contract })), rosterAfter);
  if (rosterAfter > CBA.maxRosterSize) return { ok: false, reason: `签约后人数超过上限 ${CBA.maxRosterSize}` };
  if (!snap.overCap) {
    if (avgSalary <= snap.capSpace) return { ok: true, reason: "使用薪资空间" };
    return { ok: false, reason: `薪资空间不足（剩余 ${snap.capSpace.toFixed(1)}M，报价 ${avgSalary.toFixed(1)}M）` };
  }
  if (snap.overSecondApron) return { ok: false, reason: "球队超过第二土豪线，只能签底薪" };
  const mle = snap.overFirstApron ? CBA.minimumSalary : 12.8;
  if (avgSalary <= CBA.minimumSalary + 0.01) return { ok: true, reason: "使用底薪特例" };
  if (avgSalary <= mle) return { ok: true, reason: `使用中产特例（上限 ${mle.toFixed(1)}M）` };
  return { ok: false, reason: "球队在工资帽以上且特例不足以匹配报价" };
}

/** Player's evaluation of an offer vs. asking price, role fit, and competition. */
export function evaluateOffer(
  player: FaPlayer,
  offer: OfferInput,
  team: TradeTeam,
  seed: number,
  salt: string,
  competitorInterest: number = 0,
): FaEvaluation {
  const rng = rngFor(seed, salt);
  const reasons: string[] = [];
  const { firstYear } = maxContractValue(player.age < 25 ? 0 : player.age < 33 ? 8 : 17, 1);
  const moneyRatio = offer.avgSalary / Math.max(0.5, player.askingSalary);
  let interest = 40 + moneyRatio * 35;
  if (offer.avgSalary >= firstYear * 0.95) interest += 10;
  reasons.push(`报价 ${offer.avgSalary.toFixed(1)}M/年 vs 要价 ${player.askingSalary.toFixed(1)}M/年`);

  // Fit: how much the team needs his position
  const posCount = team.players.filter((p) => p.position === player.position).length;
  const fit = Math.max(0, 18 - posCount * 6);
  interest += fit;
  reasons.push(`球队同位置人数 ${posCount}，角色契合度加成 +${fit}`);

  // Team quality: contenders pay less but attract
  const teamQuality = team.players.reduce((a, p) => a + p.ratings.overall, 0) / Math.max(1, team.players.length);
  interest += (teamQuality - 55) * 0.8;
  reasons.push(`球队实力评估 ${teamQuality.toFixed(0)} 分，影响加盟意愿`);

  interest -= competitorInterest * 0.4;
  if (competitorInterest > 0) reasons.push(`有其他球队竞争，抬高了签约门槛`);

  interest += rng.float(-6, 6);
  interest = Math.max(0, Math.min(100, interest));
  const accept = interest >= 62 && offer.years >= Math.min(player.askingYears, CBA.maxContractYears) * 0.6;
  return { interest: Math.round(interest), accept, reasons };
}

/** AI teams generate interest in a FA (used for competition simulation). */
export function aiCompetitionLevel(player: FaPlayer, seed: number, season: number): number {
  const rng = rngFor(seed, `fa-comp:${season}:${player.id}`);
  const base = (player.ratings.overall - 60) * 2.2;
  return Math.max(0, Math.min(100, base + rng.float(-10, 15)));
}

export function suggestedContract(player: FaPlayer, season: number): OfferInput {
  const ageFactor = player.age <= 27 ? 1.1 : player.age <= 31 ? 1.0 : 0.75;
  const maxYears = Math.min(CBA.maxContractYears, player.age >= 32 ? 3 : 4);
  void season;
  return {
    years: Math.max(1, Math.min(maxYears, player.askingYears)),
    avgSalary: round2(Math.max(CBA.minimumSalary, Math.min(player.askingSalary * ageFactor, CBA.salaryCap * 0.35))),
  };
}
