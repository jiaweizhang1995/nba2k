import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.NBA2K_DB_PATH ?? path.join(process.cwd(), "data", "nba2k-gm.db");

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  // Apply pending migrations on first use (dev-friendly bootstrap).
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

/** Singleton DB handle (better-sqlite3 is sync; safe for Next.js route handlers). */
export function getDb() {
  if (!_db) _db = createDb();
  return _db;
}

export type Db = ReturnType<typeof getDb>;
