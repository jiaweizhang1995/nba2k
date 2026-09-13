import { godOp, setGodMode, getSave } from "@/server/engine";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { godSchema, godToggleSchema } from "@/server/schemas";

/** POST ?action=toggle {enabled} or POST (body: {op, params}) — all logged. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "toggle") {
      const body = await parseBody(req, godToggleSchema);
      const result = setGodMode(id, body.enabled);
      return ok({ result });
    }
    const body = await parseBody(req, godSchema);
    const result = godOp(id, body.op, body.params as Record<string, unknown>);
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    return ok({ godMode: save.godMode });
  } catch (e) {
    return handleError(e);
  }
}
