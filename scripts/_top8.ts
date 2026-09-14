import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evaluationsT, players as playersT, teams as teamsT } from "@/db/schema";

const evalId = process.argv[2];
const db = getDb();
const evalRow = db.select().from(evaluationsT).where(eq(evaluationsT.id, evalId)).get()!;
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, evalRow.saveId)).all();
const all = db.select().from(playersT).where(eq(playersT.saveId, evalRow.saveId)).all();
const ovr = (p: any) => p.ratings?.overall ?? 0;

for (const abbr of process.argv.slice(3)) {
  const t = teams.find((x) => x.abbr === abbr);
  if (!t) { console.log(`${abbr}: 未找到`); continue; }
  const ps = all
    .filter((x: any) => x.teamId === t.id)
    .sort((a: any, b: any) => ovr(b) - ovr(a));
  const s = ps.slice(0, 4).map((x: any) => {
    const st = x.seasonStats?.[0];
    const ppg = st?.g ? (st.pts / st.g).toFixed(1) : "-";
    return `${x.name}(${ovr(x)})${ppg}分`;
  }).join(" / ");
  console.log(`${abbr} ${t.wins}-${t.losses}: ${s}`);
}
console.log("\n=== 联盟 OVR≥87 去向 ===");
const stars = all.filter((p: any) => ovr(p) >= 87).sort((a: any, b: any) => ovr(b) - ovr(a));
for (const p of stars) {
  const t = teams.find((x) => x.id === p.teamId);
  console.log(`${ovr(p)} ${p.name} → ${t?.abbr ?? "FA"}(${t ? t.wins + "-" + t.losses : ""})`);
}
