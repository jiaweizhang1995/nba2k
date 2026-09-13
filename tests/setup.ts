import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each vitest run gets a fresh temp SQLite database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwgm-test-"));
process.env.NBA2K_DB_PATH = path.join(dir, "test.db");
