import { stepEvaluation, EvalError } from "@/server/eval";
import { handleError, ok, fail } from "@/server/api-helpers";

/** 推进一步 AI 决策循环（观察 → Provider/回放动作 → 受控执行 → 记录）。 */
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
