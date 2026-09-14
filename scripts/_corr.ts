import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evaluationsT, players as playersT, teams as teamsT } from "@/db/schema";

const db = getDb();
const evalRow = db.select().from(evaluationsT).where(eq(evaluationsT.id, process.argv[2])).get()!;
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all();
const all = db.select().from(playersT).where(eq(playersT.saveId, evalRow.saveId)).all();
const ovr = (p: any) => p.ratings?.overall ?? 0;

const rows = teams.map((t) => {
  const ps = all.filter((p: any) => p.teamId === t.id).sort((a: any, b: any) => ovr(b) - ovr(a));
  const top3 = ps.slice(0, 3).reduce((s, p) => s + ovr(p), 0) / 3;
  const top8 = ps.slice(0, 8).reduce((s, p) => s + ovr(p), 0) / 8;
  const g = t.wins + t.losses;
  return { abbr: t.abbr, w: t.wins, l: t.losses, wpct: t.wins / g, top1: ovr(ps[0]), top3, top8 };
});
rows.sort((a, b) => b.wpct - a.wpct);

const corr = (key: "top1" | "top3" | "top8") => {
  const xs = rows.map((r) => r[key]), ys = rows.map((r) => r.wpct);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return (num / Math.sqrt(dx * dy)).toFixed(3);
};
console.log(`相关性(胜率): top1=${corr("top1")}  top3均值=${corr("top3")}  top8均值=${corr("top8")}\n`);
console.log("队  战绩    胜率  最强OVR top3均 top8均");
for (const r of rows) console.log(`${r.abbr}  ${r.w}-${r.l}  ${(r.wpct * 100).toFixed(0).padStart(3)}%   ${r.top1}     ${r.top3.toFixed(1)}   ${r.top8.toFixed(1)}`);
