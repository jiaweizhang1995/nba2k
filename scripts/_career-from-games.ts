// Read-only: rebuild career stat lines from the games table (box scores), because
// the players.careerStats archive never matched a season (see report note).
//
// Usage: TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/_career-from-games.ts <saveId> [teamAbbr]

import { getDb } from "../src/db";
import { games, players } from "../src/db/schema";
import { eq } from "drizzle-orm";

const saveId = process.argv[2];
const abbr = (process.argv[3] ?? "UTA").toUpperCase();
const db = getDb();

const roster = db.select().from(players).where(eq(players.saveId, saveId)).all().filter((p) => p.teamId === `${saveId}:${abbr}`);
const rosterIds = new Set(roster.map((p) => p.id.replace(`${saveId}:`, "")));

type Agg = { g: number; mp: number; pts: number; reb: number; ast: number; stl: number; blk: number; fgm: number; fga: number; tpm: number; tpa: number };
const empty = (): Agg => ({ g: 0, mp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0 });

const perSeason = new Map<string, Map<number, Agg>>(); // playerShortId -> season -> agg (regular season only)
const perPlayoff = new Map<string, Map<number, Agg>>();
const career = new Map<string, Agg>();

const allGames = db.select().from(games).where(eq(games.saveId, saveId)).all();
let scanned = 0;
const bump = (a: Agg, line: { mp: number; pts: number; reb: number; ast: number; stl: number; blk: number; fgm: number; fga: number; tpm: number; tpa: number }) => {
  a.g++;
  a.mp += line.mp;
  a.pts += line.pts;
  a.reb += line.reb;
  a.ast += line.ast;
  a.stl += line.stl;
  a.blk += line.blk;
  a.fgm += line.fgm;
  a.fga += line.fga;
  a.tpm += line.tpm;
  a.tpa += line.tpa;
};
for (const g of allGames) {
  if (g.status !== "FINAL" || !g.box) continue;
  scanned++;
  const isPlayoff = g.type !== "REGULAR" && g.type !== "PRESEASON";
  const bucket = isPlayoff ? perPlayoff : perSeason;
  for (const line of [...g.box.home, ...g.box.away]) {
    const short = line.playerId.includes(":") ? line.playerId.split(":").slice(1).join(":") : line.playerId;
    if (!rosterIds.has(short)) continue;
    if (!bucket.has(short)) bucket.set(short, new Map());
    const bySeason = bucket.get(short)!;
    const sAgg = bySeason.get(g.season) ?? empty();
    bump(sAgg, line);
    bySeason.set(g.season, sAgg);
    const cAgg = career.get(short) ?? empty();
    bump(cAgg, line);
    career.set(short, cAgg);
  }
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const pct = (m: number, a: number) => (a > 0 ? ((m / a) * 100).toFixed(1) : "-");
const avg = (a: Agg, f: keyof Agg) => (a.g > 0 ? (a[f] as number) / a.g : 0);

console.log(`\n===== ${abbr} 阵容生涯数据（从 ${scanned} 场已完成比赛的 box score 重算）=====\n`);
for (const p of roster.sort((a, b) => b.ratings.overall - a.ratings.overall)) {
  const short = p.id.replace(`${saveId}:`, "");
  const seasons = perSeason.get(short) ?? new Map();
  const po = perPlayoff.get(short) ?? new Map();
  const tot = career.get(short) ?? empty();
  if (tot.g === 0) {
    console.log(`${p.name}｜${p.position}｜${p.age} 岁｜评分 ${p.ratings.overall}：暂无出场记录\n`);
    continue;
  }
  console.log(`${p.name}｜${p.position}｜${p.age} 岁｜评分 ${p.ratings.overall}`);
  console.log("     赛季  场次  分钟   得分   篮板   助攻   抢断   盖帽    FG%   3P%");
  for (const s of [...seasons.keys()].sort((a, b) => a - b)) {
    const a = seasons.get(s)!;
    console.log(
      `     ${s}  ${String(a.g).padStart(4)} ${n1(avg(a, "mp")).padStart(6)} ${n1(avg(a, "pts")).padStart(6)} ${n1(avg(a, "reb")).padStart(6)} ${n1(avg(a, "ast")).padStart(6)} ${n1(avg(a, "stl")).padStart(6)} ${n1(avg(a, "blk")).padStart(6)} ${pct(a.fgm, a.fga).padStart(6)} ${pct(a.tpm, a.tpa).padStart(6)}`,
    );
  }
  const poTot = [...po.values()].reduce((x, a) => ({ g: x.g + a.g, pts: x.pts + a.pts }), { g: 0, pts: 0 });
  if (poTot.g > 0) console.log(`     季后赛合计 ${poTot.g} 场，场均 ${n1(poTot.pts / poTot.g)} 分`);
  console.log(
    `     生涯 ${tot.g} 场：${n1(avg(tot, "pts"))} 分 / ${n1(avg(tot, "reb"))} 板 / ${n1(avg(tot, "ast"))} 助 / ${n1(avg(tot, "stl"))} 断 / ${n1(avg(tot, "blk"))} 帽｜FG ${pct(tot.fgm, tot.fga)}%｜3P ${pct(tot.tpm, tot.tpa)}%｜累计 ${tot.pts} 分\n`,
  );
}
