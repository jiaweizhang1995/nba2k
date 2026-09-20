import { z } from "zod";

export const createSaveSchema = z.object({
  name: z.string().min(1).max(60),
  teamId: z.string().optional(),
  seed: z.number().int().optional(),
  season: z.number().int().min(2020).max(2050).optional(),
});

export const advanceSchema = z.object({
  mode: z.enum(["NEXT_GAME", "DAY", "WEEK", "MONTH", "REGULAR_SEASON", "PLAYOFFS", "PLAYOFF_ROUND", "SEASON"]),
});

export const rotationSchema = z.object({
  teamId: z.string().min(1),
  starters: z.array(z.string().min(1)).length(5).optional(),
  minutes: z.record(z.string(), z.number().min(0).max(48)).optional(),
  reset: z.boolean().optional(),
});

export const tradeSchema = z.object({
  parties: z
    .array(
      z.object({
        teamId: z.string().min(1),
        gives: z.array(z.object({ kind: z.enum(["PLAYER", "PICK"]), id: z.string().min(1) })),
        receives: z.array(z.object({ kind: z.enum(["PLAYER", "PICK"]), id: z.string().min(1) })),
      }),
    )
    .min(2)
    .max(3),
});

export const executeTradeSchema = tradeSchema.extend({
  force: z.boolean().optional(),
  note: z.string().max(200).optional(),
});

export const tradeOffersSchema = z.object({
  gives: z.array(z.object({ kind: z.enum(["PLAYER", "PICK"]), id: z.string().min(1) })).min(1).max(10),
});

export const draftSchema = z.object({
  prospectId: z.string().optional(),
  simulateAll: z.boolean().optional(),
});

export const faOfferSchema = z.object({
  playerId: z.string().min(1),
  years: z.number().int().min(1).max(5),
  avgSalary: z.number().min(0.5).max(80),
});

export const godSchema = z.object({
  op: z.enum(["setRating", "setAge", "setSatisfaction", "setContract", "setInjury", "transferPlayer", "grantPick", "skipToPhase", "undo"]),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const godToggleSchema = z.object({ enabled: z.boolean() });

export const aiNewsSchema = z.object({
  saveId: z.string().min(1),
  headline: z.string().min(1).max(120),
  facts: z.array(z.string().max(300)).max(20),
  tone: z.enum(["NEWS", "RUMOR", "ANALYSIS"]),
});

export const aiChemistrySchema = z.object({
  saveId: z.string().min(1),
  teamId: z.string().min(1),
});

export const aiTradeAdviceSchema = z.object({
  saveId: z.string().min(1),
  userTeamId: z.string().min(1),
  outgoing: z.array(z.object({ id: z.string(), kind: z.enum(["PLAYER", "PICK"]) })).max(10),
  incoming: z.array(z.object({ id: z.string(), kind: z.enum(["PLAYER", "PICK"]) })).max(10),
});

export const aiNegotiateSchema = z.object({
  saveId: z.string().min(1),
  counterpartTeamId: z.string().min(1),
  proposalSummary: z.string().min(1).max(500),
});

export const importSchema = z.object({
  provider: z.enum(["BALLDONTLIE", "SPORTRADAR", "CSV_JSON"]),
  season: z.number().int().min(2000).max(2050),
  apiKey: z.string().optional(),
  sourceUrl: z.string().min(1).optional(),
  playersCsv: z.string().optional(),
  teamsCsv: z.string().optional(),
  json: z.string().optional(),
  mode: z.enum(["FULL", "CONTRACTS"]).optional(), // CONTRACTS: 只按名合并合同，不替换联盟
});

export const glmTestSchema = z.object({}).optional();
