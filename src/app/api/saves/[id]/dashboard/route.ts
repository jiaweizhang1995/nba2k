import { and, eq, or, asc } from "drizzle-orm";
import { getDb } from "@/db";
import { teams as teamsT, players as playersT, games as gamesT, saves as savesT } from "@/db/schema";
import { getPhaseState, getChemistry } from "@/server/engine";
import { CBA, capSnapshot } from "@/domain/salary";
import { handleError, ok, fail } from "@/server/api-helpers";

const shortId = (full: string) => full.split(":").slice(1).join(":");

interface Advisor {
  id: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string;
  actionLabel: string;
  actionHref: string;
}

/**
 * Decision-hub payload for the GM home page. Everything here answers a
 * manager question or suggests an action; engine metadata (seed/versions/
 * data source) intentionally stays out — it lives in Settings.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const db = getDb();
    const save = db.select().from(savesT).where(eq(savesT.id, id)).get();
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const ps = getPhaseState(id);
    const userTeamFull = (ps.userTeamId as string) ?? null;
    if (!userTeamFull) return fail("NO_TEAM", "请先选择执教球队", 400);
    const teamShort = shortId(userTeamFull);

    const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, id)).all();
    const team = teamRows.find((t) => t.id === userTeamFull);
    if (!team) return fail("NO_TEAM", "球队不存在", 404);

    const roster = db.select().from(playersT).where(and(eq(playersT.saveId, id), eq(playersT.teamId, userTeamFull))).all();
    const active = roster.filter((p) => p.status === "ACTIVE" || p.status === "INJURED");

    // ---- Standings & rank ----
    const confTeams = teamRows
      .filter((t) => t.conference === team.conference)
      .map((t) => ({ id: shortId(t.id), abbr: t.abbr, city: t.city, name: t.name, wins: t.wins, losses: t.losses }))
      .sort((a, b) => b.wins - a.wins || a.abbr.localeCompare(b.abbr));
    const rank = confTeams.findIndex((t) => t.id === teamShort) + 1;
    const leader = confTeams[0];

    // ---- Games: recent (with box reasons) & upcoming ----
    const myGames = db
      .select()
      .from(gamesT)
      .where(
        and(
          eq(gamesT.saveId, id),
          eq(gamesT.season, save.season),
          or(eq(gamesT.homeTeamId, userTeamFull), eq(gamesT.awayTeamId, userTeamFull)),
        ),
      )
      .orderBy(asc(gamesT.date))
      .all();
    const teamAbbr = new Map(teamRows.map((t) => [shortId(t.id), t.abbr] as const));
    const teamNameOf = new Map(teamRows.map((t) => [shortId(t.id), `${t.city} ${t.name}`] as const));
    const recOf = (tid: string) => {
      const t = teamRows.find((x) => shortId(x.id) === tid);
      return t ? `${t.wins}-${t.losses}` : "?-?";
    };

    const finals = myGames.filter((g) => g.status === "FINAL");
    const recentGames = finals.slice(-5).reverse().map((g) => {
      const home = g.homeTeamId === userTeamFull;
      const my = (home ? g.homeScore : g.awayScore) ?? 0;
      const opp = (home ? g.awayScore : g.homeScore) ?? 0;
      const oppId = shortId(home ? g.awayTeamId : g.homeTeamId);
      const box = g.box as { notes?: string[]; home?: { name: string; pts: number }[]; away?: { name: string; pts: number }[] } | null;
      const topAll = [...(box?.home ?? []), ...(box?.away ?? [])].sort((a, b) => b.pts - a.pts)[0];
      return {
        gameId: g.id,
        date: g.date,
        home,
        opponent: teamAbbr.get(oppId) ?? "?",
        myScore: my,
        oppScore: opp,
        win: my > opp,
        topPerf: topAll ? `${topAll.name} ${topAll.pts} 分` : null,
        keyReasons: (box?.notes ?? []).slice(0, 3),
      };
    });

    // Trend: last 10, W/L string + current streak.
    const last10 = finals.slice(-10).map((g) => ((g.homeTeamId === userTeamFull ? g.homeScore : g.awayScore) ?? 0) > ((g.homeTeamId === userTeamFull ? g.awayScore : g.homeScore) ?? 0));
    let streak = 0;
    if (last10.length > 0) {
      const w = last10[last10.length - 1];
      for (let i = last10.length - 1; i >= 0 && last10[i] === w; i--) streak++;
      streak = w ? streak : -streak;
    }

    const scheduled = myGames.filter((g) => g.status === "SCHEDULED");
    const upcoming = scheduled.slice(0, 5).map((g) => {
      const home = g.homeTeamId === userTeamFull;
      const oppId = shortId(home ? g.awayTeamId : g.homeTeamId);
      return { date: g.date, home, opponent: teamAbbr.get(oppId) ?? "?", opponentName: teamNameOf.get(oppId) ?? "?", opponentRecord: recOf(oppId) };
    });
    const nextGame = upcoming[0] ?? null;
    // Back-to-back check: did we play the day before the next game?
    const nextIsB2B =
      nextGame != null &&
      finals.some((g) => {
        const d = new Date(g.date + "T00:00:00Z").getTime();
        const nd = new Date(nextGame.date + "T00:00:00Z").getTime();
        return Math.round((nd - d) / 86400000) === 1;
      });

    // ---- Injuries & fatigue ----
    const starterIds = new Set(((ps.rotation as Record<string, { starters?: string[] }> | undefined)?.[teamShort]?.starters ?? []) as string[]);
    const roleRank: Record<string, number> = { STAR: 0, STARTER: 1, SIXTH_MAN: 2, ROTATION: 3, BENCH: 4, STASH: 5 };
    const depthOrder = [...active].sort((a, b) => b.ratings.overall - a.ratings.overall || (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3));
    const autoStarters = depthOrder.slice(0, 5);
    const effectiveStarters = starterIds.size === 5 ? active.filter((p) => starterIds.has(shortId(p.id))) : autoStarters;
    const starterIdSet = new Set(effectiveStarters.map((p) => shortId(p.id)));

    const injuries = active
      .filter((p) => p.injury && p.injury.weeksRemaining > 0)
      .map((p) => ({
        playerId: shortId(p.id),
        name: p.name,
        position: p.position,
        overall: p.ratings.overall,
        description: p.injury!.description,
        weeks: Math.max(0, Math.round(p.injury!.weeksRemaining * 7)),
        severity: p.injury!.severity,
        isStarter: starterIdSet.has(shortId(p.id)),
      }))
      .sort((a, b) => Number(b.isStarter) - Number(a.isStarter) || a.weeks - b.weeks);

    const fatigue = active
      .filter((p) => p.stamina < 0.75)
      .map((p) => ({ playerId: shortId(p.id), name: p.name, stamina: Math.round(p.stamina * 100), isStarter: starterIdSet.has(shortId(p.id)) }))
      .sort((a, b) => a.stamina - b.stamina)
      .slice(0, 6);

    // ---- Rotation summary ----
    const pLine = (p: (typeof roster)[number]) => ({
      id: shortId(p.id),
      name: p.name,
      position: p.position,
      overall: p.ratings.overall,
      minutes: (ps.rotation as Record<string, { minutes?: Record<string, number> }> | undefined)?.[teamShort]?.minutes?.[shortId(p.id)] ?? null,
      stamina: Math.round(p.stamina * 100),
      injured: !!(p.injury && p.injury.weeksRemaining > 0),
    });
    const rotation = {
      configured: starterIds.size === 5,
      starters: effectiveStarters.map(pLine),
      benchTop: depthOrder.filter((p) => !starterIdSet.has(shortId(p.id))).slice(0, 4).map(pLine),
    };

    // ---- Cap / tax ----
    const cap = capSnapshot(active, active.length);

    // ---- Chemistry → basketball conclusions (3 weakest factors) ----
    const chem = getChemistry(id, teamShort);
    const chemistry = {
      overall: chem.overall,
      conclusions: [...chem.factors]
        .filter((f) => f.key !== "roster")
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map((f) => ({ label: f.label, score: f.score, note: f.note })),
    };

    // ---- Advisors: rule-based, each with a jump-to-action link ----
    const advisors: Advisor[] = [];
    for (const inj of injuries) {
      if (inj.isStarter) {
        advisors.push({
          id: `inj-${inj.playerId}`,
          severity: "HIGH",
          title: `首发 ${inj.name}（${inj.position}，${inj.overall}）伤停约 ${inj.weeks} 天`,
          detail: `${inj.description}。空出的首发位置需要指定顶替者，或把他的时间分给轮换球员。`,
          actionLabel: "调整轮换",
          actionHref: "/roster",
        });
      }
    }
    if (cap.overTax) {
      advisors.push({
        id: "tax",
        severity: "HIGH",
          title: `薪资 ${cap.totalSalary.toFixed(1)}M 已超税线（${CBA.luxuryTax}M）`,
        detail: `按当前薪资预计需缴奢侈税 ${cap.taxBill.toFixed(1)}M（税线 ${CBA.luxuryTax}M）。送出到期合同或高薪低效球员可以止损。`,
        actionLabel: "处理交易",
        actionHref: "/trade",
      });
    }
    const benchPlayers = depthOrder.filter((p) => !starterIdSet.has(shortId(p.id)));
    const benchCreator = Math.max(0, ...benchPlayers.map((p) => p.ratings.playmaking));
    if (benchPlayers.length > 0 && benchCreator < 62) {
      advisors.push({
        id: "bench-pg",
        severity: "MEDIUM",
        title: "替补席缺少组织者",
        detail: `轮换替补中最高组织评分仅 ${benchCreator}，主力控卫休息时进攻容易断电。可在自由市场或交易中寻找替补控球。`,
        actionLabel: "看自由市场",
        actionHref: "/freeagency",
      });
    }
    const top9 = depthOrder.slice(0, 9);
    const rebAvg = top9.length ? top9.reduce((a, p) => a + p.ratings.rebounding, 0) / top9.length : 0;
    if (top9.length >= 5 && rebAvg < 62) {
      advisors.push({
        id: "dreb",
        severity: "MEDIUM",
        title: "防守篮板薄弱",
        detail: `主要轮换平均篮板评分 ${rebAvg.toFixed(0)}，对手会获得大量二次进攻机会。优先补强内线或调整篮板型球员进入轮换。`,
        actionLabel: "调整轮换",
        actionHref: "/roster",
      });
    }
    const tiredStarters = fatigue.filter((f) => f.isStarter);
    if (tiredStarters.length > 0) {
      advisors.push({
        id: "fatigue",
        severity: nextIsB2B ? "HIGH" : "MEDIUM",
        title: `${tiredStarters.map((f) => f.name).join("、")} 疲劳累积（体力 ${tiredStarters.map((f) => f.stamina + "%").join("、")}）`,
        detail: nextIsB2B ? "下一场是背靠背，疲劳球员表现与伤病风险都会恶化，建议压缩他们的上场时间。" : "连续作战导致体力下降，建议在轮换中给替补更多时间。",
        actionLabel: "调整轮换",
        actionHref: "/roster",
      });
    }
    if (save.phase === "DRAFT") {
      advisors.push({
        id: "draft",
        severity: "HIGH",
        title: "选秀大会进行中",
        detail: "选秀需要经理手动操作，完成全部顺位后才能进入自由市场。",
        actionLabel: "去选秀",
        actionHref: "/draft",
      });
    }
    if (save.phase === "FREE_AGENCY") {
      advisors.push({
        id: "fa",
        severity: "HIGH",
        title: "自由市场开放中",
        detail: "报价被拒或接受都会立即生效，薪资空间有限时优先补最弱一环。",
        actionLabel: "去自由市场",
        actionHref: "/freeagency",
      });
    }

    // 待处理事件 = 必须手动操作的阶段动作（advisors 中的球队问题单独展示，不重复）。
    const pendingEvents = advisors
      .filter((a) => ["draft", "fa"].includes(a.id))
      .map((a) => ({ title: a.title, actionLabel: a.actionLabel, actionHref: a.actionHref }));

    return ok({
      team: {
        id: teamShort,
        abbr: team.abbr,
        city: team.city,
        name: team.name,
        conference: team.conference,
        wins: team.wins,
        losses: team.losses,
        phase: save.phase,
        currentDate: save.currentDate,
        season: save.season,
      },
      standings: { rank, total: confTeams.length, leaderAbbr: teamAbbr.get(leader?.id ?? "") ?? "?", gamesBack: leader ? leader.wins - team.wins : 0 },
      trend: { last10: `${last10.filter(Boolean).length}-${last10.length - last10.filter(Boolean).length}`, streak: streak === 0 ? null : streak > 0 ? `${streak} 连胜` : `${-streak} 连败` },
      nextGame: nextGame ? { ...nextGame, backToBack: nextIsB2B } : null,
      upcoming,
      recentGames,
      injuries,
      fatigue,
      rotation,
      cap: {
        totalSalary: cap.totalSalary,
        capSpace: cap.capSpace,
        overCap: cap.overCap,
        overTax: cap.overTax,
        taxBill: cap.taxBill,
        cap: CBA.salaryCap,
        luxuryTax: CBA.luxuryTax,
      },
      chemistry,
      advisors,
      pendingEvents,
    });
  } catch (e) {
    return handleError(e);
  }
}
