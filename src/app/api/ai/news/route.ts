import { generateNews } from "@/lib/ai-content";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { aiNewsSchema } from "@/server/schemas";

export async function POST(req: Request) {
  try {
    const body = await parseBody(req, aiNewsSchema);
    const result = await generateNews(body);
    return ok({ ...result });
  } catch (e) {
    return handleError(e);
  }
}
