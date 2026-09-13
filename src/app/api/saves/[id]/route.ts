import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { teams as teamsT, players as playersT, saves as savesT } from "@/db/schema";
import { deleteSave, getSave, getChemistry, getPhaseState, logEvent, deadCapHit } from "@/server/engine";
import { capSnapshot } from "@/domain/salary";
import { handleError, ok, fail } from "@/server/api-helpers";

const pickTeamSchema = z.object({ teamId: z.string().min(1) });

/** PATCH: choose the franchise the user controls (post-creation setup). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().then((j) => pickTeamSchema.parse(j));
    const db = getDb();
    const team = db.select().from(teamsT).where(and(eq(teamsT.saveId, id), eq(teamsT.id, `${id}:${body.teamId}`))).get();
    if (!team) return fail("NO_TEAM", "球队不存在", 404);
    const fullId = team.id;
    db.update(savesT)
      .set({ phaseState: { ...(getPhaseState(id)), userTeamId: fullId }, updatedAt: new Date().toISOString() })
      .where(eq(savesT.id, id))
      .run();
    logEvent(id, "SYSTEM", `选择执教球队：${team.city} ${team.name}（${team.abbr}）`, { teamId: fullId });
    return ok({ teamId: fullId });
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const db = getDb();
    const teams = db.select().from(teamsT).where(eq(teamsT.saveId, id)).all();
    const userTeamId = (getPhaseState(id).userTeamId as string) ?? teams[0]?.id ?? null;
    const shortTeamId = userTeamId ? userTeamId.split(":").slice(1).join(":") : null;
    const rawTeam = teams.find((t) => t.id === userTeamId) ?? null;
    // Strip the saveId prefix so clients use short team ids (consistent with /teams).
    const userTeam = rawTeam ? { ...rawTeam, id: rawTeam.id.split(":").slice(1).join(":") } : null;
    const roster = shortTeamId ? db.select().from(playersT).where(and(eq(playersT.saveId, id), eq(playersT.teamId, `${id}:${shortTeamId}`))).all() : [];
    const chemistry = shortTeamId ? getChemistry(id, shortTeamId) : null;
    const deadMoney = shortTeamId ? deadCapHit(id, shortTeamId) : 0;
    const { CBA_VERSION, seasonMoney } = await import("@/domain/salary");
    const money = seasonMoney(save.season);
    const cap = capSnapshot(
      roster,
      roster.filter((p) => p.status === "ACTIVE" || p.status === "INJURED").length,
      deadMoney,
      save.season,
    );
    const ratingVersion = save.ratingVersion;
    return ok({
      save,
      userTeam,
      chemistry,
      ratingVersion,
      cap: { ...cap, cbaVersion: CBA_VERSION, cap: money.salaryCap, tax: money.luxuryTax, firstApron: money.firstApron, secondApron: money.secondApron },
      teamCount: teams.length,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    deleteSave(id);
    return ok({ deleted: id });
  } catch (e) {
    return handleError(e);
  }
}
