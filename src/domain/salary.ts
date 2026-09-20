// NBA-based simulation rules. Monetary anchors use the official 2026-27
// release; exceptions and roster accounting remain simplified.
// https://www.nba.com/news/nba-salary-cap-2026-27-season

import type { Contract } from "./types";
import type { PlayerRow } from "@/db/schema";

export const CBA_VERSION = "NBA-SIM CBA v1.2";

export interface CbaParams {
  version: string;
  salaryCap: number; // millions
  luxuryTax: number;
  firstApron: number;
  secondApron: number;
  minTeamSalary: number; // 90% of cap
  maxRosterSize: number;
  minRosterSize: number;
  offseasonRosterMax: number;
  maxContractYears: number;
  maxSalaryPct: { upTo6: number; sevenTo9: number; tenPlus: number }; // standard max: 0–6 / 7–9 / 10+ years of service
  rookieScale: { pick1Round1: number; pick15Round1: number; pick30Round1: number; round2Min: number };
  minimumSalary: number;
  tradeBand1: number; // team under cap: incoming <= 150% + 100k
  tradeBand2: number; // 100-150%+100k rules for over-cap teams below apron thresholds
  taxpayerCanAggregate: boolean;
  stepienRule: boolean; // cannot trade own future 1st in consecutive years
  pickTradeYears: number; // how many future years can be traded
  tradeDeadlineDay: number; // day index in season calendar
}

export const CBA: CbaParams = {
  version: CBA_VERSION,
  salaryCap: 164.961,
  luxuryTax: 200.428,
  firstApron: 209.015,
  secondApron: 221.686,
  minTeamSalary: 148.465,
  maxRosterSize: 18, // v1.1: 15 standard + 3 two-way slots (matches real roster structure)
  minRosterSize: 13,
  // Offseason (draft + free agency) may carry up to 20 — real NBA allows 21.
  // The 18-man limit is enforced again when the regular season starts.
  offseasonRosterMax: 20,
  maxContractYears: 5,
  maxSalaryPct: { upTo6: 0.25, sevenTo9: 0.3, tenPlus: 0.35 },
  rookieScale: { pick1Round1: 12.5, pick15Round1: 4.6, pick30Round1: 2.6, round2Min: 1.2 },
  minimumSalary: 1.2,
  tradeBand1: 1.5,
  tradeBand2: 1.25,
  taxpayerCanAggregate: false,
  stepienRule: true,
  pickTradeYears: 7,
  tradeDeadlineDay: 110,
};

/** Future seasons project 7%/yr (a simulation assumption, not an NBA forecast) — a 5-year max signed in
 * 2027 should NOT still be a max-sized burden in 2031. All money lines scale
 * together so relative distances (cap/tax/aprons) stay constant. */
export const CBA_BASE_SEASON = 2027;
export const CAP_GROWTH_PER_YEAR = 0.07;

export interface SeasonMoney {
  salaryCap: number;
  luxuryTax: number;
  firstApron: number;
  secondApron: number;
  minTeamSalary: number;
  minimumSalary: number;
  midLevelException: number;
}

export function seasonMoney(season: number = CBA_BASE_SEASON): SeasonMoney {
  const g = Math.pow(1 + CAP_GROWTH_PER_YEAR, Math.max(0, season - CBA_BASE_SEASON));
  return {
    salaryCap: round2(CBA.salaryCap * g),
    luxuryTax: round2(CBA.luxuryTax * g),
    firstApron: round2(CBA.firstApron * g),
    secondApron: round2(CBA.secondApron * g),
    minTeamSalary: round2(CBA.minTeamSalary * g),
    minimumSalary: round2(CBA.minimumSalary * g),
    midLevelException: round2(15.044 * g),
  };
}

export function teamSalary(players: Pick<PlayerRow, "contract">[]): number {
  return players.reduce((sum, p) => sum + salaryForSeason(p.contract, 0), 0);
}

/** Salary owed in the Nth season of the current save (0 = current). */
export function salaryForSeason(contract: Contract, offset: number): number {
  const year = contract.years[offset];
  if (!year) return 0;
  return year.salary;
}

export function contractEndSeason(contract: Contract): number {
  const last = contract.years[contract.years.length - 1];
  return last ? last.season : 0;
}

export function isExpired(contract: Contract, season: number): boolean {
  return contractEndSeason(contract) < season;
}

export interface CapSnapshot {
  totalSalary: number;
  capSpace: number; // positive = room under cap
  overCap: boolean;
  overTax: boolean;
  overFirstApron: boolean;
  overSecondApron: boolean;
  taxBill: number; // simplified marginal tax
  rosterCount: number;
}

export function capSnapshot(teamPlayers: Pick<PlayerRow, "contract">[], rosterCount: number, deadMoney = 0, season: number = CBA_BASE_SEASON): CapSnapshot {
  const m = seasonMoney(season);
  const totalSalary = round2(teamSalary(teamPlayers) + deadMoney);
  const overCap = totalSalary > m.salaryCap;
  const overTax = totalSalary > m.luxuryTax;
  const overFirstApron = totalSalary > m.firstApron;
  const overSecondApron = totalSalary > m.secondApron;
  // Simplified marginal tax: $1.5 per $1 over tax line, $2.25 per $1 above first apron.
  let taxBill = 0;
  if (overTax) {
    const above = totalSalary - m.luxuryTax;
    taxBill = round2(Math.min(above, m.firstApron - m.luxuryTax) * 1.5 + Math.max(0, above - (m.firstApron - m.luxuryTax)) * 2.25);
  }
  return {
    totalSalary,
    capSpace: round2(m.salaryCap - totalSalary),
    overCap,
    overTax,
    overFirstApron,
    overSecondApron,
    taxBill,
    rosterCount,
  };
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Salary-matching check for one party of a trade (fictional league version):
 *  - Under the cap: incoming - outgoing <= capSpace + $0.1M (absorb into
 *    room) OR incoming <= 150% + $0.1M of outgoing — whichever is wider.
 *    Cap room is a real trade asset: a rebuilding team can absorb a big
 *    contract for picks without sending salary back.
 *  - Over the cap: incoming <= 150% + $0.1M if outgoing <= $9.8M;
 *    incoming <= 125% + $0.1M if outgoing > $9.8M.
 *  - Above second apron: incoming <= outgoing (no aggregation of multiple
 *    players into one larger salary).
 */
export function salaryMatching(outgoing: number, incoming: number, teamSnapshot: CapSnapshot): { ok: boolean; band: string } {
  const out = round2(outgoing);
  const inc = round2(incoming);
  if (!teamSnapshot.overCap) {
    const spaceLimit = round2(out + Math.max(0, teamSnapshot.capSpace) + 0.1);
    const bandLimit = round2(out * CBA.tradeBand1 + 0.1);
    const limit = Math.max(spaceLimit, bandLimit);
    const rule = spaceLimit >= bandLimit ? `帽下空间 ${Math.max(0, teamSnapshot.capSpace).toFixed(2)}M + 送出 + 0.1M` : "150%+0.1M";
    return { ok: inc <= limit, band: `UNDER_CAP: 接收薪资须 ≤ ${limit.toFixed(2)}M（${rule}）` };
  }
  if (teamSnapshot.overSecondApron) {
    return { ok: inc <= out + 0.1, band: "SECOND_APRON: 接收薪资须 ≤ 送出薪资（不得超额）" };
  }
  if (out <= 9.8) {
    const limit = round2(out * CBA.tradeBand1 + 0.1);
    return { ok: inc <= limit, band: `OVER_CAP(小额): 接收薪资须 ≤ ${limit.toFixed(2)}M（150%+0.1M）` };
  }
  const limit = round2(out * CBA.tradeBand2 + 0.1);
  return { ok: inc <= limit, band: `OVER_CAP(大额): 接收薪资须 ≤ ${limit.toFixed(2)}M（125%+0.1M）` };
}

export function maxContractValue(yearsOfService: number, years: number, season: number = CBA_BASE_SEASON): { total: number; firstYear: number } {
  const pct = yearsOfService <= 6 ? CBA.maxSalaryPct.upTo6 : yearsOfService <= 9 ? CBA.maxSalaryPct.sevenTo9 : CBA.maxSalaryPct.tenPlus;
  const firstYear = round2(seasonMoney(season).salaryCap * pct);
  return { firstYear, total: round2(firstYear * years) };
}

export function rookieScaleSalary(pickNumber: number, round: number, season: number = CBA_BASE_SEASON): number {
  const g = seasonMoney(season).salaryCap / CBA.salaryCap;
  if (round === 1) {
    const t = Math.max(0, Math.min(29, pickNumber - 1)) / 29; // 0..1
    return round2((CBA.rookieScale.pick1Round1 + (CBA.rookieScale.pick30Round1 - CBA.rookieScale.pick1Round1) * t) * g);
  }
  return round2(CBA.rookieScale.round2Min * g);
}
