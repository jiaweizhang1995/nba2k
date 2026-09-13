import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, teams as teamsT } from "@/db/schema";
import { getSave } from "@/server/engine";
import { handleError, ok, fail } from "@/server/api-helpers";

/** Roster / player list with full provenance + explainable ratings. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const url = new URL(req.url);
    const teamId = url.searchParams.get("teamId");
    const status = url.searchParams.get("status");

    const db = getDb();
    const conditions = [eq(playersT.saveId, id)];
    if (teamId) {
      const fullTeamId = teamId.includes(":") ? teamId : `${id}:${teamId}`;
      conditions.push(eq(playersT.teamId, fullTeamId));
    }
    if (status) conditions.push(eq(playersT.status, status.toUpperCase()));
    const rows = db.select().from(playersT).where(and(...conditions)).all();

    const teamMap = new Map(db.select().from(teamsT).where(eq(teamsT.saveId, id)).all().map((t) => [t.id, t]));
    const players = rows.map((p) => ({
      id: p.id.split(":").slice(1).join(":"),
      name: p.name,
      teamId: p.teamId,
      teamAbbr: p.teamId ? teamMap.get(p.teamId)?.abbr ?? null : null,
      position: p.position,
      secondPosition: p.secondPosition,
      age: p.age,
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      draftYear: p.draftYear,
      draftRound: p.draftRound,
      draftPick: p.draftPick,
      yearsPro: p.yearsPro,
      ratings: p.ratings,
      seasonStats: p.seasonStats.filter((s) => s.season === save.season),
      careerStats: p.careerStats,
      contract: p.contract,
      status: p.status,
      role: p.role,
      satisfaction: p.satisfaction,
      injury: p.injury,
      development: p.development,
      stamina: p.stamina,
      baselineStats: p.baselineStats ?? null,
      source: p.source,
    }));
    return ok({ players, season: save.season });
  } catch (e) {
    return handleError(e);
  }
}
