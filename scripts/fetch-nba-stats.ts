// Fetch real 2025-26 per-game season statistics for every imported player
// from their Wikipedia articles (career statistics → NBA regular season).
//
// Source license: Wikipedia CC BY-SA 4.0 (factual statistical data).
// Output: data/nba-real-stats.json — { externalId: perGame line | null }
//
// Uses batched action=query requests (25 titles each) with polite delays and
// 429 backoff. Resume-safe: players already present in the output are skipped.
//
// Usage:
//   npx tsx scripts/fetch-nba-stats.ts [--limit N]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const UA = "HARDWOOD-GM-Importer/1.0 (local simulation game; factual stats import)";
const API = "https://en.wikipedia.org/w/api.php";
const BATCH = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wikiBatch(titles: string[]): Record<string, string> {
  const url = `${API}?action=query&prop=revisions&rvprop=content&rvslots=main&formatversion=2&format=json&redirects=1&titles=${encodeURIComponent(titles.join("|"))}`;
  const waits = [0, 8000, 20000, 45000, 90000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) {
      console.log(`   …限流，等 ${waits[attempt] / 1000}s 后重试`);
      sleep(waits[attempt]);
    }
    try {
      const out = execFileSync("curl", ["-sS", "--fail", "-A", UA, "--max-time", "90", url], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      });
      const json = JSON.parse(out) as {
        query?: {
          pages?: { title: string; revisions?: { slots?: { main?: { content?: string } } }[] }[];
          redirects?: { from: string; to: string }[];
        };
        error?: { info: string };
      };
      const result: Record<string, string> = {};
      for (const page of json.query?.pages ?? []) {
        const content = page.revisions?.[0]?.slots?.main?.content;
        if (content) result[page.title] = content;
      }
      // Redirects: the response lists target titles, so also index every
      // requested title ("from") under its redirect target ("to").
      for (const r of json.query?.redirects ?? []) {
        if (result[r.to]) result[r.from] = result[r.to];
      }
      return result;
    } catch (e) {
      const msg = String((e as Error).message);
      const retryable = msg.includes("429") || msg.includes("ECONNRESET") || msg.includes("timed out") || msg.includes("curl: (28)");
      if (!retryable || attempt === waits.length - 1) throw e;
    }
  }
  throw new Error("unreachable");
}

function preprocessRow(row: string): string {
  return row
    .replace(/style="[^"]*"/g, "")
    // unquoted cell attributes like bgcolor=cfecec| carry their own pipe — drop them
    .replace(/bgcolor=[^|\s]*\|/gi, "")
    // season templates become readable labels ({{nbay|2025}} → 2025-26)
    .replace(/\{\{\s*nbay\s*\|\s*(\d{4})\s*\}\}/g, (_m, y: string) => `${y}-${String((Number(y) + 1) % 100).padStart(2, "0")}`)
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'''/g, "")
    .replace(/''/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*/g, "")
    .replace(/[\[\]]/g, " ");
}

function num(v: string): number | null {
  const t = v.trim().replace(/^\./, "0.");
  if (!t || t === "-" || t === "–") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedPerGame {
  season: number;
  teamRow: string;
  g: number;
  gs: number | null;
  mpg: number;
  fgPct: number | null;
  tpPct: number | null;
  ftPct: number | null;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  ppg: number;
}

/** Parse the 2025-26 ({{nbay|2025}}) regular-season row from a player article. */
export function parse2025_26Row(wikitext: string): ParsedPerGame | null {
  // Preferred scope: the "====Regular season====" subsection (most articles).
  // Many articles (e.g. traded stars) keep the NBA career table directly
  // under "===NBA===" with no regular-season subheading — fall back to the
  // career-statistics area, then the whole article. Row-level filters ({{nbay}}
  // template + non-playoffs) keep the fallback safe.
  const scopes: string[] = [];
  const rsMatch = /={4,5}\s*Regular season\s*={4,5}/.exec(wikitext);
  if (rsMatch) {
    const rest = wikitext.slice(rsMatch.index + rsMatch[0].length);
    const nextSection = rest.search(/={4,5}\s*[A-Za-z]/);
    scopes.push(nextSection === -1 ? rest : rest.slice(0, nextSection));
  }
  const careerMatch = /={2,3}\s*Career statistics\s*={2,3}/.exec(wikitext);
  if (careerMatch) scopes.push(wikitext.slice(careerMatch.index));
  scopes.push(wikitext);

  const candidates: ParsedPerGame[] = [];
  const seen = new Set<string>();
  for (const section of scopes) {
    const rows = section.split("|-");
    for (const rawRow of rows) {
      if (!/\{\{\s*nbay\s*\|\s*2025\s*[\s|}]/.test(rawRow)) continue;
      if (/playoffs/i.test(rawRow) && !/Regular/i.test(rawRow)) continue;
      // substitutions first (templates/links contain "|"), THEN split cells
      const cells = preprocessRow(rawRow)
        .replace(/\|\|/g, "|")
        .split("|")
        .map((c) => c.replace(/\s+/g, " ").trim())
        .filter((c) => c !== "");
      const seasonIdx = cells.findIndex((c) => /^2025-26/.test(c));
      if (seasonIdx === -1) continue;
      const dedup = cells.slice(seasonIdx).join("|");
      if (seen.has(dedup)) continue;
      const team = cells[seasonIdx + 1] ?? "?";
      const stats = cells.slice(seasonIdx + 2);
      if (stats.length < 11) continue;
      const tail = stats.slice(-11).map(num);
      const [gp, gs, mpg, fgPct, tpPct, ftPct, rpg, apg, spg, bpg, ppg] = tail as (number | null)[];
      if (gp == null || mpg == null || ppg == null) continue;
      seen.add(dedup);
      candidates.push({
        season: 2026,
        teamRow: team,
        g: gp,
        gs: gs ?? null,
        mpg,
        fgPct: fgPct == null ? null : fgPct > 1 ? fgPct / 100 : fgPct,
        tpPct: tpPct == null ? null : tpPct > 1 ? tpPct / 100 : tpPct,
        ftPct: ftPct == null ? null : ftPct > 1 ? ftPct / 100 : ftPct,
        rpg: rpg ?? 0,
        apg: apg ?? 0,
        spg: spg ?? 0,
        bpg: bpg ?? 0,
        ppg,
      });
    }
    // The most specific matching scope wins: stop once any row was parsed.
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;
  // multi-team season: use the row with the most games (dominant team)
  candidates.sort((a, b) => b.g - a.g);
  return candidates[0];
}

async function main() {
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

  const payloadPath = path.join(process.cwd(), "data", "nba-real-payload.json");
  const outPath = path.join(process.cwd(), "data", "nba-real-stats.json");
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8")) as {
    players: { externalId: string; name: string; wikiTitle?: string | null }[];
  };
  const existing: Record<string, unknown> = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

  const targets = payload.players.filter((p) => p.wikiTitle && !(p.externalId in existing)).slice(0, limit);
  console.log(`待抓取 ${targets.length} 名球员（已完成 ${Object.keys(existing).length}），批量 ${BATCH}/请求`);

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    // title → externalIds（同名条目去重）
    const byTitle = new Map<string, string[]>();
    for (const p of batch) {
      const t = p.wikiTitle!;
      byTitle.set(t, [...(byTitle.get(t) ?? []), p.externalId]);
    }
    let pages: Record<string, string> = {};
    let failed = false;
    try {
      pages = wikiBatch([...byTitle.keys()]);
    } catch (e) {
      // 批次失败（限流）不写结果 —— 留待下次运行重试
      failed = true;
      console.log(`   ✕ 批次失败（${e instanceof Error ? e.message.slice(0, 120) : e}），跳过待重试`);
    }
    if (!failed) {
      for (const [title, extIds] of byTitle) {
        const wt = pages[title];
        const row = wt ? parse2025_26Row(wt) : null;
        for (const extId of extIds) existing[extId] = row;
      }
    }
    const gotBatch = [...byTitle.values()].flat().filter((id) => existing[id]).length;
    console.log(`   ${Math.min(i + BATCH, targets.length)}/${targets.length}（本批有数据 ${gotBatch}）`);
    fs.writeFileSync(outPath, JSON.stringify(existing, null, 1));
    if (i + BATCH < targets.length) await sleep(1500); // 礼貌抓取
  }

  const withStats = Object.values(existing).filter(Boolean).length;
  console.log(`完成：${Object.keys(existing).length} 名球员中有 ${withStats} 名有 2025-26 数据 → ${outPath}`);
}

if (process.argv[1]?.includes("fetch-nba-stats")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
