import { requestTradeOffers, getSave } from "@/server/engine";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { tradeOffersSchema } from "@/server/schemas";

// 征集报价（NBA 2K 式）：用户只选送出的资产，联盟中感兴趣的球队回报具体报价。
// 返回的每份报价都已通过规则校验与对方 GM 意愿评估，可直接采用并执行。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!getSave(id)) return handleError(new Error("存档不存在"));
    const body = await parseBody(req, tradeOffersSchema);
    const result = requestTradeOffers(id, body.gives);
    return ok(result);
  } catch (e) {
    return handleError(e);
  }
}
