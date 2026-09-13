import { advanceSim } from "@/server/engine";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { advanceSchema } from "@/server/schemas";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, advanceSchema);
    const result = advanceSim(id, body.mode);
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}
