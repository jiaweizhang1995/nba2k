/**
 * Drive an AGENT-provider evaluation turn by turn — the harness for letting
 * a real agent (Devin) play GM through the eval framework.
 *
 *   tsx scripts/agent-eval.ts new  <teamAbbr> <years 3|5> <seed>
 *   tsx scripts/agent-eval.ts peek <evalId>          → prints observation JSON
 *   tsx scripts/agent-eval.ts act  <evalId> '<json>' → queues action + steps
 *   tsx scripts/agent-eval.ts status <evalId>        → score + seasons
 */
import { createSave } from "../src/server/engine";
import {
  createEvaluation,
  stepEvaluation,
  getEvaluationDetail,
  writeAgentAction,
} from "../src/server/eval";

async function main() {
  const cmd = process.argv[2];

  if (cmd === "new") {
    const team = (process.argv[3] ?? "SAC").toUpperCase();
    const years = Number(process.argv[4] ?? "5") as 3 | 5;
    const seed = Number(process.argv[5] ?? "20260914");
    const save = await createSave({ name: `agent-play-${team}`, teamId: team, seed });
    const { id } = await createEvaluation({
      name: `AGENT-${team}-${years}年`,
      baseSaveId: save.saveId,
      teamShortId: team,
      seed,
      years,
      provider: "AGENT",
    });
    console.log(JSON.stringify({ saveId: save.saveId, evalId: id }));
    return;
  }

  const evalId = process.argv[3];
  if (!evalId) throw new Error("需要 evalId");

  if (cmd === "peek") {
    const s = await stepEvaluation(evalId);
    if (s.waiting && s.observation) {
      console.log(s.observation);
    } else {
      console.log(JSON.stringify(s, null, 1));
    }
    return;
  }

  if (cmd === "act") {
    const raw = process.argv[4];
    if (!raw) throw new Error("act 需要动作 JSON 参数");
    writeAgentAction(evalId, JSON.parse(raw));
    const s = await stepEvaluation(evalId);
    console.log(JSON.stringify({ stage: s.stage, done: s.done, lastTurn: s.lastTurn, waiting: s.waiting }, null, 1));
    if (s.waiting && s.observation) console.log(s.observation);
    if (s.done) await printSummary(evalId);
    return;
  }

  if (cmd === "status") {
    await printSummary(evalId);
    return;
  }

  throw new Error(`未知命令 ${cmd}`);
}

async function printSummary(evalId: string) {
  const d = getEvaluationDetail(evalId);
  const sc = d.evaluation.score as Record<string, unknown> | null;
  console.log(`\n=== ${d.evaluation.name} | ${d.evaluation.status} ===`);
  if (sc) {
    console.log(`GM-BENCH ${sc.version}: ${sc.score} 分`);
    console.log(`  wins/季=${sc.winsPerSeason} 季后赛=${sc.playoffCount} 总决赛=${sc.finalsCount} 冠军=${sc.champCount} | 合法率=${sc.legalRate} 错误率=${sc.errorRate} 化学反应=${sc.finalChemistry}`);
    console.log(`  过程分: tradePnl=${sc.tradePnl} tradeBonus=${sc.tradeBonus} draft=${sc.draftBonus} fa=${sc.faValueBonus} picks=${sc.pickCapitalBonus} rosterΔ=${sc.rosterValueDelta}`);
  }
  for (const s of d.seasons) {
    console.log(`  ${s.season - 1}-${String(s.season).slice(2)}: ${s.wins}-${s.losses} | ${s.playoffResult}${s.championName ? ` | 冠军 ${s.championName}` : ""}`);
  }
}

main().catch((e) => {
  console.error("ERR:", (e as Error).message);
  process.exit(1);
});
