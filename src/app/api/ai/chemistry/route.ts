import { getChemistry, getSave } from "@/server/engine";
import { explainChemistry } from "@/lib/ai-content";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { aiChemistrySchema } from "@/server/schemas";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT } from "@/db/schema";

/** GLM explains the engine-computed chemistry (numbers are fixed inputs). */
export async function POST(req: Request) {
  try {
    const body = await parseBody(req, aiChemistrySchema);
    const save = getSave(body.saveId);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const chemistry = getChemistry(body.saveId, body.teamId);
    const db = getDb();
    const roster = db.select().from(playersT).where(and(eq(playersT.saveId, body.saveId), eq(playersT.teamId, body.teamId))).all();
    const recentMoves = roster
      .filter((p) => p.tenure <= 1)
      .slice(0, 5)
      .map((p) => `${p.name}（加入第 ${p.tenure} 年）`);
    const result = await explainChemistry({
      teamName: body.teamId.split(":").pop() ?? body.teamId,
      overall: chemistry.overall,
      factors: chemistry.factors.map((f) => ({ label: f.label, score: f.score, note: f.note })),
      recentMoves,
    });
    // ok:true at transport level; AI availability is reported via aiOk so the
    // engine-computed chemistry still reaches the client when GLM is down.
    return ok({ aiOk: result.ok, text: result.text, chemistry });
  } catch (e) {
    return handleError(e);
  }
}
