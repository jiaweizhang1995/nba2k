import { getLeagueOverview, getUpcomingGames, getRecentGames, getSave } from "@/server/engine";
import { handleError, ok, fail } from "@/server/api-helpers";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const league = getLeagueOverview(id);
    const strip = (teamId: string) => teamId.split(":").slice(1).join(":");
    type GameRowish = { homeTeamId: string; awayTeamId: string };
    const mapGame = (g: GameRowish) => ({ ...g, homeTeamId: strip(g.homeTeamId), awayTeamId: strip(g.awayTeamId) });
    const upcoming = getUpcomingGames(id, 90).map(mapGame);
    const recent = getRecentGames(id, 30).map(mapGame);
    return ok({ ...league, upcoming, recent, save });
  } catch (e) {
    return handleError(e);
  }
}
