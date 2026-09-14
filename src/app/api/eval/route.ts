import { z } from "zod";
import { createEvaluation, listEvaluations, EvalError } from "@/server/eval";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";

export const evalCreateSchema = z.object({
  name: z.string().max(80).optional(),
  baseSaveId: z.string().min(1),
  teamShortId: z.string().min(1).max(8),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  years: z.union([z.literal(3), z.literal(5)]),
  provider: z.enum(["STUB", "OPENAI_COMPAT", "AGENT"]),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});

export async function GET() {
  try {
    return ok({ evaluations: listEvaluations() });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = await parseBody(req, evalCreateSchema);
    const result = await createEvaluation(body);
    return ok(result, 201);
  } catch (e) {
    if (e instanceof EvalError) return fail(e.code, e.message);
    return handleError(e);
  }
}
