import { z } from "zod";
import { runEvaluation, EvalError } from "@/server/eval";
import { handleError, ok, fail } from "@/server/api-helpers";

const schema = z.object({ maxSteps: z.number().int().min(1).max(600).optional() });

/**
 * 一键跑完评测：服务端循环执行步进直到 DONE/ERROR/CANCELLED/PAUSED 或
 * maxSteps。POST /api/eval/[id]/run，可选 body { maxSteps }。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => ({}));
    const body = schema.safeParse(raw ?? {});
    if (!body.success) return fail("BAD_INPUT", "maxSteps 需为 1-600 的整数", 400);
    const result = await runEvaluation(id, body.data);
    return ok(result);
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message);
    return handleError(e);
  }
}
