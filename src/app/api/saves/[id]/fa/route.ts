import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT } from "@/db/schema";
import { getSave, submitFaOffer, getPhaseState, startFreeAgency, startNewSeason } from "@/server/engine";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { faOfferSchema } from "@/server/schemas";
import { FA_RULES_VERSION } from "@/domain/freeagency";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const db = getDb();
    const fas = db.select().from(playersT).where(and(eq(playersT.saveId, id), eq(playersT.status, "FREE_AGENT"))).all();
    const userTeamId = getPhaseState(id).userTeamId as string | undefined;
    return ok({
      freeAgents: fas.map((p) => ({
        id: p.id.split(":").slice(1).join(":"),
        name: p.name,
        position: p.position,
        age: p.age,
        overall: p.ratings.overall,
        potential: p.ratings.potential,
        askingSalary: Math.max(1.2, (p.contract.years[0]?.salary ?? 5) * 1.05),
        askingYears: p.age >= 32 ? 2 : 3,
        priorSalary: p.contract.years[0]?.salary ?? null,
      })),
      phase: save.phase,
      userTeamId,
      rulesVersion: FA_RULES_VERSION,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "startFreeAgency") {
      startFreeAgency(id);
      return ok({ started: true });
    }
    if (action === "startNewSeason") {
      startNewSeason(id);
      return ok({ started: true });
    }
    const body = await parseBody(req, faOfferSchema);
    const result = submitFaOffer(id, body.playerId, body.years, body.avgSalary);
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}
