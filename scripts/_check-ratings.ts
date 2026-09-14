/** Create a throwaway save, dump key players' ratings, delete. */
import { createSave, deleteSave } from "../src/server/engine";
import { getDb } from "@/db";
import { players as playersT, teams as teamsT } from "@/db/schema";
import { eq } from "drizzle-orm";

const NAMES = ["Tyrese Maxey", "Joel Embiid", "Luka Dončić", "Nikola Jokić", "Scottie Barnes", "Walker Kessler", "Tyrese Haliburton", "Stephen Curry", "Shai Gilgeous-Alexander", "Jaylen Brown", "Kentavious Caldwell-Pope", "Adem Bona", "Walker Kessler"];

async function main() {
  const s = await createSave({ name: "ratings-check", teamId: "PHI", seed: 1 });
  const db = getDb();
  const teams = db.select().from(teamsT).where(eq(teamsT.saveId, s.saveId)).all();
  const abbr = new Map(teams.map((t) => [t.id, t.abbr]));
  const players = db.select().from(playersT).where(eq(playersT.saveId, s.saveId)).all();

  // league-wide overall distribution
  const ov = players.map((p) => p.ratings.overall).sort((a, b) => b - a);
  const mean = ov.reduce((a, b) => a + b, 0) / ov.length;
  console.log(`league: ${players.length}人 | OVR 均值 ${mean.toFixed(1)} | top10: ${ov.slice(0, 10).join(",")} | p25=${ov[Math.floor(ov.length * 0.25)]} p50=${ov[Math.floor(ov.length * 0.5)]} p75=${ov[Math.floor(ov.length * 0.75)]}\n`);

  for (const name of [...new Set(NAMES)]) {
    const p = players.find((x) => x.name === name);
    if (!p) { console.log(`${name}: not found`); continue; }
    const r = p.ratings;
    console.log(`${name.padEnd(26)} ${(abbr.get(p.teamId ?? "") ?? "?").padEnd(4)} ${p.position.padEnd(3)} OVR${r.overall} | fin${r.finishing} ins${r.inside} 3p${r.threePoint} ft${r.freeThrow} pm${r.playmaking} reb${r.rebounding} pD${r.perimeterD} iD${r.interiorD} | usage${r.usageTendency}`);
  }
  deleteSave(s.saveId);
}

main().catch((e) => { console.error(e); process.exit(1); });
