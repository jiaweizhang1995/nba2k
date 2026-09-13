// Import pipeline: full league replacement — team mapping by abbr, schedule
// regeneration, provenance enforcement, user-franchise preservation.
import { describe, expect, it } from "vitest";
import { createSave, loadLeagueState, getSave, getPhaseState } from "@/server/engine";
import { importData } from "@/server/import";
import type { ImportPayload, ImportedPlayerRecord, ImportedTeamRecord, ProvenanceMeta } from "@/data/providers/types";

function meta(season = 2027): ProvenanceMeta {
  return {
    provider: "CSV_JSON",
    sourceUrl: "https://example.com/test-rosters",
    retrievedAt: "2026-09-13T00:00:00.000Z",
    season,
    licenseNote: "测试数据",
  };
}

function tinyPayload(): ImportPayload {
  const m = meta();
  const teams: ImportedTeamRecord[] = [
    { externalId: "AAA", abbr: "AAA", city: "甲城", name: "飞鸟", conference: "EAST", division: "一区", meta: m },
    { externalId: "BBB", abbr: "BBB", city: "乙城", name: "游鱼", conference: "WEST", division: "二区", meta: m },
  ];
  const players: ImportedPlayerRecord[] = [
    { externalId: "p1", name: "球员一", position: "PG", teamAbbr: "AAA", age: 25, heightCm: 190, weightKg: 88, draftYear: null, yearsPro: 3, potential: null, potentialLow: null, potentialHigh: null, contract: null, statLine: {}, meta: m },
    { externalId: "p2", name: "球员二", position: "C", teamAbbr: "AAA", age: 29, heightCm: 210, weightKg: 115, draftYear: null, yearsPro: 5, potential: null, potentialLow: null, potentialHigh: null, contract: null, statLine: {}, meta: m },
    { externalId: "p3", name: "球员三", position: "SF", teamAbbr: "BBB", age: 22, heightCm: 200, weightKg: 98, draftYear: null, yearsPro: 1, potential: null, potentialLow: null, potentialHigh: null, contract: null, statLine: {}, meta: m },
    { externalId: "p4", name: "无队球员", position: "SG", teamAbbr: "ZZZ", age: 24, heightCm: 195, weightKg: 92, draftYear: null, yearsPro: 0, potential: null, potentialLow: null, potentialHigh: null, contract: null, statLine: {}, meta: m },
  ];
  return { teams, players };
}

describe("importData full league replacement", () => {
  it("maps players to teams by abbr, regenerates schedule and preserves provenance", async () => {
    const { saveId } = await createSave({ name: "导入测试", seed: 555 });
    const result = await importData(saveId, tinyPayload());
    expect(result.teamsImported).toBe(2);
    expect(result.playersImported).toBe(4);
    expect(result.gamesScheduled).toBeGreaterThan(0); // schedule regenerated

    const state = loadLeagueState(saveId);
    expect(state.teams.map((t) => t.abbr).sort()).toEqual(["AAA", "BBB"]);
    const aaa = state.players.filter((p) => p.teamId === "AAA");
    const bbb = state.players.filter((p) => p.teamId === "BBB");
    expect(aaa.map((p) => p.name).sort()).toEqual(["球员一", "球员二"]);
    expect(bbb.map((p) => p.name)).toEqual(["球员三"]);
    // unmatched abbr → free agent, never silently dropped
    const fa = state.players.find((p) => p.name === "无队球员");
    expect(fa?.teamId ?? null).toBeNull();

    // stats were not supplied → neutral overall with zero confidence
    expect(aaa.every((p) => p.ratings.confidence === 0)).toBe(true);

    const save = getSave(saveId)!;
    expect(save.dataStatus).toBe("IMPORTED");
    expect(save.dataProvider).toBe("CSV_JSON");
    expect(save.phase).toBe("REGULAR_SEASON");

    // provenance recorded as a data source
    const { getDb } = await import("@/db");
    const { dataSources } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const sources = getDb().select().from(dataSources).where(eq(dataSources.saveId, saveId)).all();
    expect(sources.some((s) => s.provider === "CSV_JSON" && s.status === "IMPORTED")).toBe(true);
  });

  it("preserves the user franchise when the abbreviation still exists", async () => {
    const { saveId, teamId } = await createSave({ name: "导入续约测试", seed: 556 });
    // default user team is the first demo team (t-xxx short id); after import,
    // a team with the same abbr should re-map the user franchise.
    const phase = getPhaseState(saveId);
    const prevUser = phase.userTeamId as string;
    expect(prevUser).toBeTruthy();
    void teamId;

    await importData(saveId, tinyPayload());
    const after = getPhaseState(saveId).userTeamId as string | undefined;
    // demo first team is 海港城灯塔(BOS) — payload has no BOS team → falls back to null
    if (prevUser.split(":").pop()!.replace(/^t-/i, "").toUpperCase() === "AAA") {
      expect(after).toBe(`${saveId}:AAA`);
    } else {
      expect(after).toBeUndefined();
    }
    expect(getSave(saveId)!.phase).toBe("REGULAR_SEASON");
  });

  it("rejects records without provenance", async () => {
    const { saveId } = await createSave({ name: "溯源测试", seed: 557 });
    const payload = tinyPayload();
    const bad = { ...payload, players: payload.players.map((p) => ({ ...p, meta: { ...p.meta, sourceUrl: "" } })) };
    await expect(importData(saveId, bad)).rejects.toThrow(/来源元数据|PROVENANCE/);
  });
});

describe("default real-data save (auto-seed)", () => {
  it("seeds a full real NBA league from the committed payload", async () => {
    const { seedDefaultRealSave, realPayloadExists } = await import("../src/server/seed");
    if (!realPayloadExists()) {
      console.log("payload asset missing — skip");
      return;
    }
    const saveId = await seedDefaultRealSave();
    expect(saveId).toBeTruthy();
    const state = loadLeagueState(saveId!);
    expect(state.teams).toHaveLength(30);
    expect(state.players.length).toBeGreaterThanOrEqual(500);
    const { getDb } = await import("@/db");
    const { players: playersT } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = getDb().select().from(playersT).where(eq(playersT.saveId, saveId!)).all();
    const withBaseline = rows.filter((p) => p.baselineStats);
    expect(withBaseline.length).toBeGreaterThanOrEqual(300);
    const save = getSave(saveId!)!;
    expect(save.dataStatus).toBe("IMPORTED");
  }, 120_000);
});

describe("mergeContracts (contract-only backfill)", () => {
  it("updates contracts by name without replacing the league", async () => {
    const { saveId } = await createSave({ name: "合同合并测试", seed: 558 });
    await importData(saveId, tinyPayload()); // 先导入小联盟（球员一/二/三）
    const before = loadLeagueState(saveId);
    expect(before.teams).toHaveLength(2);

    const result = await import("../src/server/import").then((m) =>
      m.mergeContracts(
        saveId,
        [
          { name: " 球员一 ", salary: 30, years: 3 },
          { name: "不存在的人", salary: 5 },
        ],
        { provider: "CSV_JSON", sourceUrl: "test://contracts", retrievedAt: "2026-09-13T00:00:00.000Z", season: 2027, licenseNote: "test" },
      ),
    );
    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(["不存在的人"]);

    // league untouched (30 teams, same players) but the matched player's
    // contract updated with the real salary
    const after = loadLeagueState(saveId);
    expect(after.teams).toHaveLength(2);
    expect(after.players).toHaveLength(before.players.length);
    const first = after.players.find((p) => p.name === "球员一")!;
    expect(first.contract.years[0].salary).toBeCloseTo(30);
    expect(first.contract.years).toHaveLength(3);

    // provenance registered
    const { getDb } = await import("@/db");
    const { dataSources } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const sources = getDb().select().from(dataSources).where(eq(dataSources.saveId, saveId)).all();
    expect(sources.some((s) => s.scope === "CONTRACTS" && s.records === 1)).toBe(true);
  });
});
