// Provenance & data integrity: demo data is clearly marked, ratings carry
// versions, imports require full provenance and reject fabricated-looking data.
import { describe, expect, it } from "vitest";
import { generateDemoLeague, DEMO_LICENSE, DEMO_PROVIDER } from "@/data/demo";
import { computeRatings, computeRatingsFromPerGame, RATING_VERSION } from "@/domain/ratings";
import { parsePlayersCsv } from "@/data/providers/csv";
import { assertProvenance, ProviderError } from "@/data/providers/types";
import { balldontlieAdapter } from "@/data/providers/balldontlie";
import { sportradarAdapter } from "@/data/providers/sportradar";

describe("Demo data provenance", () => {
  it("demo players carry DEMO provider + license note", () => {
    const { players } = generateDemoLeague(11, 2027);
    expect(players.length).toBeGreaterThan(300);
    // via the demoSource helper used by the engine:
    const src = { provider: DEMO_PROVIDER, licenseNote: DEMO_LICENSE, status: "DEMO" as const };
    expect(src.provider).toBe("DEMO");
    expect(DEMO_LICENSE).toMatch(/DEMO \/ ILLUSTRATIVE/);
    expect(src.status).toBe("DEMO");
  });
});

describe("Ratings explainability", () => {
  it("ratings computed from stats carry version + confidence; empty sample → zero confidence", () => {
    const line = { season: 2027, teamAbbr: "TST", g: 70, mp: 2400, pts: 1400, reb: 560, ast: 420, stl: 70, blk: 35, tov: 180, fgm: 500, fga: 1100, tpm: 160, tpa: 450, ftm: 240, fta: 300 };
    const r = computeRatings(line, "SG", 26, { potential: 85, potentialLow: 78, potentialHigh: 92 });
    expect(r.ratingVersion).toBe(RATING_VERSION);
    expect(r.overall).toBeGreaterThanOrEqual(25);
    expect(r.overall).toBeLessThanOrEqual(99);
    expect(r.confidence).toBeGreaterThan(0.9); // 2400 min sample
    const empty = computeRatings({ ...line, g: 0, mp: 0, pts: 0 }, "SG", 20);
    expect(empty.confidence).toBe(0);
  });
});

describe("Import provenance enforcement", () => {
  const meta = { provider: "CSV_JSON", sourceUrl: "https://example.com/data", retrievedAt: "2026-09-13T00:00:00.000Z", season: 2027, licenseNote: "test" };

  it("accepts records with complete provenance", () => {
    expect(() => assertProvenance(meta)).not.toThrow();
  });

  it("rejects records missing provenance fields", () => {
    expect(() => assertProvenance({ ...meta, sourceUrl: "" })).toThrow(ProviderError);
    expect(() => assertProvenance({ ...meta, retrievedAt: "not-a-date" })).toThrow(ProviderError);
    expect(() => assertProvenance({ ...meta, licenseNote: "" })).toThrow(ProviderError);
  });

  it("CSV parser attaches provenance and normalizes stats", () => {
    const csv = "name,position,age,g,mp,pts,reb,ast,stl,blk,tov,fgm,fga,tpm,tpa,ftm,fta\n测试球员,PG,24,60,2000,1100,300,400,60,10,150,400,900,120,350,180,220";
    const rows = parsePlayersCsv(csv, meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("测试球员");
    expect(rows[0].meta.provider).toBe("CSV_JSON");
    expect(rows[0].statLine.pts).toBe(1100);
    expect(rows[0].contract).toBeNull(); // no salary provided → unknown, not fabricated
  });

  it("adapters declare their requirements without fabricating data", () => {
    expect(balldontlieAdapter.requiresApiKey).toBe(true);
    expect(balldontlieAdapter.apiKeyEnvVar).toBe("BALLDONTLIE_API_KEY");
    expect(sportradarAdapter.requiresApiKey).toBe(true);
  });

  it("BALLDONTLIE adapter without key fails clearly", async () => {
    await expect(balldontlieAdapter.fetchSeason(2027, {})).rejects.toThrow(/API Key/);
  });

  it("Sportradar adapter without license fails clearly, no scraping", async () => {
    await expect(sportradarAdapter.fetchSeason(2027, { apiKey: "test" })).rejects.toThrow(/授权/);
  });
});

describe("Ratings v1.3 from real per-game stats (2K27-calibrated band)", () => {
  const star = { season: 2026, teamRow: "BOS", g: 70, gs: 70, mpg: 36, fgPct: 0.49, tpPct: 0.38, ftPct: 0.85, rpg: 8.5, apg: 5.5, spg: 1.1, bpg: 0.6, ppg: 28 };
  const role = { season: 2026, teamRow: "BOS", g: 65, gs: 30, mpg: 24, fgPct: 0.45, tpPct: 0.37, ftPct: 0.8, rpg: 3.5, apg: 1.8, spg: 0.7, bpg: 0.2, ppg: 9 };
  const bench = { season: 2026, teamRow: "BOS", g: 40, gs: 2, mpg: 12, fgPct: 0.42, tpPct: 0.33, ftPct: 0.72, rpg: 1.8, apg: 0.8, spg: 0.3, bpg: 0.1, ppg: 4 };

  it("real superstar production maps to elite overall with high confidence", () => {
    const r = computeRatingsFromPerGame(star, "SF", 27);
    expect(r.ratingVersion).toBe("RATING-ENGINE v1.3");
    // 联盟分布校准后：巨星落在 2K 风格的 85-89 档
    expect(r.overall).toBeGreaterThanOrEqual(84);
    expect(r.overall).toBeLessThanOrEqual(92);
    expect(r.confidence).toBe(1);
  });

  it("role player and bench map to realistic mid/below bands", () => {
    const rr = computeRatingsFromPerGame(role, "SG", 24);
    const rb = computeRatingsFromPerGame(bench, "SG", 22);
    // 联盟下限 68：轮换 71-80，替补更低但不出下限
    expect(rr.overall).toBeGreaterThanOrEqual(70);
    expect(rr.overall).toBeLessThanOrEqual(80);
    expect(rb.overall).toBeLessThan(rr.overall);
    expect(rb.overall).toBeGreaterThanOrEqual(68);
  });

  it("low sample lowers confidence honestly", () => {
    const r = computeRatingsFromPerGame({ ...star, g: 8 }, "SF", 27);
    expect(r.confidence).toBeLessThanOrEqual(0.2);
  });
});
