import { getDraftBoard, getDraftOrder, makeDraftPick, getSave, getPhaseState } from "@/server/engine";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { draftSchema } from "@/server/schemas";
import { DRAFT_RULES_VERSION } from "@/domain/draft";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const board = getDraftBoard(id);
    const order = getDraftOrder(id);
    const userTeamId = getPhaseState(id).userTeamId as string | undefined;
    return ok({ board, order, userTeamId, draftYear: save.season, phase: save.phase, rulesVersion: DRAFT_RULES_VERSION });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, draftSchema);
    const picked = makeDraftPick(id, body);
    return ok({ picked });
  } catch (e) {
    return handleError(e);
  }
}
