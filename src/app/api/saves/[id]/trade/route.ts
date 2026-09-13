import { executeTrade, getAiTradeFeedback, validateTradeOnServer, getSave } from "@/server/engine";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { executeTradeSchema, tradeSchema } from "@/server/schemas";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return handleError(new Error("存档不存在"));
    const body = await parseBody(req, executeTradeSchema);
    const result = executeTrade(id, body.parties, { godMode: save.godMode, force: body.force, note: body.note });
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // validate-only + AI feedback preview
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, tradeSchema);
    const validation = validateTradeOnServer(id, body.parties);
    const feedback = getAiTradeFeedback(id, body.parties);
    return ok({ validation, feedback });
  } catch (e) {
    return handleError(e);
  }
}
