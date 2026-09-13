import { getEvents } from "@/server/engine";
import { handleError, ok } from "@/server/api-helpers";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));
    const category = url.searchParams.get("category") ?? undefined;
    return ok({ events: getEvents(id, limit, category) });
  } catch (e) {
    return handleError(e);
  }
}
