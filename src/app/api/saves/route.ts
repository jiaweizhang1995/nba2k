import { createSave, listSaves } from "@/server/engine";
import { seedDefaultRealSave, realPayloadExists } from "@/server/seed";
import { handleError, ok, parseBody } from "@/server/api-helpers";
import { createSaveSchema } from "@/server/schemas";

export async function GET() {
  try {
    let saves = listSaves().filter((s) => !s.isEval);
    // Personal build: boot straight into the real NBA league on first run.
    if (saves.length === 0 && realPayloadExists() && process.env.NBA2K_NO_AUTOSEED !== "1") {
      await seedDefaultRealSave();
      saves = listSaves();
    }
    return ok({ saves });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = await parseBody(req, createSaveSchema);
    const result = await createSave(body);
    return ok(result, 201);
  } catch (e) {
    return handleError(e);
  }
}
