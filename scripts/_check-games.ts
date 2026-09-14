import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, games as gamesT, teams as teamsT } from "@/db/schema";
const db = getDb();
const ev = db.select().from(evalT).all()[0];
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, ev.saveId)).all();
const games = db.select().from(gamesT).where(eq(gamesT.saveId, ev.saveId)).all();
const reg = games.filter((g: any) => g.type === "REGULAR");
const played = reg.filter((g: any) => g.status === "FINAL");
const sched = reg.filter((g: any) => g.status === "SCHEDULED");
console.log("REG games:", reg.length, "final:", played.length, "scheduled-left:", sched.length);
const cnt = new Map<string, number>();
for (const g of played) { cnt.set(g.homeTeamId, (cnt.get(g.homeTeamId) ?? 0) + 1); cnt.set(g.awayTeamId, (cnt.get(g.awayTeamId) ?? 0) + 1); }
const rows = teams.map((t) => ({ abbr: t.abbr, g: cnt.get(t.id) ?? 0 })).sort((a, b) => a.g - b.g);
console.log(rows.map((r) => `${r.abbr}:${r.g}`).join(" "));
for (const g of sched.slice(0, 12)) {
  const h = teams.find((t) => t.id === g.homeTeamId)?.abbr;
  const a = teams.find((t) => t.id === g.awayTeamId)?.abbr;
  console.log("unplayed:", g.date, a, "@", h);
}
