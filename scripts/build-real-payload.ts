// Merge the roster payload + fetched real 2025-26 per-game statistics into the
// committed asset used by the app's auto-seed: src/data/real/nba-real-2026-27.json
//
// Usage: npx tsx scripts/build-real-payload.ts

import fs from "node:fs";
import path from "node:path";

function main() {
  const rosterPath = path.join(process.cwd(), "data", "nba-real-payload.json");
  const statsPath = path.join(process.cwd(), "data", "nba-real-stats.json");
  const contractsPath = path.join(process.cwd(), "data", "nba-real-contracts.json");
  const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  const stats: Record<string, unknown> = fs.existsSync(statsPath)
    ? JSON.parse(fs.readFileSync(statsPath, "utf8"))
    : {};
  const contracts: Record<string, { salary?: number; yearsRemaining?: number } | null> = fs.existsSync(contractsPath)
    ? JSON.parse(fs.readFileSync(contractsPath, "utf8"))
    : {};

  let withStats = 0;
  for (const p of roster.players as { externalId: string; perGame?: unknown; contract?: unknown }[]) {
    const s = stats[p.externalId];
    if (s) {
      p.perGame = s;
      withStats++;
    }
    // Real contract: year-1 salary is a live ESPN fact; later years carry the
    // same salary flat (approximation until a multi-year source is imported).
    const c = contracts[p.externalId];
    if (c && c.salary) {
      const salaryM = Math.round(c.salary / 1e4) / 100;
      const yrs = Math.max(1, Math.min(5, c.yearsRemaining ?? 1));
      p.contract = {
        type: salaryM >= 42 ? "MAX" : salaryM <= 1.4 ? "MINIMUM" : "VETERAN",
        years: Array.from({ length: yrs }, (_, i) => ({ season: 2027 + i, salary: salaryM })),
        birdRights: (c.yearsRemaining ?? 1) >= 2,
        noTrade: false,
        option: null,
        signedSeason: 2027,
      };
    }
  }
  roster.contractMeta = {
    provider: "ESPN",
    sourceUrl: "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027",
    retrievedAt: new Date().toISOString(),
    season: 2027,
    licenseNote: "来源：ESPN 公开数据端点。当前赛季真实薪资与剩余年数；未来年份按同等薪资平推（近似）。公益数据，仅本地个人使用。",
  };

  const outDir = path.join(process.cwd(), "src", "data", "real");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "nba-real-2026-27.json");
  fs.writeFileSync(outPath, JSON.stringify(roster));
  const withContract = (roster.players as { contract?: unknown }[]).filter((p) => p.contract).length;
  console.log(
    `已生成 ${outPath}：球队 ${roster.teams.length}，球员 ${roster.players.length}（真实统计 ${withStats} 名，真实合同 ${withContract} 份）`,
  );
}

main();
