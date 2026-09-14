/**
 * Run a full eval end-to-end against the dev DB.
 * Usage: tsx scripts/run-eval.ts [teamAbbr] [years] [seed] [provider]
 */
import { createSave } from "../src/server/engine";
import { createEvaluation, runEvaluation, getEvaluationDetail } from "../src/server/eval";

async function main() {
  const team = (process.argv[2] ?? "SAC").toUpperCase();
  const years = Number(process.argv[3] ?? "5") as 3 | 5;
  const seed = Number(process.argv[4] ?? "20260914");
  const provider = (process.argv[5] ?? "STUB") as "STUB" | "OPENAI_COMPAT";
  // For OPENAI_COMPAT: EVAL_BASE_URL / EVAL_MODEL / EVAL_API_KEY env vars.
  const providerCfg =
    provider === "OPENAI_COMPAT"
      ? { baseUrl: process.env.EVAL_BASE_URL!, model: process.env.EVAL_MODEL!, apiKey: process.env.EVAL_API_KEY! }
      : {};
  if (provider === "OPENAI_COMPAT" && (!providerCfg.baseUrl || !providerCfg.model || !providerCfg.apiKey)) {
    throw new Error("OPENAI_COMPAT 需要 EVAL_BASE_URL / EVAL_MODEL / EVAL_API_KEY 环境变量");
  }

  const t0 = Date.now();
  const save = await createSave({ name: `验收基准-${team}-${years}年`, teamId: team, seed });
  console.log(`base save: ${save.saveId} team=${save.teamId}`);

  const { id } = await createEvaluation({
    name: `验收-${team}-${years}年-${provider}`,
    baseSaveId: save.saveId,
    teamShortId: team,
    seed,
    years,
    provider,
    ...providerCfg,
  });
  console.log(`eval: ${id} — running...`);

  const { state, steps } = await runEvaluation(id);
  const detail = getEvaluationDetail(id);
  const sc = detail.evaluation.score;

  console.log(`\n=== 完成 (${((Date.now() - t0) / 1000).toFixed(0)}s, ${steps} 步) ===`);
  console.log(`stage=${state.stage} status=${detail.evaluation.status}`);
  console.log(`score: ${sc ? `${sc.score} (${sc.version})` : "none"}`);
  if (sc) {
    console.log(`  wins/季=${sc.winsPerSeason} 季后赛x${sc.playoffCount} 总决赛x${sc.finalsCount} 冠军x${sc.champCount}`);
    console.log(`  合法率=${(Number(sc.legalRate) * 100).toFixed(0)}% 错误率=${(Number(sc.errorRate) * 100).toFixed(0)}% 化学反应=${sc.finalChemistry}`);
    console.log(`  交易数=${sc.tradeCount} 交易盈亏=${sc.tradePnl} 过程加成=${sc.tradeBonus} 选秀加成=${sc.draftBonus} 签约加成=${sc.faValueBonus} 签权资产=${sc.pickCapitalBonus} 阵容价值变化=${sc.rosterValueDelta}`);
  }
  for (const s of detail.seasons) {
    console.log(`  ${s.season - 1}-${String(s.season).slice(2)}: ${s.wins}-${s.losses} | 季后赛=${s.playoffResult}${s.championName ? ` | 冠军=${s.championName}` : ""}`);
  }
  // Decision audit: what did the agent actually do?
  const turns = detail.turns ?? [];
  const actions = new Map<string, number>();
  for (const t of turns) actions.set(t.action, (actions.get(t.action) ?? 0) + 1);
  console.log(`  动作分布: ${[...actions.entries()].map(([a, n]) => `${a}x${n}`).join(" ")}`);
  const trades = turns.filter((t) => t.action === "propose_trade" || t.action === "respond_trade");
  for (const t of trades.slice(0, 12)) console.log(`    [${t.stage}] ${t.action}: ${t.decision ?? ""} → ${(t.resultSummary ?? "").slice(0, 90)}`);
  const errs = turns.filter((t) => t.error);
  if (errs.length) {
    console.log(`  错误回合 ${errs.length}:`);
    for (const t of errs.slice(0, 8)) console.log(`    [${t.stage}] ${t.action}: ${(t.error ?? "").slice(0, 100)}`);
  }
  const signings = turns.filter((t) => ["sign_free_agent", "extend_contract", "waive_player", "decline_option", "respond_offer_sheet", "draft_pick"].includes(t.action));
  for (const t of signings.slice(0, 20)) console.log(`    [${t.stage}] ${t.action}: ${t.decision ?? ""} → ${(t.resultSummary ?? "").slice(0, 90)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
