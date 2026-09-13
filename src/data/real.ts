// Loader for the committed real-NBA payload asset (src/data/real/*.json).
// Kept dependency-free so both the server engine and the seeding bootstrap
// can use it without import cycles.

import fs from "node:fs";
import path from "node:path";
import type { ImportPayload } from "./providers/types";

const REAL_PAYLOAD_DIR = path.join(process.cwd(), "src", "data", "real");

export const REAL_PAYLOAD_PATH = path.join(REAL_PAYLOAD_DIR, "nba-real-2026-27.json");

export interface RealPayload extends ImportPayload {
  contractMeta?: { provider: string; sourceUrl: string; retrievedAt: string; season: number; licenseNote: string };
}

export function realPayloadExists(): boolean {
  return fs.existsSync(REAL_PAYLOAD_PATH);
}

export function loadRealPayload(): RealPayload | null {
  if (!realPayloadExists()) return null;
  return JSON.parse(fs.readFileSync(REAL_PAYLOAD_PATH, "utf8")) as RealPayload;
}
