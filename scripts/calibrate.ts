// Calibration: simulate a full regular season with the real NBA payload and
// compare against the REAL 2025-26 baseline:
//   1. real team scoring (sum of roster players' real PPG ≈ team PPG)
//   2. real standings (W-L from Wikipedia season article, best-effort)
//   3. real player scoring leaders vs simulated leaders
// Writes docs/simulation-calibration.md.
//
// Usage: TSX_TSCONFIG_PATH=scripts/tsconfig.json npx tsx scripts/calibrate.ts [--days N]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.NBA2K_NO_AUTOSEED = "1";
if (!process.env.NBA2K_DB_PATH) {
  process.env.NBA2K_DB_PATH = path.join(process.cwd(), "data", "calibration.db");
  if (fs.existsSync(process.env.NBA2K_DB_PATH)) fs.rmSync(process.env.NBA2K_DB_PATH);
}

const UA = "HARDWOOD-GM-Importer/1.0 (local simulation game)";

interface PayloadPlayer {
  externalId: string;
  name: string;
  teamAbbr?: string;
  perGame?: { ppg: number; rpg: number; apg: number; g: number } | null;
}

function fetchWiki(page: string): string {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&format=json&prop=text&redirects=1`;
  const out = execFileSync("curl", ["-sS", "--fail", "-A", UA, "--max-time", "30", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (JSON.parse(out) as { parse?: { text?: { "*": string } } }).parse?.text?.["*"] ?? "";
}

/** Parse final 2025-26 standings (W-L) from the rendered season article HTML. */
function fetchRealStandings(): Record<string, { w: number; l: number }> {
  const html = fetchWiki("2025–26 NBA season");
  const out: Record<string, { w: number; l: number }> = {};
  // rows like: ...team link text... <td>N</td> <td>N</td> within standings tables
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  const abbrs: Record<string, string> = {
    "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN", "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET", "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
    "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL", "Memphis Grizzlies": "MEM", "Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP", "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI", "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC", "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR",
    "Utah Jazz": "UTA", "Washington Wizards": "WAS",
  };
  for (const table of tables) {
    // only proper standings tables carry the "Games won" header
    if (!/Games won/.test(table)) continue;
    const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    for (const row of rows) {
      const team = Object.keys(abbrs).find((name) => row.includes(`>${name}<`));
      if (!team) continue;
      const nums = (row.match(/<td[^>]*>\s*(\d{1,3})\s*<\/td>/g) ?? [])
        .map((c) => Number(c.replace(/<[^>]*>/g, "").trim()))
        .filter((n) => Number.isFinite(n));
      if (nums.length >= 2) {
        out[abbrs[team]] = { w: nums[0], l: nums[1] };
      }
    }
    if (Object.keys(out).length >= 30) break;
  }
  return out;
}

async function main() {
  const { createSave, advanceSim, loadLeagueState } = await import("../src/server/engine");
  const { importData } = await import("../src/server/import");
  const { getDb } = await import("../src/db");
  const { players: playersT, teams: teamsT } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const payload = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src", "data", "real", "nba-real-2026-27.json"), "utf8"),
  ) as { players: PayloadPlayer[] };

  // --- real baseline -------------------------------------------------------
  const realTeamPpg = new Map<string, { sum: number; n: number }>();
  const realPlayers = payload.players
    .filter((p) => p.perGame && p.teamAbbr)
    .map((p) => ({ name: p.name, abbr: p.teamAbbr!, ppg: p.perGame!.ppg, g: p.perGame!.g }));
  for (const p of realPlayers) {
    const cur = realTeamPpg.get(p.abbr) ?? { sum: 0, n: 0 };
    cur.sum += p.ppg;
    cur.n += 1;
    realTeamPpg.set(p.abbr, cur);
  }
  const realLeagueAvg = [...realTeamPpg.values()].reduce((a, v) => a + v.sum, 0) / realTeamPpg.size;
  const realStandings = fetchRealStandings();
  console.log(`真实基线：联盟平均每队得分 ≈ ${realLeagueAvg.toFixed(1)}；战绩解析 ${Object.keys(realStandings).length}/30 队`);

  // --- simulate ------------------------------------------------------------
  const created = await createSave({ name: "calibration", seed: 424242 });
  await importData(created.saveId, payload as never);
  const daysArg = process.argv.indexOf("--days");
  const maxDays = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 400;
  const result = advanceSim(created.saveId, "REGULAR_SEASON");
  void maxDays;
  console.log(`模拟完成：${result.days} 天 / ${result.gamesPlayed} 场，阶段 → ${result.phaseChanged}`);

  const db = getDb();
  const teamRows = db.select().from(teamsT).where(eq(teamsT.saveId, created.saveId)).all();
  const state = loadLeagueState(created.saveId);

  // sim team scoring from finished games
  const simTeamPts = new Map<string, { sum: number; games: number }>();
  for (const g of state.games.filter((x) => x.status === "FINAL" && x.type === "REGULAR")) {
    for (const [tid, pts] of [[g.homeTeamId, g.homeScore], [g.awayTeamId, g.awayScore]] as [string, number | null][]) {
      const cur = simTeamPts.get(tid) ?? { sum: 0, games: 0 };
      cur.sum += pts ?? 0;
      cur.games += 1;
      simTeamPts.set(tid, cur);
    }
  }
  const simTeamAvg = new Map<string, number>();
  for (const [tid, v] of simTeamPts) simTeamAvg.set(tid, v.games ? v.sum / v.games : 0);
  const simLeagueAvg = [...simTeamAvg.values()].reduce((a, v) => a + v, 0) / Math.max(1, simTeamAvg.size);

  // sim scorers from player season stats
  const playerRows = db.select().from(playersT).where(eq(playersT.saveId, created.saveId)).all();
  const simScorers = playerRows
    .map((p) => {
      const s = p.seasonStats.find((x) => x.season === state.season);
      return { name: p.name, g: s?.g ?? 0, ppg: s && s.g > 0 ? s.pts / s.g : 0 };
    })
    .filter((p) => p.g >= 20)
    .sort((a, b) => b.ppg - a.ppg)
    .slice(0, 15);

  // standings comparison
  const simStandings = teamRows
    .map((t) => ({ abbr: t.abbr, wins: t.wins, losses: t.losses, simAvg: simTeamAvg.get(t.id.split(":").pop() ?? t.id) ?? 0 }))
    .sort((a, b) => b.wins - a.wins);
  const withReal = simStandings.filter((s) => realStandings[s.abbr]);

  const std = (arr: number[]) => {
    const m = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, arr.length));
  };
  const realWinPct = withReal.map((s) => realStandings[s.abbr].w / Math.max(1, realStandings[s.abbr].w + realStandings[s.abbr].l));
  const simWinPct = withReal.map((s) => s.wins / Math.max(1, s.wins + s.losses));

  // --- report --------------------------------------------------------------
  const lines: string[] = [];
  lines.push("# 模拟校准报告：模拟引擎 vs 真实 NBA 2025-26");
  lines.push("");
  lines.push(`- 模拟场次：${result.gamesPlayed} 场常规赛（${state.season - 1}-${String(state.season).slice(2)} 赛季）`);
  lines.push(`- 真实基线来源：Wikipedia 球员条目 2025-26 场均数据（CC BY-SA 4.0）；战绩来自 Wikipedia 赛季条目（${Object.keys(realStandings).length}/30 队解析成功）`);
  lines.push("");
  lines.push("## 1) 联盟平均每队得分");
  lines.push("");
  lines.push(`| 指标 | 真实 2025-26 | 模拟 | 差异 |`);
  lines.push(`| --- | --- | --- | --- |`);
  lines.push(`| 平均每队得分 | ${realLeagueAvg.toFixed(1)} | ${simLeagueAvg.toFixed(1)} | ${(simLeagueAvg - realLeagueAvg).toFixed(1)} |`);
  lines.push("");
  lines.push("## 2) 得分手对比（场均 ≥ 一定样本的前 15 名）");
  lines.push("");
  lines.push("| 排名 | 真实球员 | 真实 PPG | 模拟球员 | 模拟 PPG |");
  lines.push("| --- | --- | --- | --- | --- |");
  const realTop15 = [...realPlayers].sort((a, b) => b.ppg - a.ppg).slice(0, 15);
  for (let i = 0; i < 15; i++) {
    const r = realTop15[i];
    const s = simScorers[i];
    lines.push(`| ${i + 1} | ${r.name} | ${r.ppg.toFixed(1)} | ${s?.name ?? "-"} | ${s ? s.ppg.toFixed(1) : "-"} |`);
  }
  const realTop5Avg = realTop15.slice(0, 5).reduce((a, r) => a + r.ppg, 0) / 5;
  const simTop5Avg = simScorers.slice(0, 5).reduce((a, r) => a + r.ppg, 0) / 5;
  lines.push("");
  lines.push(`- 真实前 5 得分手平均：${realTop5Avg.toFixed(1)} PPG；模拟前 5 平均：${simTop5Avg.toFixed(1)} PPG`);
  lines.push("");
  lines.push("## 3) 战绩分布（模拟 vs 真实）");
  lines.push("");
  lines.push(`| 指标 | 真实 | 模拟 |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| 胜率标准差（30 队） | ${std(realWinPct).toFixed(3)} | ${std(simWinPct).toFixed(3)} |`);
  lines.push(`| 最佳战绩 | ${Math.max(...realWinPct).toFixed(3)}（${withReal[realWinPct.indexOf(Math.max(...realWinPct))]?.abbr ?? "?"}） | ${Math.max(...simWinPct).toFixed(3)} |`);
  lines.push(`| 最差战绩 | ${Math.min(...realWinPct).toFixed(3)} | ${Math.min(...simWinPct).toFixed(3)} |`);
  lines.push("");
  lines.push("## 4) 各队模拟场均得分 vs 真实（按差异排序）");
  lines.push("");
  lines.push("| 球队 | 真实得分( roster 求和近似 ) | 模拟场均 | 差异 | 模拟战绩 | 真实战绩 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  const diffs = [...teamRows]
    .map((t) => {
      const abbr = t.abbr;
      const real = realTeamPpg.get(abbr)?.sum ?? 0;
      const simAvg = simTeamAvg.get(t.id.split(":").pop() ?? t.id) ?? 0;
      const rec = simStandings.find((s) => s.abbr === abbr);
      return { abbr, real, simAvg, diff: simAvg - real, wins: rec?.wins ?? 0, losses: rec?.losses ?? 0, realRec: realStandings[abbr] };
    })
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const d of diffs) {
    lines.push(
      `| ${d.abbr} | ${d.real.toFixed(1)} | ${d.simAvg.toFixed(1)} | ${d.diff > 0 ? "+" : ""}${d.diff.toFixed(1)} | ${d.wins}-${d.losses} | ${d.realRec ? `${d.realRec.w}-${d.realRec.l}` : "—"} |`,
    );
  }
  lines.push("");
  lines.push("> 注：真实每队得分以「队内球员真实 PPG 求和」近似（两向合同/边缘球员可能缺失少量样本），“真实战绩”为 2025-26 常规赛最终战绩。");

  const outDir = path.join(process.cwd(), "docs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "simulation-calibration.md"), lines.join("\n"));
  console.log(lines.slice(0, 22).join("\n"));
  console.log(`\n报告已写入 docs/simulation-calibration.md`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
