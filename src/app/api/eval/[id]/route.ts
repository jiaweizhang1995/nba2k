import { getEvaluationDetail, stepEvaluation, EvalError } from "@/server/eval";
import { handleError, ok, fail } from "@/server/api-helpers";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return ok(getEvaluationDetail(id));
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message, 404);
    return handleError(e);
  }
}

/** 推进一步（客户端循环调用以驱动评测；暂停/取消在服务端强制生效）。 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const state = await stepEvaluation(id);
    return ok({ state });
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message);
    return handleError(e);
  }
}
