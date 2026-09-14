import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, games as gamesT, teams as teamsT } from "@/db/schema";
const db = getDb();
const ev = db.select().from(evalT).all()[0];
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, ev.saveId)).all();
const phi = teams.find((t) => t.abbr === "PHI")!;
console.log("phi.id =", phi.id);
const games = db.select().from(gamesT).where(eq(gamesT.saveId, ev.saveId)).all()
  .filter((g: any) => g.type === "PLAYOFF" && g.status === "FINAL");
const g = games.find((x: any) => x.homeTeamId === phi.id || x.awayTeamId === phi.id);
console.log("game teamIds:", g.awayTeamId, "@", g.homeTeamId);
const l = (g.box.home[0] ?? g.box.away[0]);
console.log("sample line:", JSON.stringify(l).slice(0, 300));
console.log("home lines:", g.box.home.length, "away:", g.box.away.length);
console.log("line teamIds:", [...new Set([...g.box.home, ...g.box.away].map((x: any) => x.teamId))]);
