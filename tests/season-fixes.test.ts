// Regression tests for the issues found in the 5-year Kings playthrough:
// SEASON-mode champion recording, waivers/dead money, the generated draft
// class for real-data saves, and AI roster-fill fairness in free agency.
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, awards as awardsT, teams as teamsT } from "@/db/schema";
import {
  advanceSim,
  createSave,
  deadCapHit,
  getDraftBoard,
  getSave,
  makeDraftPick,
  startNewSeason,
  submitFaOffer,
  waivePlayer,
} from "@/server/engine";
import { generateDraftClass } from "@/domain/draft";
import { CBA, capSnapshot, seasonMoney } from "@/domain/salary";

let saveId: string;
let userShort: string;

beforeAll(async () => {
  const s = await createSave({ name: "赛季修复回归", seed: 42424 });
  saveId = s.saveId;
  userShort = s.teamId.split(":").pop()!;
}, 120_000);

describe("generated draft class (domain)", () => {
  it("is deterministic and well-formed", () => {
    const a = generateDraftClass(42424, 2028);
    const b = generateDraftClass(42424, 2028);
    expect(a).toHaveLength(60);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateDraftClass(42424, 2029);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
    for (const p of a) {
      expect(p.ratings.overall).toBeGreaterThanOrEqual(40);
      expect(p.ratings.overall).toBeLessThanOrEqual(90);
      expect(p.ratings.potential ?? 0).toBeGreaterThanOrEqual(p.ratings.overall);
      expect(p.ratings.potentialLow! <= p.ratings.potentialHigh!).toBe(true);
      expect(["PG", "SG", "SF", "PF", "C"]).toContain(p.position);
      expect(p.age).toBeGreaterThanOrEqual(19);
      expect(p.age).toBeLessThanOrEqual(22);
    }
  });
});

describe("SEASON-mode champion recording", () => {
  it("advanceSim SEASON records champion + awards + draft class", () => {
    const r = advanceSim(saveId, "SEASON");
    expect(r.champion).toBeTruthy();
    expect(r.awards.some((a) => a.type === "CHAMPION")).toBe(true);
    const save = getSave(saveId)!;
    expect(save.phase).toBe("DRAFT");
    const champRow = getDb()
      .select()
      .from(awardsT)
      .where(and(eq(awardsT.saveId, saveId), eq(awardsT.season, save.season - 1), eq(awardsT.type, "CHAMPION")))
      .get();
    expect(champRow).toBeTruthy();
    // 60-man synthetic class generated for the upcoming draft
    expect(getDraftBoard(saveId)).toHaveLength(60);
  }, 300_000);
});

describe("free agency fairness + roster fill", () => {
  it("draft resolves real rookies; quality FAs survive the auto-fill pass", () => {
    const picked = makeDraftPick(saveId, { simulateAll: true });
    expect(picked.length).toBe(60);
    expect(picked.every((p) => p.prospect !== null)).toBe(true);
    expect(getSave(saveId)!.phase).toBe("FREE_AGENCY");

    const db = getDb();
    const save = getSave(saveId)!;
    const fas = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
      .all()
      .filter((p) => p.teamId === null);
    // Filler pass signs only <72 overall: at least one quality FA remains.
    expect(fas.some((p) => p.ratings.overall >= 72)).toBe(true);
    void save;
  }, 120_000);

  it("waive frees a roster spot but leaves honest dead money on the cap", () => {
    const db = getDb();
    // Since the fix, the user's own expiring players reach free agency — the
    // roster may sit at the 13-man floor. Sign a cheap body first so the
    // waive doesn't breach the minimum.
    const tried = new Set<string>();
    for (;;) {
      const cur = db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
        .all();
      if (cur.length > CBA.minRosterSize) break;
      const fa = db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
        .all()
        .filter((p) => p.teamId === null && !tried.has(p.id))
        .sort((a, b) => a.ratings.overall - b.ratings.overall)[0];
      if (!fa) break;
      tried.add(fa.id);
      // Young FAs demand 4-year deals; the accept rule needs ≥60% of ask.
      // League minimum grows with the cap — use the save's current season.
      submitFaOffer(saveId, fa.id.split(":").slice(1).join(":"), 3, seasonMoney(getSave(saveId)!.season).minimumSalary);
    }
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
      .all()
      .sort((a, b) => (b.contract.years[0]?.salary ?? 0) - (a.contract.years[0]?.salary ?? 0));
    expect(roster.length).toBeGreaterThan(CBA.minRosterSize);
    const victim = roster[0];
    const salary = victim.contract.years[0]?.salary ?? 0;
    const before = capSnapshot(roster, roster.length);

    const r = waivePlayer(saveId, victim.id.split(":").slice(1).join(":"));
    expect(r.waived).toBe(victim.name);
    expect(r.total).toBeGreaterThan(0);
    expect(deadCapHit(saveId, userShort)).toBeCloseTo(salary, 1);

    const after = db.select().from(playersT).where(eq(playersT.id, victim.id)).get()!;
    expect(after.status).toBe("FREE_AGENT");
    expect(after.teamId).toBeNull();

    const newRoster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
      .all();
    const snapAfter = capSnapshot(newRoster, newRoster.length, deadCapHit(saveId, userShort));
    // Dead money keeps the total unchanged: the books stay honest.
    expect(snapAfter.totalSalary).toBeCloseTo(before.totalSalary, 1);
  });

  it("startNewSeason fills AI rosters to 15 at market value", () => {
    startNewSeason(saveId);
    expect(getSave(saveId)!.phase).toBe("REGULAR_SEASON");
    const db = getDb();
    const teams = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
    const sizes = teams
      .filter((t) => t.id !== `${saveId}:${userShort}`)
      .map((t) => db.select().from(playersT).where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, t.id))).all().length);
    const at15 = sizes.filter((n) => n >= 15).length;
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(CBA.minRosterSize);
    expect(at15).toBeGreaterThanOrEqual(20);
  }, 120_000);
});
