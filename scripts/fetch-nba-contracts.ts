// Fetch real NBA contracts (current-season salary + years remaining) for every
// imported player from ESPN's public core API.
//
// Source: ESPN public endpoints (site.web.api.espn.com / sports.core.api.espn.com).
// Provenance recorded as provider=ESPN in the merged payload.
//
// Output: data/nba-real-contracts.json — { externalId: { salary, yearsRemaining, tradeValue, espnId } }
// Resume-safe. Usage:
//   npx tsx scripts/fetch-nba-contracts.ts

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const UA = "NBA2K-Importer/1.0 (local simulation game; factual contract import)";
const SEASON = 2027; // ESPN season key for the 2026-27 campaign

// ESPN team ids verified against each roster's displayName on 2026-09-13.
// Must cover every abbr in the payload — a missing entry means that team's
// players silently end up with no contract at all (UTA/26 was dropped here
// once and the whole Jazz roster imported as rating-derived placeholders).
const ESPN_TEAM_IDS: Record<string, number> = {
  ATL: 1, BOS: 2, NOP: 3, CHI: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8, GSW: 9, HOU: 10,
  IND: 11, LAC: 12, LAL: 13, MIA: 14, MIL: 15, MIN: 16, BKN: 17, NYK: 18, ORL: 19, PHI: 20,
  PHX: 21, POR: 22, SAC: 23, SAS: 24, OKC: 25, UTA: 26, WAS: 27, TOR: 28, MEM: 29, CHA: 30,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlJson(url: string): unknown {
  const waits = [0, 5000, 15000, 30000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) {
      console.log(`   …限流，等 ${waits[attempt] / 1000}s 后重试`);
      sleep(waits[attempt]);
    }
    try {
      const out = execFileSync("curl", ["-sS", "--fail", "-A", UA, "--max-time", "30", url], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      return JSON.parse(out);
    } catch (e) {
      const msg = String((e as Error).message);
      const retryable = msg.includes("429") || msg.includes("ECONNRESET") || msg.includes("timed out");
      if (!retryable || attempt === waits.length - 1) throw e;
    }
  }
  throw new Error("unreachable");
}

const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const GENERATIONAL = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function nameTokens(name: string): string[] {
  return stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !GENERATIONAL.has(t));
}

function tokenKey(name: string): string {
  return nameTokens(name).sort().join(" ");
}

interface EspnAthlete {
  id: string;
  displayName: string;
  jersey?: string;
}

async function main() {
  const payloadPath = path.join(process.cwd(), "src", "data", "real", "nba-real-2026-27.json");
  const outPath = path.join(process.cwd(), "data", "nba-real-contracts.json");
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8")) as {
    players: { externalId: string; name: string; teamAbbr?: string; jersey?: number | null }[];
  };
  const existing: Record<string, unknown> = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : {};
  // --verify: 重新校验已缓存合同的身份（espnId 的 displayName 必须与球员姓名
  // 词元重叠），删除错配记录以便重新匹配。
  if (process.argv.includes("--verify")) {
    const nameByExt = new Map(payload.players.map((p) => [p.externalId, p.name]));
    let removed = 0;
    for (const [extId, rec] of Object.entries(existing)) {
      const espnId = (rec as { espnId?: string } | null)?.espnId;
      const playerName = nameByExt.get(extId);
      if (!espnId || !playerName) continue;
      try {
        const a = curlJson(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${espnId}`) as { displayName?: string };
        const key = tokenKey(playerName);
        const tokens = new Set(key.split(" "));
        const real = tokenKey(a.displayName ?? "");
        const overlap = real.split(" ").filter((t) => tokens.has(t)).length;
        if (!real || overlap === 0) {
          console.log(`✕ 身份不符：${playerName} → espnId ${espnId} 是 ${a.displayName ?? "?"}，删除合同记录`);
          delete existing[extId];
          removed++;
        }
        await sleep(200);
      } catch {
        /* 无法校验时保留 */
      }
    }
    fs.writeFileSync(outPath, JSON.stringify(existing, null, 1));
    console.log(`--verify 完成：删除 ${removed} 条错配合同`);
    return;
  }

  const byAbbr = new Map<string, typeof payload.players>();
  for (const p of payload.players) {
    if (!p.teamAbbr) continue;
    const list = byAbbr.get(p.teamAbbr) ?? [];
    list.push(p);
    byAbbr.set(p.teamAbbr, list);
  }
  const unmapped = [...byAbbr.keys()].filter((abbr) => !(abbr in ESPN_TEAM_IDS));
  if (unmapped.length) {
    throw new Error(`ESPN_TEAM_IDS 缺少球队 ${unmapped.join("、")}：这些队的球员会全部被导入为无合同占位，先补映射再抓取`);
  }

  // 1) ESPN rosters → athlete ids, matched to payload players
  const matches = new Map<string, { espnId: string; name: string }>(); // externalId → espn
  const unmatched: string[] = [];
  for (const [abbr, id] of Object.entries(ESPN_TEAM_IDS)) {
    let roster: { athletes?: EspnAthlete[] };
    try {
      roster = curlJson(`https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/roster`) as never;
    } catch (e) {
      console.log(`✕ ${abbr} 花名册抓取失败：${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    const ours = byAbbr.get(abbr) ?? [];
    const espnAthletes = roster.athletes ?? [];
    const usedEspn = new Set<string>();
    for (const p of ours) {
      if (p.externalId in existing) {
        matches.set(p.externalId, { espnId: "(cached)", name: p.name });
        continue;
      }
      const pJersey = p.jersey != null ? String(p.jersey) : null;
      const pKey = tokenKey(p.name);
      const pTokens = new Set(pKey.split(" "));
      // Identity-first matching: an exact token-set name match wins. Jersey
      // number alone is NEVER enough — jerseys collide within a roster and
      // especially across trades (LaMelo Ball → Terrence Shannon Jr. bug).
      const nameOf = (a: EspnAthlete) => tokenKey(a.displayName);
      const tokenOverlap = (a: EspnAthlete) => {
        const t = nameOf(a).split(" ");
        return t.filter((x) => pTokens.has(x)).length / Math.max(1, t.length);
      };
      let hit = espnAthletes.find((a) => !usedEspn.has(a.id) && pKey && nameOf(a) === pKey);
      if (!hit) {
        // Fall back to jersey number, but only when the name shares at least
        // one token (nickname/abbreviation variants like "Nickeil" ↔ "Naw").
        hit = espnAthletes.find((a) => !usedEspn.has(a.id) && pJersey && a.jersey === pJersey && tokenOverlap(a) > 0);
      }
      if (!hit && pJersey) {
        // Last resort: same-team jersey match with NO name overlap — record
        // it explicitly as unverified instead of silently trusting it.
        const candidate = espnAthletes.find((a) => !usedEspn.has(a.id) && a.jersey === pJersey);
        if (candidate) {
          console.log(`   ⚠ ${p.name}（#${pJersey}）按球衣号只找到 ${candidate.displayName}，姓名不符 → 保持未匹配`);
        }
      }
      if (hit) {
        usedEspn.add(hit.id);
        matches.set(p.externalId, { espnId: hit.id, name: p.name });
      } else {
        unmatched.push(p.name);
      }
    }
    console.log(`${abbr}: ESPN ${espnAthletes.length} 人，匹配 ${ours.filter((p) => matches.has(p.externalId)).length}/${ours.length}`);
    await sleep(400);
  }
  if (unmatched.length) console.log(`未匹配（保持未知）: ${unmatched.slice(0, 10).join("、")}${unmatched.length > 10 ? " …" : ""}`);

  // 2) contract per matched athlete (skip cached)
  const toFetch = [...matches.entries()].filter(([extId]) => !(extId in existing));
  console.log(`抓取 ${toFetch.length} 份合同…`);
  let okCount = 0;
  for (let i = 0; i < toFetch.length; i++) {
    const [extId, m] = toFetch[i];
    if (m.espnId === "(cached)") continue;
    try {
      let json = curlJson(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${SEASON}/athletes/${m.espnId}/contract`) as {
        salary?: number;
        yearsRemaining?: number;
        incomingTradeValue?: number;
      };
      if (!json.salary) {
        json = curlJson(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/athletes/${m.espnId}/contract`) as typeof json;
      }
      if (json.salary) {
        existing[extId] = {
          salary: json.salary,
          yearsRemaining: json.yearsRemaining ?? 1,
          tradeValue: json.incomingTradeValue ?? json.salary,
          espnId: m.espnId,
        };
        okCount++;
      } else {
        existing[extId] = null; // 无合同记录（边缘球员）—— 显式记录为无
      }
    } catch {
      // 404 = 无合同记录
      existing[extId] = null;
    }
    if ((i + 1) % 40 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(existing, null, 1));
      console.log(`   进度 ${i + 1}/${toFetch.length}`);
    }
    await sleep(350);
  }
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 1));
  const withContract = Object.values(existing).filter(Boolean).length;
  console.log(`完成：匹配 ${matches.size}，合同 ${withContract} 份（本次新增 ${okCount}）→ ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
