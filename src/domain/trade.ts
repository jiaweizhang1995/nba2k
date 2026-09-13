// Trade engine: asset valuation, league rule validation, and AI GM verdicts.
// Deterministic and pure. Rule params come from salary.ts (CBA v1.0).

import { CBA, capSnapshot, round2, salaryMatching, contractEndSeason, salaryForSeason, type CapSnapshot } from "./salary";
import { rngFor } from "./rng";
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

/**
 * Need premium (需求溢价): how much MORE a team is willing to value an
 * incoming player. Two components:
 *  - 球星溢价: 70+ 天赋是稀缺品，争冠/季后赛球队愿意「多换一」付出合计估值
 *    高于球星单卡的包（与现实联盟一致）；
 *  - 位置需求溢价: 补强薄弱位置的加价。
 * 边缘球员（overall < 60）无任何溢价，防止垃圾合同被炒高。球星溢价封顶 +100%，
 * 位置溢价封顶 +25%。
 */
export function needPremium(team: TradeTeam, p: TradePlayer): number {
  const isStar = p.role === "STAR" || p.ratings.overall >= 70;
  if (!isStar && p.ratings.overall < 60) return 0;
  let premium = 0;
  if (isStar) {
    premium +=
      team.aiPhase === "CONTENDER" ? 0.9 : team.aiPhase === "PLAYOFF" ? 0.7 : team.aiPhase === "BUBBLE" ? 0.45 : 0.25;
  }
  const atPos = team.players.filter((x) => x.position === p.position);
  const best = atPos.reduce((a, x) => Math.max(a, x.ratings.overall), 0);
  if (atPos.length <= 2) premium += 0.1; // thin position
  if (p.ratings.overall > best + 5) premium += 0.15; // clear upgrade over incumbent
  else if (p.ratings.overall > best) premium += 0.06;
  return Math.min(isStar ? 1.0 : 0.25, premium);
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
      if (!p) return { name: "?", value: 0, breakdown: [] as string[] };
      const base = playerValue(p, season);
      const premium = needPremium(team, p);
      if (premium > 0) {
        return {
          name: base.name,
          value: round2(base.value * (1 + premium)),
          breakdown: [...base.breakdown, `位置需求溢价 +${Math.round(premium * 100)}%（${team.abbr} 需要他）`],
        };
      }
      return base;
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

// ---------------------------------------------------------------------------
// Offer collection（征集报价）: the user names the package they're sending and
// interested teams come back with concrete counter-packages. Every offer is
// pre-checked against the full rule validator AND the AI GM verdict, so any
// offer shown is legal and acceptable as-is. Deterministic: same assets + same
// seed → identical offers.
// ---------------------------------------------------------------------------

export interface OfferAssetRef {
  kind: "PLAYER" | "PICK";
  id: string;
}

export interface GeneratedOffer {
  teamId: string;
  /** What the responding team sends back. */
  gives: OfferAssetRef[];
  /** User perspective: value received − value given. */
  userNetValue: number;
  /** Responding team perspective (always ≥ threshold since they accept). */
  valueDelta: number;
  verdict: AiGmVerdict;
  interestNotes: string[];
}

const ROLE_EXPENDABILITY: Record<string, number> = { BENCH: 0, ROTATION: 1, SIXTH_MAN: 2, STARTER: 3, STAR: 4, STASH: 0 };

/** Salary the responding team must send so the matching band passes. */
function minSalaryOut(salaryRecv: number, snap: CapSnapshot): number {
  if (salaryRecv <= 0) return 0;
  if (snap.overSecondApron) return round2(salaryRecv - 0.1);
  if (snap.overCap && salaryRecv > 9.8) return round2((salaryRecv - 0.1) / CBA.tradeBand2);
  return round2((salaryRecv - 0.1) / CBA.tradeBand1);
}

export function generateTradeOffers(
  userTeamId: string,
  userPackage: { players: TradePlayer[]; picks: TradePick[] },
  teams: TradeTeam[],
  season: number,
  seed: number,
  maxOffers = 6,
): GeneratedOffer[] {
  const userTeam = teams.find((t) => t.id === userTeamId);
  if (!userTeam) return [];
  const assetKey = [...userPackage.players, ...userPackage.picks].map((a) => a.id).sort().join("|");
  const userGives: OfferAssetRef[] = [
    ...userPackage.players.map((p) => ({ kind: "PLAYER" as const, id: p.id })),
    ...userPackage.picks.map((pk) => ({ kind: "PICK" as const, id: pk.id })),
  ];
  const rng = rngFor(seed, `offers:${season}:${userTeamId}:${assetKey}`);

  const offeredVals = [
    ...userPackage.players.map((p) => playerValue(p, season)),
    ...userPackage.picks.map((pk) => pickValue(pk, season)),
  ];
  const offerV = offeredVals.reduce((a, v) => a + v.value, 0);
  if (offerV <= 0) return [];
  const salaryRecv = userPackage.players.reduce((a, p) => a + salaryForSeason(p.contract, 0), 0);
  const inCount = userPackage.players.length;
  const offeredPositions = new Set(userPackage.players.map((p) => p.position));
  const offeredHasStar = userPackage.players.some((p) => p.role === "STAR");

  const offers: GeneratedOffer[] = [];

  for (const team of teams) {
    if (team.id === userTeamId) continue;
    const snap = capSnapshot(team.players.map((p) => ({ contract: p.contract })), team.players.length);
    const minOut = minSalaryOut(salaryRecv, snap);

    const phaseTol = team.aiPhase === "CONTENDER" ? -1 : team.aiPhase === "PLAYOFF" ? 0 : team.aiPhase === "BUBBLE" ? 2 : 4;
    const tol = phaseTol - (team.aiRisk - 0.5) * 4;
    // The team pays a need premium for the user's players — the same premium
    // aiEvaluateTrade applies, so the builder and the verdict stay consistent.
    const offerVForTeam = round2(
      userPackage.players.reduce((a, p) => a + playerValue(p, season).value * (1 + needPremium(team, p)), 0) +
        userPackage.picks.reduce((a, pk) => a + pickValue(pk, season).value, 0),
    );
    const budget = round2(offerVForTeam - tol);
    const premiumPlayer = userPackage.players.find((p) => needPremium(team, p) > 0);

    // Roster bounds for BOTH sides: their after −out +inCount, and the user's
    // after −inCount +outCount must both stay within [min, max].
    const maxOut = Math.min(
      Math.max(0, team.players.length + inCount - CBA.minRosterSize),
      Math.max(0, CBA.maxRosterSize - userTeam.players.length + inCount),
    );
    const floorOut = Math.max(
      0,
      team.players.length + inCount - CBA.maxRosterSize,
      CBA.minRosterSize - userTeam.players.length + inCount,
    );
    if (floorOut > maxOut) continue;

    // Expendable players: bench/rotation first, weaker overall first, no-trade
    // excluded. Jittered by the save seed so teams vary but runs are stable.
    const eligible = team.players
      .filter((p) => !p.contract.noTrade)
      .map((p) => ({
        p,
        v: playerValue(p, season),
        order: (ROLE_EXPENDABILITY[p.role] ?? 2) * 100 - p.ratings.overall + rng.float(0, 6),
      }))
      .sort((a, b) => a.order - b.order);

    const ownedPicks = team.picks
      .filter((pk) => pk.status === "OWNED" && pk.year > season)
      .map((pk) => ({ pk, v: pickValue(pk, season) }))
      .sort((a, b) => a.v.value - b.v.value);

    let built: GeneratedOffer | null = null;

    for (let attempt = 0; attempt < 4 && !built; attempt++) {
      // Attempt 0 targets an equal-salary package; later attempts aim lower
      // (still ≥ the matching-band floor) to fit tighter value budgets.
      const targetSal = attempt === 0 ? salaryRecv : Math.max(minOut, round2(salaryRecv * (1 - attempt * 0.18)));

      // Greedy closest-fit: repeatedly take the eligible player whose salary
      // lands nearest the remaining target — converges to 1-2 clean salary
      // matches instead of stacking minimum contracts (which would blow the
      // roster-size limit on the user's side).
      const chosen: typeof eligible = [];
      let pkgVal = 0;
      let pkgSal = 0;
      const pool = [...eligible];
      while (chosen.length < maxOut) {
        if (pkgSal >= minOut && pkgSal >= targetSal - 1.0) break;
        if (pkgSal > round2(salaryRecv * CBA.tradeBand1 + 0.1)) break; // would break the user's own band
        const remaining = Math.max(0, targetSal - pkgSal);
        const feasible = pool.filter((c) => pkgVal + c.v.value <= budget + 1.5);
        if (feasible.length === 0) break;
        if (chosen.length === 0) {
          // First piece: prefer a salary-matched (±10M) player and, within that
          // window, the BEST player — star-chase psychology: the bidding team
          // sends its best tradable contract, not its worst albatross.
          feasible.sort((a, b) => {
            const da = Math.abs(salaryForSeason(a.p.contract, 0) - remaining);
            const db = Math.abs(salaryForSeason(b.p.contract, 0) - remaining);
            const wa = da <= 10 ? 0 : 1;
            const wb = db <= 10 ? 0 : 1;
            if (wa !== wb) return wa - wb;
            return wa === 0 ? b.v.value - a.v.value : da - db;
          });
        } else {
          feasible.sort(
            (a, b) =>
              Math.abs(salaryForSeason(a.p.contract, 0) - remaining) - Math.abs(salaryForSeason(b.p.contract, 0) - remaining),
          );
        }
        const pick = feasible[0];
        chosen.push(pick);
        pkgVal = round2(pkgVal + pick.v.value);
        pkgSal = round2(pkgSal + salaryForSeason(pick.p.contract, 0));
        pool.splice(pool.indexOf(pick), 1);
      }
      if (chosen.length === 0 && salaryRecv <= 0) {
        // User is sending only picks: teams answer with a single cheap asset.
        const inBudget = eligible.filter((c) => c.v.value <= budget && c.v.value > 0);
        if (inBudget.length > 0 && maxOut > 0) {
          const best = inBudget.reduce((a, b) =>
            Math.abs(b.v.value - budget * 0.6) < Math.abs(a.v.value - budget * 0.6) ? b : a,
          );
          chosen.push(best);
          pkgVal = round2(pkgVal + best.v.value);
          pkgSal = round2(pkgSal + salaryForSeason(best.p.contract, 0));
        }
      }
      if (chosen.length === 0 || chosen.length > maxOut || pkgSal < minOut) continue;
      if (pkgSal > round2(salaryRecv * CBA.tradeBand1 + 0.1)) continue; // user's matching band

      // Sweeten with future picks (up to one 1st + one 2nd) while the value
      // budget allows — picks don't count against roster size, so they are the
      // classic filler in star swaps. Stepien-safe: at most one own 1st.
      const addedPicks: { pk: TradePick; v: Valuation }[] = [];
      if (ownedPicks.length > 0 && (team.aiPhase !== "REBUILD" || offeredHasStar || rng.chance(0.45))) {
        let firstAdded = false;
        let secondAdded = false;
        for (const o of ownedPicks) {
          if (addedPicks.length >= 2) break;
          if (pkgVal + o.v.value > budget) continue;
          if (o.pk.round === 1) {
            if (firstAdded) continue;
            firstAdded = true;
          } else {
            if (secondAdded) continue;
            secondAdded = true;
          }
          pkgVal = round2(pkgVal + o.v.value);
          addedPicks.push(o);
        }
      }

      const gives: OfferAssetRef[] = [
        ...chosen.map((c) => ({ kind: "PLAYER" as const, id: c.p.id })),
        ...addedPicks.map((o) => ({ kind: "PICK" as const, id: o.pk.id })),
      ];
      const parties: TradeParty[] = [
        { teamId: userTeamId, gives: userGives, receives: gives },
        { teamId: team.id, gives, receives: userGives },
      ];
      const validation = validateTrade({ saveId: "offers", parties }, teams, season);
      if (!validation.legal) continue;
      const verdict = aiEvaluateTrade(parties[1], { saveId: "offers", parties }, teams, season);
      if (!verdict.accept) continue;

      const userInV = round2(pkgVal);
      const userNetValue = round2(userInV - offerV);
      const notes: string[] = [];
      for (const c of chosen) {
        if (offeredPositions.has(c.p.position)) notes.push(`${c.p.name} 补强你送出的 ${c.p.position} 位置空缺`);
      }
      if (addedPicks.length > 0) notes.push(`${addedPicks.map((o) => o.v.name).join("、")} 作为价值补偿附上`);
      if (premiumPlayer) {
        const pm = needPremium(team, premiumPlayer);
        notes.push(
          pm >= 0.5
            ? `球星溢价：${team.aiPhase === "CONTENDER" ? "争冠窗口" : "急需球星"}，愿意为 ${premiumPlayer.name} 多付约 ${Math.round(pm * 100)}%`
            : `位置需求溢价：愿意为 ${premiumPlayer.name} 多付约 ${Math.round(pm * 100)}%`,
        );
      }
      if (team.aiPhase === "CONTENDER" && offeredHasStar) notes.push("争冠窗口：为即战力愿意付出未来首轮");
      if (team.aiPhase === "REBUILD") notes.push("重建期：看重你送出的资产与未来灵活性");
      if (snap.overSecondApron || snap.overTax) notes.push(`薪资 ${snap.totalSalary.toFixed(1)}M 超线，需要配平`);

      built = { teamId: team.id, gives, userNetValue, valueDelta: verdict.valueDelta, verdict, interestNotes: notes.slice(0, 3) };
    }
    if (built) offers.push(built);
  }

  return offers.sort((a, b) => b.userNetValue - a.userNetValue).slice(0, maxOffers);
}
