// Position model: NBA 2K-style primary + secondary positions and lineup slots.
//
// Source data is messy on purpose: Wikipedia rosters only use generic tags
// (G / GF / F / FC / C) and never split PG from SG. resolvePositions() turns
// those raw tokens into the 5-slot model the game uses — primary position plus
// a secondary "can also play" spot, using assists and height as tie-breakers.
// The raw token is kept in the payload as the factual source value.

export const LINEUP_POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
export type LineupPos = (typeof LINEUP_POSITIONS)[number];

export interface PosPair {
  position: LineupPos;
  secondPosition: LineupPos | null;
}

const isLineupPos = (p: string): p is LineupPos => (LINEUP_POSITIONS as readonly string[]).includes(p);

/**
 * Resolve a raw position token ("G", "GF", "PG", …) into a primary + secondary
 * pair. `apg` / `heightCm` disambiguate generic tags; both may be null.
 * Deterministic — no randomness.
 */
export function resolvePositions(raw: string | null | undefined, ctx: { apg?: number | null; heightCm?: number | null } = {}): PosPair {
  const p = (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const { apg, heightCm } = ctx;
  switch (p) {
    case "PG":
      return { position: "PG", secondPosition: "SG" };
    case "SG":
      return { position: "SG", secondPosition: "PG" };
    case "G": {
      // Generic guard: high-assist or very small guards are the point.
      const pg = (apg != null && apg >= 5.5) || (heightCm != null && heightCm <= 189);
      return pg ? { position: "PG", secondPosition: "SG" } : { position: "SG", secondPosition: "PG" };
    }
    case "GF":
    case "FG":
      return { position: "SG", secondPosition: "SF" };
    case "SF":
      return { position: "SF", secondPosition: "PF" };
    case "F": {
      // Generic forward: genuine bigs lean to the 4/5, the rest are wings.
      if (heightCm != null && heightCm >= 208) return { position: "PF", secondPosition: "C" };
      return { position: "SF", secondPosition: "PF" };
    }
    case "PF":
      return { position: "PF", secondPosition: "C" };
    case "FC":
      return { position: "PF", secondPosition: "C" };
    case "CF":
      return { position: "C", secondPosition: "PF" };
    case "C":
      return { position: "C", secondPosition: "PF" };
    default:
      return isLineupPos(p) ? { position: p, secondPosition: null } : { position: "SF", secondPosition: "PF" };
  }
}

/** 0 = cannot play the slot, 1 = secondary spot, 2 = natural position. */
export function positionFit(p: { position: string; secondPosition?: string | null }, slot: string): 0 | 1 | 2 {
  if (p.position === slot) return 2;
  if (p.secondPosition === slot) return 1;
  return 0;
}

/** Display label: "SG/PG" style, primary first. */
export function positionLabel(p: { position: string; secondPosition?: string | null }): string {
  return p.secondPosition ? `${p.position}/${p.secondPosition}` : p.position;
}

/**
 * Fill the 5 lineup slots (PG→C) from a roster: scarcest-eligible slot first,
 * natural position preferred over flex, best overall wins ties. Anything left
 * uncovered falls back to the best remaining player (out-of-position allowed).
 */
export function assignStarters<T extends { id: string; position: string; secondPosition?: string | null; ratings: { overall: number } }>(
  players: T[],
): (T | null)[] {
  const picked = new Set<string>();
  const slots: (T | null)[] = [null, null, null, null, null];
  const byOvr = (a: T, b: T) => b.ratings.overall - a.ratings.overall || (a.id < b.id ? -1 : 1);
  // Fill the hardest-to-cover positions first so flex players land where needed.
  const order = LINEUP_POSITIONS.map((pos, i) => ({ pos, i, n: players.filter((p) => positionFit(p, pos) > 0).length })).sort((a, b) => a.n - b.n || a.i - b.i);
  for (const s of order) {
    const rest = players.filter((p) => !picked.has(p.id));
    if (!rest.length) break;
    const pool = rest.filter((p) => p.position === s.pos);
    const flex = rest.filter((p) => p.secondPosition === s.pos);
    const best = [...(pool.length ? pool : flex.length ? flex : rest)].sort(byOvr)[0];
    slots[s.i] = best;
    picked.add(best.id);
  }
  return slots;
}

/**
 * Lay a saved starter list onto the PG→C slots. The rotation contract is
 * slot-ordered — starters[i] is the player for LINEUP_POSITIONS[i] — so we
 * honor the stored order exactly (including deliberate out-of-position
 * experiments). Unknown ids become null slots.
 */
export function placeIntoSlots<T extends { id: string }>(players: T[], starterIds: string[]): (T | null)[] {
  const byId = new Map(players.map((p) => [p.id, p] as const));
  return LINEUP_POSITIONS.map((_, i) => byId.get(starterIds[i]) ?? null);
}
