/** Dump per-game season stats for a team inside an eval's cloned save.
 *  Usage: tsx scripts/_eval-stats.ts <evalId> [teamAbbr] */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evaluationsT, players as playersT, teams as teamsT } from "@/db/schema";

const evalId = process.argv[2];
const teamAbbr = process.argv[3];
if (!evalId) throw new Error("需要 evalId");
const db = getDb();
const evalRow = db.select().from(evaluationsT).where(eq(evaluationsT.id, evalId)).get();
if (!evalRow) throw new Error("eval not found");

const teams = db.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all();
const target = teamAbbr
  ? teams.filter((t) => t.abbr === teamAbbr.toUpperCase())
  : teams.filter((t) => t.id === evalRow.teamFullId);
if (!target.length) throw new Error("team not found");

const tid = target[0].id;
const players = db.select().from(playersT).where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.teamId, tid))).all();

const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "-");
console.log(`${target[0].city} ${target[0].name}  ${target[0].wins}-${target[0].losses}\n`);
const rows = players
  .map((p) => {
    const s = p.seasonStats[0];
    if (!s || s.g === 0) return null;
    const g = s.g;
    return {
      name: p.name,
      pos: p.position,
      g,
      mpg: s.mp / g,
      ppg: s.pts / g,
      rpg: s.reb / g,
      apg: s.ast / g,
      spg: s.stl / g,
      bpg: s.blk / g,
      tpg: s.tov / g,
      fg: pct(s.fgm, s.fga),
      tp: pct(s.tpm, s.tpa),
      ft: pct(s.ftm, s.fta),
    };
  })
  .filter(Boolean)
  .sort((a, b) => b!.mpg - a!.mpg);

console.log("球员".padEnd(26), "位置", "场次", "分钟", "得分", "篮板", "助攻", "抢断", "盖帽", "失误", "FG%", "3P%", "FT%");
for (const r of rows) {
  console.log(
    r!.name.padEnd(28),
    r!.pos.padEnd(3),
    String(r!.g).padStart(3),
    r!.mpg.toFixed(1).padStart(6),
    r!.ppg.toFixed(1).padStart(6),
    r!.rpg.toFixed(1).padStart(6),
    r!.apg.toFixed(1).padStart(6),
    r!.spg.toFixed(1).padStart(6),
    r!.bpg.toFixed(1).padStart(6),
    r!.tpg.toFixed(1).padStart(6),
    r!.fg.padStart(6),
    r!.tp.padStart(6),
    r!.ft.padStart(6),
  );
}
