// Playoff round-by-round advancement: PLAYOFF_ROUND simulates exactly one
// round per call — first round → conference semis → conference finals →
// Finals → phase transition — while PLAYOFFS still resolves everything.
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, advanceSim, loadLeagueState, getSave } from "@/server/engine";

let saveId: string;

beforeAll(async () => {
  const s = await createSave({ name: "季后赛分轮测试", seed: 90909 });
  saveId = s.saveId;
}, 120_000);

describe("PLAYOFF_ROUND advancement", () => {
  it("stops after each round: R1 → CONF_SEMI → CONF_FINAL → FINALS → DRAFT", () => {
    // Schedule length is seed-dependent — a single REGULAR_SEASON advance is
    // capped at 240 days, so loop until the phase actually flips.
    for (let i = 0; i < 4 && getSave(saveId)!.phase === "REGULAR_SEASON"; i++) advanceSim(saveId, "REGULAR_SEASON");
    expect(getSave(saveId)!.phase).toBe("PLAYOFFS");

    // Round 1: all R1 series done, semis scheduled, still in PLAYOFFS.
    const r1 = advanceSim(saveId, "PLAYOFF_ROUND");
    let po = loadLeagueState(saveId).playoffs!;
    expect(po.series.filter((s) => s.round === "R1").every((s) => s.done)).toBe(true);
    expect(po.series.some((s) => s.round === "CONF_SEMI" && !s.done)).toBe(true);
    expect(getSave(saveId)!.phase).toBe("PLAYOFFS");
    expect(r1.notes.some((n) => n.includes("季后赛 R1"))).toBe(true);
    expect(r1.notes.some((n) => n.includes("下一轮"))).toBe(true);

    // Conference semifinals.
    advanceSim(saveId, "PLAYOFF_ROUND");
    po = loadLeagueState(saveId).playoffs!;
    expect(po.series.filter((s) => s.round === "CONF_SEMI").every((s) => s.done)).toBe(true);
    expect(po.series.some((s) => s.round === "CONF_FINAL" && !s.done)).toBe(true);
    expect(getSave(saveId)!.phase).toBe("PLAYOFFS");

    // Conference finals → Finals created.
    advanceSim(saveId, "PLAYOFF_ROUND");
    po = loadLeagueState(saveId).playoffs!;
    expect(po.series.filter((s) => s.round === "CONF_FINAL").every((s) => s.done)).toBe(true);
    expect(po.series.some((s) => s.round === "FINALS" && !s.done)).toBe(true);
    expect(getSave(saveId)!.phase).toBe("PLAYOFFS");

    // Finals → champion crowned, phase leaves PLAYOFFS.
    const r4 = advanceSim(saveId, "PLAYOFF_ROUND");
    expect(r4.champion).toBeTruthy();
    expect(getSave(saveId)!.phase).not.toBe("PLAYOFFS");
    po = loadLeagueState(saveId).playoffs!;
    expect(po.series.find((s) => s.round === "FINALS")?.done).toBe(true);
    expect(po.championTeamId).toBeTruthy();
  }, 300_000);
});
