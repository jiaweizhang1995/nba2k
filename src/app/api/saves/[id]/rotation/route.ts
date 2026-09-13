import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, saves as savesT } from "@/db/schema";
import { getPhaseState, logEvent, EngineError } from "@/server/engine";
import { handleError, ok, fail, parseBody } from "@/server/api-helpers";
import { rotationSchema } from "@/server/schemas";

/** Accept both short ("BOS") and full ("saveId:BOS") team ids. */
const shortId = (t: string) => (t.includes(":") ? t.split(":").slice(1).join(":") : t);

/** GET: current rotation config for a team (+ roster availability context). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(_req.url);
    const teamId = url.searchParams.get("teamId");
    if (!teamId) return fail("NO_TEAM", "缺少 teamId", 400);
    const db = getDb();
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, id), eq(playersT.teamId, `${id}:${shortId(teamId)}`)))
      .all();
    const rotation = ((getPhaseState(id).rotation as Record<string, { starters: string[]; minutes?: Record<string, number> }> | undefined) ?? {})[shortId(teamId)] ?? null;
    return ok({
      rotation,
      roster: roster.map((p) => ({
        id: shortId(p.id),
        name: p.name,
        position: p.position,
        secondPosition: p.secondPosition,
        overall: p.ratings.overall,
        role: p.role,
        status: p.status,
        stamina: p.stamina,
        injured: !!(p.injury && p.injury.weeksRemaining > 0),
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}

/** PUT: save (or reset) the manager's rotation: 5 starters + minute targets. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, rotationSchema);
    const db = getDb();
    const teamShort = shortId(body.teamId);

    if (body.reset) {
      const ps = getPhaseState(id);
      const rotation = { ...((ps.rotation as Record<string, unknown>) ?? {}) };
      delete rotation[teamShort];
      db.update(savesT)
        .set({ phaseState: { ...ps, rotation }, updatedAt: new Date().toISOString() })
        .where(eq(savesT.id, id))
        .run();
      logEvent(id, "SYSTEM", `恢复自动轮换：${teamShort}`, { teamId: teamShort });
      return ok({ reset: true });
    }

    if (!body.starters) throw new EngineError("NO_STARTERS", "请选择 5 名首发球员");
    const roster = db
      .select()
      .from(playersT)
      .where(and(eq(playersT.saveId, id), eq(playersT.teamId, `${id}:${teamShort}`)))
      .all();
    const rosterIds = new Set(roster.map((p) => shortId(p.id)));
    const unavailable = body.starters.filter((pid) => {
      const p = roster.find((x) => shortId(x.id) === pid);
      return !p || p.status === "INJURED" || !!(p.injury && p.injury.weeksRemaining > 0);
    });
    if (unavailable.length > 0) {
      const names = unavailable.map((pid) => roster.find((x) => shortId(x.id) === pid)?.name ?? pid).join("、");
      return fail("STARTER_UNAVAILABLE", `首发中有无法登场的球员：${names}`, 400);
    }
    if (new Set(body.starters).size !== 5) return fail("DUP_STARTERS", "首发球员重复", 400);
    for (const pid of body.starters) {
      if (!rosterIds.has(pid)) return fail("NOT_OWNED", `球员 ${pid} 不在该队阵容中`, 400);
    }

    const ps = getPhaseState(id);
    const rotation = { ...((ps.rotation as Record<string, unknown>) ?? {}) };
    rotation[teamShort] = { starters: body.starters, minutes: body.minutes ?? {} };
    db.update(savesT)
      .set({ phaseState: { ...ps, rotation }, updatedAt: new Date().toISOString() })
      .where(eq(savesT.id, id))
      .run();
    const nameOf = (pid: string) => roster.find((x) => shortId(x.id) === pid)?.name ?? pid;
    const minutesSummary = body.minutes
      ? Object.entries(body.minutes)
          .filter(([, m]) => m > 0)
          .map(([pid, m]) => `${nameOf(pid)} ${Math.round(m)}分`)
          .join("、")
      : "自动分配";
    logEvent(id, "SYSTEM", `更新轮换：${teamShort} 首发 ${body.starters.map(nameOf).join("、")}；时间分配：${minutesSummary}`, { teamId: teamShort });
    return ok({ rotation: rotation[teamShort] });
  } catch (e) {
    return handleError(e);
  }
}
