// Agent-realism regressions: the mechanics that make the sim a fair test of
// GM intelligence — real years-of-service for awards, user-side contract
// expiry + Bird-rights re-signing, cut-down-day roster enforcement, AI phase
// refresh, and the AI↔AI offseason trade market.
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, teams as teamsT, events as eventsT } from "@/db/schema";
import {
  advanceSim,
  createSave,
  executeTrade,
  getSave,
  listInboundOffers,
  makeDraftPick,
  respondInboundOffer,
  startNewSeason,
  submitFaOffer,
  waivePlayer,
} from "@/server/engine";
import { generateDraftClass } from "@/domain/draft";
import { askingSalaryFor, canAfford } from "@/domain/freeagency";
import { CBA, maxContractValue } from "@/domain/salary";

let saveId: string;
let userShort: string;
let starId: string;

beforeAll(async () => {
  const s = await createSave({ name: "agent 真实性回归", seed: 777001 });
  saveId = s.saveId;
  userShort = s.teamId.split(":").pop()!;
  const db = getDb();
  const save = getSave(saveId)!;
  // Force the user's best player's contract to end this season, so the
  // upcoming offseason exercises the expiry → free agency → bird-rights path.
  const star = db
    .select()
    .from(playersT)
    .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
    .all()
    .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
  db.update(playersT)
    .set({ contract: { ...star.contract, years: [{ season: save.season, salary: 30 }] } })
    .where(eq(playersT.id, star.id))
    .run();
  starId = star.id;
}, 120_000);

describe("imported real players carry real service time", () => {
  it("veterans get estimated yearsPro instead of 0", () => {
    const vets = getDb()
      .select()
      .from(playersT)
      .where(eq(playersT.saveId, saveId))
      .all()
      .filter((p) => p.age >= 30);
    expect(vets.length).toBeGreaterThan(10);
    expect(vets.every((p) => p.yearsPro >= 9)).toBe(true);
  });
});

describe("awards eligibility + user contract expiry", () => {
  it("ROY goes to a genuine first/second-year player, never a 34yo vet", () => {
    const r = advanceSim(saveId, "SEASON");
    const roy = r.awards.find((a) => a.type === "ROY");
    if (roy?.player) {
      const row = getDb()
        .select()
        .from(playersT)
        .where(eq(playersT.saveId, saveId))
        .all()
        .find((p) => p.name === roy.player);
      expect(row).toBeTruthy();
      expect(row!.yearsPro).toBeLessThanOrEqual(1);
    }
  }, 300_000);

  it("aging is real: retirees exist, no 43+ player stays active", () => {
    const all = getDb().select().from(playersT).where(eq(playersT.saveId, saveId)).all();
    const old = all.filter((p) => (p.status === "ACTIVE" || p.status === "INJURED") && p.age >= 43);
    expect(old.length).toBe(0);
    const retired = all.filter((p) => p.status === "RETIRED");
    expect(retired.length).toBeGreaterThan(0);
  });

  it("mid-season trade deadline fires once: flag persisted, deals bounded at 4", () => {
    const save = getSave(saveId)!;
    // season already rolled to next year in phaseState — the deadline ran
    // during the *previous* season's Feb window.
    const flag = (save.phaseState as Record<string, unknown>)[`deadlineMarket:${save.season - 1}`];
    expect(flag).toBe(true);
    const deadlineDeals = getDb()
      .select()
      .from(eventsT)
      .where(and(eq(eventsT.saveId, saveId), eq(eventsT.category, "TRADE")))
      .all()
      .filter((e) => e.message.includes("（AI 交易截止日）"));
    expect(deadlineDeals.length).toBeLessThanOrEqual(4);
  });

  it("user's expiring star enters the market with lastTeamId (not auto-resigned)", () => {
    const after = getDb().select().from(playersT).where(eq(playersT.id, starId)).get()!;
    expect(after.status).toBe("FREE_AGENT");
    expect(after.teamId).toBeNull();
    expect(after.lastTeamId).toBe(`${saveId}:${userShort}`);
  });
});

describe("bird rights + cut-down day + AI league dynamics", () => {
  it("bird rights let an over-cap team re-sign its own free agent", () => {
    const db = getDb();
    makeDraftPick(saveId, { simulateAll: true });
    expect(getSave(saveId)!.phase).toBe("FREE_AGENCY");
    const own = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT"), eq(playersT.lastTeamId, `${saveId}:${userShort}`)))
      .all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
    expect(own).toBeTruthy();
    // Offer his full max-contract number — bird covers the cap side, and a
    // max offer should clear the interest bar comfortably.
    const offer = Math.min(49, maxContractValue(own!.yearsPro, 1).firstYear);
    const r = submitFaOffer(saveId, own!.id.split(":").slice(1).join(":"), 2, offer);
    // Rejection by interest is acceptable; what must NOT happen is a
    // cap/space refusal — bird rights bypass it.
    if (!r.accepted) {
      expect(r.reason ?? "").not.toMatch(/薪资空间不足|土豪线|中产特例/);
    }
    expect(r.interest).toBeGreaterThanOrEqual(60);
  });

  it("startNewSeason refuses when the user roster exceeds 18", () => {
    const db = getDb();
    // Sign cheap FAs until the user roster passes the regulation max.
    const fas = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.status, "FREE_AGENT")))
      .all()
      .filter((p) => p.teamId === null)
      .sort((a, b) => a.ratings.overall - b.ratings.overall);
    for (const fa of fas) {
      const rosterCount = db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
        .all().length;
      if (rosterCount > CBA.maxRosterSize) break;
      // Young FAs demand 4-year deals; the accept rule needs ≥60% of ask.
      submitFaOffer(saveId, fa.id.split(":").slice(1).join(":"), 3, CBA.minimumSalary);
    }
    const finalCount = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
      .all().length;
    if (finalCount > CBA.maxRosterSize) {
      let threw = false;
      try {
        startNewSeason(saveId);
      } catch (e) {
        threw = true;
        expect((e as Error).message).toContain("裁");
      }
      expect(threw).toBe(true);
      // Waive back down, then the season must be allowed to start.
      for (;;) {
        const roster = db
          .select()
          .from(playersT)
          .where(and(eq(playersT.saveId, saveId), eq(playersT.teamId, `${saveId}:${userShort}`)))
          .all()
          .sort((a, b) => a.ratings.overall - b.ratings.overall);
        if (roster.length <= CBA.maxRosterSize) break;
        waivePlayer(saveId, roster[0].id.split(":").slice(1).join(":"));
      }
    }
    startNewSeason(saveId);
    expect(getSave(saveId)!.phase).toBe("REGULAR_SEASON");
  }, 120_000);

  it("AI phases are re-derived from last season's standings", () => {
    const phases = new Set(
      getDb()
        .select()
        .from(teamsT)
        .where(eq(teamsT.saveId, saveId))
        .all()
        .map((t) => t.aiPhase),
    );
    // A full season of standings must produce at least two distinct phases.
    expect(phases.size).toBeGreaterThanOrEqual(2);
  });

  it("AI↔AI trade market actually deals, stays bounded, and never involves the user's team", () => {
    const events = getDb()
      .select()
      .from(eventsT)
      .where(and(eq(eventsT.saveId, saveId), eq(eventsT.category, "TRADE")))
      .all();
    const deals = events.filter((e) => e.message.includes("（AI 休赛期交易）") || e.message.includes("（AI 交易截止日）"));
    const summary = events.find((e) => e.message.includes("休赛期 AI 交易市场") || e.message.includes("交易截止日：AI 球队"));
    // A living league: rebuilders shop vets to contenders — expect real volume.
    expect(deals.length).toBeGreaterThanOrEqual(1);
    expect(deals.length).toBeLessThanOrEqual(10);
    expect(summary).toBeTruthy();
    // The market must never touch the user's roster — the GM's assets are his own.
    for (const e of deals) {
      expect(e.message).not.toContain(`${userShort} 送出`);
      expect(e.message).not.toContain(`送出 ${userShort}`);
    }
  });
});

describe("mid-level exception is a single annual exception", () => {
  const mkTeam = (totalSalary: number): import("@/domain/trade").TradeTeam => ({
    id: "T", abbr: "T", players: Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, teamId: "T", position: "SG", age: 27, yearsPro: 5,
      ratings: { overall: 70 } as never,
      contract: { type: "VETERAN" as const, years: [{ season: 2027, salary: totalSalary / 14 }], birdRights: false, noTrade: false, option: null, signedSeason: 2026 },
      status: "ACTIVE", role: "BENCH",
    })),
    picks: [], aiPhase: "PLAYOFF", aiRisk: 0.5, deadMoney: 0,
  });

  it("an over-cap team gets ONE MLE — the second MLE-sized offer is rejected", () => {
    const team = mkTeam(160); // over cap, under first apron
    expect(canAfford(team, 12, 15, 0, false).ok).toBe(true);
    expect(canAfford(team, 12, 15, 0, true).ok).toBe(false);
    // minimum deals still work after the MLE is spent
    expect(canAfford(team, CBA.minimumSalary, 15, 0, true).ok).toBe(true);
  });
});

describe("market-rate free agency pricing", () => {
  const cheapRookieDeal = { type: "ROOKIE" as const, years: [{ season: 2027, salary: 4 }], birdRights: false, noTrade: false, option: null, signedSeason: 2024 };

  it("an 85-overall star off a rookie deal asks near-max, not prev×1.05", () => {
    const ask = askingSalaryFor(cheapRookieDeal, 4, 85, 23);
    const maxFirst = maxContractValue(4, 1).firstYear;
    // 85 → 65% of the service-tier max — market money, not a discount.
    expect(ask).toBeCloseTo(maxFirst * 0.65, 1);
    expect(ask).toBeGreaterThan(15);
  });

  it("an aging ex-max player's anchor weakens — the market corrects him", () => {
    const oldMax = { ...cheapRookieDeal, type: "MAX" as const, years: [{ season: 2027, salary: 50 }] };
    const ask = askingSalaryFor(oldMax, 15, 74, 34);
    // rating 74 → 16% of max; old anchor decayed 50% → 25M vs rating ~7.7M.
    expect(ask).toBeLessThanOrEqual(26);
    expect(ask).toBeGreaterThanOrEqual(CBA.minimumSalary);
  });
});

describe("draft class floor", () => {
  it("even a weak class has draftable first-round talent", () => {
    for (const season of [2028, 2029, 2030, 2031, 2032]) {
      const cls = generateDraftClass(777001, season);
      expect(cls.filter((p) => p.ratings.overall >= 64).length).toBeGreaterThanOrEqual(3);
      expect(cls).toHaveLength(60);
    }
  });

  it("generational talents exist across years (~18% of classes) and are visibly elite", () => {
    let genCount = 0;
    for (let season = 2027; season <= 2046; season++) {
      const cls = generateDraftClass(555777, season);
      const best = Math.max(...cls.map((p) => p.ratings.overall));
      if (best >= 78) genCount++;
    }
    // 20 seasons at ~18% → expect 2-8 generational classes, never zero.
    expect(genCount).toBeGreaterThanOrEqual(2);
    expect(genCount).toBeLessThanOrEqual(9);
  });
});

describe("inbound trade offers", () => {
  it("a deadline offer persists past the market flag write and accepts cleanly", async () => {
    // Seed 555005 deterministically produces a deadline offer — the flag
    // write must not clobber it, and accepting must clear normal validation.
    const s = await createSave({ name: "inbound 回归", seed: 555005 });
    for (let i = 0; i < 8; i++) {
      await advanceSim(s.saveId, "MONTH");
      const sv = getSave(s.saveId)!;
      if ((sv.phaseState as Record<string, unknown>)[`deadlineMarket:${sv.season}`]) break;
    }
    const offers = listInboundOffers(s.saveId);
    expect(offers.length).toBeGreaterThanOrEqual(1);
    const offer = offers[0];
    expect(offer.playerName).not.toBe("?");
    expect(offer.asks.length).toBeGreaterThan(0);
    const res = respondInboundOffer(s.saveId, offer.id, true);
    expect(res.accepted).toBe(true);
    expect(listInboundOffers(s.saveId)).toHaveLength(0);
  }, 120_000);

  it("the trade window closes after Feb 6 — user trades get a WINDOW block", async () => {
    const s = await createSave({ name: "deadline window", seed: 555006 });
    for (let i = 0; i < 8; i++) {
      await advanceSim(s.saveId, "MONTH");
      const sv = getSave(s.saveId)!;
      if ((sv.phaseState as Record<string, unknown>)[`deadlineMarket:${sv.season}`]) break;
    }
    const sv = getSave(s.saveId)!;
    expect(sv.phase).toBe("REGULAR_SEASON");
    expect(sv.currentDate > `${sv.season}-02-06`).toBe(true);
    const res = executeTrade(s.saveId, [
      { teamId: "SAC", gives: [{ kind: "PLAYER", id: "x" }], receives: [{ kind: "PLAYER", id: "y" }] },
      { teamId: "LAL", gives: [{ kind: "PLAYER", id: "y" }], receives: [{ kind: "PLAYER", id: "x" }] },
    ]);
    expect(res.executed).toBe(false);
    expect(res.validation?.issues.some((i) => i.code === "WINDOW")).toBe(true);
  }, 120_000);
});
