import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, games as gamesT, teams as teamsT } from "@/db/schema";
const db = getDb();
const ev = db.select().from(evalT).all()[0];
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, ev.saveId)).all();
const phi = teams.find((t) => t.abbr === "PHI")!;
const games = db.select().from(gamesT).where(eq(gamesT.saveId, ev.saveId)).all()
  .filter((g: any) => g.type === "PLAYOFF" && g.status === "FINAL");

const agg = new Map<string, any>();
for (const g of games) {
  for (const l of [...(g.box?.home ?? []), ...(g.box?.away ?? [])]) {
    if (l.teamId !== "PHI") continue;
    let a = agg.get(l.playerId);
    if (!a) { a = { name: l.name, g: 0, mp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 }; agg.set(l.playerId, a); }
    a.g++; a.mp += l.mp; a.pts += l.pts; a.reb += l.reb; a.ast += l.ast; a.stl += l.stl; a.blk += l.blk; a.tov += l.tov;
    a.fgm += l.fgm; a.fga += l.fga; a.tpm += l.tpm; a.tpa += l.tpa; a.ftm += l.ftm; a.fta += l.fta;
  }
}
const pct = (m: number, a: number) => (a > 0 ? ((m / a) * 100).toFixed(1) + "%" : "-");
const rows = [...agg.values()].sort((a, b) => b.pts / b.g - a.pts / a.g);
console.log(`=== PHI 季后赛数据（${rows[0]?.g ?? 0} 场）===`);
console.log("球员".padEnd(26), "分钟", "得分", "篮板", "助攻", "抢断", "盖帽", "FG%", "3P%", "FT%");
for (const a of rows) {
  console.log(
    a.name.padEnd(28),
    (a.mp / a.g).toFixed(1).padStart(5),
    (a.pts / a.g).toFixed(1).padStart(6),
    (a.reb / a.g).toFixed(1).padStart(6),
    (a.ast / a.g).toFixed(1).padStart(6),
    (a.stl / a.g).toFixed(1).padStart(6),
    (a.blk / a.g).toFixed(1).padStart(6),
    pct(a.fgm, a.fga).padStart(6),
    pct(a.tpm, a.tpa).padStart(6),
    pct(a.ftm, a.fta).padStart(6),
  );
}
// 每场最高得分
console.log("\n=== 每场队内最高分 ===");
for (const g of games) {
  const lines = [...(g.box?.home ?? []), ...(g.box?.away ?? [])].filter((l: any) => l.teamId === "PHI");
  const top = lines.sort((a: any, b: any) => b.pts - a.pts)[0];
  const away = teams.find((t) => t.id === g.awayTeamId)?.abbr;
  const home = teams.find((t) => t.id === g.homeTeamId)?.abbr;
  console.log(`${g.date} ${away}@${home} ${g.awayScore}-${g.homeScore} | ${top?.name} ${top?.pts}分${top?.reb}板${top?.ast}助`);
}
