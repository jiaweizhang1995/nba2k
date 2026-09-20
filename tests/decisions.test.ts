import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players, saves } from "@/db/schema";
import { createSave, getPhaseState, getSave, getDraftBoard, startFreeAgency } from "@/server/engine";
import { clearProspectCache } from "@/domain/draft";
import { GET, POST } from "@/app/api/saves/[id]/decisions/route";

let id: string;
const ctx = () => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => POST(new Request("http://localhost/decisions", { method: "POST", body: JSON.stringify(body) }), ctx());

beforeAll(async () => { id = (await createSave({ name: "decision API", seed: 90321 })).saveId; });

describe("GM decision API", () => {
  it("reports valid contract terms and rejects incomplete actions without writes", async () => {
    const before = getSave(id)!.updatedAt;
    const res = await GET(new Request("http://localhost/decisions"), ctx());
    const body = await res.json();
    expect(body.extensions.length).toBeGreaterThan(0);
    expect(body.extensions.every((p: { maxSalary: number; minimumSalary: number }) => p.maxSalary >= p.minimumSalary)).toBe(true);
    expect((await post({ action: "respondInboundOffer", offerId: "missing" })).status).toBe(400);
    expect(getSave(id)!.updatedAt).toBe(before);
  });

  it("shows a pending option and releases it at its exact salary with no dead cap", async () => {
    const db = getDb();
    const ps = getPhaseState(id);
    const p = db.select().from(players).where(and(eq(players.saveId, id), eq(players.teamId, String(ps.userTeamId)))).get()!;
    const short = p.id.split(":").slice(1).join(":");
    const season = getSave(id)!.season;
    db.update(players).set({ contract: { ...p.contract, option: null, years: [{ season, salary: 9.5 }] } }).where(eq(players.id, p.id)).run();
    db.update(saves).set({ phase: "DRAFT", phaseState: { ...ps, [`toPending:${season}`]: [short] } as never }).where(eq(saves.id, id)).run();
    const body = await (await GET(new Request("http://localhost/decisions"), ctx())).json();
    expect(body.teamOptions).toEqual([{ id: short, name: p.name, salary: 9.5 }]);
    expect((await post({ action: "declineOption", playerId: short })).status).toBe(200);
    expect(db.select().from(players).where(eq(players.id, p.id)).get()!.teamId).toBeNull();
    expect(getPhaseState(id).deadCap).toEqual(ps.deadCap);
    expect((await post({ action: "declineOption", playerId: short })).status).toBe(400);
  });

  it("keeps scouting stable when the process cache is empty", () => {
    const board = getDraftBoard(id);
    clearProspectCache();
    expect(getDraftBoard(id)).toEqual(board);
  });

  it("hides extension actions once free agency begins", async () => {
    getDb().update(saves).set({ phase: "FREE_AGENCY" }).where(eq(saves.id, id)).run();
    const body = await (await GET(new Request("http://localhost/decisions"), ctx())).json();
    expect(body.extensions).toEqual([]);
    expect(() => startFreeAgency(id)).toThrow(/选秀完成后/);
  });
});
