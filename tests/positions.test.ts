// 位置槽位模型测试：泛位置解析、可打位置判定、首发槽位分配。
import { describe, expect, it } from "vitest";
import { assignStarters, placeIntoSlots, positionFit, resolvePositions, LINEUP_POSITIONS } from "@/domain/positions";

describe("resolvePositions", () => {
  it("passes through explicit 5-slot positions with a sensible secondary", () => {
    expect(resolvePositions("PG")).toEqual({ position: "PG", secondPosition: "SG" });
    expect(resolvePositions("C")).toEqual({ position: "C", secondPosition: "PF" });
    expect(resolvePositions("PF")).toEqual({ position: "PF", secondPosition: "C" });
  });

  it("resolves generic G by assists: high-apg → PG, low-apg → SG", () => {
    expect(resolvePositions("G", { apg: 8.9 }).position).toBe("PG");
    expect(resolvePositions("G", { apg: 6.8 }).position).toBe("PG");
    expect(resolvePositions("G", { apg: 3.7 }).position).toBe("SG");
  });

  it("resolves generic G by height when stats are missing", () => {
    expect(resolvePositions("G", { heightCm: 185 }).position).toBe("PG");
    expect(resolvePositions("G", { heightCm: 198 }).position).toBe("SG");
    expect(resolvePositions("G", {}).position).toBe("SG");
  });

  it("resolves wings and bigs", () => {
    expect(resolvePositions("GF")).toEqual({ position: "SG", secondPosition: "SF" });
    expect(resolvePositions("G/F")).toEqual({ position: "SG", secondPosition: "SF" });
    expect(resolvePositions("FC")).toEqual({ position: "PF", secondPosition: "C" });
    expect(resolvePositions("F/C")).toEqual({ position: "PF", secondPosition: "C" });
    expect(resolvePositions("CF")).toEqual({ position: "C", secondPosition: "PF" });
  });

  it("resolves generic F by height: wings SF/PF, bigs PF/C", () => {
    expect(resolvePositions("F", { heightCm: 203 })).toEqual({ position: "SF", secondPosition: "PF" });
    expect(resolvePositions("F", { heightCm: 198 })).toEqual({ position: "SF", secondPosition: "PF" });
    expect(resolvePositions("F", { heightCm: 211 })).toEqual({ position: "PF", secondPosition: "C" });
    expect(resolvePositions("F", {})).toEqual({ position: "SF", secondPosition: "PF" });
  });
});

interface TPlayer {
  id: string;
  position: string;
  secondPosition?: string | null;
  ratings: { overall: number };
}
const mk = (id: string, position: string, overall: number, secondPosition: string | null = null): TPlayer => ({ id, position, secondPosition, ratings: { overall } });

describe("positionFit", () => {
  it("2 = natural, 1 = secondary, 0 = cannot", () => {
    const p = mk("a", "SG", 80, "SF");
    expect(positionFit(p, "SG")).toBe(2);
    expect(positionFit(p, "SF")).toBe(1);
    expect(positionFit(p, "C")).toBe(0);
  });
});

describe("assignStarters", () => {
  it("fills all five slots with natural positions when possible", () => {
    const roster = [
      mk("pg", "PG", 80),
      mk("sg", "SG", 82),
      mk("sf", "SF", 85),
      mk("pf", "PF", 79),
      mk("c", "C", 81),
      mk("bench", "SG", 70, "PG"),
    ];
    const slots = assignStarters(roster);
    expect(slots.map((p) => p?.id)).toEqual(["pg", "sg", "sf", "pf", "c"]);
  });

  it("prefers scarce positions: a lone C starts at C even with lower overall", () => {
    const roster = [
      mk("g1", "SG", 90, "PG"),
      mk("g2", "SG", 88, "PG"),
      mk("f1", "SF", 87, "PF"),
      mk("f2", "SF", 86, "PF"),
      mk("c1", "C", 72),
      mk("g3", "PG", 70),
    ];
    const slots = assignStarters(roster);
    expect(slots[4]?.id).toBe("c1"); // C slot
    expect(slots.filter(Boolean)).toHaveLength(5);
    // the five distinct players
    expect(new Set(slots.map((p) => p?.id)).size).toBe(5);
  });

  it("falls back to best remaining when a position has nobody", () => {
    // No center at all — the C slot takes the best leftover.
    const roster = [mk("a", "PG", 90), mk("b", "SG", 88), mk("c", "SF", 86), mk("d", "PF", 84), mk("e", "SG", 83, "SF"), mk("f", "SF", 82, "PF")];
    const slots = assignStarters(roster);
    expect(slots.filter(Boolean)).toHaveLength(5);
    expect(new Set(slots.map((p) => p?.id)).size).toBe(5);
    // top-5 by overall all start
    expect(slots.map((p) => p?.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns nulls for slots it cannot fill on a short roster", () => {
    const slots = assignStarters([mk("a", "PG", 90), mk("b", "SG", 88), mk("c", "SF", 86)]);
    expect(slots.filter(Boolean)).toHaveLength(3);
  });
});

describe("placeIntoSlots", () => {
  it("honors the stored slot order exactly, including deliberate misfits", () => {
    const roster = [mk("pg", "PG", 80), mk("sg", "SG", 82, "PG"), mk("sf", "SF", 85), mk("pf", "PF", 79), mk("c", "C", 81)];
    const slots = placeIntoSlots(roster, ["sg", "pg", "sf", "pf", "c"]); // user deliberately put the SG at PG
    expect(slots.map((p) => p?.id)).toEqual(["sg", "pg", "sf", "pf", "c"]);
    expect(LINEUP_POSITIONS).toHaveLength(5);
  });

  it("leaves null for unknown or missing starter ids", () => {
    const roster = [mk("a", "PG", 80)];
    const slots = placeIntoSlots(roster, ["a", "gone", "x", "y", "z"]);
    expect(slots[0]?.id).toBe("a");
    expect(slots.slice(1).every((s) => s === null)).toBe(true);
  });
});
