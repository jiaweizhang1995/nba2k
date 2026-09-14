import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, teams as teamsT, saves as savesT } from "@/db/schema";
const db = getDb();
const ev = db.select().from(evalT).all()[0];
const save = db.select().from(savesT).where(eq(savesT.id, ev.saveId)).get();
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, ev.saveId)).all();
const abbr = (id: string) => teams.find((t) => t.id === id)?.abbr ?? id;
const pstate = typeof save.phaseState === "string" ? JSON.parse(save.phaseState) : save.phaseState;
const series = pstate?.playoffs?.series ?? [];
for (const s of series) {
  console.log(`${s.round} ${s.conference ?? "FIN"}: ${abbr(s.aTeamId)}(${s.winsA}) vs ${abbr(s.bTeamId)}(${s.winsB}) next=${s.nextGameDate}`);
}
