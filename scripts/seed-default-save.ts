// 生成默认「真实 NBA」存档（幂等：已有默认存档时跳过）。
// 用法：npm run data:seed
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { saves } from "../src/db/schema";
import { seedDefaultRealSave } from "../src/server/seed";
import { listSaves } from "../src/server/engine";

async function main() {
  const existing = listSaves().filter((s) => !s.isEval && s.name.startsWith("真实 NBA"));
  if (existing.length > 0) {
    console.log(`已存在默认真实数据存档「${existing[0].name}」，跳过。`);
    return;
  }
  const saveId = await seedDefaultRealSave();
  if (!saveId) {
    console.error("真实数据 payload 缺失（src/data/real/nba-real-2026-27.json），未创建。");
    process.exit(1);
  }
  const row = getDb().select().from(saves).where(eq(saves.id, saveId)).get();
  console.log(`已创建默认存档：${row?.name}（种子=${row?.seed}）`);
}

main();
