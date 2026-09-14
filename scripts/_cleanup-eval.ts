import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evaluations as evalT, evalTurns as turnT, evalSeasons as seasT } from "@/db/schema";
import { deleteSave } from "../src/server/engine";
const db = getDb();
const evals = db.select().from(evalT).all();
for (const ev of evals) {
  db.delete(turnT).where(eq(turnT.evaluationId, ev.id)).run();
  db.delete(seasT).where(eq(seasT.evaluationId, ev.id)).run();
  db.delete(evalT).where(eq(evalT.id, ev.id)).run();
  for (const sid of [ev.saveId, ev.baseSaveId]) {
    if (sid) { try { deleteSave(sid); } catch {} }
  }
  console.log("cleaned eval", ev.id);
}
console.log("done", evals.length);
