// Read-only check: is injury generation off for this save, and who is still hurt?
// Usage: TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/_check-injuries.ts <saveId>

import { getDb } from "../src/db";
import { players } from "../src/db/schema";
import { getSave, loadLeagueState } from "../src/server/engine";
import { eq } from "drizzle-orm";

const saveId = process.argv[2];
const save = getSave(saveId);
if (!save) throw new Error(`存档不存在：${saveId}`);

const ps = (save.phaseState ?? {}) as Record<string, unknown>;
const all = getDb().select().from(players).where(eq(players.saveId, saveId)).all();
const hurt = all.filter((p) => p.injury || p.status === "INJURED");
const mine = all.filter((p) => p.teamId === `${saveId}:UTA`);
const hurtMine = mine.filter((p) => p.injury || p.status === "INJURED");

console.log(`存档 ${save.name}｜赛季 ${save.season}｜阶段 ${save.phase}`);
console.log(`phaseState.injuriesDisabled = ${ps.injuriesDisabled === true}`);
// The value the sim actually branches on (loadLeagueState → season.ts injury roll).
console.log(`loadLeagueState().injuriesDisabled = ${loadLeagueState(saveId, { includeGames: false }).injuriesDisabled === true}`);
console.log(`全联盟剩余伤号 = ${hurt.length}`);
console.log(`我方伤号 = ${hurtMine.length}（阵容 ${mine.length} 人）`);
console.log(`我方伤病字段非空：${mine.filter((p) => p.injury).map((p) => p.name).join("、") || "无"}`);
