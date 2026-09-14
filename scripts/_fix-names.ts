import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT } from "@/db/schema";
const db = getDb();
const all = db.select().from(playersT).all();
const re = /^([A-Z])\. ([A-Z])\. /;
let n = 0;
for (const p of all) {
  if (re.test(p.name)) {
    const nn = p.name.replace(re, "$1$2 ");
    db.update(playersT).set({ name: nn }).where(eq(playersT.id, p.id)).run();
    console.log(`${p.name} → ${nn}`);
    n++;
  }
}
console.log("updated", n, "rows");
