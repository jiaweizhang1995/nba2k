// DEMO / ILLUSTRATIVE league data — 100% FICTIONAL.
//
// Everything produced by this module is original synthetic content for
// demonstrating the game. It is NOT real NBA data, NOT any real league's data,
// and every record carries provenance { provider: "DEMO", status: "DEMO",
// licenseNote: "DEMO / ILLUSTRATIVE — fictional, not real-world data" }.
//
// For real-world data, use the import pipeline (settings page or
// `npm run import`) with BALLDONTLIE / Sportradar / CSV-JSON adapters.

import { rngFor } from "@/domain/rng";
import { computeRatings, RATING_VERSION } from "@/domain/ratings";
import type { Contract, PlayerRatings, Position, SeasonStatLine, TeamPhase } from "@/domain/types";

export const DEMO_PROVIDER = "DEMO";
export const DEMO_LICENSE = "DEMO / ILLUSTRATIVE — 虚构演示数据，非真实联赛数据";

export interface DemoTeam {
  id: string;
  abbr: string;
  city: string;
  name: string;
  conference: "EAST" | "WEST";
  division: string;
  colorPrimary: string;
}

export interface DemoPlayerSeed {
  id: string;
  name: string;
  teamId: string | null;
  position: Position;
  secondPosition: Position | null;
  age: number;
  heightCm: number;
  weightKg: number;
  draftYear: number | null;
  draftRound: number | null;
  draftPick: number | null;
  yearsPro: number;
  ratings: PlayerRatings;
  seasonStats: SeasonStatLine[];
  contract: Contract;
  role: string;
  satisfaction: number;
  status: "ACTIVE" | "PROSPECT";
  phase: TeamPhase | null; // team phase hint for AI
}

const EAST: [string, string, string, string, string][][] = [
  // [abbr, city, name, division, color]
  [
    ["BOS", "海港城", "灯塔", "大西洋", "#38bdf8"],
    ["NYK", "大苹果城", "旋风", "大西洋", "#f97316"],
    ["PHI", "自由城", "钟声", "大西洋", "#0ea5e9"],
    ["TOR", "枫叶城", "极光", "大西洋", "#a855f7"],
    ["BKN", "桥头市", "铁桥", "大西洋", "#64748b"],
  ],
  [
    ["CHI", "风垒市", "公牛鲨", "中部", "#ef4444"],
    ["CLE", "湖岸城", "磐石", "中部", "#eab308"],
    ["DET", "车都", "活塞谷", "中部", "#3b82f6"],
    ["IND", "赛道城", "疾风", "中部", "#facc15"],
    ["MIL", "磨坊城", "雄鹿角", "中部", "#22c55e"],
  ],
  [
    ["ATL", "鹰岩城", "猎鹰", "东南", "#f43f5e"],
    ["CHA", "蜂巢市", "大黄蜂", "东南", "#06b6d4"],
    ["MIA", "烈日滩", "热浪", "东南", "#fb7185"],
    ["ORL", "魔泉城", "幻影", "东南", "#8b5cf6"],
    ["WAS", "权杖城", "红隼", "东南", "#dc2626"],
  ],
];
const WEST: [string, string, string, string, string][][] = [
  [
    ["DEN", "高原本地", "雪峰", "西北", "#f59e0b"],
    ["MIN", "寒湖城", "凛冬", "西北", "#10b981"],
    ["OKC", "雷原市", "雷霆云", "西北", "#60a5fa"],
    ["POR", "玫瑰港", "青云", "西北", "#e11d48"],
    ["UTA", "盐谷", "雪鸮", "西北", "#f59e0b"],
  ],
  [
    ["GSW", "金门湾", "潮汐", "太平洋", "#fbbf24"],
    ["LAC", "天使港", "锚链", "太平洋", "#6366f1"],
    ["LAL", "紫金湾", "星辰", "太平洋", "#7c3aed"],
    ["PHX", "日烬城", "炎沙", "太平洋", "#f97316"],
    ["SAC", "王城", "银冠", "太平洋", "#a78bfa"],
  ],
  [
    ["DAL", "牛仔城", "疾驰", "西南", "#2563eb"],
    ["HOU", "航天城", "星座", "西南", "#ef4444"],
    ["MEM", "蓝调城", "棕熊", "西南", "#0d9488"],
    ["NOP", "鹈鹕湾", "湾流", "西南", "#0284c7"],
    ["SAS", "阿拉莫", "刺刃", "西南", "#57534e"],
  ],
];

const FIRST = ["泽维", "凯登", "马里奥", "杰登", "泰伦", "科迪", "德文", "阿隆", "尼科", "埃兰", "朱利安", "凯尔", "布兰登", "特雷", "肖恩", "达柳斯", "杰伦", "马利克", "奥马尔", "瑞恩", "伊曼纽尔", "安德烈", "克里斯托弗", "罗曼", "迪米特里", "卢卡", "亚历杭德罗", "小卡洛斯", "以赛亚", "塞德里克", "马库斯", "德里克", "格兰特", "奥斯汀", "钱斯", "科尔比", "德肖恩", "埃默森", "费利克斯", "加布里埃尔"];
const LAST = ["科尔曼", "布莱恩特", "奥杜亚", "维加斯", "田川", "金佐", "拉尔森", "门罗", "奥科罗", "佩特罗夫", "奇亚里尼", "范德维尔", "华盛顿", "伊巴卡涅", "尤索夫", "津琴科", "阿德托昆贝", "博格丹", "卡鲁索", "德罗拉", "恩迪亚耶", "福克斯沃斯", "加尔萨", "赫伦纽斯", "伊沃", "久里奇", "卡拉马佐夫", "隆戈", "姆巴耶", "纳瓦罗", "欧文森", "帕拉西奥斯", "昆塔纳", "罗西", "萨尔", "特奥", "乌舍尔", "瓦伦丁", "温特斯", "杨森"];

const HEIGHT_BY_POS: Record<Position, [number, number]> = { PG: [183, 196], SG: [190, 201], SF: [196, 206], PF: [201, 211], C: [208, 221] };
const WEIGHT_BY_POS: Record<Position, [number, number]> = { PG: [78, 92], SG: [84, 100], SF: [92, 108], PF: [100, 116], C: [108, 130] };

export function generateDemoLeague(seed: number, season: number): { teams: DemoTeam[]; players: DemoPlayerSeed[] } {
  const rng = rngFor(seed, "demo-league");
  const teams: DemoTeam[] = [];
  const push = (rows: [string, string, string, string, string][], conf: "EAST" | "WEST") => {
    for (const [abbr, city, name, division, color] of rows) {
      teams.push({ id: `t-${abbr.toLowerCase()}`, abbr, city, name, conference: conf, division, colorPrimary: color });
    }
  };
  for (const block of EAST) push(block, "EAST");
  for (const block of WEST) push(block, "WEST");

  const players: DemoPlayerSeed[] = [];
  const usedNames = new Set<string>();
  const nextName = () => {
    for (let i = 0; i < 500; i++) {
      const n = `${rng.pick(FIRST)}·${rng.pick(LAST)}`;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
    return `球员·${players.length}`;
  };

  const positions: Position[] = ["PG", "SG", "SF", "PF", "C"];

  for (const team of teams) {
    // Team strength tier determines overall distribution; creates title contenders,
    // mid teams and lottery teams like a real league.
    const tier = rng.next(); // 0-1
    const baseOverall = tier < 0.2 ? 72 : tier < 0.55 ? 64 : 57;
    // 13-man roster: 1-2 stars, starters, bench.
    const rosterPlan = [
      { pos: "PG", star: true },
      { pos: "SG", star: tier < 0.4 },
      { pos: "SF", star: tier < 0.15 },
      { pos: "PF", star: false },
      { pos: "C", star: tier < 0.3 },
      { pos: "SG", star: false },
      { pos: "PF", star: false },
      { pos: "PG", star: false },
      { pos: "C", star: false },
      { pos: "SF", star: false },
      { pos: "SG", star: false },
      { pos: "PF", star: false },
      { pos: "PG", star: false },
    ] as { pos: Position; star: boolean }[];

    rosterPlan.forEach((slot, idx) => {
      const pos = slot.pos;
      const star = slot.star && rng.chance(0.85);
      const ageRoll = rng.next();
      const age = star ? rng.int(23, 31) : ageRoll < 0.3 ? rng.int(19, 22) : ageRoll < 0.75 ? rng.int(23, 29) : rng.int(30, 37);
      const overall = Math.max(38, Math.min(94, baseOverall + (star ? rng.int(8, 16) : rng.int(-10, 6)) + (idx >= 10 ? -rng.int(2, 8) : 0)));
      const potential = age <= 23 ? Math.min(97, overall + rng.int(6, 22)) : age <= 26 ? Math.min(96, overall + rng.int(0, 8)) : null;
      const [hMin, hMax] = HEIGHT_BY_POS[pos];
      const [wMin, wMax] = WEIGHT_BY_POS[pos];
      const heightCm = rng.int(hMin, hMax);
      const weightKg = rng.int(wMin, wMax);
      const yearsPro = Math.max(0, age - rng.int(19, 22));
      const draftYear = season - 1 - yearsPro;

      // Synthetic stat line consistent with ratings (per game over a season).
      const g = rng.int(55, 78);
      const mpg = star ? rng.float(32, 38) : idx < 5 ? rng.float(26, 33) : rng.float(12, 24);
      const mp = Math.round(mpg * g);
      const scoringBase = (overall - 42) * (0.32 + rng.float(0, 0.1));
      const ppg = Math.max(3, scoringBase * (mpg / 30));
      const pts = Math.round(ppg * g);
      const rpg = (pos === "C" ? rng.float(6, 12) : pos === "PF" ? rng.float(4.5, 9) : pos === "SF" ? rng.float(3.5, 7) : rng.float(2, 5.5)) * (mpg / 30 + 0.35);
      const reb = Math.round(rpg * g);
      const apg = (pos === "PG" ? rng.float(4, 10) : pos === "SG" ? rng.float(1.5, 4) : rng.float(1, 4)) * (mpg / 30 + 0.3);
      const ast = Math.round(apg * g);
      const stl = Math.round(rng.float(0.5, 2) * g);
      const blk = Math.round((pos === "C" ? rng.float(0.8, 2.4) : pos === "PF" ? rng.float(0.5, 1.6) : rng.float(0.2, 0.9)) * g);
      const tov = Math.round(rng.float(0.8, 3.2) * g);
      const fga = Math.round(pts / 1.3); // season attempts, ~1.3 points per scoring attempt (incl. FT share)
      const fgm = Math.round(fga * (0.47 + (overall - 60) * 0.002));
      const tpa = Math.round(fga * rng.float(0.2, 0.55));
      const tpm = Math.round(tpa * (0.35 + (overall - 60) * 0.0022));
      const fta = Math.round(pts * 0.18);
      const ftm = Math.round(fta * rng.float(0.7, 0.86));
      const statLine: SeasonStatLine = {
        season,
        teamAbbr: team.abbr,
        g,
        mp,
        pts,
        reb,
        ast,
        stl,
        blk,
        tov,
        fgm,
        fga,
        tpm,
        tpa,
        ftm,
        fta,
      };

      const ratings = computeRatings(statLine, pos, age, {
        potential,
        potentialLow: potential != null ? Math.max(40, potential - rng.int(4, 12)) : null,
        potentialHigh: potential != null ? Math.min(98, potential + rng.int(2, 10)) : null,
      });
      // Nudge overall toward the target to keep league tiers coherent.
      ratings.overall = Math.round((ratings.overall + overall) / 2);

      const contract = makeDemoContract(rng, age, overall, season, yearsPro);

      players.push({
        id: `p-${team.abbr.toLowerCase()}-${idx + 1}`,
        name: nextName(),
        teamId: team.id,
        position: pos,
        secondPosition: rng.chance(0.35) ? positions[(positions.indexOf(pos) + rng.int(1, 2)) % 5] : null,
        age,
        heightCm,
        weightKg,
        draftYear,
        draftRound: yearsPro > 0 ? (rng.chance(0.75) ? 1 : 2) : null,
        draftPick: yearsPro > 0 ? rng.int(1, 60) : null,
        yearsPro,
        ratings,
        seasonStats: [statLine],
        contract,
        role: star ? "STAR" : idx < 5 ? "STARTER" : idx < 10 ? "ROTATION" : "BENCH",
        satisfaction: rng.int(60, 88),
        status: "ACTIVE",
        phase: null,
      });
    });
  }

  // Draft classes for the next 3 seasons (draftYear = label of the season the
  // class will play in; the first class is drafted at the end of `season - 1`'s
  // playoffs, i.e. when the save rolls into season `season + 1`).
  for (let yearOffset = 1; yearOffset <= 3; yearOffset++) {
    const draftYear = season + yearOffset;
    for (let i = 1; i <= 60; i++) {
      const round = i <= 30 ? 1 : 2;
      const pickNo = round === 1 ? i : i - 30;
      const pos = rng.pick(positions);
      const age = rng.int(18, 21);
      const quality = round === 1 ? (pickNo <= 5 ? 66 : pickNo <= 15 ? 60 : 54) : 48;
      const overall = Math.max(35, quality + rng.int(-7, 7));
      const potential = Math.min(97, overall + rng.int(8, 26));
      const [hMin, hMax] = HEIGHT_BY_POS[pos];
      const [wMin, wMax] = WEIGHT_BY_POS[pos];
      const mpg = rng.float(0, 0.1); // no pro stats yet
      const statLine: SeasonStatLine = {
        season: draftYear - 1,
        teamAbbr: "N/A",
        g: 0,
        mp: Math.round(mpg * 30),
        pts: 0,
        reb: 0,
        ast: 0,
        stl: 0,
        blk: 0,
        tov: 0,
        fgm: 0,
        fga: 0,
        tpm: 0,
        tpa: 0,
        ftm: 0,
        fta: 0,
      };
      const potentialLow = Math.max(35, overall - rng.int(0, 6));
      const potentialHigh = Math.min(98, overall + rng.int(4, Math.max(6, potential - overall)));
      const ratings = computeRatings(statLine, pos, age, {
        potential,
        potentialLow,
        potentialHigh,
      });
      ratings.overall = overall;
      ratings.confidence = 0; // no professional sample
      players.push({
        id: `d-${draftYear}-${i}`,
        name: nextName(),
        teamId: null,
        position: pos,
        secondPosition: null,
        age,
        heightCm: rng.int(hMin, hMax),
        weightKg: rng.int(wMin, wMax),
        draftYear,
        draftRound: round,
        draftPick: pickNo,
        yearsPro: 0,
        ratings,
        seasonStats: [statLine],
        contract: {
          type: "ROOKIE",
          years: [],
          birdRights: false,
          noTrade: false,
          option: null,
          signedSeason: draftYear,
        },
        role: "STASH",
        satisfaction: 70,
        status: "PROSPECT",
        phase: null,
      });
    }
  }

  return { teams, players };
}

function makeDemoContract(rng: ReturnType<typeof rngFor>, age: number, overall: number, season: number, yearsPro: number): Contract {
  if (yearsPro <= 1) {
    // rookie-scale-ish deal
    const salary = Math.round((2.5 + rng.float(0, 5)) * 10) / 10;
    return {
      type: "ROOKIE",
      years: [season, season + 1, season + 2, season + 3].map((s, i) => ({ season: s, salary: Math.round(salary * (1 - i * 0.05) * 10) / 10 })),
      birdRights: false,
      noTrade: false,
      option: rng.chance(0.5) ? "TO" : null,
      signedSeason: season - yearsPro,
    };
  }
  const baseSalary = overall >= 82 ? Math.round(38 + rng.float(0, 8)) : overall >= 74 ? Math.round(24 + rng.float(0, 12)) : overall >= 66 ? Math.round(12 + rng.float(0, 10)) : Math.round(2 + rng.float(0, 9));
  const years = overall >= 80 ? rng.int(3, 5) : overall >= 70 ? rng.int(2, 4) : rng.int(1, 3);
  // Expirations spread over the next few seasons so each offseason has a
  // moderate free-agent class instead of half the league hitting the market.
  const yearsLeft = rng.int(0, 3);
  const endSeason = season + yearsLeft;
  const arr: { season: number; salary: number }[] = [];
  for (let s = season; s <= endSeason; s++) {
    const escalate = 1 + (s - season) * 0.05;
    arr.push({ season: s, salary: Math.round(baseSalary * escalate * 10) / 10 });
  }
  return {
    type: overall >= 82 ? "MAX" : "VETERAN",
    years: arr,
    birdRights: yearsPro >= 3,
    noTrade: overall >= 84 && rng.chance(0.4),
    option: rng.chance(0.3) ? "PO" : null,
    signedSeason: season - rng.int(0, Math.max(0, years - 1)),
  };
}

export function demoSource(provider = DEMO_PROVIDER) {
  return {
    provider,
    sourceUrl: null,
    retrievedAt: null,
    season: null,
    licenseNote: DEMO_LICENSE,
    status: "DEMO" as const,
    ratingVersion: RATING_VERSION,
  };
}
