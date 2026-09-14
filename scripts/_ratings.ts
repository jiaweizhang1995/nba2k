/** Dump ratings for key players in a save. Usage: tsx scripts/_ratings.ts <saveId|evalId> [nameFilter] */
import { eq, like, or } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evaluationsT, players as playersT, teams as teamsT } from "@/db/schema";

const id = process.argv[2];
const filter = process.argv[3];
const db = getDb();
const evalRow = db.select().from(evaluationsT).where(eq(evaluationsT.id, id)).get();
const saveId = evalRow ? evalRow.saveId : id;
const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, saveId)).all();
const abbr = new Map(teamRows.map((t) => [t.id, t.abbr]));
const players = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all()
  .filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
  .sort((a, b) => b.ratings.overall - a.ratings.overall);

for (const p of players) {
  const r = p.ratings;
  console.log(
    `${p.name.padEnd(26)} ${(abbr.get(p.teamId ?? "") ?? "FA").padEnd(4)} ${p.position.padEnd(3)} OVR${r.overall} | fin${r.finishing} ins${r.inside} 3p${r.threePoint} ft${r.freeThrow} pm${r.playmaking} reb${r.rebounding} pD${r.perimeterD} iD${r.interiorD} | usage${r.usageTendency.toFixed(2)} | ${p.role}`,
  );
}
