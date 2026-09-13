import { importData } from "@/server/import";
import { parseImportJson, parsePlayersCsv, parseTeamsCsv } from "@/data/providers/csv";
import { balldontlieAdapter } from "@/data/providers/balldontlie";
import { sportradarAdapter } from "@/data/providers/sportradar";
import { handleError, ok, parseBody, fail } from "@/server/api-helpers";
import { importSchema } from "@/server/schemas";

/** POST /api/saves/[id]/import — run an adapter or parse uploaded CSV/JSON. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await parseBody(req, importSchema);

    if (body.provider === "CSV_JSON" && body.mode === "CONTRACTS") {
      // 仅合并合同：CSV 列 name,salary,contract_years —— 不替换联盟
      if (!body.playersCsv) return fail("NO_INPUT", "请上传合同 CSV（列：name,salary,contract_years）");
      const { mergeContracts } = await import("@/server/import");
      const rows = body.playersCsv
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(1)
        .map((line) => {
          const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
          return { name: cells[0] ?? "", salary: Number(cells[1]) || 0, years: Number(cells[2]) || 1 };
        })
        .filter((r) => r.name && r.salary > 0);
      const result = mergeContracts(id, rows, {
        provider: "CSV_JSON",
        sourceUrl: body.sourceUrl ?? "user-upload://local-file",
        retrievedAt: new Date().toISOString(),
        season: body.season,
        licenseNote: "用户提供数据：来源与授权由上传方负责",
      });
      return ok({ result });
    }

    if (body.provider === "CSV_JSON") {
      if (!body.playersCsv && !body.json) return fail("NO_INPUT", "请上传 CSV 或 JSON 数据");
      const sourceUrl = body.sourceUrl ?? "user-upload://local-file";
      const retrievedAt = new Date().toISOString();
      const meta = {
        provider: "CSV_JSON",
        sourceUrl,
        retrievedAt,
        season: body.season,
        licenseNote: "用户提供数据：来源与授权由上传方负责",
      };
      if (body.json) {
        const payload = parseImportJson(body.json);
        const result = await importData(id, payload);
        return ok({ result });
      }
      const players = parsePlayersCsv(body.playersCsv ?? "", meta);
      const teams = body.teamsCsv ? parseTeamsCsv(body.teamsCsv, meta) : [];
      const result = await importData(id, { teams, players });
      return ok({ result });
    }

    const adapter = body.provider === "BALLDONTLIE" ? balldontlieAdapter : sportradarAdapter;
    const apiKey = body.apiKey || (adapter.apiKeyEnvVar ? process.env[adapter.apiKeyEnvVar] : undefined) || undefined;
    const payload = await adapter.fetchSeason(body.season, { apiKey });
    const result = await importData(id, payload);
    return ok({ result });
  } catch (e) {
    return handleError(e);
  }
}
