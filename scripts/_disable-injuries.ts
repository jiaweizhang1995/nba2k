// One-off admin: switch injury generation off for a save and heal everyone
// currently hurt. Both operations go through the engine's god path so they are
// audited in the event log and undoable like any other god op.
//
// Usage: TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/_disable-injuries.ts <saveId>

import { getSave, godOp, setGodMode } from "../src/server/engine";

async function main() {
  const saveId = process.argv[2];
  if (!saveId) {
    console.error("用法：npx tsx scripts/_disable-injuries.ts <saveId>");
    process.exit(1);
  }
  const save = getSave(saveId);
  if (!save) {
    console.error(`存档不存在：${saveId}`);
    process.exit(1);
  }
  console.log(`存档：${save.name}（${saveId}，赛季 ${save.season}，阶段 ${save.phase}）`);

  await setGodMode(saveId, true);
  console.log("① 关闭伤病生成：", JSON.stringify(await godOp(saveId, "setInjuriesDisabled", { disabled: true })));
  console.log("② 清除现有伤病：", JSON.stringify(await godOp(saveId, "healAllInjuries", {})));
  await setGodMode(saveId, false);
  console.log("完成：本赛季起不再产生新伤病，现有伤号已全部伤愈。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
