/** Advance the eval clone save day-by-day until PHI's *current* series resolves. */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, teams as teamsT, saves as savesT } from "@/db/schema";
import { advanceSim } from "../src/server/engine";

const evalId = process.argv[2];
const db = getDb();
const ev = db.select().from(evalT).where(eq(evalT.id, evalId)).get()!;
const saveId = ev.saveId as string;
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
const abbr = (id: string) => teams.find((t) => t.id === id)?.abbr ?? id;
const pstate = () => { const s = db.select().from(savesT).where(eq(savesT.id, saveId)).get(); return typeof s.phaseState === "string" ? JSON.parse(s.phaseState) : s.phaseState; };

// PHI's LIVE series (not yet decided)
const findSeries = () => (pstate()?.playoffs?.series ?? []).find((s: any) =>
  (abbr(s.aTeamId) === "PHI" || abbr(s.bTeamId) === "PHI") && s.winsA < 4 && s.winsB < 4);
const s0 = findSeries();
if (!s0) { console.log("PHI 没有在进行的系列赛（已淘汰或夺冠）"); process.exit(0); }
console.log(`系列赛：${abbr(s0.aTeamId)} vs ${abbr(s0.bTeamId)}（${s0.round}）`);

for (let day = 0; day < 20; day++) {
  const r = advanceSim(saveId, "DAY");
  const sv = findSeries() ?? (pstate()?.playoffs?.series ?? []).find((s: any) => abbr(s.aTeamId) === "PHI" || abbr(s.bTeamId) === "PHI");
  for (const g of r.results) {
    if (g.home === "PHI" || g.away === "PHI") {
      console.log(`${g.date}  ${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}   ${g.homeScore > g.awayScore ? g.home : g.away} 胜`);
    }
  }
  if (!sv || sv.winsA >= 4 || sv.winsB >= 4) {
    const last = (pstate()?.playoffs?.series ?? []).filter((s: any) => abbr(s.aTeamId) === "PHI" || abbr(s.bTeamId) === "PHI").pop();
    if (last) console.log(`\n== 系列赛结束：${abbr(last.aTeamId)} ${last.winsA} - ${last.winsB} ${abbr(last.bTeamId)} ==`);
    break;
  }
  const save = db.select().from(savesT).where(eq(savesT.id, saveId)).get();
  if (save.phase !== "PLAYOFFS") { console.log("phase 已离开 PLAYOFFS"); break; }
}
