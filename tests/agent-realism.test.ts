// Agent-realism regressions: the mechanics that make the sim a fair test of
// GM intelligence — real years-of-service for awards, user-side contract
// expiry + Bird-rights re-signing, cut-down-day roster enforcement, AI phase
// refresh, and the AI↔AI offseason trade market.
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, teams as teamsT, events as eventsT, saves as savesT, draftPicks as picksT } from "@/db/schema";
import {
  advanceSim,
  createSave,
  deadCapHit,
  executeTrade,
  extendContract,
  getDraftOrder,
  getPhaseState,
  getSave,
  listInboundOffers,
  listOfferSheets,
  loadLeagueState,
  makeDraftPick,
  respondInboundOffer,
  respondOfferSheet,
  setRotation,
  startNewSeason,
  submitFaOffer,
  validateTradeOnServer,
  waivePlayer,
} from "@/server/engine";
import { generateDraftClass } from "@/domain/draft";
import { applyDevelopment, devMinutesFactor } from "@/domain/sim/season";
import { askingSalaryFor, canAfford, evaluateOffer, isRestrictedFa } from "@/domain/freeagency";
import { CBA, maxContractValue, round2, seasonMoney } from "@/domain/salary";

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
      // League minimum scales with the cap — use the save's current season.
      submitFaOffer(saveId, fa.id.split(":").slice(1).join(":"), 3, seasonMoney(getSave(saveId)!.season).minimumSalary);
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

describe("live free-agency market", () => {
  it("the FA pool churns while the user waits — stars sign first", async () => {
    const s = await createSave({ name: "fa churn", seed: 555010 });
    await advanceSim(s.saveId, "SEASON");
    makeDraftPick(s.saveId, { simulateAll: true });
    expect(getSave(s.saveId)!.phase).toBe("FREE_AGENCY");
    const db = getDb();
    const poolOf = () =>
      db
        .select()
        .from(playersT)
        .where(and(eq(playersT.saveId, s.saveId), eq(playersT.status, "FREE_AGENT")))
        .all()
        .filter((p) => p.teamId === null);
    const before = poolOf();
    const starsBefore = before.filter((p) => p.ratings.overall >= 78).length;
    expect(before.length).toBeGreaterThan(10);
    // One week of open market: AI teams must actually sign people.
    await advanceSim(s.saveId, "WEEK");
    const after = poolOf();
    expect(after.length).toBeLessThan(before.length);
    const starsAfter = after.filter((p) => p.ratings.overall >= 78).length;
    expect(starsAfter).toBeLessThanOrEqual(starsBefore);
    // Second week keeps churning — the market doesn't freeze for the user.
    await advanceSim(s.saveId, "WEEK");
    expect(poolOf().length).toBeLessThanOrEqual(after.length);
  }, 300_000);
});

describe("restricted free agency — offer sheets + matching rights", () => {
  const makeUserRfa = (svId: string, userFull: string, aiTeamId: string, salary = 9, years = 3) => {
    const db = getDb();
    // Turn a real roster player into an expired-rookie FA on the market.
    const p = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, svId), eq(playersT.teamId, userFull)))
      .all()
      .filter((x) => x.status === "ACTIVE")
      .sort((a, b) => a.ratings.overall - b.ratings.overall)[0];
    db.update(playersT)
      .set({
        teamId: null,
        lastTeamId: userFull,
        status: "FREE_AGENT",
        contract: { type: "ROOKIE", years: [], birdRights: true, noTrade: false, option: null, signedSeason: getSave(svId)!.season - 4 },
      })
      .where(eq(playersT.id, p.id))
      .run();
    // Inject a pending offer sheet from the AI team.
    const save = getSave(svId)!;
    const key = `offerSheets:${save.season}`;
    const ps = getPhaseState(svId);
    const sheet = { id: `sheet:${p.id.split(":").pop()}`, playerId: p.id, fromTeamId: aiTeamId, salary, years, expiresOn: "2099-01-01" };
    db.update(savesT)
      .set({ phaseState: { ...ps, [key]: [sheet] } as never })
      .where(eq(savesT.id, svId))
      .run();
    return { playerId: p.id, sheetId: sheet.id };
  };

  it("RFA status, sheet match, decline, and window expiry all resolve correctly", async () => {
    const s = await createSave({ name: "rfa", seed: 555030 });
    await advanceSim(s.saveId, "SEASON");
    makeDraftPick(s.saveId, { simulateAll: true });
    expect(getSave(s.saveId)!.phase).toBe("FREE_AGENCY");
    const db = getDb();
    const userFull = `${s.saveId}:${s.teamId.split(":").pop()}`;
    const aiTeam = db.select().from(teamsT).where(eq(teamsT.saveId, s.saveId)).all().find((t) => t.id !== userFull)!;

    // sanity: a rookie-contract FA with a last team IS restricted
    const probe = { contract: { type: "ROOKIE" }, lastTeamId: userFull };
    expect(isRestrictedFa(probe)).toBe(true);
    expect(isRestrictedFa({ contract: { type: "VETERAN" }, lastTeamId: userFull })).toBe(false);
    expect(isRestrictedFa({ contract: { type: "ROOKIE" }, lastTeamId: null })).toBe(false);

    // 1) match → player returns on the sheet's terms
    const a = makeUserRfa(s.saveId, userFull, aiTeam.id, 11, 4);
    expect(listOfferSheets(s.saveId).length).toBe(1);
    const m = respondOfferSheet(s.saveId, a.sheetId, true);
    expect(m.matched).toBe(true);
    const pa = db.select().from(playersT).where(eq(playersT.id, a.playerId)).get()!;
    expect(pa.teamId).toBe(userFull);
    expect(pa.contract.years[0].salary).toBe(11);
    expect(pa.contract.years.length).toBe(4);
    expect(listOfferSheets(s.saveId).length).toBe(0);

    // 2) decline → player signs with the offering team
    const b = makeUserRfa(s.saveId, userFull, aiTeam.id, 8, 3);
    respondOfferSheet(s.saveId, b.sheetId, false);
    const pb = db.select().from(playersT).where(eq(playersT.id, b.playerId)).get()!;
    expect(pb.teamId).toBe(aiTeam.id);
    expect(pb.contract.years[0].salary).toBe(8);

    // 3) letting the window close forfeits — sheet finalizes to the offerer
    const c = makeUserRfa(s.saveId, userFull, aiTeam.id, 7, 2);
    startNewSeason(s.saveId);
    const pc = db.select().from(playersT).where(eq(playersT.id, c.playerId)).get()!;
    expect(pc.teamId).toBe(aiTeam.id);
    expect(listOfferSheets(s.saveId).length).toBe(0);
    expect(getSave(s.saveId)!.phase).toBe("REGULAR_SEASON");
  }, 300_000);

  it("poaching another team's RFA is never guaranteed — the incumbent can match", async () => {
    const s = await createSave({ name: "rfa poach", seed: 555031 });
    await advanceSim(s.saveId, "SEASON");
    makeDraftPick(s.saveId, { simulateAll: true });
    const db = getDb();
    const userFull = `${s.saveId}:${s.teamId.split(":").pop()}`;
    // An AI team's expired rookie hits the market restricted.
    const aiTeam = db.select().from(teamsT).where(eq(teamsT.saveId, s.saveId)).all().find((t) => t.id !== userFull)!;
    // Cheapest AI player → asking price is affordable even over the cap (MLE),
    // so the offer actually reaches the matching-rights check.
    const p = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, aiTeam.id)))
      .all()
      .sort((a, b) => a.ratings.overall - b.ratings.overall)[0];
    db.update(playersT)
      .set({
        teamId: null,
        lastTeamId: aiTeam.id,
        status: "FREE_AGENT",
        contract: { type: "ROOKIE", years: [], birdRights: true, noTrade: false, option: null, signedSeason: getSave(s.saveId)!.season - 4 },
      })
      .where(eq(playersT.id, p.id))
      .run();
    const ask = askingSalaryFor(p.contract, p.yearsPro, p.ratings.overall, p.age, getSave(s.saveId)!.season);
    const r = submitFaOffer(s.saveId, p.id.split(":").pop()!, 3, ask);
    const after = db.select().from(playersT).where(eq(playersT.id, p.id)).get()!;
    // Either the offer was matched (he re-signed with the AI incumbent) or he
    // actually joined us — but he can NEVER be signed around the match right.
    if (!r.accepted) {
      expect(r.reason).toContain("母队");
      expect(after.teamId).toBe(aiTeam.id);
    } else {
      expect(after.teamId).toBe(userFull);
    }
  }, 300_000);
});

describe("contract extensions — lock up expiring talent before the market", () => {
  it("extendable window, 140% rule, asking floor, once-per-season", async () => {
    const s = await createSave({ name: "extensions", seed: 555040 });
    const db = getDb();
    const userFull = `${s.saveId}:${s.teamId.split(":").pop()}`;
    const season = getSave(s.saveId)!.season;
    const userShort = s.teamId.split(":").pop()!;

    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, userFull)))
      .all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall);

    // Best player gets a 1-year deal → extendable
    const star = roster[0];
    db.update(playersT)
      .set({ contract: { ...star.contract, years: [{ season, salary: 20 }] } })
      .where(eq(playersT.id, star.id))
      .run();
    const ask = askingSalaryFor(star.contract, star.yearsPro, star.ratings.overall, star.age, season);

    // 140% rule: last year was 20M → first extension year ≤ 28M
    const tooRich = () => extendContract(s.saveId, star.id.split(":").pop()!, 3, 40);
    if (ask >= 40) {
      expect(tooRich).toThrow();
    }
    // Below-floor offer rejected (returns, not throws)
    const low = extendContract(s.saveId, star.id.split(":").pop()!, 3, seasonMoney(season).minimumSalary);
    expect(low.extended).toBe(false);
    expect((low as { reason?: string }).reason).toContain("拒绝");

    // Fair offer at asking → signed, years appended, satisfaction bump
    const before = db.select().from(playersT).where(eq(playersT.id, star.id)).get()!;
    const ok = extendContract(s.saveId, star.id.split(":").pop()!, 3, Math.min(ask, 28));
    if (Math.min(ask, 28) >= ask * 0.95) {
      expect(ok.extended).toBe(true);
      const after = db.select().from(playersT).where(eq(playersT.id, star.id)).get()!;
      expect(after.contract.years.length).toBe(4); // 1 left + 3 new
      expect(after.contract.years[0].salary).toBe(20); // existing year untouched
      expect(after.contract.years[1].salary).toBe(Math.round(Math.min(ask, 28) * 100) / 100);
      expect(after.satisfaction).toBe(Math.min(100, before.satisfaction + 5));
      // Once per season — a second negotiation is refused outright
      expect(() => extendContract(s.saveId, star.id.split(":").pop()!, 2, Math.min(ask, 28))).toThrow(/已与其续约/);
    }

    // A player with 3+ years left is NOT extendable
    const mid = roster[2];
    db.update(playersT)
      .set({ contract: { ...mid.contract, years: [{ season, salary: 10 }, { season: season + 1, salary: 10 }, { season: season + 2, salary: 10 }] } })
      .where(eq(playersT.id, mid.id))
      .run();
    expect(() => extendContract(s.saveId, mid.id.split(":").pop()!, 2, 15)).toThrow(/还剩 3 年/);

    // Someone else's player can't be extended
    const other = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId))).all().find((p) => p.teamId && p.teamId !== userFull)!;
    expect(() => extendContract(s.saveId, other.id.split(":").pop()!, 2, 10)).toThrow(/不在你的阵容/);

    void userShort;
  }, 120_000);
});

describe("player options are the player's call", () => {
  it("underpaid stars opt out; overpaid vets take the guaranteed year", async () => {
    const s = await createSave({ name: "player options", seed: 555080 });
    const db = getDb();
    const season = getSave(s.saveId)!.season;
    const all = db.select().from(playersT).where(eq(playersT.saveId, s.saveId)).all()
      .filter((p) => p.status === "ACTIVE" && p.teamId);
    // Eight clearly-underpaid stars on a PO year (option 6M vs ~30M ask) and
    // eight overpaid role players (option 12M vs ~8M ask) → mixed outcomes.
    const underpaid = all.filter((p) => p.ratings.overall >= 82).slice(0, 8);
    const overpaid = all.filter((p) => p.ratings.overall <= 72 && p.ratings.overall >= 65).slice(0, 8);
    for (const p of underpaid) {
      db.update(playersT).set({ contract: { ...p.contract, option: "PO", years: [{ season: season + 1, salary: 6 }] } }).where(eq(playersT.id, p.id)).run();
    }
    for (const p of overpaid) {
      db.update(playersT).set({ contract: { ...p.contract, option: "PO", years: [{ season: season + 1, salary: 14 }] } }).where(eq(playersT.id, p.id)).run();
    }
    await advanceSim(s.saveId, "SEASON");
    const readBack = (id: string) => db.select().from(playersT).where(eq(playersT.id, id)).get()!;
    const underOut = underpaid.filter((p) => readBack(p.id).status === "FREE_AGENT").length;
    const overOut = overpaid.filter((p) => readBack(p.id).status === "FREE_AGENT").length;
    // Underpaid stars mostly walk; overpaid vets overwhelmingly opt in.
    expect(underOut).toBeGreaterThanOrEqual(2);
    expect(overOut).toBeLessThanOrEqual(2);
    // Opted-in players consumed the option.
    const stayed = overpaid.map((p) => readBack(p.id)).filter((p) => p.status === "ACTIVE");
    for (const p of stayed) expect(p.contract.option).toBeNull();
  }, 300_000);
});

describe("pick protections actually protect", () => {
  it("a lottery-protected traded pick stays home and shifts the obligation", async () => {
    const s = await createSave({ name: "protection conveys", seed: 555090 });
    const db = getDb();
    const season = getSave(s.saveId)!.season;
    // Rig standings: ORL finishes dead last → guaranteed lottery slot.
    db.update(teamsT).set({ wins: 60, losses: 22 }).where(eq(teamsT.saveId, s.saveId)).run();
    const orl = db.select().from(teamsT).where(and(eq(teamsT.saveId, s.saveId), eq(teamsT.abbr, "ORL"))).get()!;
    db.update(teamsT).set({ wins: 0, losses: 82 }).where(eq(teamsT.id, orl.id)).run();
    // ORL owes its next first to BOS with lottery protection.
    const bos = db.select().from(teamsT).where(and(eq(teamsT.saveId, s.saveId), eq(teamsT.abbr, "BOS"))).get()!;
    const pick = db.select().from(picksT).where(and(eq(picksT.saveId, s.saveId), eq(picksT.year, season + 1), eq(picksT.round, 1), eq(picksT.originalTeamId, orl.id))).get()!;
    db.update(picksT).set({ holderTeamId: bos.id, protection: { type: "LOTTERY_TOP_X", x: 14, yearShift: 1 } }).where(eq(picksT.id, pick.id)).run();
    await advanceSim(s.saveId, "SEASON");
    const after = db.select().from(picksT).where(eq(picksT.id, pick.id)).get()!;
    // Protection triggered: obligation shifts a year, unprotected now.
    expect(after.year).toBe(season + 2);
    expect(after.protection).toBeNull();
    expect(after.holderTeamId).toBe(bos.id);
    expect(after.status).toBe("OWNED");
    // And ORL kept its own lottery slot in this year's order.
    const order = getDraftOrder(s.saveId);
    const orlSlot = order.find((o) => o.round === 1 && o.holderTeamId === orl.id.split(":").slice(1).join(":") || o.holderTeamId === orl.id);
    expect(orlSlot).toBeTruthy();
  }, 300_000);
});

describe("stretch provision on waivers", () => {
  it("stretching spreads dead money over 2n+1 seasons at the same total", async () => {
    const s = await createSave({ name: "stretch", seed: 555070 });
    const db = getDb();
    const userFull = `${s.saveId}:${s.teamId.split(":").pop()}`;
    const userShort = s.teamId.split(":").pop()!;
    const season = getSave(s.saveId)!.season;
    // Give a bench player a 2-year, 10M/yr deal, then stretch-waive him.
    const p = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, userFull))).all()
      .sort((a, b) => a.ratings.overall - b.ratings.overall)[0];
    db.update(playersT)
      .set({ contract: { ...p.contract, years: [{ season, salary: 10 }, { season: season + 1, salary: 10 }] } })
      .where(eq(playersT.id, p.id))
      .run();
    const r = waivePlayer(s.saveId, p.id.split(":").pop()!, { stretch: true });
    expect(r.waived).toBe(p.name);
    // 2 remaining years → stretched over 5 seasons.
    expect(r.deadMoney.length).toBe(5);
    expect(r.deadMoney[0].season).toBe(season);
    expect(r.deadMoney[4].season).toBe(season + 4);
    expect(r.deadMoney[0].salary).toBeCloseTo(4, 1);
    expect(Math.abs(r.total - 20)).toBeLessThan(0.5);
    // And the dead cap actually lands on the user's books this season.
    expect(deadCapHit(s.saveId, userShort)).toBeCloseTo(4, 1);
  }, 120_000);
});

describe("in-season AI signings", () => {
  it("AI teams hit the minimum market when a star goes down", async () => {
    const s = await createSave({ name: "in-season signings", seed: 555050 });
    const db = getDb();
    const userFull = `${s.saveId}:${s.teamId.split(":").pop()}`;
    // A real FA worth signing (not just filler).
    const fa = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId), eq(playersT.status, "FREE_AGENT")))
      .all()
      .filter((p) => p.teamId === null)
      .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
    expect(fa).toBeTruthy();
    // Put an AI team's best player on the shelf for two months.
    const aiTeam = db.select().from(teamsT).where(eq(teamsT.saveId, s.saveId)).all().find((t) => t.id !== userFull)!;
    const star = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, aiTeam.id)))
      .all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall)[0];
    db.update(playersT)
      .set({ status: "INJURED", injury: { description: "acl tear", weeksRemaining: 8, severity: "SEVERE" } })
      .where(eq(playersT.id, star.id))
      .run();
    const poolBefore = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId), eq(playersT.status, "FREE_AGENT"))).all().filter((p) => p.teamId === null).length;
    // One month crosses ~4 weekly signing ticks — someone gets signed.
    await advanceSim(s.saveId, "MONTH");
    const poolAfter = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId), eq(playersT.status, "FREE_AGENT"))).all().filter((p) => p.teamId === null).length;
    const signEvents = db.select().from(eventsT).where(and(eq(eventsT.saveId, s.saveId), eq(eventsT.category, "FA"))).all().filter((e) => e.message.includes("底薪签下"));
    expect(signEvents.length + Math.max(0, poolBefore - poolAfter)).toBeGreaterThan(0);
    // In-season deals are one-year minimums, never cap-busters.
    for (const e of signEvents) {
      const pid = (e.payload as { playerId?: string } | null)?.playerId;
      if (!pid) continue;
      const p = db.select().from(playersT).where(eq(playersT.id, pid)).get()!;
      expect(p.contract.type).toBe("MINIMUM");
      expect(p.contract.years.length).toBe(1);
    }
  }, 300_000);
});

describe("minutes-driven development", () => {
  it("real rotation runs accelerate growth; the bench stalls it", () => {
    // Pure boundary check — the roll itself stays seeded/random.
    expect(devMinutesFactor(70, 28)).toEqual({ chance: 0.15, ceil: 1 });
    expect(devMinutesFactor(70, 10)).toEqual({ chance: 0, ceil: 0 });
    expect(devMinutesFactor(10, 30)).toEqual({ chance: -0.15, ceil: -1 }); // barely dressed
    expect(devMinutesFactor(0, 0)).toEqual({ chance: -0.15, ceil: -1 }); // never played
  });

  it("starters grow faster than benchwarmers across many seasons", () => {
    // Two identical 21yo prospects (same overall/potential), one playing 25+
    // mpg, one glued to the bench. Over 20 development windows the rotation
    // player's total growth must clearly outpace the buried one's.
    const mkKid = (id: string, g: number, mpg: number) => ({
      id, name: id, teamId: "T", lastTeamId: "T", position: "SG", age: 21, yearsPro: 2, tenure: 2,
      ratings: { overall: 70, threePoint: 70, finishing: 70, inside: 70, freeThrow: 70, playmaking: 70, rebounding: 70, perimeterD: 70, interiorD: 70, usageTendency: 50, potential: 82, potentialLow: 75, potentialHigh: 88, confidence: 50 },
      seasonStats: [{ g, mp: g * mpg, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 }],
      contract: { type: "ROOKIE" as const, years: [{ season: 2027, salary: 5 }], birdRights: false, noTrade: false, option: null, signedSeason: 2025 },
      status: "ACTIVE", role: "BENCH", satisfaction: 70, injury: null,
      development: { trajectory: "STABLE", growthLeft: 12, lastDelta: 0 }, stamina: 1, lastGameDate: null,
    });
    const starter = mkKid("kidA", 70, 25);
    const buried = mkKid("kidB", 8, 6);
    const state = {
      saveId: "t", seed: 555060, season: 2027, phase: "OFFSEASON" as const, currentDate: "2027-07-01",
      teams: [{ id: "T", abbr: "T", city: "T", name: "T", conference: "EAST" as const, division: "X", wins: 30, losses: 52 }],
      players: [starter, buried], games: [], playoffs: null,
    };
    let sumA = 0, sumB = 0;
    for (let i = 0; i < 20; i++) {
      state.season = 2027 + i;
      // applyDevelopment ages players — pin age/overall so every window rolls
      // under identical conditions.
      for (const p of [starter, buried]) {
        p.ratings.overall = 70;
        p.age = 21;
      }
      const deltas = applyDevelopment(state as never);
      sumA += deltas.find((d) => d.playerId === "kidA")?.delta ?? 0;
      sumB += deltas.find((d) => d.playerId === "kidB")?.delta ?? 0;
    }
    expect(sumA).toBeGreaterThan(sumB + 5);
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

  it("a star with a warm market refuses ~25%-below-ask lowballs", () => {
    // Booker-at-31.85M regression: asking ~41.65M, warm competition, a 77%-of-
    // ask offer used to sail through `interest >= 62`. Now it must fail.
    const ask = askingSalaryFor(cheapRookieDeal, 11, 87, 30);
    const fa = {
      id: "p1", name: "Star", position: "SG", age: 30,
      ratings: { overall: 87, potential: null }, status: "FREE_AGENT" as const,
      askingSalary: ask, askingYears: 4, contract: cheapRookieDeal,
    };
    const mkP = (i: number) => ({
      id: `t${i}`, name: `T${i}`, teamId: "T", position: i % 2 ? "PG" : "C", age: 27, yearsPro: 5,
      ratings: { overall: 74, potential: null } as never, contract: cheapRookieDeal, status: "ACTIVE", role: "STARTER",
    });
    const team = { id: "T", abbr: "TST", players: [0, 1, 2, 3, 4].map(mkP), picks: [], aiPhase: "PLAYOFF" as const, aiRisk: 0.5 };
    const lowball = evaluateOffer(fa, { years: 4, avgSalary: round2(ask * 0.77) }, team, 42, "t", 60);
    expect(lowball.accept).toBe(false);
    const fair = evaluateOffer(fa, { years: 4, avgSalary: ask }, team, 42, "t", 60);
    expect(fair.accept).toBe(true);
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

describe("manager rotation", () => {
  it("setRotation stores 5 owned healthy starters and rejects bad configs", async () => {
    const s = await createSave({ name: "rotation", seed: 555020 });
    const db = getDb();
    const userFull = (getSave(s.saveId)!.phaseState as { userTeamId?: string }).userTeamId ?? `${s.saveId}:${s.teamId.split(":").pop()}`;
    void userFull;
    const short = s.teamId.split(":").pop()!;
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, s.teamId)))
      .all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall);
    const five = roster.slice(0, 5).map((p) => p.id.split(":").pop()!);
    const r = setRotation(s.saveId, short, five);
    expect((r.rotation as { starters: string[] }).starters).toEqual(five);
    // Duplicates and foreigners are rejected.
    expect(() => setRotation(s.saveId, short, [five[0], five[0], five[1], five[2], five[3]])).toThrow();
    const other = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, s.saveId)))
      .all()
      .find((p) => p.teamId !== s.teamId && p.teamId !== null)!;
    expect(() => setRotation(s.saveId, short, [five[0], five[1], five[2], five[3], other.id.split(":").pop()!])).toThrow();
  });
});

describe("inbound trade offers", () => {
  it("a deadline offer persists past the market flag write and accepts cleanly", async () => {
    // Some seeds genuinely produce no call — a thin movable-salary roster is
    // unmatchable under CBA bands. So inject a validated synthetic offer and
    // test the two invariants: the deadline flag write must not clobber it,
    // and accepting must pass full trade validation.
    const s = await createSave({ name: "inbound 回归", seed: 555005 });
    const db = getDb();
    const userFull = s.teamId;
    const userShort = s.teamId.split(":").pop()!;
    const season = getSave(s.saveId)!.season;

    // Find an offer that is legal TODAY: an AI vet whose salary one user
    // piece (outside the top-3) can match within the trade bands.
    const userRoster = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, userFull))).all()
      .sort((a, b) => b.ratings.overall - a.ratings.overall);
    const untouchable = new Set(userRoster.slice(0, 3).map((p) => p.id));
    const movable = userRoster.filter((p) => !untouchable.has(p.id) && !p.contract.noTrade);
    const teams = db.select().from(teamsT).where(eq(teamsT.saveId, s.saveId)).all().filter((t) => t.id !== userFull);
    let injected: { teamAbbr: string; vetId: string; pieceId: string } | null = null;
    outer: for (const t of teams) {
      const vets = db.select().from(playersT).where(and(eq(playersT.saveId, s.saveId), eq(playersT.teamId, t.id))).all()
        .filter((p) => !p.contract.noTrade && (p.contract.signedSeason ?? 0) < season);
      for (const v of vets) {
        for (const m of movable) {
          const vSal = v.contract.years[0]?.salary ?? 0;
          const mSal = m.contract.years[0]?.salary ?? 0;
          if (vSal <= 0 || mSal <= 0) continue;
          const parties = [
            { teamId: t.id.split(":").pop()!, gives: [{ kind: "PLAYER" as const, id: v.id.split(":").pop()! }], receives: [{ kind: "PLAYER" as const, id: m.id.split(":").pop()! }] },
            { teamId: userShort, gives: [{ kind: "PLAYER" as const, id: m.id.split(":").pop()! }], receives: [{ kind: "PLAYER" as const, id: v.id.split(":").pop()! }] },
          ];
          const v2 = validateTradeOnServer(s.saveId, parties);
          if (v2.legal) {
            injected = { teamAbbr: t.abbr, vetId: v.id.split(":").pop()!, pieceId: m.id.split(":").pop()! };
            break outer;
          }
        }
      }
    }
    expect(injected, "no legal inbound offer constructible").toBeTruthy();
    const ps = getPhaseState(s.saveId);
    db.update(savesT)
      .set({
        phaseState: {
          ...ps,
          inboundOffers: [{ id: "inj-offer-1", fromTeam: injected!.teamAbbr, playerId: injected!.vetId, asks: [{ kind: "PLAYER", id: injected!.pieceId }] }],
        } as never,
      })
      .where(eq(savesT.id, s.saveId))
      .run();
    expect(listInboundOffers(s.saveId).length).toBe(1);

    // Advance to the deadline — the flag write must not clobber the pending offer.
    for (let i = 0; i < 8; i++) {
      await advanceSim(s.saveId, "MONTH");
      const sv = getSave(s.saveId)!;
      if ((sv.phaseState as Record<string, unknown>)[`deadlineMarket:${sv.season}`]) break;
    }
    const offers = listInboundOffers(s.saveId);
    expect(offers.length).toBeGreaterThanOrEqual(1);
    const offer = offers.find((o) => o.id === "inj-offer-1") ?? offers[0];
    expect(offer.giveNames[0]).not.toBe("?");
    expect(offer.wants.length).toBeGreaterThan(0);
    const res = respondInboundOffer(s.saveId, offer.id, true);
    expect(res.accepted).toBe(true);
    expect(listInboundOffers(s.saveId).filter((o) => o.id === offer.id)).toHaveLength(0);
  }, 300_000);

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

describe("morale has teeth: monthly drift + disgruntled discount", () => {
  const mkP = (id: string, overall: number, satisfaction: number, teamId = "A", age = 27) => ({
    id, name: id, teamId, lastTeamId: teamId, position: "SG", age, yearsPro: 5, tenure: 2,
    ratings: { overall } as never,
    seasonStats: [], contract: { type: "VETERAN" as const, years: [{ season: 2027, salary: 10 }], birdRights: false, noTrade: false, option: null, signedSeason: 2025 },
    status: "ACTIVE", role: "STARTER", satisfaction, injury: null,
    development: { trajectory: "STABLE", growthLeft: 0, lastDelta: 0 }, stamina: 1, lastGameDate: null,
  });

  it("a losing month erodes stars in real time; winning heals", async () => {
    const { applyMonthlyMorale } = await import("@/domain/sim/season");
    const teams = [
      { id: "A", abbr: "A", city: "A", name: "A", conference: "EAST" as const, division: "x", wins: 5, losses: 25 },   // .167 — bleeding
      { id: "B", abbr: "B", city: "B", name: "B", conference: "WEST" as const, division: "x", wins: 24, losses: 6 },  // .800 — healing
    ];
    const players = [
      mkP("loser-star", 84, 50, "A", 30),
      mkP("loser-buried", 81, 50, "A"),
      // 9 higher-rated teammates push loser-buried to rank 10
      ...Array.from({ length: 9 }, (_, i) => mkP(`a${i}`, 82, 50, "A")),
      mkP("winner", 80, 50, "B"),
    ];
    const state = { saveId: "s", seed: 1, season: 2027, phase: "REGULAR_SEASON", currentDate: "2026-12-01", teams, players, games: [], playoffs: null } as never;
    const shifts = applyMonthlyMorale(state);
    const by = Object.fromEntries(shifts.map((s) => [s.playerId, s.to - s.from]));
    expect(by["loser-star"]).toBe(-4);                 // 84ov on a .167 team
    expect(by["loser-buried"]).toBe(-5);               // losing -2 (<82) + buried -3
    expect(by["winner"]).toBe(2);                      // .800 heals slowly
  });

  it("a disgruntled star is worth less — the league smells blood", async () => {
    const { playerValue } = await import("@/domain/trade");
    const happy = mkP("s", 84, 70);
    const mad = { ...mkP("s", 84, 25), satisfaction: 25 };
    const vHappy = playerValue(happy, 2027).value;
    const vMad = playerValue(mad, 2027).value;
    expect(vMad / vHappy).toBeCloseTo(0.8, 2);
    expect(playerValue(mad, 2027).breakdown.join(" ")).toContain("逼宫");
  });
});
