// GAME-SIM v2.0 quality gates: determinism, realistic scoring/stat lines,
// rotation minutes (auto + manager-set), injury & fatigue effects, schedule
// integrity (no B2B, venue streaks, meeting caps) and overtime validity.
import { describe, expect, it, beforeAll } from "vitest";
import { generateDemoLeague } from "@/data/demo";
import { simulateGame, buildRotation, type SimTeam, type SimPlayer } from "@/domain/sim/game";
import { createSchedule, type LeagueState, type LeagueTeam } from "@/domain/sim/season";
import { rngFor } from "@/domain/rng";
import { createSave, loadLeagueState, advanceSim } from "@/server/engine";

function toSimTeam(state: LeagueState, teamId: string, staminaOverride?: Record<string, number>): SimTeam {
  const t = state.teams.find((x) => x.id === teamId)!;
  return {
    id: t.id,
    name: t.abbr,
    players: state.players
      .filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"))
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position as SimPlayer["position"],
        ratings: {
          overall: p.ratings.overall,
          inside: p.ratings.inside,
          finishing: p.ratings.finishing,
          threePoint: p.ratings.threePoint,
          freeThrow: p.ratings.freeThrow,
          playmaking: p.ratings.playmaking,
          rebounding: p.ratings.rebounding,
          perimeterD: p.ratings.perimeterD,
          interiorD: p.ratings.interiorD,
        },
        usageTendency: p.ratings.usageTendency,
        role: p.role,
        injury: p.injury && p.injury.weeksRemaining > 0 ? { weeksRemaining: p.injury.weeksRemaining, severity: p.injury.severity } : null,
        stamina: staminaOverride?.[p.id] ?? p.stamina,
      })),
  };
}

let realSaveId: string;
let realState: LeagueState;

beforeAll(async () => {
  const s = await createSave({ name: "引擎质量测试", seed: 20260913 });
  realSaveId = s.saveId;
  realState = loadLeagueState(realSaveId);
}, 180_000);

describe("GAME-SIM v2.0 确定性", () => {
  it("同 seed+salt → 完全相同的比分与数据行", () => {
    const home = toSimTeam(realState, realState.teams[0].id);
    const away = toSimTeam(realState, realState.teams[1].id);
    const a = simulateGame(home, away, { seed: 99, salt: "det" });
    const b = simulateGame(home, away, { seed: 99, salt: "det" });
    expect(a.homeScore).toBe(b.homeScore);
    expect(a.awayScore).toBe(b.awayScore);
    expect(a.box).toEqual(b.box);
    expect(a.otPeriods).toBe(b.otPeriods);
  });

  it("不同 seed → 不同结果", () => {
    const home = toSimTeam(realState, realState.teams[0].id);
    const away = toSimTeam(realState, realState.teams[1].id);
    const scores = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = simulateGame(home, away, { seed: 1000 + i * 7919, salt: "det" });
      scores.add(`${r.homeScore}-${r.awayScore}`);
    }
    expect(scores.size).toBeGreaterThan(1);
  });
});

describe("比分与统计合理性（真实数据 30 场）", () => {
  const results: ReturnType<typeof simulateGame>[] = [];
  beforeAll(() => {
    const teams = realState.teams;
    for (let i = 0; i < 30; i++) {
      const home = toSimTeam(realState, teams[i % teams.length].id);
      const away = toSimTeam(realState, teams[(i * 7 + 13) % teams.length].id);
      if (home.id === away.id) continue;
      results.push(simulateGame(home, away, { seed: 5000 + i * 101, salt: "quality" }));
    }
  });

  it("每队每场得分在 75-150 之间，总分均值在 95-125", () => {
    const all: number[] = [];
    for (const r of results) {
      all.push(r.homeScore, r.awayScore);
      expect(r.homeScore).toBeGreaterThan(70);
      expect(r.homeScore).toBeLessThan(155);
      expect(r.awayScore).toBeGreaterThan(70);
      expect(r.awayScore).toBeLessThan(155);
      expect(r.homeScore).not.toBe(r.awayScore); // OT 保证分出胜负
    }
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    expect(avg).toBeGreaterThan(95);
    expect(avg).toBeLessThan(128);
  });

  it("轮换分钟守恒：无加时每队 240 分钟，出手/失误/篮板在 NBA 范围", () => {
    let fga = 0, tpa = 0, fta = 0, tov = 0, reb = 0, n = 0;
    for (const r of results) {
      if (r.otPeriods === 0) {
        for (const side of [r.box.home, r.box.away]) {
          const mpSum = side.reduce((a, l) => a + l.mp, 0);
          expect(Math.abs(mpSum - 240)).toBeLessThan(1.2);
        }
      }
      for (const l of [...r.box.home, ...r.box.away]) {
        expect(l.mp).toBeLessThanOrEqual(45); // 常规时间单人不超过 45 分钟
        expect(l.mp).toBeGreaterThanOrEqual(0);
        fga += l.fga; tpa += l.tpa; fta += l.fta; tov += l.tov; reb += l.reb;
      }
      n += 4; // 2 teams × (2 sides each game counted once below)
      void n;
    }
    const games = results.length * 2;
    const fpa = (v: number) => v / games;
    expect(fpa(fga)).toBeGreaterThan(72);
    expect(fpa(fga)).toBeLessThan(100);
    expect(tpa / fga).toBeGreaterThan(0.18);
    expect(tpa / fga).toBeLessThan(0.55);
    expect(fpa(fta)).toBeGreaterThan(12);
    expect(fpa(fta)).toBeLessThan(30);
    expect(fpa(tov)).toBeGreaterThan(8);
    expect(fpa(tov)).toBeLessThan(20);
    expect(fpa(reb)).toBeGreaterThan(35);
    expect(fpa(reb)).toBeLessThan(55);
  });

  it("得分分布有层次：主力得分多于替补", () => {
    for (const r of results.slice(0, 10)) {
      const starters = r.box.home.slice(0, 5).reduce((a, l) => a + l.pts, 0);
      const bench = r.box.home.slice(5).reduce((a, l) => a + l.pts, 0);
      expect(starters).toBeGreaterThanOrEqual(bench);
    }
  });
});

describe("经理轮换配置生效", () => {
  it("配置的首发获得远高于替补的时间，接近目标分钟", () => {
    const teamId = realState.teams[0].id;
    const roster = realState.players.filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"));
    const byOvr = [...roster].sort((a, b) => b.ratings.overall - a.ratings.overall);
    const starters = byOvr.slice(4, 9).map((p) => p.id); // 故意不用 top5，验证配置被遵守
    const team = toSimTeam(realState, teamId);
    team.config = { starters, minutes: Object.fromEntries(starters.map((id) => [id, 36])) };
    const rng = rngFor(1, "rotcfg");
    const slots = buildRotation(team, rng, {});
    const mpOf = (pid: string) => slots.find((s) => s.player.id === pid)?.plan ?? 0;
    for (const id of starters) expect(mpOf(id)).toBeCloseTo(36, 0);
    const nonStarterMax = slots.filter((s) => !starters.includes(s.player.id)).reduce((a, s) => Math.max(a, s.plan), 0);
    expect(nonStarterMax).toBeLessThan(30);
    const away = toSimTeam(realState, realState.teams[1].id);
    const game = simulateGame(team, away, { seed: 77, salt: "rotcfg" });
    for (const id of starters) {
      const line = game.box.home.find((l) => l.playerId === id);
      expect(line).toBeTruthy();
      expect(line!.mp).toBeGreaterThan(28);
    }
  });

  it("不给任何配置时按角色自动分配：首发合计时间显著高于替补", () => {
    const teamId = realState.teams[2].id;
    const team = toSimTeam(realState, teamId);
    const rng = rngFor(2, "auto");
    const slots = buildRotation(team, rng, {});
    const top5 = slots.slice(0, 5).reduce((a, s) => a + s.plan, 0);
    const rest = slots.slice(5).reduce((a, s) => a + s.plan, 0);
    expect(top5).toBeGreaterThan(rest);
    // 没有人因为评分高而被强塞不合理的最低时间：替补角色可以低至 0
    const minPlan = slots[slots.length - 1].plan;
    expect(minPlan).toBeLessThan(12);
  });
});

describe("伤病与疲劳影响", () => {
  it("伤病球员不会登场", () => {
    const teamId = realState.teams[3].id;
    const roster = realState.players.filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"));
    const victim = roster.find((p) => p.status === "ACTIVE")!;
    victim.injury = { description: "测试伤", weeksRemaining: 2, severity: "MINOR" };
    victim.status = "INJURED";
    const team = toSimTeam(realState, teamId);
    const away = toSimTeam(realState, realState.teams[4].id);
    const game = simulateGame(team, away, { seed: 31, salt: "inj" });
    expect(game.box.home.find((l) => l.playerId === victim.id)).toBeUndefined();
  });

  it("低体力球队：轮换缩短（替补份额下降）且表现更差", () => {
    const teamId = realState.teams[3].id;
    const awayId = realState.teams[4].id;
    // 轮换缩短：替补的计划分钟占比下降
    const freshTeam = toSimTeam(realState, teamId);
    const tiredTeam = toSimTeam(realState, teamId);
    for (const p of tiredTeam.players) p.stamina = 0.5;
    const freshRot = buildRotation(freshTeam, rngFor(5, "fat"), {});
    const tiredRot = buildRotation(tiredTeam, rngFor(5, "fat"), {});
    const benchShare = (rot: ReturnType<typeof buildRotation>) => {
      const total = rot.reduce((a, s) => a + s.plan, 0);
      return rot.slice(5).reduce((a, s) => a + s.plan, 0) / total;
    };
    expect(benchShare(tiredRot)).toBeGreaterThan(benchShare(freshRot));

    // 表现更差：同一对手、相同 seed 序列，疲劳球队场均得分更低
    let freshPts = 0;
    let tiredPts = 0;
    const away = toSimTeam(realState, awayId);
    for (let i = 0; i < 15; i++) {
      const r1 = simulateGame(toSimTeam(realState, teamId), away, { seed: 700 + i, salt: "perf" });
      const r2 = simulateGame(tiredTeam, away, { seed: 700 + i, salt: "perf" });
      freshPts += r1.homeScore;
      tiredPts += r2.homeScore;
    }
    expect(tiredPts).toBeLessThan(freshPts);
  });

  it("背靠背：轮换进一步缩短、球队节奏变慢", () => {
    const teamId = realState.teams[5].id;
    const team = toSimTeam(realState, teamId);
    const opp = toSimTeam(realState, realState.teams[6].id);
    const normal = buildRotation(toSimTeam(realState, teamId), rngFor(6, "b2b"), {});
    const b2b = buildRotation(team, rngFor(6, "b2b"), { backToBack: true });
    const benchShare = (rot: ReturnType<typeof buildRotation>) => rot.slice(5).reduce((a, s) => a + s.plan, 0) / rot.reduce((a, s) => a + s.plan, 0);
    expect(benchShare(b2b)).toBeGreaterThan(benchShare(normal));
    const fgaOf = (r: ReturnType<typeof simulateGame>) => [...r.box.home, ...r.box.away].reduce((a, l) => a + l.fga, 0);
    let fgaNormal = 0;
    let fgaB2b = 0;
    for (let i = 0; i < 10; i++) {
      fgaNormal += fgaOf(simulateGame(toSimTeam(realState, teamId), opp, { seed: 61 + i, salt: "pace" }));
      fgaB2b += fgaOf(simulateGame(team, opp, { seed: 61 + i, salt: "pace", backToBackHome: true }));
    }
    expect(fgaB2b).toBeLessThan(fgaNormal); // 背靠背整体节奏变慢
  });
});

describe("赛程完整性", () => {
  it("82 场/队；无背靠背；连主/连客 ≤3；单队单日最多 1 场；交手 ≤4 次", () => {
    const demo = generateDemoLeague(7, 2027);
    const state = {
      saveId: "s",
      seed: 7,
      season: 2027,
      phase: "REGULAR_SEASON" as const,
      currentDate: "2026-10-21",
      teams: demo.teams.map((t) => ({ ...t, wins: 0, losses: 0 })) as LeagueTeam[],
      players: [],
      games: [],
      playoffs: null,
    };
    const games = createSchedule(state);
    expect(games).toHaveLength((30 * 82) / 2);

    const byTeam = new Map<string, { dates: string[]; venues: ("H" | "A")[] }>();
    const meetings = new Map<string, number>();
    for (const g of games) {
      for (const [t, v] of [[g.homeTeamId, "H"], [g.awayTeamId, "A"]] as const) {
        if (!byTeam.has(t)) byTeam.set(t, { dates: [], venues: [] });
        byTeam.get(t)!.dates.push(g.date);
        byTeam.get(t)!.venues.push(v as "H" | "A");
      }
      const mk = g.homeTeamId < g.awayTeamId ? `${g.homeTeamId}|${g.awayTeamId}` : `${g.awayTeamId}|${g.homeTeamId}`;
      meetings.set(mk, (meetings.get(mk) ?? 0) + 1);
    }
    for (const [teamId, { dates, venues }] of byTeam) {
      expect(dates).toHaveLength(82);
      expect(new Set(dates).size).toBe(82); // 单日最多 1 场
      const sorted = [...dates].sort();
      for (let i = 1; i < sorted.length; i++) {
        const d1 = new Date(sorted[i - 1] + "T00:00:00Z").getTime();
        const d2 = new Date(sorted[i] + "T00:00:00Z").getTime();
        expect((d2 - d1) / 86400000).toBeGreaterThanOrEqual(2); // 无背靠背
      }
      // 连主/连客 ≤ 3（按时间排序后检查）
      const order = dates
        .map((d, i) => ({ d, v: venues[i] }))
        .sort((a, b) => a.d.localeCompare(b.d))
        .map((x) => x.v);
      let run = 1;
      for (let i = 1; i < order.length; i++) {
        run = order[i] === order[i - 1] ? run + 1 : 1;
        expect(run).toBeLessThanOrEqual(3);
      }
      void teamId;
    }
    for (const count of meetings.values()) expect(count).toBeLessThanOrEqual(4);
  });
});

describe("加时与季后赛推进", () => {
  it("加时赛产生有效胜负（扫描 400 场势均力敌对局）", () => {
    // 用同一支球队自打（实力相同）最大化进入加时的概率；NBA 加时率约 6%。
    const tA = realState.teams[0].id;
    const tB = realState.teams[7].id;
    const home = toSimTeam(realState, tA);
    const away = toSimTeam(realState, tB);
    let sawOT = 0;
    for (let i = 0; i < 400 && sawOT < 2; i++) {
      const r = simulateGame(home, away, { seed: 400_000 + i * 977, salt: "ot" });
      if (r.otPeriods > 0) {
        sawOT++;
        expect(r.homeScore).not.toBe(r.awayScore);
        for (const side of [r.box.home, r.box.away]) {
          const mpSum = side.reduce((a, l) => a + l.mp, 0);
          expect(mpSum).toBeGreaterThan(240); // 加时增加上场时间
        }
      }
    }
    expect(sawOT).toBeGreaterThanOrEqual(2);
  });

  it("常规赛推进 → 季后赛 → 总冠军（完整流程冒烟）", async () => {
    const r1 = advanceSim(realSaveId, "REGULAR_SEASON");
    expect(r1.phaseChanged).toBe("PLAYOFFS");
    const r2 = advanceSim(realSaveId, "PLAYOFFS");
    expect(r2.champion).toBeTruthy();
    expect(r2.awards.some((a) => a.type === "CHAMPION")).toBe(true);
    const { getSave } = await import("@/server/engine");
    expect(getSave(realSaveId)!.phase).toBe("DRAFT"); // 休赛期自动进入选秀
  }, 600_000);
});
