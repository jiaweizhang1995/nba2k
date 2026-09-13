// Trade engine: asset valuation, league rule validation, and AI GM verdicts.
// Deterministic and pure. Rule params come from salary.ts (CBA v1.0).

import { CBA, capSnapshot, round2, salaryMatching, contractEndSeason, salaryForSeason } from "./salary";
import type { PlayerRatings, TradeParty, TradeProposal, TradeRuleIssue, TradeValidation, AiGmVerdict, TeamPhase, Contract } from "./types";

export const TRADE_RULES_VERSION = `${CBA.version} / TRADE-RULES v1.0`;

export interface TradePlayer {
  id: string;
  name: string;
  teamId: string | null;
  position: string;
  age: number;
  yearsPro: number;
  ratings: PlayerRatings;
  contract: Contract;
  status: string;
  role: string;
}

export interface TradePick {
  id: string;
  year: number;
  round: number;
  originalTeamId: string;
  holderTeamId: string;
  status: string;
  protection: { type: "LOTTERY_TOP_X" | "NONE"; x: number | null; yearShift: number } | null;
}

export interface TradeTeam {
  id: string;
  abbr: string;
  players: TradePlayer[];
  picks: TradePick[];
  aiPhase: TeamPhase;
  aiRisk: number;
}

export interface Valuation {
  kind: "PLAYER" | "PICK";
  id: string;
  name: string;
  value: number; // abstract trade value points
  breakdown: string[];
}

/** Age curve multiplier: value peaks ~25-27. */
export function ageMultiplier(age: number): number {
  if (age <= 21) return 1.08;
  if (age <= 24) return 1.12;
  if (age <= 27) return 1.05;
  if (age <= 30) return 0.92;
  if (age <= 33) return 0.72;
  return 0.5;
}

export function playerValue(p: TradePlayer, season: number): Valuation {
  const r = p.ratings;
  const base = Math.pow(Math.max(0, r.overall - 40), 1.55);
  let v = base * 0.9;
  if (r.potential != null && p.age <= 24) {
    v += Math.max(0, r.potential - r.overall) * 2.4; // upside premium
  }
  v *= ageMultiplier(p.age);

  // Contract value: cheap production is worth more; albatross discounts.
  const salary = salaryForSeason(p.contract, 0);
  const productionPerM = salary > 0 ? (r.overall - 45) / salary : 2;
  let contractNote = "";
  if (productionPerM < 0.15) {
    v *= 0.85;
    contractNote = `合同偏贵（${salary.toFixed(1)}M/赛季，评分 ${r.overall}）压低交易价值`;
  } else if (productionPerM > 0.8) {
    v *= 1.12;
    contractNote = `高性价比合同（${salary.toFixed(1)}M/赛季）提升交易价值`;
  }
  const yearsLeft = Math.max(0, contractEndSeason(p.contract) - season);
  if (yearsLeft === 0) {
    v *= 0.8;
    contractNote = "到期合同（价值打折但方便清空间）";
  }
  if (p.contract.noTrade) v *= 0.7;

  const breakdown = [
    `基础：评分 ${r.overall} → ${base.toFixed(1)} 点`,
    r.potential != null && p.age <= 24 ? `潜力加成：上限 ${r.potential} → +${(Math.max(0, r.potential - r.overall) * 2.4).toFixed(1)}` : null,
    `年龄系数 ×${ageMultiplier(p.age).toFixed(2)}（${p.age} 岁）`,
    contractNote || `合同 ${salary.toFixed(1)}M，剩余 ${yearsLeft} 年`,
    p.contract.noTrade ? "含不可交易条款" : null,
  ].filter(Boolean) as string[];

  return { kind: "PLAYER", id: p.id, name: p.name, value: round2(v), breakdown };
}

export function pickValue(pick: TradePick, season: number): Valuation {
  let v = pick.round === 1 ? 14 : 4;
  const breakdown = [`${pick.round === 1 ? "首轮" : "次轮"} ${pick.year} 年签基础 ${v} 点`];
  if (pick.year - season >= 4) {
    v *= 0.85;
    breakdown.push("远期签打折 ×0.85");
  }
  if (pick.protection && pick.protection.type === "LOTTERY_TOP_X" && pick.protection.x) {
    v *= 0.85;
    breakdown.push(`前 ${pick.protection.x} 保护 ×0.85`);
  }
  breakdown.push("选秀权价值由顺位区间、年份与保护条款决定");
  return { kind: "PICK", id: pick.id, name: `${pick.year} ${pick.round === 1 ? "首轮" : "次轮"}签`, value: round2(v), breakdown };
}

/**
 * Validate a trade against league rules. Supports 2-3 team trades.
 * Rules: roster size 13-15, salary matching bands, no-trade clauses,
 * Stepien rule (own future 1sts in consecutive years), single-appearance.
 */
export function validateTrade(proposal: TradeProposal, teams: TradeTeam[], season: number): TradeValidation {
  const issues: TradeRuleIssue[] = [];
  const salaryCheck: TradeValidation["salaryCheck"] = [];

  if (proposal.parties.length < 2) {
    issues.push({ code: "PARTIES", severity: "BLOCKER", message: "交易至少需要两支球队" });
  }

  // Global asset registry across all participating teams.
  const playerById = new Map<string, TradePlayer & { ownerTeamId: string }>();
  const pickById = new Map<string, TradePick & { ownerTeamId: string }>();
  for (const t of teams) {
    for (const p of t.players) playerById.set(p.id, { ...p, ownerTeamId: t.id });
    for (const pk of t.picks) pickById.set(pk.id, { ...pk, holderTeamId: t.id, ownerTeamId: t.id });
  }

  // Each asset may be GIVEN by exactly one party (an asset changing hands
  // appears once in `gives` and once in the receiver's `receives`).
  const givenBy = new Map<string, string>();
  for (const party of proposal.parties) {
    for (const asset of party.gives) {
      if (givenBy.has(asset.id)) {
        issues.push({ code: "DUP_ASSET", severity: "BLOCKER", message: `同一资产在交易中被送出两次` });
      }
      givenBy.set(asset.id, party.teamId);
    }
  }
  // Every `receives` entry must correspond to a give from another party.
  for (const party of proposal.parties) {
    for (const asset of party.receives) {
      const from = givenBy.get(asset.id);
      if (!from) {
        issues.push({ code: "ASSET_NOT_IN_TRADE", severity: "BLOCKER", message: `接收的资产没有被任何球队送出（凭空收资产）` });
      } else if (from === party.teamId && proposal.parties.length > 1 && party.gives.some((g) => g.id === asset.id)) {
        // giving to yourself — allowed (pick swap flavor), no issue
      }
    }
  }

  for (const party of proposal.parties) {
    const team = teams.find((t) => t.id === party.teamId);
    if (!team) {
      issues.push({ code: "NO_TEAM", severity: "BLOCKER", message: `球队不存在` });
      continue;
    }
    type RegPlayer = TradePlayer & { ownerTeamId: string };
    type RegPick = TradePick & { ownerTeamId: string };
    const givePlayers = party.gives.filter((a) => a.kind === "PLAYER").map((a) => playerById.get(a.id)).filter((p): p is RegPlayer => !!p);
    const recvPlayers = party.receives.filter((a) => a.kind === "PLAYER").map((a) => playerById.get(a.id)).filter((p): p is RegPlayer => !!p);
    const givePicks = party.gives.filter((a) => a.kind === "PICK").map((a) => pickById.get(a.id)).filter((p): p is RegPick => !!p);

    // Ownership check: you can only trade what you hold.
    for (const p of givePlayers) {
      if (!p || p.ownerTeamId !== party.teamId) issues.push({ code: "NOT_OWNED", severity: "BLOCKER", message: `${team.abbr} 送出的球员不在其阵容中` });
    }
    for (const p of recvPlayers) {
      if (p && p.teamId === null) {
        issues.push({ code: "FA_PLAYER", severity: "BLOCKER", message: `自由球员不能被交易` });
      }
    }
    for (const pk of givePicks) {
      if (!pk || pk.holderTeamId !== party.teamId) {
        issues.push({ code: "PICK_NOT_OWNED", severity: "BLOCKER", message: `${team.abbr} 送出的选秀权不归其持有` });
      }
    }

    // No-trade clauses
    for (const p of givePlayers) {
      if (p?.contract.noTrade) {
        issues.push({ code: "NO_TRADE_CLAUSE", severity: "BLOCKER", message: `${p.name} 合同含不可交易条款，球员可以否决交易` });
      }
    }

    // Roster size after trade
    const afterSize = team.players.length - givePlayers.length + recvPlayers.length;
    if (afterSize > CBA.maxRosterSize) {
      issues.push({ code: "ROSTER_MAX", severity: "BLOCKER", message: `${team.abbr} 交易后人数 ${afterSize} 超过上限 ${CBA.maxRosterSize}` });
    }
    if (afterSize < CBA.minRosterSize) {
      issues.push({ code: "ROSTER_MIN", severity: "BLOCKER", message: `${team.abbr} 交易后人数 ${afterSize} 低于下限 ${CBA.minRosterSize}` });
    }

    // Salary matching
    const outgoing = givePlayers.reduce((a, p) => a + salaryForSeason(p.contract, 0), 0);
    const incoming = recvPlayers.reduce((a, p) => a + salaryForSeason(p.contract, 0), 0);
    const snap = capSnapshot(team.players.map((p) => ({ contract: p.contract })), team.players.length);
    const check = salaryMatching(outgoing, incoming, snap);
    salaryCheck.push({ partyTeamId: team.id, incoming: round2(incoming), outgoing: round2(outgoing), band: check.band, ok: check.ok });
    if (!check.ok) {
      issues.push({ code: "SALARY_MATCH", severity: "BLOCKER", message: `${team.abbr} 薪资配平失败：送出 ${outgoing.toFixed(2)}M，接收 ${incoming.toFixed(2)}M（${check.band}）` });
    }

    // Stepien rule: cannot trade own future 1st in consecutive years.
    // Protected picks are exempt — protection exists precisely to allow trading them.
    if (CBA.stepienRule) {
      const ownFutureFirsts = givePicks
        .filter(
          (pk) =>
            pk.round === 1 &&
            pk.originalTeamId === party.teamId &&
            pk.year > season &&
            (!pk.protection || pk.protection.type === "NONE"),
        )
        .sort((a, b) => a.year - b.year);
      for (let i = 1; i < ownFutureFirsts.length; i++) {
        if (ownFutureFirsts[i].year === ownFutureFirsts[i - 1].year + 1) {
          issues.push({
            code: "STEPIEN",
            severity: "BLOCKER",
            message: `${team.abbr} 违反 Stepien 规则：不得连续两年交易自己的无保护首轮签（${ownFutureFirsts[i - 1].year}、${ownFutureFirsts[i].year}）`,
          });
        }
      }
      for (const pk of givePicks) {
        if (pk.year > season + CBA.pickTradeYears) {
          issues.push({ code: "PICK_WINDOW", severity: "BLOCKER", message: `选秀权最多交易未来 ${CBA.pickTradeYears} 年内的签` });
        }
      }
    }

    // Picks given away must remain count >= 0; nothing else.
  }

  // Trade window: deadline during regular season (simplified).
  return { legal: issues.every((i) => i.severity !== "BLOCKER"), issues, salaryCheck };
}

/** AI GM verdict: pure value + needs based; returns accept/reject with reasons. */
export function aiEvaluateTrade(
  party: TradeParty, // this AI team's perspective
  proposal: TradeProposal,
  teams: TradeTeam[],
  season: number,
): AiGmVerdict {
  const team = teams.find((t) => t.id === party.teamId);
  if (!team) return { accept: false, valueDelta: 0, feedback: "评估失败：球队数据缺失", reasons: [] };

  const findPlayerGlobally = (id: string): TradePlayer | undefined => {
    for (const t of teams) {
      const p = t.players.find((x) => x.id === id);
      if (p) return p;
    }
    return undefined;
  };
  const findPickGlobally = (id: string): TradePick | undefined => {
    for (const t of teams) {
      const pk = t.picks.find((x) => x.id === id);
      if (pk) return pk;
    }
    return undefined;
  };

  const incoming = party.receives.map((a) => {
    if (a.kind === "PLAYER") {
      const p = findPlayerGlobally(a.id);
      return p ? playerValue(p, season) : { name: "?", value: 0, breakdown: [] as string[] };
    }
    const pk = findPickGlobally(a.id);
    return pk ? pickValue(pk, season) : { name: "?", value: 0, breakdown: [] as string[] };
  });
  const outgoing = party.gives.map((a) => {
    if (a.kind === "PLAYER") {
      const p = team.players.find((x) => x.id === a.id);
      return p ? playerValue(p, season) : { name: "?", value: 0, breakdown: [] as string[] };
    }
    const pk = team.picks.find((x) => x.id === a.id);
    return pk ? pickValue(pk, season) : { name: "?", value: 0, breakdown: [] as string[] };
  });

  const inV = incoming.reduce((a, v) => a + v.value, 0);
  const outV = outgoing.reduce((a, v) => a + v.value, 0);
  const delta = round2(inV - outV);

  const reasons: string[] = [];
  for (const v of incoming) reasons.push(`收到 ${v.name}：估值 ${v.value} 点`);
  for (const v of outgoing) reasons.push(`送出 ${v.name}：估值 ${v.value} 点`);

  // Phase-based tolerance: contenders accept smaller wins; rebuilders hoard picks.
  const threshold =
    team.aiPhase === "CONTENDER" ? -1 : team.aiPhase === "PLAYOFF" ? 0 : team.aiPhase === "BUBBLE" ? 2 : 4;
  // Risk tolerance shifts threshold slightly.
  const tol = threshold - (team.aiRisk - 0.5) * 4;
  const accept = delta >= tol;

  const incomingStars = party.receives.filter((a) => {
    const p = findPlayerGlobally(a.id);
    return p && p.role === "STAR";
  }).length;

  let feedback: string;
  if (accept) {
    feedback = delta > 8 ? `我的球探部门认为这笔交易明显对我们有利，成交。` : `价值基本对等，我们愿意推进这笔交易。`;
    if (team.aiPhase === "REBUILD" && incoming.some((v) => (v as Valuation).kind === "PICK")) feedback = "重建期的我们永远需要选秀权，这笔可以谈。";
  } else {
    feedback = `从价值上看我们亏了 ${Math.abs(delta).toFixed(1)} 点。`;
    if (team.aiPhase === "REBUILD") feedback += "我们正在重建，需要更多未来资产作为补偿。";
    else if (incomingStars > 0) feedback += "球星不是问题，问题是代价。";
    else feedback += "拿更接近的报价回来谈。";
  }
  return { accept, valueDelta: delta, feedback, reasons };
}
