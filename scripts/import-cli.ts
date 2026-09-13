// CLI: npm run import -- --save <saveId> --file <players.csv> [--teams teams.csv] --season 2027 --source-url https://...
// Imports user-supplied CSV/JSON data into an existing save with provenance.

import fs from "node:fs";
import path from "node:path";
import { parsePlayersCsv, parseTeamsCsv, parseImportJson } from "../src/data/providers/csv";
import { importData, mergeContracts } from "../src/server/import";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseCsvRows(text: string): { name: string; salary: number; years?: number }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headers = splitLine(lines[0]);
  const nameIdx = headers.findIndex((h) => h.trim().toLowerCase() === "name");
  const salaryIdx = headers.findIndex((h) => h.trim().toLowerCase() === "salary");
  const yearsIdx = headers.findIndex((h) => h.trim().toLowerCase() === "contract_years");
  if (nameIdx === -1 || salaryIdx === -1) throw new Error("CSV 需要 name 与 salary 列");
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    return {
      name: (cells[nameIdx] ?? "").trim(),
      salary: Number(cells[salaryIdx]) || 0,
      years: yearsIdx >= 0 ? Number(cells[yearsIdx]) || 1 : 1,
    };
  });
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function main() {
  const file = arg("file");
  const saveId = arg("save");
  const season = Number(arg("season") ?? new Date().getFullYear() + 1);
  const sourceUrl = arg("source-url") ?? "user-upload://cli";
  if (!file || !saveId) {
    console.error(`用法: npm run import -- --save <saveId> --file <players.csv|payload.json> [--teams teams.csv] --season <label> --source-url <url>`);
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(file), "utf8");
  const meta = {
    provider: "CSV_JSON",
    sourceUrl,
    retrievedAt: new Date().toISOString(),
    season,
    licenseNote: "用户提供数据：来源与授权由上传方负责",
  } as const;

  if (process.argv.includes("--merge-contracts")) {
    // 只合并合同（按球员名匹配），不替换联盟：列 name,salary,contract_years
    const rows = parseCsvRows(text);
    const r = mergeContracts(saveId, rows, meta);
    console.log("合同合并完成:", r);
    process.exit(0);
  }

  let result;
  if (file.endsWith(".json")) {
    result = await importData(saveId, parseImportJson(text));
  } else {
    const teamsFile = arg("teams");
    const teams = teamsFile ? parseTeamsCsv(fs.readFileSync(path.resolve(teamsFile), "utf8"), meta) : [];
    result = await importData(saveId, { teams, players: parsePlayersCsv(text, meta) });
  }
  console.log("导入完成:", result);
  process.exit(0);
}

main().catch((e) => {
  console.error("导入失败:", e);
  process.exit(1);
});
