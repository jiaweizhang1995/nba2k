import { getEvaluationRow, SCORE_VERSION } from "@/server/eval";
import { handleError, ok, fail } from "@/server/api-helpers";

/** 模型对比：同基准存档+同球队+同种子+同年限的评测并排对比。 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 6);
    if (ids.length < 2) return fail("NEED_IDS", "至少提供两个评测 id（?ids=a,b）");

    const rows = ids.map((id) => getEvaluationRow(id)).map((r, i) => ({ id: ids[i], row: r }));
    for (const { id, row } of rows) {
      if (!row) return fail("NO_EVAL", `评测不存在：${id}`);
    }
    const first = rows[0].row!;
    const sameScenario = rows.every(
      ({ row }) => row!.baseSaveId === first.baseSaveId && row!.teamShortId === first.teamShortId && row!.seed === first.seed && row!.years === first.years,
    );

    const comparison = rows.map(({ id, row }) => {
      const r = row!;
      const score = (r.score ?? {}) as {
        totalWins?: number; playoffCount?: number; champCount?: number; tradeCount?: number;
        legalRate?: number; errorRate?: number; callCount?: number; latencyMsSum?: number;
        finalChemistry?: number; score?: number; replayMatch?: boolean;
      };
      return {
        id,
        name: r.name,
        provider: r.provider,
        model: r.model,
        apiKeyMasked: r.apiKeyMasked,
        seed: r.seed,
        years: r.years,
        status: r.status,
        totalWins: score.totalWins ?? 0,
        playoffCount: score.playoffCount ?? 0,
        champCount: score.champCount ?? 0,
        legalRate: score.legalRate ?? null,
        errorRate: score.errorRate ?? null,
        callCount: score.callCount ?? r.callCount,
        latencyMsSum: score.latencyMsSum ?? r.latencyMsSum,
        finalChemistry: score.finalChemistry ?? null,
        score: score.score ?? null,
        replayMatch: score.replayMatch,
      };
    });

    return ok({ scoreVersion: SCORE_VERSION, sameScenario, comparison });
  } catch (e) {
    return handleError(e);
  }
}
