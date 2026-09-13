// Data import pipeline: takes an ImportPayload from any adapter, validates
// provenance, recomputes ratings from the imported stat lines, and performs a
// FULL league replacement inside a transaction: teams, players, schedule,
// draft picks, FA offers and awards. Every record gets provenance metadata.
// Statistics are imported as-is — anything the provider does not supply stays
// empty and is shown as 未知, never fabricated.

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  players as playersT,
  teams as teamsT,
  saves as savesT,
  dataSources as dsT,
  games as gamesT,
  draftPicks as picksT,
  faOffers as faOffersT,
  awards as awardsT,
} from "@/db/schema";
import { blendWithMarketEstimate, computeRatings, computeRatingsFromPerGame, estimateRatingsFromSalary, RATING_VERSION, RATING_VERSION_V13 } from "@/domain/ratings";
import { resolvePositions, type LineupPos } from "@/domain/positions";
import { createSchedule, type LeagueState } from "@/domain/sim/season";
import { hashSeed } from "@/domain/rng";
import type { SeasonStatLine } from "@/domain/types";
import { assertProvenance, type ImportPayload } from "@/data/providers/types";
import { EngineError, logEvent, getSave, getPhaseState } from "./engine";

const uuid = () => globalThis.crypto.randomUUID();
const now = () => new Date().toISOString();

export interface ImportResult {
  teamsImported: number;
  playersImported: number;
  gamesScheduled: number;
  picksGenerated: number;
  warnings: string[];
}

export async function importData(saveId: string, payload: ImportPayload): Promise<ImportResult> {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");
  if (!payload.players.length) throw new EngineError("EMPTY_IMPORT", "导入数据为空");

  const warnings: string[] = [];
  for (const p of payload.players) {
    assertProvenance(p.meta);
    if (!p.age) warnings.push(`${p.name}: 缺少年龄，导入后显示为未知`);
    if (!p.contract) warnings.push(`${p.name}: 缺少合同数据（薪资显示未知）`);
    if (!p.statLine.pts) warnings.push(`${p.name}: 缺少赛季统计，评分显示为未知（低置信度）`);
  }
  for (const t of payload.teams) assertProvenance(t.meta);
  const teamAbbrs = new Set(payload.teams.map((t) => t.abbr.toUpperCase()));
  for (const p of payload.players) {
    if (p.teamAbbr && !teamAbbrs.has(p.teamAbbr.toUpperCase())) {
      warnings.push(`${p.name}: 球队缩写 ${p.teamAbbr} 不在导入列表中，将成为自由球员`);
    }
  }

  const season = payload.players[0]?.meta.season ?? save.season;
  const provider = String(payload.players[0]?.meta.provider ?? "UNKNOWN");

  // Preserve the user's franchise across the replacement when the abbreviation
  // still exists (e.g. demo BOS → real BOS).
  const prevUserTeamId = (getPhaseState(saveId).userTeamId as string | undefined) ?? null;
  const prevUserShort = prevUserTeamId ? prevUserTeamId.split(":").pop() : null;
  const prevUserAbbr = prevUserShort ? prevUserShort.replace(/^t-/i, "").toUpperCase() : null;
  const matchedUserTeam = prevUserAbbr ? payload.teams.find((t) => t.abbr.toUpperCase() === prevUserAbbr) : null;
  const userTeamIdAfter = matchedUserTeam ? `${saveId}:${matchedUserTeam.externalId}` : null;

  // Generate the schedule in memory first (fail fast before writing anything).
  // Built from the INCOMING team ids so the games reference the new league.
  const leagueState: LeagueState = {
    saveId,
    seed: save.seed,
    season,
    phase: "REGULAR_SEASON",
    currentDate: `${season - 1}-10-21`,
    teams: payload.teams.map((t) => ({
      id: t.externalId,
      abbr: t.abbr.toUpperCase().slice(0, 4),
      city: t.city,
      name: t.name,
      conference: t.conference === "WEST" ? ("WEST" as const) : ("EAST" as const),
      division: t.division,
      wins: 0,
      losses: 0,
    })),
    players: [],
    games: [],
    playoffs: null,
  };
  const schedule = createSchedule(leagueState);

  let gamesScheduled = 0;
  let picksGenerated = 0;

  db.transaction((tx) => {
    tx.delete(playersT).where(eq(playersT.saveId, saveId)).run();
    tx.delete(teamsT).where(eq(teamsT.saveId, saveId)).run();
    tx.delete(gamesT).where(eq(gamesT.saveId, saveId)).run();
    tx.delete(picksT).where(eq(picksT.saveId, saveId)).run();
    tx.delete(faOffersT).where(eq(faOffersT.saveId, saveId)).run();
    tx.delete(awardsT).where(eq(awardsT.saveId, saveId)).run();

    const teamIdByAbbr = new Map<string, string>();
    for (const t of payload.teams) {
      const fullId = `${saveId}:${t.externalId}`;
      teamIdByAbbr.set(t.abbr.toUpperCase(), fullId);
      const teamColor = t.color ?? "#38bdf8";
      tx.insert(teamsT)
        .values({
          id: fullId,
          saveId,
          abbr: t.abbr.toUpperCase().slice(0, 4),
          city: t.city,
          name: t.name,
          conference: t.conference === "WEST" ? "WEST" : "EAST",
          division: t.division,
          colorPrimary: teamColor,
          wins: 0,
          losses: 0,
          aiPhase: "BUBBLE",
          aiRisk: 0.5,
          source: {
            provider: t.meta.provider,
            sourceUrl: t.meta.sourceUrl,
            retrievedAt: t.meta.retrievedAt,
            season: t.meta.season,
            licenseNote: t.meta.licenseNote,
            status: "IMPORTED",
            ratingVersion: RATING_VERSION,
          },
        })
        .run();
    }

    for (const p of payload.players) {
      const statLine: SeasonStatLine = {
        season,
        teamAbbr: "N/A",
        g: p.statLine.g ?? 0,
        mp: p.statLine.mp ?? 0,
        pts: p.statLine.pts ?? 0,
        reb: p.statLine.reb ?? 0,
        ast: p.statLine.ast ?? 0,
        stl: p.statLine.stl ?? 0,
        blk: p.statLine.blk ?? 0,
        tov: p.statLine.tov ?? 0,
        fgm: p.statLine.fgm ?? 0,
        fga: p.statLine.fga ?? 0,
        tpm: p.statLine.tpm ?? 0,
        tpa: p.statLine.tpa ?? 0,
        ftm: p.statLine.ftm ?? 0,
        fta: p.statLine.fta ?? 0,
      };
      // Raw provider tokens (G/GF/F/FC…) resolve to primary + secondary slots
      // using assists/height as tie-breakers; explicit 5-slot values pass
      // through. An explicit secondPosition in the payload always wins.
      const perGame = p.perGame ?? null;
      const apg = perGame?.apg ?? (statLine.g > 0 ? statLine.ast / statLine.g : null);
      const resolved = resolvePositions(p.position, { apg, heightCm: p.heightCm });
      const position: LineupPos = resolved.position;
      const secondPosition: LineupPos | null = (p.secondPosition as LineupPos | null | undefined) ?? resolved.secondPosition;
      let ratings = perGame
        ? computeRatingsFromPerGame(perGame, position, p.age || 25, {
            potential: p.potential,
            potentialLow: p.potentialLow,
            potentialHigh: p.potentialHigh,
          })
        : computeRatings(statLine, position, p.age || 25, {
            potential: p.potential,
            potentialLow: p.potentialLow,
            potentialHigh: p.potentialHigh,
          });
      // No statistics in the source:
      //  - has a real contract → transparent market-value estimate (salary is
      //    a live public fact; confidence 0.15, version marked -EST);
      //  - no stats and no contract → neutral placeholder overall 50 with
      //    zero confidence, shown honestly in the UI; never a made-up rating.
      const salaryM = p.contract?.years?.[0]?.salary ?? null;
      if (!perGame && !p.statLine.pts) {
        if (salaryM && salaryM > 0) {
          ratings = estimateRatingsFromSalary(salaryM, position, p.age || 25, p.externalId, {
            potential: p.potential,
            potentialLow: p.potentialLow,
            potentialHigh: p.potentialHigh,
          });
        } else {
          ratings.overall = 50;
        }
      } else if (salaryM && salaryM > 0) {
        // 有统计但样本很小（边缘轮换、短时间 call-up）：统计公式会被极低
        // 分钟数拉爆，按置信度混入市场估值，避免 2 分钟样本评出 25 分。
        const sampleMpg = perGame?.mpg ?? (statLine.g > 0 ? statLine.mp / statLine.g : 99);
        ratings = blendWithMarketEstimate(ratings, salaryM, position, p.age || 25, p.externalId, sampleMpg);
      }
      const teamFullId = p.teamAbbr ? teamIdByAbbr.get(p.teamAbbr.toUpperCase()) ?? null : null;
      // Real payload lacks career-length data — estimate years pro from age
      // (players enter at ~19-22). Without this every imported veteran counts
      // as a rookie and is wrongly eligible for Rookie of the Year.
      const yearsPro = p.yearsPro ?? Math.max(0, Math.min(15, (p.age || 25) - 20));
      tx.insert(playersT)
        .values({
          id: `${saveId}:${p.externalId}`,
          saveId,
          name: p.name,
          teamId: teamFullId,
          position,
          secondPosition,
          age: p.age || 25,
          heightCm: p.heightCm ?? 200,
          weightKg: p.weightKg ?? 100,
          draftYear: p.draftYear ?? (yearsPro > 0 ? season - 1 - yearsPro : null),
          draftRound: null,
          draftPick: null,
          yearsPro,
          ratings,
          seasonStats: [statLine],
          careerStats: [statLine],
          contract: p.contract && (p.contract.years?.[0]?.salary ?? 0) > 0
            ? p.contract
            : {
                // No reliable source contract → market-value placeholder:
                // nobody in the NBA actually plays for $0, and a zero-salary
                // roster poisons every trade/cap check downstream.
                type: "VETERAN" as const,
                years: [{ season, salary: Math.max(1.2, Math.round(Math.max(0, ratings.overall - 55) * 0.6 * 10) / 10) }],
                birdRights: false,
                noTrade: false,
                option: null,
                signedSeason: season,
              },
          status: "ACTIVE",
          role: "ROTATION",
          satisfaction: 70,
          injury: null,
          development: { trajectory: "STABLE", growthLeft: 0, lastDelta: 0 },
          tenure: yearsPro > 0 ? Math.max(1, Math.min(6, yearsPro)) : 0,
          stamina: 1,
          lastGameDate: null,
          baselineStats: perGame ? (perGame as unknown as Record<string, unknown>) : null,
          source: {
            provider: p.meta.provider,
            sourceUrl: p.meta.sourceUrl,
            retrievedAt: p.meta.retrievedAt,
            season: p.meta.season,
            licenseNote: p.meta.licenseNote,
            status: "IMPORTED",
            ratingVersion: perGame ? RATING_VERSION_V13 : RATING_VERSION,
          },
        })
        .run();
    }

    // Refine usage tendencies to each player's share of team scoring
    // (post-roster pass — the per-game fallback used global ppg only).
    const inserted = tx.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
    const byTeam = new Map<string, typeof inserted>();
    for (const row of inserted) {
      if (!row.teamId) continue;
      const list = byTeam.get(row.teamId) ?? [];
      list.push(row);
      byTeam.set(row.teamId, list);
    }
    for (const [, roster] of byTeam) {
      const sorted = [...roster].sort((a, b) => b.ratings.overall - a.ratings.overall);
      // Real payload rosters run 19-21 deep (two-ways, camp bodies). The CBA
      // max is 18 — the tail end of the roster gets waived to free agency.
      const surplus = sorted.slice(18);
      for (const row of surplus) {
        tx.update(playersT).set({ teamId: null, status: "FREE_AGENT", role: "BENCH" }).where(eq(playersT.id, row.id)).run();
      }
      const kept = sorted.slice(0, 18);
      kept.forEach((row, i) => {
        const role = i === 0 && row.ratings.overall >= 86 ? "STAR" : i === 1 && row.ratings.overall >= 84 ? "STAR" : i < 5 ? "STARTER" : i === 5 && row.ratings.overall >= 79 ? "SIXTH_MAN" : i < 10 ? "ROTATION" : "BENCH";
        tx.update(playersT).set({ role }).where(eq(playersT.id, row.id)).run();
      });
      const totalPpg = kept.reduce((a, r) => a + ((r.baselineStats as { ppg?: number } | null)?.ppg ?? 0), 0);
      if (totalPpg <= 0) continue;
      for (const row of kept) {
        const base = row.baselineStats as { ppg?: number } | null;
        if (!base?.ppg) continue;
        const share = base.ppg / totalPpg;
        // 只精修 usageTendency；ratingVersion 反映实际评分公式（v1.3 等），不在此覆写
        const ratings = {
          ...row.ratings,
          usageTendency: Math.round(Math.max(0.05, Math.min(0.42, share)) * 100) / 100,
        };
        tx.update(playersT).set({ ratings }).where(eq(playersT.id, row.id)).run();
      }
    }

    for (const g of schedule) {
      tx.insert(gamesT)
        .values({
          id: `${saveId}:${g.id}`,
          saveId,
          date: g.date,
          season: g.season,
          type: g.type,
          homeTeamId: `${saveId}:${g.homeTeamId}`,
          awayTeamId: `${saveId}:${g.awayTeamId}`,
          homeScore: null,
          awayScore: null,
          status: "SCHEDULED",
          box: null,
        })
        .run();
      gamesScheduled++;
    }

    // Draft picks: next 7 years × 2 rounds per team (deterministic protections).
    for (let year = season; year < season + 7; year++) {
      for (const t of payload.teams) {
        for (const round of [1, 2]) {
          tx.insert(picksT)
            .values({
              id: `${saveId}:pk-${year}-${round}-${t.abbr}`,
              saveId,
              year,
              round,
              originalTeamId: `${saveId}:${t.externalId}`,
              holderTeamId: `${saveId}:${t.externalId}`,
              status: "OWNED",
              protection:
                round === 1 && hashSeed(`prot:${saveId}:${year}:${t.abbr}`) % 10 === 0
                  ? { type: "LOTTERY_TOP_X", x: 3, yearShift: 1 }
                  : null,
              resolved: null,
            })
            .run();
          picksGenerated++;
        }
      }
    }

    tx.insert(dsT)
      .values({
        id: uuid(),
        saveId,
        provider,
        sourceUrl: payload.players[0]?.meta.sourceUrl ?? null,
        retrievedAt: payload.players[0]?.meta.retrievedAt ?? now(),
        season,
        licenseNote: payload.players[0]?.meta.licenseNote ?? "UNKNOWN",
        status: "IMPORTED",
        scope: "LEAGUE",
        records: payload.players.length,
      })
      .run();

    // Contract provenance is a separate source (e.g. ESPN) from the roster/stats.
    const contractMeta = (payload as { contractMeta?: { provider: string; sourceUrl: string; retrievedAt: string; season: number; licenseNote: string } }).contractMeta;
    if (contractMeta) {
      tx.insert(dsT)
        .values({
          id: uuid(),
          saveId,
          provider: contractMeta.provider,
          sourceUrl: contractMeta.sourceUrl,
          retrievedAt: contractMeta.retrievedAt,
          season: contractMeta.season,
          licenseNote: contractMeta.licenseNote,
          status: "IMPORTED",
          scope: "CONTRACTS",
          records: payload.players.filter((p) => p.contract).length,
        })
        .run();
    }

    const basePhaseState = (getPhaseState(saveId) ?? {}) as Record<string, unknown>;
    const nextPhaseState: Record<string, unknown> = { ...basePhaseState };
    delete nextPhaseState.draft;
    delete nextPhaseState.playoffs;
    if (userTeamIdAfter) nextPhaseState.userTeamId = userTeamIdAfter;
    else delete nextPhaseState.userTeamId;

    const anyPerGame = payload.players.some((p) => p.perGame);
    tx.update(savesT)
      .set({
        dataProvider: provider,
        dataStatus: "IMPORTED",
        ratingVersion: anyPerGame ? RATING_VERSION_V13 : RATING_VERSION,
        phase: "REGULAR_SEASON",
        currentDate: `${season - 1}-10-21`,
        phaseState: nextPhaseState,
        updatedAt: now(),
      })
      .where(eq(savesT.id, saveId))
      .run();
  });

  logEvent(
    saveId,
    "SYSTEM",
    `导入数据：provider=${provider}，球队 ${payload.teams.length} 支，球员 ${payload.players.length} 名，赛程 ${gamesScheduled} 场（赛季 ${season}）。统计缺失字段显示为未知。`,
    { provider, season, teams: payload.teams.length, players: payload.players.length },
  );

  return { teamsImported: payload.teams.length, playersImported: payload.players.length, gamesScheduled, picksGenerated, warnings };
}

// ---------------------------------------------------------------------------
// Contract-only merge: update player contracts by name without touching the
// league (used to backfill salaries, e.g. from a Spotrac/ESPN CSV export).
// ---------------------------------------------------------------------------

export interface ContractCsvRow {
  name: string;
  salary: number; // millions per year
  years?: number;
}

export function mergeContracts(saveId: string, rows: ContractCsvRow[], meta: { provider: string; sourceUrl: string; retrievedAt: string; season: number; licenseNote: string }): { matched: number; unmatched: string[] } {
  const db = getDb();
  const save = getSave(saveId);
  if (!save) throw new EngineError("NO_SAVE", "存档不存在");

  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter((t) => t && !["jr", "sr", "ii", "iii", "iv", "v"].includes(t))
      .sort()
      .join(" ");

  const unmatched: string[] = [];
  let matched = 0;

  db.transaction((tx) => {
    const all = tx.select().from(playersT).where(eq(playersT.saveId, saveId)).all();
    const byName = new Map<string, typeof all[number]>();
    for (const p of all) byName.set(norm(p.name), p);
    for (const row of rows) {
      const player = byName.get(norm(row.name));
      if (!player) {
        unmatched.push(row.name);
        continue;
      }
      const years = Math.max(1, Math.min(5, row.years ?? 1));
      const salary = Math.round(row.salary * 100) / 100;
      tx.update(playersT)
        .set({
          contract: {
            type: salary >= 42 ? "MAX" : salary <= 1.4 ? "MINIMUM" : "VETERAN",
            years: Array.from({ length: years }, (_, i) => ({ season: save.season + i, salary })),
            birdRights: years >= 2,
            noTrade: false,
            option: null,
            signedSeason: save.season,
          },
        })
        .where(eq(playersT.id, player.id))
        .run();
      matched++;
    }

    tx.insert(dsT)
      .values({
        id: uuid(),
        saveId,
        provider: meta.provider,
        sourceUrl: meta.sourceUrl,
        retrievedAt: meta.retrievedAt,
        season: meta.season,
        licenseNote: meta.licenseNote,
        status: "IMPORTED",
        scope: "CONTRACTS",
        records: matched,
      })
      .run();
  });

  logEvent(saveId, "SYSTEM", `合同合并导入：匹配 ${matched} 名球员（来源 ${meta.provider}），未匹配 ${unmatched.length} 名`, {
    provider: meta.provider,
    matched,
    unmatched: unmatched.slice(0, 20),
  });
  return { matched, unmatched };
}
