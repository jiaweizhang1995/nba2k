import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { dataSources as dsT } from "@/db/schema";
import { handleError, ok } from "@/server/api-helpers";

/** Data source registry: provenance, update times, license notes. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const db = getDb();
    const rows = db.select().from(dsT).where(eq(dsT.saveId, id)).all();
    return ok({ sources: rows });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const sourceId = url.searchParams.get("sourceId");
    if (!sourceId) return handleError(new Error("缺少 sourceId"));
    const db = getDb();
    db.delete(dsT).where(and(eq(dsT.saveId, id), eq(dsT.id, sourceId))).run();
    return ok({ deleted: sourceId });
  } catch (e) {
    return handleError(e);
  }
}
