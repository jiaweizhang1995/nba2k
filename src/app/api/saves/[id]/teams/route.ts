import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { teams as teamsT, players as playersT, draftPicks as picksT } from "@/db/schema";
import { getSave, deadCapHit } from "@/server/engine";
import { capSnapshot } from "@/domain/salary";
import { handleError, ok, fail } from "@/server/api-helpers";

/** All teams with cap snapshots + pick counts (used by trade center & league pages). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const db = getDb();
    // The upcoming draft consumes the picks of the season just completed, and
    // save.season is rolled forward on entering DRAFT (see prepareDraft).
    const nextDraftYear = save.phase === "DRAFT" ? save.season - 1 : save.season;
    const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, id)).all();
    const out = teamRows.map((t) => {
      const roster = db.select().from(playersT).where(and(eq(playersT.saveId, id), eq(playersT.teamId, t.id))).all();
      const picks = db.select().from(picksT).where(and(eq(picksT.saveId, id), eq(picksT.holderTeamId, t.id), eq(picksT.year, nextDraftYear))).all();
      const snap = capSnapshot(roster, roster.length, deadCapHit(id, t.id.split(":").slice(1).join(":")));
      return {
        id: t.id.split(":").slice(1).join(":"),
        abbr: t.abbr,
        city: t.city,
        name: t.name,
        conference: t.conference,
        division: t.division,
        colorPrimary: t.colorPrimary,
        wins: t.wins,
        losses: t.losses,
        aiPhase: t.aiPhase,
        cap: { totalSalary: snap.totalSalary, capSpace: snap.capSpace, overTax: snap.overTax, overSecondApron: snap.overSecondApron, taxBill: snap.taxBill },
        rosterSize: roster.length,
        futureFirsts: picks.filter((p) => p.round === 1).length,
      };
    });
    return ok({ teams: out, season: save.season });
  } catch (e) {
    return handleError(e);
  }
}
