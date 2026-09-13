// Default-save seeding: a personal single-player build that boots straight
// into a real NBA league. createSave() itself builds the league from the
// committed real-data payload asset, so seeding is just a named createSave.
//
// Env gate: NBA2K_NO_AUTOSEED=1 disables (tests / CI).

import { createSave } from "./engine";
import { realPayloadExists } from "@/data/real";

export const DEFAULT_SAVE_SEED = 20272027;

export { realPayloadExists };

/** Create the default real-data save (idempotence is handled by the caller). */
export async function seedDefaultRealSave(): Promise<string | null> {
  if (!realPayloadExists()) return null;
  const created = await createSave({ name: "真实 NBA 2026-27", seed: DEFAULT_SAVE_SEED, season: 2027 });
  return created.saveId;
}
