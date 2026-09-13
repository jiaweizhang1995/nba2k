// League CBA parameters — FICTIONAL LEAGUE RULES ("LEAGUE CBA v1.0").
// These are the in-game rules of this original simulation league, versioned
// and shown in the UI. They are simplified but internally consistent.

import type { Contract } from "./types";
import type { PlayerRow } from "@/db/schema";

export const CBA_VERSION = "LEAGUE CBA v1.1";

export interface CbaParams {
  version: string;
  salaryCap: number; // millions
  luxuryTax: number;
  firstApron: number;
  secondApron: number;
  minTeamSalary: number; // 90% of cap
  maxRosterSize: number;
  minRosterSize: number;
  maxContractYears: number;
  maxSalaryPct: { under9: number; nineTo18: number; over18: number }; // years of service -> 30/35/40% of cap
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
  salaryCap: 140,
  luxuryTax: 170,
  firstApron: 178,
  secondApron: 188,
  minTeamSalary: 126,
  maxRosterSize: 18, // v1.1: 15 standard + 3 two-way slots (matches real roster structure)
  minRosterSize: 13,
  maxContractYears: 5,
  maxSalaryPct: { under9: 0.3, nineTo18: 0.35, over18: 0.4 },
  rookieScale: { pick1Round1: 12.5, pick15Round1: 4.6, pick30Round1: 2.6, round2Min: 1.2 },
  minimumSalary: 1.2,
  tradeBand1: 1.5,
  tradeBand2: 1.25,
  taxpayerCanAggregate: false,
  stepienRule: true,
  pickTradeYears: 7,
  tradeDeadlineDay: 110,
};

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

export function capSnapshot(teamPlayers: Pick<PlayerRow, "contract">[], rosterCount: number): CapSnapshot {
  const totalSalary = round2(teamSalary(teamPlayers));
  const overCap = totalSalary > CBA.salaryCap;
  const overTax = totalSalary > CBA.luxuryTax;
  const overFirstApron = totalSalary > CBA.firstApron;
  const overSecondApron = totalSalary > CBA.secondApron;
  // Simplified marginal tax: $1.5 per $1 over tax line, $2.25 per $1 above first apron.
  let taxBill = 0;
  if (overTax) {
    const above = totalSalary - CBA.luxuryTax;
    taxBill = round2(Math.min(above, CBA.firstApron - CBA.luxuryTax) * 1.5 + Math.max(0, above - (CBA.firstApron - CBA.luxuryTax)) * 2.25);
  }
  return {
    totalSalary,
    capSpace: round2(CBA.salaryCap - totalSalary),
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
 *  - Under the cap: may take back up to 150% + $0.1M of outgoing salary
 *    (practically unlimited by cap room).
 *  - Over the cap: incoming <= 150% + $0.1M if outgoing <= $9.8M;
 *    incoming <= 125% + $0.1M if outgoing > $9.8M.
 *  - Above second apron: incoming <= outgoing (no aggregation of multiple
 *    players into one larger salary).
 */
export function salaryMatching(outgoing: number, incoming: number, teamSnapshot: CapSnapshot): { ok: boolean; band: string } {
  const out = round2(outgoing);
  const inc = round2(incoming);
  if (!teamSnapshot.overCap) {
    const limit = round2(out * CBA.tradeBand1 + 0.1);
    return { ok: inc <= limit, band: `UNDER_CAP: 接收薪资须 ≤ ${limit.toFixed(2)}M（150%+0.1M）` };
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

export function maxContractValue(yearsOfService: number, years: number): { total: number; firstYear: number } {
  const pct = yearsOfService < 9 ? CBA.maxSalaryPct.under9 : yearsOfService < 18 ? CBA.maxSalaryPct.nineTo18 : CBA.maxSalaryPct.over18;
  const firstYear = round2(CBA.salaryCap * pct);
  return { firstYear, total: round2(firstYear * years) };
}

export function rookieScaleSalary(pickNumber: number, round: number): number {
  if (round === 1) {
    const t = Math.max(0, Math.min(29, pickNumber - 1)) / 29; // 0..1
    return round2(CBA.rookieScale.pick1Round1 + (CBA.rookieScale.pick30Round1 - CBA.rookieScale.pick1Round1) * t);
  }
  return CBA.rookieScale.round2Min;
}
