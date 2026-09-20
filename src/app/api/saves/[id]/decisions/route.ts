import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { players as playersT, teams as teamsT } from "@/db/schema";
import {
  declineOption,
  EngineError,
  extendContract,
  exerciseOption,
  getPhaseState,
  getSave,
  listInboundOffers,
  listOfferSheets,
  respondInboundOffer,
  respondOfferSheet,
} from "@/server/engine";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { extensionTerms } from "@/domain/freeagency";

const idSchema = z.string().min(1);
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("respondInboundOffer"), offerId: idSchema, accept: z.boolean() }),
  z.object({ action: z.literal("respondOfferSheet"), sheetId: idSchema, match: z.boolean() }),
  z.object({ action: z.literal("exerciseOption"), playerId: idSchema }),
  z.object({ action: z.literal("declineOption"), playerId: idSchema }),
  z.object({ action: z.literal("extendContract"), playerId: idSchema, extraYears: z.number().int().min(1).max(5), avgSalary: z.number().finite().positive() }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const save = getSave(id);
    if (!save) return fail("NO_SAVE", "存档不存在", 404);
    const db = getDb();
    const ps = getPhaseState(id);
    const userTeamId = String(ps.userTeamId ?? "");
    const teamNames = new Map(db.select().from(teamsT).where(eq(teamsT.saveId, id)).all().map((t) => [t.id, `${t.city} ${t.name}`]));
    const playerNames = new Map(db.select().from(playersT).where(eq(playersT.saveId, id)).all().map((p) => [p.id, p.name]));
    const userRoster = db.select().from(playersT).where(and(eq(playersT.saveId, id), eq(playersT.teamId, userTeamId))).all();
    const pendingIds = new Set((ps[`toPending:${save.season}`] as string[] | undefined) ?? []);
    const offseason = save.phase === "DRAFT" || save.phase === "FREE_AGENCY";
    const teamOptions = userRoster
      .filter((p) => offseason && pendingIds.has(p.id.split(":").slice(1).join(":")))
      .map((p) => ({ id: p.id.split(":").slice(1).join(":"), name: p.name, salary: p.contract.years[0]?.salary ?? 0 }));
    const extended = new Set((ps[`extended:${save.season}`] as string[] | undefined) ?? []);
    const extensionWindow = ["REGULAR_SEASON", "PLAYOFFS", "DRAFT"].includes(save.phase);
    const extensions = userRoster
      .filter((p) => extensionWindow && !extended.has(p.id) && (p.status === "ACTIVE" || p.status === "INJURED") && p.contract.years.length > 0 && p.contract.years.length <= 2)
      .map((p) => ({ id: p.id.split(":").slice(1).join(":"), name: p.name, yearsLeft: p.contract.years.length, ...extensionTerms(p, save.season) }));
    return ok({
      phase: save.phase,
      inboundOffers: listInboundOffers(id),
      offerSheets: listOfferSheets(id).map((s) => ({ ...s, playerName: playerNames.get(s.playerId) ?? s.playerId, fromTeamName: teamNames.get(s.fromTeamId) ?? s.fromTeamId })),
      teamOptions,
      extensions,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!getSave(id)) throw new EngineError("NO_SAVE", "存档不存在");
    const body = await parseBody(req, decisionSchema);
    let result: unknown;
    if (body.action === "respondInboundOffer") {
      result = respondInboundOffer(id, body.offerId, body.accept);
    } else if (body.action === "respondOfferSheet") {
      result = respondOfferSheet(id, body.sheetId, body.match);
    } else if (body.action === "exerciseOption" || body.action === "declineOption") {
      result = body.action === "exerciseOption" ? exerciseOption(id, body.playerId) : declineOption(id, body.playerId);
    } else {
      result = extendContract(id, body.playerId, body.extraYears, body.avgSalary);
    }
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}
