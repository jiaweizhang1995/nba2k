// Standings & season progression: records update, standings sort, playoff
// bracket flows, offseason transitions.
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, advanceSim, loadLeagueState, getSave, getDraftOrder, getDraftBoard, makeDraftPick, getPhaseState } from "@/server/engine";
import { standings } from "@/domain/sim/season";

let saveId: string;

beforeAll(async () => {
  const s = await createSave({ name: "赛季推进测试", seed: 80808 });
  saveId = s.saveId;
}, 120_000);

describe("Regular season progression", () => {
  it("advance DAY simulates that day's games and updates records", async () => {
    const before = loadLeagueState(saveId);
    expect(before.games.length).toBeGreaterThan(1000);
    const r = advanceSim(saveId, "DAY");
    expect(r.days).toBe(1);
    const after = loadLeagueState(saveId);
    const totalWins = after.teams.reduce((s, t) => s + t.wins, 0);
    expect(totalWins).toBe(r.gamesPlayed);
    expect(totalWins).toBeGreaterThan(0);
  });

  it("standings sorted by win% and divisions present", () => {
    const state = loadLeagueState(saveId);
    const st = standings(state);
    expect(st.EAST).toHaveLength(15);
    expect(st.WEST).toHaveLength(15);
    for (const conf of [st.EAST, st.WEST]) {
      for (let i = 1; i < conf.length; i++) {
        const prev = conf[i - 1];
        const cur = conf[i];
        const prevPct = prev.wins / Math.max(1, prev.wins + prev.losses);
        const curPct = cur.wins / Math.max(1, cur.wins + cur.losses);
        expect(prevPct).toBeGreaterThanOrEqual(curPct);
      }
    }
  });

  it("regular season completes → playoffs start → champion → offseason → draft ready", async () => {
    const r = advanceSim(saveId, "REGULAR_SEASON");
    expect(r.phaseChanged).toBe("PLAYOFFS");
    const saveAfterReg = getSave(saveId)!;
    expect(saveAfterReg.phase).toBe("PLAYOFFS");

    const r2 = advanceSim(saveId, "PLAYOFFS");
    expect(r2.champion).toBeTruthy();
    expect(r2.awards.some((a) => a.type === "CHAMPION")).toBe(true);
    expect(r2.awards.some((a) => a.type === "MVP")).toBe(true);
    const saveAfterPo = getSave(saveId)!;
    expect(saveAfterPo.phase).toBe("DRAFT");
    // season label rolled over
    expect(saveAfterPo.season).toBe(saveAfterReg.season + 1);

    // draft order exists and a deterministic 60-man synthetic class is
    // generated for the new season (real-data saves ship without prospects,
    // so the engine creates one — otherwise the draft acquires nobody).
    const order = getDraftOrder(saveId);
    expect(order).toHaveLength(60);
    const board = getDraftBoard(saveId);
    expect(board).toHaveLength(60);
    expect(board.every((p) => p.scouting.floor <= p.scouting.ceiling)).toBe(true);
  }, 300_000);

  it("draft completes → free agency → new season starts with fresh schedule", async () => {
    const ps = getPhaseState(saveId);
    const userTeamId = (ps.userTeamId as string).split(":").pop()!;
    // A 60-prospect class was generated at draft entry, so every slot
    // resolves to a real rookie instead of a skipped pick.
    const picked = makeDraftPick(saveId, { simulateAll: true });
    expect(picked.length).toBe(60);
    expect(picked.every((p) => p.prospect !== null)).toBe(true);

    const saveAfterDraft = getSave(saveId)!;
    expect(saveAfterDraft.phase).toBe("FREE_AGENCY");

    // start new season
    const { startNewSeason } = await import("@/server/engine");
    startNewSeason(saveId);
    const saveNew = getSave(saveId)!;
    expect(saveNew.phase).toBe("REGULAR_SEASON");
    expect(saveNew.season).toBe(saveAfterDraft.season);

    // new schedule generated: 1230 games for the new season
    const state = loadLeagueState(saveId);
    expect(state.games).toHaveLength(1230);
    expect(state.players.filter((p) => p.status === "ACTIVE" && p.teamId === userTeamId).length).toBeGreaterThanOrEqual(13);
  }, 300_000);

  it("draft with a prospect class: board, auto-picks and rookie contracts", async () => {
    // Re-open a draft on the live save by seeding a synthetic 60-prospect
    // class directly (mechanics coverage only — shipped saves carry no
    // fictional prospects). Insert with draftYear = current season.
    const { getDb } = await import("@/db");
    const { players: playersT, saves: savesT } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const db = getDb();
    const save = getSave(saveId)!;
    // The previous test exercised this season's picks (empty class), so roll
    // the save one more year forward and draft against the next pick class.
    const season = save.season + 1;
    const mkRatings = (overall: number) => ({
      overall,
      inside: overall,
      finishing: overall,
      shooting: overall,
      threePoint: overall,
      freeThrow: overall,
      playmaking: overall,
      rebounding: overall,
      perimeterD: overall,
      interiorD: overall,
      usageTendency: 0.2,
      potential: overall + 8,
      potentialLow: overall - 4,
      potentialHigh: overall + 12,
      confidence: 0.3,
      ratingVersion: "test",
    });
    const positions = ["PG", "SG", "SF", "PF", "C"];
    for (let i = 0; i < 60; i++) {
      db.insert(playersT)
        .values({
          id: `${saveId}:test-prospect-${i}`,
          saveId,
          name: `测试新秀 ${i + 1}`,
          teamId: null,
          position: positions[i % 5],
          secondPosition: null,
          age: 19,
          heightCm: 200,
          weightKg: 100,
          draftYear: season,
          draftRound: null,
          draftPick: null,
          yearsPro: 0,
          ratings: mkRatings(72 - Math.floor(i / 6)),
          seasonStats: [],
          careerStats: [],
          contract: { type: "ROOKIE", years: [], birdRights: false, noTrade: false, option: null, signedSeason: season },
          status: "PROSPECT",
          role: "BENCH",
          satisfaction: 70,
          injury: null,
          development: { trajectory: "GROWING", growthLeft: 8, lastDelta: 0 },
          tenure: 0,
          stamina: 1,
          lastGameDate: null,
          source: {
            provider: "CSV_JSON",
            sourceUrl: "https://example.com/test-prospects",
            retrievedAt: new Date().toISOString(),
            season,
            licenseNote: "test fixture — synthetic prospects for mechanics coverage",
            status: "IMPORTED",
            ratingVersion: "test",
          },
        })
        .run();
    }
    // Put the save into DRAFT with a full 60-slot order honoring REAL pick
    // ownership — AI trades may have moved picks, so each slot goes to the
    // current holder, not the original team.
    const { draftPicks: picksT } = await import("@/db/schema");
    const pickRows = db
      .select()
      .from(picksT)
      .where(and(eq(picksT.saveId, saveId), eq(picksT.year, season)))
      .all();
    const byRound = (r: number) =>
      pickRows
        .filter((p) => p.round === r)
        .sort((a, b) => a.originalTeamId.localeCompare(b.originalTeamId))
        .map((p, i) => ({ pickNumber: i + 1, round: r, holderTeamId: p.holderTeamId.split(":").pop()! }));
    const order = [...byRound(1), ...byRound(2)];
    db.update(savesT)
      .set({ season, phase: "DRAFT", phaseState: { draft: { order, lottery: [], worst14: [] } } as never, updatedAt: new Date().toISOString() })
      .where(eq(savesT.id, saveId))
      .run();

    const board = getDraftBoard(saveId);
    expect(board).toHaveLength(60);
    expect(board.every((p) => p.scouting.floor <= p.scouting.ceiling)).toBe(true);

    const picked = makeDraftPick(saveId, { simulateAll: true });
    expect(picked.length).toBe(60);
    expect(getSave(saveId)!.phase).toBe("FREE_AGENCY");

    const state = loadLeagueState(saveId);
    const rookies = state.players.filter((p) => p.contract.type === "ROOKIE" && p.status === "ACTIVE");
    expect(rookies.length).toBeGreaterThanOrEqual(55);
  }, 120_000);
});
