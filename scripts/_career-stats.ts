// Read-only: career stat lines for the user's roster, straight from the save.
// careerStats holds one entry per completed season (last 10); seasonStats[0] is
// the season currently being played.
//
// Usage: TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/_career-stats.ts <saveId> [teamAbbr]

import { getDb } from "../src/db";
import { players } from "../src/db/schema";
import { eq } from "drizzle-orm";
import type { SeasonStatLine } from "../src/domain/types";

const saveId = process.argv[2];
const abbr = (process.argv[3] ?? "UTA").toUpperCase();

const rows = getDb()
  .select()
  .from(players)
  .where(eq(players.saveId, saveId))
  .all()
  .filter((p) => p.teamId === `${saveId}:${abbr}`)
  .sort((a, b) => b.ratings.overall - a.ratings.overall);

const per = (s: SeasonStatLine, f: "mp" | "pts" | "reb" | "ast" | "stl" | "blk") => (s.g > 0 ? s[f] / s.g : 0);
const pct = (m: number, a: number) => (a > 0 ? ((m / a) * 100).toFixed(1) : "-");
const n1 = (v: number) => v.toFixed(1);

console.log(`\n===== ${abbr} 阵容生涯数据（存档 ${saveId.slice(0, 8)}）=====\n`);

for (const p of rows) {
  console.log(`${p.name}｜${p.position}｜${p.age} 岁｜评分 ${p.ratings.overall}｜球龄 ${p.yearsPro} 年`);
  const lines = [...p.careerStats];
  const cur = p.seasonStats[0];
  if (cur && cur.g > 0 && !lines.some((l) => l.season === cur.season)) lines.push(cur);
  lines.sort((a, b) => a.season - b.season);
  if (lines.length === 0) {
    console.log("  （暂无出场记录）\n");
    continue;
  }
  console.log("     赛季   球队   场次  分钟  得分  篮板  助攻  抢断  盖帽   FG%   3P%");
  for (const s of lines) {
    const inProgress = cur && s.season === cur.season ? " *" : "  ";
    console.log(
      `  ${String(s.season)}${inProgress} ${(s.teamAbbr ?? "--").padEnd(5)} ${String(s.g).padStart(4)} ${n1(per(s, "mp")).padStart(6)} ${n1(per(s, "pts")).padStart(6)} ${n1(per(s, "reb")).padStart(6)} ${n1(per(s, "ast")).padStart(6)} ${n1(per(s, "stl")).padStart(6)} ${n1(per(s, "blk")).padStart(6)} ${pct(s.fgm, s.fga).padStart(6)} ${pct(s.tpm, s.tpa).padStart(6)}`,
    );
  }
  const tot = lines.reduce(
    (a, s) => ({ g: a.g + s.g, mp: a.mp + s.mp, pts: a.pts + s.pts, reb: a.reb + s.reb, ast: a.ast + s.ast, stl: a.stl + s.stl, blk: a.blk + s.blk }),
    { g: 0, mp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 },
  );
  const avg = (v: number) => (tot.g > 0 ? v / tot.g : 0);
  console.log(
    `  合计${String(lines.length).padStart(3)} 季 ${String(tot.g).padStart(4)} 场：${n1(avg(tot.pts))} 分 / ${n1(avg(tot.reb))} 板 / ${n1(avg(tot.ast))} 助 / ${n1(avg(tot.stl))} 断 / ${n1(avg(tot.blk))} 帽，累计 ${tot.pts} 分\n`,
  );
}
console.log("注：' *' 表示该季正在进行中；导入球员的第一季为存档起始时的基准赛季。");
