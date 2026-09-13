// BALLDONTLIE adapter — free tier for development/personal testing.
// Docs: https://docs.balldontlie.io/
//
// NOTE: The free BALDONTLIE tier does not include contract or salary data.
// Missing fields stay missing (contract: null) — the game shows "未知" rather
// than inventing values, per the data-integrity policy.

import { ProviderError, type DataSourceAdapter, type ImportPayload, type ProvenanceMeta } from "./types";

const BASE = "https://api.balldontlie.io/v1";

export const balldontlieAdapter: DataSourceAdapter = {
  id: "BALLDONTLIE",
  label: "BALLDONTLIE（开发/个人测试）",
  docsUrl: "https://docs.balldontlie.io/",
  requiresApiKey: true,
  apiKeyEnvVar: "BALLDONTLIE_API_KEY",
  licenseNote: "数据版权归 BALLDONTLIE 及其上游提供方；仅限开发与个人测试用途，商用需获得授权。",
  async fetchSeason(season, opts): Promise<ImportPayload> {
    const key = opts.apiKey;
    if (!key) throw new ProviderError("NO_API_KEY", "BALLDONTLIE 需要在设置中提供 API Key（环境变量 BALLDONTLIE_API_KEY）");
    const meta: ProvenanceMeta = {
      provider: "BALLDONTLIE",
      sourceUrl: BASE,
      retrievedAt: new Date().toISOString(),
      season,
      licenseNote: this.licenseNote,
    };
    const headers = { Authorization: key };
    const teamsRaw = await paged(`${BASE}/teams`, headers);
    const playersRaw = await paged(`${BASE}/players?per_page=100`, headers);
    const seasonAvgs = await paged(`${BASE}/season_averages?season=${season}&per_page=100`, headers);

    type AvgRow = Record<string, unknown>;
    const statsByPlayer = new Map<number, AvgRow>();
    for (const s of seasonAvgs) {
      const pid = Number((s as Record<string, unknown>).player_id);
      if (!statsByPlayer.has(pid)) statsByPlayer.set(pid, s as AvgRow);
    }

    const posMap: Record<string, string> = { G: "SG", "F": "SF", "C": "C", "G-F": "SG", "F-G": "SF", "F-C": "PF", "C-F": "C" };

    return {
      teams: teamsRaw.map((t) => {
        const r = t as Record<string, string>;
        const conf = (r.conference ?? "").toUpperCase() === "WEST" ? "WEST" : "EAST";
        return {
          externalId: String(r.id),
          abbr: (r.abbreviation ?? r.city?.slice(0, 3) ?? "TBD").toUpperCase(),
          city: r.city ?? "未知",
          name: r.full_name?.split(" ").slice(-1)[0] ?? r.name ?? "未知",
          conference: conf,
          division: r.division ?? "未知",
          meta,
        };
      }),
      players: playersRaw.map((p) => {
        const r = p as Record<string, unknown>;
        const id = Number(r.id);
        const avg = statsByPlayer.get(id);
        const height = typeof r.height === "string" ? parseHeight(r.height) : null;
        return {
          externalId: String(id),
          name: String(r.first_name ?? "") + " " + String(r.last_name ?? ""),
          position: posMap[String(r.position ?? "F")] ?? "SF",
          age: 0, // provider does not expose age; UI shows 未知
          heightCm: height,
          weightKg: null,
          draftYear: null,
          yearsPro: null,
          potential: null,
          potentialLow: null,
          potentialHigh: null,
          contract: null, // provider does not expose contracts — left unknown
          statLine: avg
            ? {
                season,
                teamAbbr: "N/A",
                g: num(avg.gp),
                mp: num(avg.min) * Math.max(1, num(avg.gp)),
                pts: num(avg.pts) * Math.max(1, num(avg.gp)),
                reb: (num(avg.reb) ) * Math.max(1, num(avg.gp)),
                ast: num(avg.ast) * Math.max(1, num(avg.gp)),
                stl: num(avg.stl) * Math.max(1, num(avg.gp)),
                blk: num(avg.blk) * Math.max(1, num(avg.gp)),
                tov: num(avg.turnover) * Math.max(1, num(avg.gp)),
                fgm: num(avg.fgm) * Math.max(1, num(avg.gp)),
                fga: num(avg.fga) * Math.max(1, num(avg.gp)),
                tpm: num(avg.fg3m) * Math.max(1, num(avg.gp)),
                tpa: num(avg.fg3a) * Math.max(1, num(avg.gp)),
                ftm: num(avg.ftm) * Math.max(1, num(avg.gp)),
                fta: num(avg.fta) * Math.max(1, num(avg.gp)),
              }
            : {},
          meta,
        };
      }),
    };
  },
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseHeight(h: string): number | null {
  // BALLDONTLIE v1 returns "" sometimes; handle "6-6" ft-in format.
  const m = /^(\d+)-(\d+)$/.exec(h.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * 30.48 + Number(m[2]) * 2.54);
}

async function paged(url: string, headers: Record<string, string>, maxPages = 20): Promise<unknown[]> {
  const out: unknown[] = [];
  let nextCursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const sep = url.includes("?") ? "&" : "?";
    const u = nextCursor ? `${url}${sep}cursor=${nextCursor}` : url;
    const res = await fetch(u, { headers });
    if (!res.ok) throw new ProviderError("PROVIDER_HTTP", `BALLDONTLIE 请求失败：HTTP ${res.status}`);
    const json = (await res.json()) as { data?: unknown[]; meta?: { next_cursor?: string } };
    out.push(...(json.data ?? []));
    nextCursor = json.meta?.next_cursor ?? null;
    if (!nextCursor) break;
  }
  return out;
}
