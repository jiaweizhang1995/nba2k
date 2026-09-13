// God Mode: explicitly bypasses rules, writes audit entries, undo restores.
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, setGodMode, godOp, getEvents, loadLeagueState, getSave } from "@/server/engine";
import { executeTrade } from "@/server/engine";

let saveId: string;

beforeAll(async () => {
  const s = await createSave({ name: "GOD测试", seed: 66666 });
  saveId = s.saveId;
});

describe("God Mode gating", () => {
  it("is off by default and blocks god ops", async () => {
    const save = getSave(saveId)!;
    expect(save.godMode).toBe(false);
    expect(() => godOp(saveId, "setRating", { playerId: "x", field: "overall", value: 90 })).toThrow(/GOD MODE 未开启/);
  });

  it("must be enabled explicitly and logs the toggle", async () => {
    setGodMode(saveId, true);
    expect(getSave(saveId)!.godMode).toBe(true);
    const events = getEvents(saveId, 20, "GOD");
    expect(events.some((e) => e.message.includes("已开启"))).toBe(true);
  });
});

describe("God operations", () => {
  it("edits player rating/age/contract with audit trail", async () => {
    const state = loadLeagueState(saveId);
    const p = state.players.find((x) => x.teamId)!;
    const shortId = p.id;

    godOp(saveId, "setRating", { playerId: shortId, field: "overall", value: 97 });
    const after = loadLeagueState(saveId).players.find((x) => x.id === shortId)!;
    expect(after.ratings.overall).toBe(97);

    godOp(saveId, "setAge", { playerId: shortId, value: 19 });
    expect(loadLeagueState(saveId).players.find((x) => x.id === shortId)!.age).toBe(19);

    godOp(saveId, "setContract", { playerId: shortId, years: 2, salary: 5.5 });
    const c = loadLeagueState(saveId).players.find((x) => x.id === shortId)!.contract;
    expect(c.years).toHaveLength(2);
    expect(c.years[0].salary).toBeCloseTo(5.5);

    const events = getEvents(saveId, 50, "GOD");
    expect(events.filter((e) => e.godMode).length).toBeGreaterThanOrEqual(3);
  });

  it("undo restores the previous state snapshot", async () => {
    const state = loadLeagueState(saveId);
    const p = state.players.find((x) => x.teamId)!;
    const before = loadLeagueState(saveId).players.find((x) => x.id === p.id)!.ratings.overall;

    godOp(saveId, "setRating", { playerId: p.id, field: "overall", value: 99 });
    expect(loadLeagueState(saveId).players.find((x) => x.id === p.id)!.ratings.overall).toBe(99);

    godOp(saveId, "undo", {});
    const restored = loadLeagueState(saveId).players.find((x) => x.id === p.id)!.ratings.overall;
    expect(restored).toBe(before);
  });

  it("forced god trade bypasses validation and is flagged in the log", async () => {
    const state = loadLeagueState(saveId);
    const teamA = state.teams[0].id;
    const teamB = state.teams[1].id;
    const rosterOf = (t: string) => state.players.filter((p) => p.teamId === t);
    // deliberately illegal: 1-for-5 (roster overflow)
    const a = rosterOf(teamA);
    const b = rosterOf(teamB);
    const parties = [
      { teamId: teamA, gives: [{ kind: "PLAYER" as const, id: a[a.length - 1].id }], receives: b.slice(0, 5).map((p) => ({ kind: "PLAYER" as const, id: p.id })) },
      { teamId: teamB, gives: b.slice(0, 5).map((p) => ({ kind: "PLAYER" as const, id: p.id })), receives: [{ kind: "PLAYER" as const, id: a[a.length - 1].id }] },
    ];
    const result = executeTrade(saveId, parties, { godMode: true, force: true });
    expect(result.executed).toBe(true);
    const events = getEvents(saveId, 30, "GOD");
    expect(events.some((e) => e.message.includes("跳过交易规则校验"))).toBe(true);
  });
});
