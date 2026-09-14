import { describe, expect, it } from "vitest";
import { createSave, getSave, getDraftOrder } from "@/server/engine";
import { importData } from "@/server/import";
import { createEvaluation, stepEvaluation, writeAgentAction } from "@/server/eval";
import { getDb } from "@/db";
import { draftPicks as picksT, players as playersT } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { ImportPayload } from "@/data/providers/types";

function tiny(): ImportPayload {
  const meta = { provider: "CSV_JSON", sourceUrl: "t", retrievedAt: "2026-09-13", season: 2027, licenseNote: "t" };
  const abbrs = ["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"];
  const east = new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DET","IND","MIA","MIL","NYK","ORL","PHI","TOR","WAS"]);
  const pos = ["PG","SG","SF","PF","C"] as const;
  const teams = abbrs.map((abbr, i) => ({ externalId: abbr, abbr, city: `c${i}`, name: `t${i}`, conference: east.has(abbr) ? "EAST" : "WEST", division: `d${i % 6}`, meta }));
  const players: ImportPayload["players"] = [];
  abbrs.forEach((abbr) => {
    for (let i = 0; i < 14; i++) {
      players.push({
        externalId: `${abbr}-${i}`, name: `${abbr} p${i}`, position: pos[i % 5], teamAbbr: abbr, age: 24, heightCm: 198, weightKg: 95, draftYear: null, yearsPro: 3, potential: 70, potentialLow: 66, potentialHigh: 78, contract: null,
        statLine: { season: 2027, teamAbbr: abbr, g: 60, mp: 1500, pts: 600, reb: 250, ast: 150, stl: 40, blk: 30, tov: 80, fgm: 220, fga: 500, tpm: 60, tpa: 180, ftm: 100, fta: 120 },
        meta,
      });
    }
  });
  return { teams, players };
}

describe("AGENT draft_pick", () => {
  it("stops at my slot and lets the agent choose the prospect", async () => {
    const { saveId } = await createSave({ name: "dbg", teamId: "BKN", seed: 1 });
    await importData(saveId, tiny());
    const { id: evalId } = await createEvaluation({ name: "draft-test", baseSaveId: saveId, teamShortId: "BKN", seed: 1, years: 3, provider: "AGENT" });
    // 推进到 DRAFT 阶段（advance_season 若干次）
    for (let i = 0; i < 30; i++) {
      const s = getSave((await import("@/db")).getDb().select().from((await import("@/db/schema")).evaluations).where(eq((await import("@/db/schema")).evaluations.id, evalId)).get()!.saveId)!;
      if (s.phase === "DRAFT") break;
      writeAgentAction(evalId, { action: "advance_season", params: {} });
      const r = await stepEvaluation(evalId);
      if (r.done) break;
    }
    const evalRow = getDb().select().from((await import("@/db/schema")).evaluations).where(eq((await import("@/db/schema")).evaluations.id, evalId)).get()!;
    const s0 = getSave(evalRow.saveId)!;
    console.log("phase:", s0.phase, "season:", s0.season);
    expect(s0.phase).toBe("DRAFT");

    // 第一次 draft_pick：推进到 BKN 签位并停下
    writeAgentAction(evalId, { action: "draft_pick", params: {} });
    const r1 = await stepEvaluation(evalId);
    console.log("r1:", r1.lastTurn?.summary);
    const db = getDb();
    const done1 = db.select().from(picksT).where(and(eq(picksT.saveId, evalRow.saveId), eq(picksT.year, s0.season), eq(picksT.status, "EXERCISED"))).all().length;
    const order = getDraftOrder(evalRow.saveId);
    const mySlot = order.findIndex((o, i) => i >= done1 && o.holderTeamId === "BKN");
    console.log("done:", done1, "mySlot@:", mySlot + 1, "of", order.length);
    // 应停在我方签位前，而非跑穿全部 60 顺位
    expect(done1).toBeLessThan(60);
    expect(mySlot).toBeGreaterThanOrEqual(0);
    expect(mySlot).toBe(done1); // 下一个就是 BKN

    // 第二次 draft_pick 带 prospectId：真正由我选
    const obs = (await stepEvaluation(evalId)); // waiting -> 取观察
    const board = JSON.parse(obs.observation ?? "{}").draft?.topProspects ?? [];
    const target = board[0]?.id;
    writeAgentAction(evalId, { action: "draft_pick", params: { prospectId: target } });
    const r2 = await stepEvaluation(evalId);
    console.log("r2:", r2.lastTurn?.summary);
    expect(r2.lastTurn?.summary).toContain("我方选择");

    // 验证该新秀进了我队且是指定目标
    const drafted = db.select().from(playersT).where(and(eq(playersT.saveId, evalRow.saveId), eq(playersT.id, `${evalRow.saveId}:${target}`))).get();
    expect(drafted?.teamId).toBe(`${evalRow.saveId}:BKN`);
  }, 300_000);
});
