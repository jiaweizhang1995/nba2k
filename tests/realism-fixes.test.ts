import { describe, expect, it } from "vitest";
import { clearProspectCache, generateScoutingReport, runLottery } from "@/domain/draft";
import { applyDevelopment, type LeaguePlayer, type LeagueState } from "@/domain/sim/season";
import { maxContractValue, seasonMoney } from "@/domain/salary";
import { validateTrade, type TradePick, type TradeTeam } from "@/domain/trade";

// ---- lottery: only picks 1-4 are drawn, 5-14 keep standings order ----

describe("lottery: 14 non-playoff teams, top-4 draw only", () => {
  // pool is ordered worst → best (standings order); playoff order comes after.
  const pool = Array.from({ length: 14 }, (_, i) => `LOT${i}`);
  const playoff = Array.from({ length: 16 }, (_, i) => `PO${i}`);
  const drawn = runLottery(42, 2028, pool, playoff);

  it("returns all 30 teams in draft order", () => {
    expect(drawn).toHaveLength(30);
    expect(new Set(drawn).size).toBe(30);
  });

  it("picks 1-4 are drawn from the pool only — playoff teams can't jump in", () => {
    expect(drawn.slice(0, 4).every((t) => pool.includes(t))).toBe(true);
    expect(new Set(drawn.slice(0, 4)).size).toBe(4);
  });

  it("picks 5-14 keep the pool's original standings order", () => {
    const undrawn = pool.filter((t) => !drawn.slice(0, 4).includes(t));
    expect(drawn.slice(4, 14)).toEqual(undrawn);
  });

  it("the worst team falls at worst to pick 5", () => {
    expect(drawn.indexOf("LOT0")).toBeLessThan(5);
  });

  it("playoff teams pick 15-30 in their standings order", () => {
    expect(drawn.slice(14)).toEqual(playoff);
    expect(drawn.slice(14).every((t) => !pool.includes(t))).toBe(true);
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(runLottery(42, 2028, pool, playoff)).toEqual(drawn);
    // Not strictly guaranteed for every seed pair, but a different salt
    // must produce a different RNG stream — sample several seeds.
    const alt = [1, 7, 99].map((s) => runLottery(s, 2028, pool, playoff).slice(0, 4).join(","));
    expect(new Set(alt).size).toBeGreaterThan(1);
  });
});

describe("scouting reports survive process restarts", () => {
  it("use persisted prospect ratings instead of the in-memory cache", () => {
    const ratings = {
      overall: 78, inside: 70, finishing: 75, threePoint: 82, freeThrow: 80,
      playmaking: 72, rebounding: 61, perimeterD: 68, interiorD: 45,
      usageTendency: 60, potential: 86, potentialLow: 80, potentialHigh: 90, confidence: 70,
    };
    const before = generateScoutingReport("prospect-restart", 1234, ratings);
    clearProspectCache();
    const after = generateScoutingReport("prospect-restart", 1234, ratings);
    expect(after).toEqual(before);
    expect(after.ceiling).toBe(90);
  });
});

// ---- development: real players (null potential) consume growthLeft ----

const mkPlayer = (over: Partial<LeaguePlayer>): LeaguePlayer => ({
  id: "p1", name: "Real Player", teamId: "t1", lastTeamId: "t1",
  position: "SF", age: 23, yearsPro: 3, tenure: 2,
  ratings: {
    overall: 75, threePoint: 75, finishing: 75, inside: 75, freeThrow: 75,
    playmaking: 75, rebounding: 75, perimeterD: 75, interiorD: 75,
    usageTendency: 50, potential: null, potentialLow: null, potentialHigh: null, confidence: 0,
  },
  seasonStats: [{ g: 78, mp: 2500, pts: 1200, reb: 400, ast: 300, stl: 60, blk: 30, tov: 150, fgm: 450, fga: 900, tpm: 120, tpa: 330, ftm: 150, fta: 190 }],
  contract: { type: "VETERAN", years: [{ season: 2027, salary: 12 }], birdRights: true, noTrade: false, option: null, signedSeason: 2025 },
  status: "ACTIVE", role: "STARTER", satisfaction: 60,
  injury: null,
  development: { trajectory: "GROWING", growthLeft: 6, lastDelta: 0 },
  stamina: 90, lastGameDate: null,
  ...over,
});

const mkState = (players: LeaguePlayer[]): LeagueState => ({
  saveId: "t", seed: 7, season: 2028, phase: "OFFSEASON", currentDate: "2028-06-20",
  teams: [{ id: "t1", abbr: "T1", city: "T", name: "T", conference: "EAST", division: "X", wins: 45, losses: 37 }],
  players, games: [], playoffs: null,
});

describe("applyDevelopment: growthLeft fallback for null-potential players", () => {
  it("a young real player with growthLeft uses it as the growth budget", () => {
    const p = mkPlayer({});
    const before = p.development.growthLeft;
    applyDevelopment(mkState([p]));
    // Either he grew (consuming budget) or the year was neutral — but the
    // budget path must be live: over a few seasons it strictly depletes.
    const st = mkState([p]);
    for (let i = 0; i < 6 && p.development.growthLeft > 0; i++) applyDevelopment(st);
    expect(p.development.growthLeft).toBeLessThan(before);
  });

  it("growthLeft only decreases by actual positive growth (no free reset)", () => {
    const p = mkPlayer({ development: { trajectory: "STABLE", growthLeft: 5, lastDelta: 0 } });
    applyDevelopment(mkState([p]));
    const spent = Math.max(0, p.development.lastDelta);
    expect(p.development.growthLeft).toBe(5 - spent);
  });

  it("explicit potential still drives synthetic prospects and re-derives the budget", () => {
    const p = mkPlayer({ ratings: { ...mkPlayer({}).ratings, potential: 85 } });
    applyDevelopment(mkState([p]));
    expect(p.development.growthLeft).toBe(Math.max(0, 85 - p.ratings.overall));
  });
});

// ---- Stepien: stateful check across separate trades ----

const mkPick = (id: string, year: number, original: string, holder: string): TradePick => ({
  id, year, round: 1, originalTeamId: original, holderTeamId: holder,
  status: "OWNED", protection: null,
});

const mkTradeTeam = (id: string, picks: TradePick[]): TradeTeam => ({
  id, abbr: id, players: [], picks, aiPhase: "PLAYOFF", aiRisk: 0.5, deadMoney: 0,
});

describe("Stepien: consecutive firsts already dealt in a prior trade still block", () => {
  const season = 2028;
  const now = { phase: "OFFSEASON" as const, date: `${season}-07-01` };

  it("dealing the 2030 first after already dealing 2029 is a STEPIEN blocker", () => {
    // A's 2029 first is already held by B (traded in an earlier deal — not
    // part of this proposal). Sending out the 2030 first would leave A
    // without a first-round pick in both 2029 and 2030.
    const a = mkTradeTeam("A", [mkPick("a30", 2030, "A", "A"), mkPick("a31", 2031, "A", "A")]);
    const b = mkTradeTeam("B", [mkPick("a29", 2029, "A", "B"), mkPick("b30", 2030, "B", "B")]);
    const v = validateTrade(
      { saveId: "s", parties: [
        { teamId: "A", gives: [{ kind: "PLAYER", id: "pa" }, { kind: "PICK", id: "a30" }], receives: [{ kind: "PLAYER", id: "pb" }] },
        { teamId: "B", gives: [{ kind: "PLAYER", id: "pb" }], receives: [{ kind: "PLAYER", id: "pa" }, { kind: "PICK", id: "a30" }] },
      ] },
      [a, b], season, now,
    );
    expect(v.issues.some((i) => i.code === "STEPIEN")).toBe(true);
  });

  it("same trade is legal when the neighboring years are still owned", () => {
    const a = mkTradeTeam("A", [mkPick("a29", 2029, "A", "A"), mkPick("a30", 2030, "A", "A"), mkPick("a31", 2031, "A", "A")]);
    const b = mkTradeTeam("B", [mkPick("b30", 2030, "B", "B")]);
    const v = validateTrade(
      { saveId: "s", parties: [
        { teamId: "A", gives: [{ kind: "PLAYER", id: "pa" }, { kind: "PICK", id: "a30" }], receives: [{ kind: "PLAYER", id: "pb" }] },
        { teamId: "B", gives: [{ kind: "PLAYER", id: "pb" }], receives: [{ kind: "PLAYER", id: "pa" }, { kind: "PICK", id: "a30" }] },
      ] },
      [a, b], season, now,
    );
    expect(v.issues.some((i) => i.code === "STEPIEN")).toBe(false);
  });
});


describe("NBA standard maximum salary", () => {
  it.each([[0, 0.25], [6, 0.25], [7, 0.3], [9, 0.3], [10, 0.35], [20, 0.35]])("%i years of service", (years, percent) => {
    expect(maxContractValue(years, 1, 2027).firstYear).toBeCloseTo(seasonMoney(2027).salaryCap * percent, 1);
  });
  it("anchors money to the official 2026–27 season", () => {
    expect(seasonMoney(2027).salaryCap).toBe(164.96);
    expect(seasonMoney(2027).secondApron).toBe(221.69);
  });
});
