import { getTeamAssets, getSave } from "@/server/engine";
import { handleError, ok, fail } from "@/server/api-helpers";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const url = new URL(req.url);
    const teamId = url.searchParams.get("teamId");
    if (!teamId) return fail("NO_TEAM", "缺少 teamId 参数");
    const assets = getTeamAssets(id, teamId);
    return ok({ assets });
  } catch (e) {
    return handleError(e);
  }
}
