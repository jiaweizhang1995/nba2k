import { getSave } from "@/server/engine";
import { gmNegotiationTone } from "@/lib/ai-content";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { aiNegotiateSchema } from "@/server/schemas";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { teams as teamsT } from "@/db/schema";

/** GLM writes the counterpart GM's negotiation tone. Decision stays rule-based. */
export async function POST(req: Request) {
  try {
    const body = await parseBody(req, aiNegotiateSchema);
    const save = getSave(body.saveId);
    if (!save) return handleError(new Error("存档不存在"));
    const db = getDb();
    const team = db.select().from(teamsT).where(eq(teamsT.id, body.counterpartTeamId)).get();
    const teamLabel = team ? `${team.city} ${team.name}` : body.counterpartTeamId;
    const result = await gmNegotiationTone({
      counterpartTeam: teamLabel,
      counterpartPhase: team?.aiPhase ?? "未知",
      engineFeedback: `对方AI阶段：${team?.aiPhase ?? "未知"}（风险偏好 ${team?.aiRisk ?? 0.5}）`,
      proposalSummary: body.proposalSummary,
    });
    return ok({ ...result });
  } catch (e) {
    return handleError(e);
  }
}
