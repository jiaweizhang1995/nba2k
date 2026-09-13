import { z } from "zod";
import { controlEvaluation, EvalError } from "@/server/eval";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";

const schema = z.object({ action: z.enum(["start", "pause", "cancel"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, schema);
    const status = controlEvaluation(id, body.action);
    return ok({ status });
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message);
    return handleError(e);
  }
}
