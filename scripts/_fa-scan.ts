import { getDb } from "../src/db";
import { players as playersT } from "../src/db/schema";
import { eq } from "drizzle-orm";

const saveId = process.argv[2];
const db = getDb();
const rows = db.select().from(playersT).where(eq(playersT.saveId, saveId)).all()
  .filter((p) => p.status === "FREE_AGENT");
rows.sort((a, b) => (a.ratings as {overall:number}).overall - (b.ratings as {overall:number}).overall);
for (const p of rows) {
  const r = p.ratings as {overall:number};
  console.log(`${p.id.split(":").pop()!.padEnd(40)} ${p.name.padEnd(26)} ${p.position} ${p.age}岁 OVR${r.overall}`);
}
console.log("total FA:", rows.length);
