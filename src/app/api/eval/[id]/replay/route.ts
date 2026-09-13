import { startReplay, EvalError } from "@/server/eval";
import { handleError, ok, fail } from "@/server/api-helpers";

/** 创建回放评测：同基准存档+同种子重新克隆，按记录动作重放（不调用模型）。 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return ok(startReplay(id), 201);
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message);
    return handleError(e);
  }
}
