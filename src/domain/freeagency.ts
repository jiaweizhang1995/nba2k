// Free agency: offer evaluation, AI competition, signing rules. Deterministic.

import { rngFor } from "./rng";
import { CBA, capSnapshot, round2, maxContractValue, seasonMoney } from "./salary";
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

/** The same terms power the contract UI and the engine's acceptance rules. */
export function extensionTerms(player: { contract: Contract; yearsPro: number; age: number; ratings: { overall: number; potential: number | null } }, season: number) {
  const money = seasonMoney(season);
  const lastSalary = player.contract.years.at(-1)?.salary ?? 0;
  const asking = askingSalaryFor(player.contract, player.yearsPro, player.ratings.overall, player.age, season);
  const risingStar = player.age <= 25 && (player.ratings.potential ?? 0) > player.ratings.overall + 8;
  const floor = asking * (risingStar ? 1 : 0.95);
  const cap = Math.min(maxContractValue(player.yearsPro, 1, season).firstYear, Math.max(lastSalary, money.salaryCap / 15) * 1.4);
  return {
    asking, floor, risingStar,
    minimumSalary: money.minimumSalary,
    maxSalary: Math.floor((cap + 0.000001) * 100) / 100,
    suggestedSalary: Math.ceil(Math.max(floor, money.minimumSalary) * 100) / 100,
    maxYears: Math.min(CBA.maxContractYears, CBA.maxContractYears + 1 - player.contract.years.length),
  };
}

export interface OfferInput {
  years: number;
  avgSalary: number;
}

/**
 * A free agent's per-year asking price: ~5% raise on his previous salary,
 * capped by the CBA max-contract tier for his years of service. Without the
 * cap, 10-year vets on 50M+ deals would ask above the legal max.
 */
export function askingSalaryFor(contract: Contract, yearsPro: number, overall = 70, age = 27, season?: number): number {
  // Anchor on the salary he JUST earned (last year entry), not the first —
  // escalating deals make the gap real over a 5-year eval. Empty contract
  // (expired deal already stripped) → no anchor at all: rating sets the ask.
  const prev = contract.years[contract.years.length - 1]?.salary ?? 0;
  const maxFirst = maxContractValue(yearsPro, 1, season ?? contract.years[0]?.season ?? 2027).firstYear;
  // Market value is set by talent, not by what the last contract happened to
  // pay — an 85-overall player coming off a rookie deal does not ask 5.5M.
  const ratingPct = overall >= 90 ? 1 : overall >= 87 ? 0.85 : overall >= 84 ? 0.65 : overall >= 81 ? 0.45 : overall >= 78 ? 0.28 : overall >= 75 ? 0.16 : overall >= 72 ? 0.08 : 0;
  const ratingAsk = round2(ratingPct * maxFirst);
  // Prior salary anchors the ask, but the anchor weakens with age — a 34yo
  // ex-max player knows the market has corrected.
  const anchor = round2(prev * (age >= 33 ? 0.5 : age >= 30 ? 0.7 : 0.9));
  const floor = seasonMoney(season ?? contract.years[0]?.season ?? 2027).minimumSalary;
  return round2(Math.max(floor, Math.min(Math.max(ratingAsk, anchor), maxFirst)));
}

export interface FaEvaluation {
  interest: number; // 0-100
  accept: boolean;
  reasons: string[];
}

/** Does the team have room or an exception to pay this? `mleUsed` = the
 * team's one mid-level exception this offseason is already spent. */
export type SigningMechanism = "SPACE" | "MINIMUM" | "MLE" | "NONE";

/** A restricted free agent: coming off an expired rookie-scale deal — the
 * incumbent team holds matching rights (real RFA rules). */
export function isRestrictedFa(p: { contract: { type: string }; lastTeamId: string | null }): boolean {
  return p.contract.type === "ROOKIE" && !!p.lastTeamId;
}

export function canAfford(team: TradeTeam, avgSalary: number, rosterAfter: number, deadMoney = 0, mleUsed = false, season: number = 2027): { ok: boolean; reason: string; mechanism: SigningMechanism } {
  const m = seasonMoney(season);
  const snap = capSnapshot(team.players.map((p) => ({ contract: p.contract })), rosterAfter, deadMoney, season);
  if (rosterAfter > CBA.offseasonRosterMax) return { ok: false, reason: `签约后人数超过休赛期上限 ${CBA.offseasonRosterMax}`, mechanism: "NONE" };
  if (!snap.overCap) {
    if (avgSalary <= snap.capSpace) return { ok: true, reason: "使用薪资空间", mechanism: "SPACE" };
    return { ok: false, reason: `薪资空间不足（剩余 ${snap.capSpace.toFixed(1)}M，报价 ${avgSalary.toFixed(1)}M）`, mechanism: "NONE" };
  }
  // 底薪特例先于土豪线拦截：二奢球队唯一能用的签约工具就是底薪，
  // 若先判 overSecondApron 连底薪都会被拒（与提示文案矛盾）。
  if (avgSalary <= m.minimumSalary + 0.01) return { ok: true, reason: "使用底薪特例", mechanism: "MINIMUM" };
  if (snap.overSecondApron) return { ok: false, reason: "球队超过第二土豪线，只能签底薪", mechanism: "NONE" };
  if (snap.overFirstApron) return { ok: false, reason: "球队超过第一土豪线，只能签底薪", mechanism: "NONE" };
  if (mleUsed) return { ok: false, reason: "本赛季中产特例已使用，只剩底薪可用", mechanism: "NONE" };
  if (avgSalary <= m.midLevelException) return { ok: true, reason: `使用中产特例（上限 ${m.midLevelException.toFixed(2)}M）`, mechanism: "MLE" };
  return { ok: false, reason: "球队在工资帽以上且特例不足以匹配报价", mechanism: "NONE" };
}

/** Player's evaluation of an offer vs. asking price, role fit, and competition. */
export function evaluateOffer(
  player: FaPlayer,
  offer: OfferInput,
  team: TradeTeam,
  seed: number,
  salt: string,
  competitorInterest: number = 0,
  season: number = 2027,
  incumbent: boolean = false,
): FaEvaluation {
  const rng = rngFor(seed, salt);
  const reasons: string[] = [];
  const { firstYear } = maxContractValue(player.age < 25 ? 0 : player.age < 33 ? 8 : 17, 1, season);
  const moneyRatio = offer.avgSalary / Math.max(0.5, player.askingSalary);

  // 金钱是第一道门：市场定价不是装饰品。低于要价 ~12% 以上，球员几乎
  // 一定拒绝——除非市场冷清（没有竞争者时他才会打折）。这堵死了"球星
  // 稳定七五折签约"的漏洞：有市场的球员总能拿到接近要价。
  const coldMarket = competitorInterest < 25;
  const isMinimumOffer = offer.avgSalary <= seasonMoney(season).minimumSalary + 0.05;
  // 冷市场底薪豁免：没人要的球员最后会接受一年底薪留在联盟——底薪报价
  // 不走折价拒绝线，但要球员实际接受仍然需要意愿分够。
  const minimumFallback = coldMarket && isMinimumOffer && offer.years >= 1;
  const moneyFloor = coldMarket ? 0.75 : 0.88;
  if (moneyRatio < moneyFloor && !minimumFallback) {
    reasons.push(
      `报价 ${offer.avgSalary.toFixed(1)}M/年 远低于要价 ${player.askingSalary.toFixed(1)}M/年（底线 ${(moneyFloor * 100).toFixed(0)}%），被直接拒绝`,
    );
    return { interest: 10, accept: false, reasons };
  }

  let interest = 12 + moneyRatio * 55;
  if (moneyRatio >= 1.0) interest += 12;
  else if (moneyRatio >= 0.95) interest += 6;
  if (offer.avgSalary >= firstYear * 0.95) interest += 8;
  reasons.push(`报价 ${offer.avgSalary.toFixed(1)}M/年 vs 要价 ${player.askingSalary.toFixed(1)}M/年`);

  // Fit: how much the team needs his position
  const posCount = team.players.filter((p) => p.position === player.position).length;
  const fit = Math.max(0, 14 - posCount * 5);
  interest += fit;
  reasons.push(`球队同位置人数 ${posCount}，角色契合度加成 +${fit}`);

  // Team quality: contenders pay less but attract
  const teamQuality = team.players.reduce((a, p) => a + p.ratings.overall, 0) / Math.max(1, team.players.length);
  interest += (teamQuality - 74) * 1.4;
  reasons.push(`球队实力评估 ${teamQuality.toFixed(0)} 分，影响加盟意愿`);

  interest -= competitorInterest * 0.35;
  if (competitorInterest > 0) reasons.push(`有其他球队竞争，抬高了签约门槛`);

  // Incumbents win ties: a bird-rights re-sign carries a loyalty discount —
  // without it a max-salary superstar asking at the cap ceiling would be
  // mathematically unsignable (no room to outbid competition above the max).
  if (incumbent) {
    interest += 10;
    reasons.push(`母队忠诚加成 +10`);
  }

  if (minimumFallback) {
    // 底薪兜底：愿意留队的球员在无人问津时接受一年底薪，而不是退役消失。
    interest += 25;
    reasons.push(`市场冷清，底薪合同仍可谈（+25 意愿）`);
  }

  interest += rng.float(-5, 5);
  interest = Math.max(0, Math.min(100, interest));
  const yearsOk = minimumFallback ? offer.years >= 1 : offer.years >= Math.min(player.askingYears, CBA.maxContractYears) * 0.6;
  const accept = interest >= 62 && yearsOk;
  return { interest: Math.round(interest), accept, reasons };
}

/** AI teams generate interest in a FA (used for competition simulation). */
export function aiCompetitionLevel(player: FaPlayer, seed: number, season: number): number {
  const rng = rngFor(seed, `fa-comp:${season}:${player.id}`);
  const base = (player.ratings.overall - 74) * 4.6;
  return Math.max(0, Math.min(100, base + rng.float(-10, 15)));
}

export function suggestedContract(player: FaPlayer, season: number): OfferInput {
  const m = seasonMoney(season);
  const ageFactor = player.age <= 27 ? 1.1 : player.age <= 31 ? 1.0 : 0.75;
  const maxYears = Math.min(CBA.maxContractYears, player.age >= 32 ? 3 : 4);
  return {
    years: Math.max(1, Math.min(maxYears, player.askingYears)),
    avgSalary: round2(Math.max(m.minimumSalary, Math.min(player.askingSalary * ageFactor, m.salaryCap * 0.35))),
  };
}
