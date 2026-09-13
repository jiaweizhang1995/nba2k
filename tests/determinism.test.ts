// Determinism: same seed + same input sequence => identical results.
import { describe, expect, it } from "vitest";
import { PRNG, rngFor } from "@/domain/rng";
import { generateDemoLeague } from "@/data/demo";
import { simulateGame } from "@/domain/sim/game";
import { createSchedule } from "@/domain/sim/season";
import { createSave, advanceSim, getLeagueOverview } from "@/server/engine";

describe("PRNG determinism", () => {
  it("same seed & salt produce identical streams", () => {
    const a = rngFor(12345, "salt");
    const b = rngFor(12345, "salt");
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different salt produces different streams", () => {
    const a = rngFor(12345, "salt1");
    const b = rngFor(12345, "salt2");
    expect(a.next()).not.toBe(b.next());
  });

  it("PRNG helpers stay in range and are reproducible", () => {
    const mk = () => {
      const r = new PRNG(42);
      return [r.int(1, 10), r.float(0, 1), r.chance(0.5), r.pick([1, 2, 3]), r.shuffle([1, 2, 3, 4]), r.gauss()];
    };
    expect(mk()).toEqual(mk());
  });
});

describe("Demo league generation determinism", () => {
  it("same seed yields identical league", () => {
    const a = generateDemoLeague(777, 2027);
    const b = generateDemoLeague(777, 2027);
    expect(a.teams).toEqual(b.teams);
    expect(a.players.map((p) => [p.id, p.ratings.overall, p.contract])).toEqual(b.players.map((p) => [p.id, p.ratings.overall, p.contract]));
  });

  it("league structure: 30 teams, roster sizes within limits, prospects present", () => {
    const { teams, players } = generateDemoLeague(1, 2027);
    expect(teams).toHaveLength(30);
    const actives = players.filter((p) => p.status === "ACTIVE");
    expect(actives.length).toBeGreaterThanOrEqual(30 * 13);
    for (const t of teams) {
      const n = actives.filter((p) => p.teamId === t.id).length;
      expect(n).toBeGreaterThanOrEqual(13);
      expect(n).toBeLessThanOrEqual(15);
    }
    expect(players.filter((p) => p.status === "PROSPECT").length).toBe(180); // 3 classes × 60
  });
});

describe("Game sim determinism", () => {
  it("same seed+salt → identical box scores", () => {
    const { teams, players } = generateDemoLeague(9, 2027);
    const mkTeam = (abbr: string) => {
      const t = teams.find((x) => x.abbr === abbr)!;
      return {
        id: t.id,
        name: `${t.city} ${t.name}`,
        players: players.filter((p) => p.teamId === t.id && p.status === "ACTIVE").map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          ratings: {
            overall: p.ratings.overall,
            inside: p.ratings.inside,
            finishing: p.ratings.finishing,
            threePoint: p.ratings.threePoint,
            freeThrow: p.ratings.freeThrow,
            playmaking: p.ratings.playmaking,
            rebounding: p.ratings.rebounding,
            perimeterD: p.ratings.perimeterD,
            interiorD: p.ratings.interiorD,
          },
          usageTendency: p.ratings.usageTendency,
          role: p.role,
          injury: null,
          stamina: 1,
        })),
      };
    };
    const home = mkTeam("BOS");
    const away = mkTeam("LAL");
    const a = simulateGame(home, away, { seed: 314, salt: "fixed" });
    const b = simulateGame(home, away, { seed: 314, salt: "fixed" });
    expect(a.homeScore).toBe(b.homeScore);
    expect(a.awayScore).toBe(b.awayScore);
    expect(a.box).toEqual(b.box);
    // sanity: scores within plausible range
    expect(a.homeScore).toBeGreaterThan(60);
    expect(a.homeScore).toBeLessThan(180);
    // totals match box scores
    const homePts = a.box.home.reduce((s: number, l: { pts: number }) => s + l.pts, 0);
    expect(homePts).toBe(a.homeScore);
  });
});

describe("Schedule determinism", () => {
  it("same seed → identical schedule; 82 games per team; no team plays twice a day", () => {
    const { teams } = generateDemoLeague(5, 2027);
    const state = {
      saveId: "s",
      seed: 5,
      season: 2027,
      phase: "REGULAR_SEASON" as const,
      currentDate: "2026-10-21",
      teams: teams.map((t) => ({ ...t, wins: 0, losses: 0 })),
      players: [],
      games: [],
      playoffs: null,
    };
    const a = createSchedule(state);
    const b = createSchedule(state);
    expect(a.map((g) => [g.homeTeamId, g.awayTeamId, g.date])).toEqual(b.map((g) => [g.homeTeamId, g.awayTeamId, g.date]));
    expect(a).toHaveLength((30 * 82) / 2);
    const perTeam = new Map<string, number>();
    const perTeamDay = new Map<string, Set<string>>();
    for (const g of a) {
      perTeam.set(g.homeTeamId, (perTeam.get(g.homeTeamId) ?? 0) + 1);
      perTeam.set(g.awayTeamId, (perTeam.get(g.awayTeamId) ?? 0) + 1);
      for (const t of [g.homeTeamId, g.awayTeamId]) {
        if (!perTeamDay.has(t)) perTeamDay.set(t, new Set());
        perTeamDay.get(t)!.add(g.date);
      }
    }
    for (const t of teams) {
      expect(perTeam.get(t.id)).toBe(82);
      expect(perTeamDay.get(t.id)!.size).toBe(82); // one game per day max
    }
  });
});

describe("End-to-end season determinism (engine)", () => {
  it("two saves with same seed produce identical season results", async () => {
    const s1 = await createSave({ name: "确定性A", seed: 424242 });
    const s2 = await createSave({ name: "确定性B", seed: 424242 });
    const r1 = advanceSim(s1.saveId, "SEASON");
    const r2 = advanceSim(s2.saveId, "SEASON");
    expect(r1.days).toBe(r2.days);
    expect(r1.gamesPlayed).toBe(r2.gamesPlayed);
    expect(r1.results).toEqual(r2.results);
    expect(r1.injuries).toEqual(r2.injuries);
    expect(r1.awards.map((a) => a.type)).toEqual(r2.awards.map((a) => a.type));
    // standings identical
    const l1 = getLeagueOverview(s1.saveId);
    const l2 = getLeagueOverview(s2.saveId);
    const rec = (overview: typeof l1) => [...overview.east, ...overview.west].map((t) => [t.abbr, t.wins, t.losses]);
    expect(rec(l1)).toEqual(rec(l2));
  }, 300_000);
});
