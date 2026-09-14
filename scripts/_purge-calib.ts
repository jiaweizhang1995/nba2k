import { like } from "drizzle-orm";
import { getDb } from "@/db";
import { saves } from "@/db/schema";
import { deleteSave } from "../src/server/engine";
const db = getDb();
const rows = db.select({ id: saves.id, name: saves.name }).from(saves).where(like(saves.name, "calib-%")).all();
for (const r of rows) { deleteSave(r.id); console.log("deleted", r.name, r.id); }
console.log(`done: ${rows.length} calib saves purged`);
