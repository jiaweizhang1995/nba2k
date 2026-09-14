/** Standings for an eval's cloned save. Usage: tsx scripts/_eval-standings.ts <evalId> */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evaluationsT, teams as teamsT } from "@/db/schema";

const evalId = process.argv[2];
if (!evalId) throw new Error("需要 evalId");
const db = getDb();
const e = db.select().from(evaluationsT).where(eq(evaluationsT.id, evalId)).get();
if (!e) throw new Error("eval not found");
const teams = db.select().from(teamsT).where(eq(teamsT.saveId, e.saveId)).all();
for (const conf of ["EAST", "WEST"] as const) {
  console.log(`\n=== ${conf === "EAST" ? "东部" : "西部"} ===`);
  teams
    .filter((t) => t.conference === conf)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.abbr.padEnd(4)} ${t.wins}-${t.losses}`));
}
