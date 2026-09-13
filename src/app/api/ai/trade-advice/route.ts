import { getSave } from "@/server/engine";
import { suggestTradeIdeas } from "@/lib/ai-content";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { aiTradeAdviceSchema } from "@/server/schemas";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players as playersT, draftPicks as picksT } from "@/db/schema";
import { playerValue, pickValue, type TradePlayer, type TradePick } from "@/domain/trade";

/** GLM turns engine valuations into negotiation strategy text. Never decides. */
export async function POST(req: Request) {
  try {
    const body = await parseBody(req, aiTradeAdviceSchema);
    const save = getSave(body.saveId);
    if (!save) return handleError(new Error("存档不存在"));
    const db = getDb();

    const loadPlayer = (id: string): TradePlayer | null => {
      const row = db.select().from(playersT).where(eq(playersT.id, `${body.saveId}:${id}`)).get();
      return row ? { ...row, id, teamId: row.teamId?.split(":").slice(1).join(":") ?? null } : null;
    };
    const loadPick = (id: string): TradePick | null => {
      const row = db.select().from(picksT).where(and(eq(picksT.saveId, body.saveId), eq(picksT.id, `${body.saveId}:${id}`))).get();
      return row ? { id, year: row.year, round: row.round, originalTeamId: row.originalTeamId.split(":").slice(1).join(":"), holderTeamId: row.holderTeamId.split(":").slice(1).join(":"), status: row.status, protection: row.protection } : null;
    };

    const outItems = body.outgoing.map((a) => {
      if (a.kind === "PLAYER") {
        const p = loadPlayer(a.id);
        return p ? playerValue(p, save.season) : { name: a.id, value: 0, breakdown: ["未找到资产"] };
      }
      const pk = loadPick(a.id);
      return pk ? pickValue(pk, save.season) : { name: a.id, value: 0, breakdown: ["未找到资产"] };
    });
    const inItems = body.incoming.map((a) => {
      if (a.kind === "PLAYER") {
        const p = loadPlayer(a.id);
        return p ? playerValue(p, save.season) : { name: a.id, value: 0, breakdown: ["未找到资产"] };
      }
      const pk = loadPick(a.id);
      return pk ? pickValue(pk, save.season) : { name: a.id, value: 0, breakdown: ["未找到资产"] };
    });

    const result = await suggestTradeIdeas({
      userTeam: body.userTeamId.split(":").pop() ?? body.userTeamId,
      outgoing: outItems.map((v) => ({ name: v.name, value: v.value, note: v.breakdown[0] ?? "" })),
      incoming: inItems.map((v) => ({ name: v.name, value: v.value, note: v.breakdown[0] ?? "" })),
      engineVerdict: `送出合计 ${outItems.reduce((a, v) => a + v.value, 0).toFixed(1)} 点，接收合计 ${inItems.reduce((a, v) => a + v.value, 0).toFixed(1)} 点`,
      teamPhase: "由对方球队阶段决定谈判弹性",
    });
    return ok({ ...result, valuation: { outgoing: outItems, incoming: inItems } });
  } catch (e) {
    return handleError(e);
  }
}
