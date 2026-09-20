// Import 30 real NBA teams + real player rosters from Wikipedia.
//
// Source: "List of current NBA Eastern/Western Conference team rosters"
// (each team's roster template). Wikipedia content is CC BY-SA 4.0 — this
// importer records full provenance (provider=WIKIPEDIA, sourceUrl,
// retrievedAt, season, licenseNote) on every imported record.
//
// Only FACTS are imported: names, positions, heights, weights, ages, jersey
// numbers. Season statistics are NOT fetched and stay empty — the game shows
// 未知/低置信度 instead of fabricating numbers.
//
// Usage:
//   npx tsx scripts/fetch-nba-rosters.ts            # build data/nba-real-payload.json
//   npx tsx scripts/fetch-nba-rosters.ts --import   # + create a new save and import it
//   npx tsx scripts/fetch-nba-rosters.ts --import --into <saveId>

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const API = "https://en.wikipedia.org/w/api.php";
const UA = "NBA2K-Importer/1.0 (local simulation game; factual roster import)";
const SEASON_LABEL = 2027; // 2026-27
const LIST_PAGES: { url: string; conference: "EAST" | "WEST"; page: string }[] = [
  { url: "https://en.wikipedia.org/wiki/List_of_current_NBA_Eastern_Conference_team_rosters", conference: "EAST", page: "List of current NBA Eastern Conference team rosters" },
  { url: "https://en.wikipedia.org/wiki/List_of_current_NBA_Western_Conference_team_rosters", conference: "WEST", page: "List of current NBA Western Conference team rosters" },
];

// Factual static data (public team facts): tricode, city, nickname, division, color.
const TEAM_FACTS: Record<string, { abbr: string; city: string; nickname: string; division: string; color: string }> = {
  "Atlanta Hawks": { abbr: "ATL", city: "亚特兰大", nickname: "老鹰", division: "Southeast", color: "#e03a3e" },
  "Boston Celtics": { abbr: "BOS", city: "波士顿", nickname: "凯尔特人", division: "Atlantic", color: "#007a33" },
  "Brooklyn Nets": { abbr: "BKN", city: "布鲁克林", nickname: "篮网", division: "Atlantic", color: "#000000" },
  "Charlotte Hornets": { abbr: "CHA", city: "夏洛特", nickname: "黄蜂", division: "Southeast", color: "#1d1160" },
  "Chicago Bulls": { abbr: "CHI", city: "芝加哥", nickname: "公牛", division: "Central", color: "#ce1141" },
  "Cleveland Cavaliers": { abbr: "CLE", city: "克利夫兰", nickname: "骑士", division: "Central", color: "#860038" },
  "Dallas Mavericks": { abbr: "DAL", city: "达拉斯", nickname: "独行侠", division: "Southwest", color: "#00538c" },
  "Denver Nuggets": { abbr: "DEN", city: "丹佛", nickname: "掘金", division: "Northwest", color: "#0e2240" },
  "Detroit Pistons": { abbr: "DET", city: "底特律", nickname: "活塞", division: "Central", color: "#c8102e" },
  "Golden State Warriors": { abbr: "GSW", city: "金州", nickname: "勇士", division: "Pacific", color: "#1d428a" },
  "Houston Rockets": { abbr: "HOU", city: "休斯敦", nickname: "火箭", division: "Southwest", color: "#ce1141" },
  "Indiana Pacers": { abbr: "IND", city: "印第安纳", nickname: "步行者", division: "Central", color: "#002d62" },
  "Los Angeles Clippers": { abbr: "LAC", city: "洛杉矶", nickname: "快船", division: "Pacific", color: "#c8102e" },
  "Los Angeles Lakers": { abbr: "LAL", city: "洛杉矶", nickname: "湖人", division: "Pacific", color: "#552583" },
  "Memphis Grizzlies": { abbr: "MEM", city: "孟菲斯", nickname: "灰熊", division: "Southwest", color: "#5d76a9" },
  "Miami Heat": { abbr: "MIA", city: "迈阿密", nickname: "热火", division: "Southeast", color: "#98002e" },
  "Milwaukee Bucks": { abbr: "MIL", city: "密尔沃基", nickname: "雄鹿", division: "Central", color: "#00471b" },
  "Minnesota Timberwolves": { abbr: "MIN", city: "明尼苏达", nickname: "森林狼", division: "Northwest", color: "#236192" },
  "New Orleans Pelicans": { abbr: "NOP", city: "新奥尔良", nickname: "鹈鹕", division: "Southwest", color: "#0c2340" },
  "New York Knicks": { abbr: "NYK", city: "纽约", nickname: "尼克斯", division: "Atlantic", color: "#f58426" },
  "Oklahoma City Thunder": { abbr: "OKC", city: "俄克拉何马城", nickname: "雷霆", division: "Northwest", color: "#007ac1" },
  "Orlando Magic": { abbr: "ORL", city: "奥兰多", nickname: "魔术", division: "Southeast", color: "#0077c0" },
  "Philadelphia 76ers": { abbr: "PHI", city: "费城", nickname: "76人", division: "Atlantic", color: "#006bb6" },
  "Phoenix Suns": { abbr: "PHX", city: "菲尼克斯", nickname: "太阳", division: "Pacific", color: "#1d1160" },
  "Portland Trail Blazers": { abbr: "POR", city: "波特兰", nickname: "开拓者", division: "Northwest", color: "#e03a3e" },
  "Sacramento Kings": { abbr: "SAC", city: "萨克拉门托", nickname: "国王", division: "Pacific", color: "#5a2d81" },
  "San Antonio Spurs": { abbr: "SAS", city: "圣安东尼奥", nickname: "马刺", division: "Southwest", color: "#c4ced4" },
  "Toronto Raptors": { abbr: "TOR", city: "多伦多", nickname: "猛龙", division: "Atlantic", color: "#ce1141" },
  "Utah Jazz": { abbr: "UTA", city: "犹他", nickname: "爵士", division: "Northwest", color: "#002b5c" },
  "Washington Wizards": { abbr: "WAS", city: "华盛顿", nickname: "奇才", division: "Southeast", color: "#002b5c" },
};

const DIVISION_CN: Record<string, string> = {
  Atlantic: "大西洋",
  Central: "中部",
  Southeast: "东南",
  Northwest: "西北",
  Pacific: "太平洋",
  Southwest: "西南",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wikiApi(page: string): Promise<string> {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext&redirects=1`;
  // curl handles this environment's proxy/TLS path reliably (node fetch fails).
  const waits = [0, 5000, 15000, 30000, 60000]; // polite retry/backoff on 429
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) {
      console.log(`   …被限流，等待 ${waits[attempt] / 1000}s 后重试（第 ${attempt} 次）`);
      await sleep(waits[attempt]);
    }
    try {
      const out = execFileSync("curl", ["-sS", "--fail", "-A", UA, "--max-time", "30", url], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const json = JSON.parse(out) as { parse?: { wikitext?: { "*": string } }; error?: { info: string } };
      if (!json.parse?.wikitext) throw new Error(`Wikipedia 返回错误（${page}）：${json.error?.info ?? "no wikitext"}`);
      return json.parse.wikitext["*"];
    } catch (e) {
      const msg = String((e as Error).message);
      const rateLimited = msg.includes("429") || msg.includes("ECONNRESET") || msg.includes("timed out");
      if (!rateLimited || attempt === waits.length - 1) throw e;
    }
  }
  throw new Error(`unreachable: ${page}`);
}

/** Split template params on top-level "|" only (handles nested {{...}} / [[...]]). */
function splitParams(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{" && raw[i + 1] === "{") { depth++; cur += "{{"; i++; continue; }
    if (c === "}" && raw[i + 1] === "}") { depth--; cur += "}}"; i++; continue; }
    if (c === "[" && raw[i + 1] === "[") { depth++; cur += "[["; i++; continue; }
    if (c === "]" && raw[i + 1] === "]") { depth--; cur += "]]"; i++; continue; }
    if (c === "|" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseTemplateParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  // The caller's regex already strips the template name; a stray name-only
  // first chunk (no "=") is skipped below, so use ALL parts.
  const parts = splitParams(raw);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    params[key] = part.slice(eq + 1).trim();
  }
  return params;
}

interface ParsedPlayer {
  name: string;
  rawName: string; // pre-normalization name — externalId slug source
  position: string;
  num: number | null;
  heightCm: number | null;
  weightKg: number | null;
  age: number;
  wikiTitle: string | null; // en.wikipedia article title for stats lookup
}

/**
 * Keep the raw Wikipedia position token (normalized): G / GF / F / FC / CF / C
 * are the only tags Wikipedia roster templates use — they never split PG from
 * SG. The factual token is preserved here; resolvePositions() in
 * src/domain/positions.ts maps it to the game's 5-slot model at import time
 * using stats/height as tie-breakers.
 */
function mapPosition(pos: string): string {
  const p = pos.toUpperCase().replace(/[^A-Z]/g, "");
  const known = new Set(["PG", "SG", "SF", "PF", "C", "G", "F", "GF", "FG", "FC", "CF"]);
  return known.has(p) ? p : "F";
}

function computeAge(dob: string): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const birth = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(birth.getTime())) return null;
  const nowUtc = new Date();
  let age = nowUtc.getUTCFullYear() - y;
  const beforeBirthday =
    nowUtc.getUTCMonth() + 1 < mo || (nowUtc.getUTCMonth() + 1 === mo && nowUtc.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age;
}

function parsePlayersFromTemplate(wikitext: string): ParsedPlayer[] {
  const players: ParsedPlayer[] = [];
  const re = /\{\{\s*player2\s*\|([\s\S]*?)\}\}/gi;
  for (const match of wikitext.matchAll(re)) {
    const params = parseTemplateParams(match[1]);
    const first = params["first"] ?? "";
    const last = params["last"] ?? "";
    const rawName = params["name"] ?? `${first} ${last}`.trim();
    // Wikipedia writes initials spaced ("V. J. Edgecombe"); the league style
    // is compact ("VJ Edgecombe"). Display uses the compact form; externalId
    // below still slugs the raw name so ids stay stable across re-fetches.
    const name = rawName.replace(/^([A-Z])\. ?([A-Z])\. /, "$1$2 ");
    if (!name) continue;
    const ft = Number(params["ft"] ?? 0) || 0;
    const inch = Number(params["in"] ?? 0) || 0;
    const lbs = Number(params["lbs"] ?? 0) || 0;
    const age = computeAge(params["dob"] ?? "");
    if (age == null) continue; // cannot place without an age fact — skip and warn
    const dab = params["dab"] ?? "";
    const wikiTitle = `${first} ${last}`.trim() + (dab ? ` (${dab})` : "");
    players.push({
      name,
      rawName,
      position: mapPosition(params["pos"] ?? ""),
      num: Number(params["num"]) || null,
      heightCm: ft > 0 ? Math.round((ft * 12 + inch) * 2.54) : null,
      weightKg: lbs > 0 ? Math.round(lbs * 0.4536) : null,
      age,
      wikiTitle,
    });
  }
  return players;
}

interface TeamListing {
  teamPage: string;
  rosterTemplate: string;
  division: string;
  conference: "EAST" | "WEST";
}

function parseConferenceList(wikitext: string, conference: "EAST" | "WEST"): TeamListing[] {
  const out: TeamListing[] = [];
  let currentDivision = "";
  const lines = wikitext.split("\n");
  for (const line of lines) {
    const div = /^\s*==\s*\[\[([A-Za-z ]+?) Division/.exec(line);
    if (div) {
      currentDivision = div[1];
      continue;
    }
    const team = /^\s*===\s*\[\[([^\]|]+?)(?:\s*\([^)]*\))?\]\]\s*===/.exec(line);
    if (team) {
      const teamPage = team[1].trim();
      const tpl = new RegExp(`\\{\\{\\s*${teamPage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+roster\\s*\\}\\}`, "i");
      out.push({ teamPage, rosterTemplate: `${teamPage} roster`, division: currentDivision, conference });
      void tpl;
    }
  }
  return out;
}

async function main() {
  const importFlag = process.argv.includes("--import");
  const intoIdx = process.argv.indexOf("--into");
  const intoSaveId = intoIdx >= 0 ? process.argv[intoIdx + 1] : undefined;

  console.log("1) 抓取分区名单索引页…");
  const listings: TeamListing[] = [];
  for (const lp of LIST_PAGES) {
    const wt = await wikiApi(lp.page);
    listings.push(...parseConferenceList(wt, lp.conference));
  }
  console.log(`   共 ${listings.length} 支球队`);
  if (listings.length !== 30) throw new Error(`预期 30 支球队，实际 ${listings.length}`);

  console.log("2) 抓取 30 支球队名单模板并解析…");
  const retrievedAt = new Date().toISOString();
  const teams: ImportPayloadTeam[] = [];
  const players: ImportPayloadPlayer[] = [];
  const warnings: string[] = [];

  for (const listing of listings) {
    const facts = TEAM_FACTS[listing.teamPage];
    if (!facts) {
      warnings.push(`未知球队：${listing.teamPage}（TEAM_FACTS 缺少映射）`);
      continue;
    }
    const wt = await wikiApi(`Template:${listing.rosterTemplate}`);
    const roster = parsePlayersFromTemplate(wt);
    if (roster.length === 0) {
      warnings.push(`${listing.teamPage}: 名单解析为空，请检查模板结构`);
    }
    teams.push({
      externalId: facts.abbr,
      abbr: facts.abbr,
      city: facts.city,
      name: facts.nickname,
      conference: listing.conference,
      division: DIVISION_CN[listing.division] ?? listing.division,
      color: facts.color,
      meta: {
        provider: "WIKIPEDIA",
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(listing.teamPage)}`,
        retrievedAt,
        season: SEASON_LABEL,
        licenseNote: "来源：Wikipedia（CC BY-SA 4.0）。名单为事实数据（姓名/位置/身高/体重/年龄/号码），使用需署名并以相同方式共享。",
      },
    });
    for (const p of roster) {
      players.push({
        externalId: `nba-${p.rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}${p.num ? `-${p.num}` : ""}`,
        name: p.name,
        position: p.position,
        teamAbbr: facts.abbr,
        wikiTitle: p.wikiTitle,
        jersey: p.num,
        age: p.age,
        heightCm: p.heightCm,
        weightKg: p.weightKg,
        draftYear: null,
        yearsPro: null,
        potential: null,
        potentialLow: null,
        potentialHigh: null,
        contract: null, // 合同/薪资不在本来源中 → 显示未知
        statLine: {}, // 统计未导入 → 评分为未知（置信度 0），绝不编造
        meta: {
          provider: "WIKIPEDIA",
          sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(listing.teamPage)}`,
          retrievedAt,
          season: SEASON_LABEL,
          licenseNote: "来源：Wikipedia（CC BY-SA 4.0）。名单为事实数据（姓名/位置/身高/体重/年龄/号码），使用需署名并以相同方式共享。",
        },
      });
    }
    console.log(`   ${facts.abbr} ${listing.teamPage}: ${roster.length} 名球员`);
    await sleep(1200); // 礼貌抓取
  }

  if (warnings.length) {
    console.log("警告:");
    for (const w of warnings) console.log("  -", w);
  }

  const payload = { teams, players };
  const outPath = path.join(process.cwd(), "data", "nba-real-payload.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1));
  console.log(`3) Payload 已写入 ${outPath}（球队 ${teams.length}，球员 ${players.length}）`);

  if (importFlag) {
    const { createSave, getSave } = await import("../src/server/engine");
    const { importData } = await import("../src/server/import");
    const { getDb } = await import("../src/db");
    const { saves } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");

    let saveId = intoSaveId;
    if (!saveId) {
      const created = await createSave({ name: "真实 NBA 2026-27", seed: 20272027 });
      saveId = created.saveId;
    }
    const result = await importData(saveId, payload as never);
    // rename save for clarity
    const db = getDb();
    db.update(saves).set({ name: "真实 NBA 2026-27（Wikipedia 数据）" }).where(eq(saves.id, saveId)).run();
    const save = getSave(saveId);
    console.log("4) 导入完成:", {
      saveId,
      saveName: save?.name,
      teamsImported: result.teamsImported,
      playersImported: result.playersImported,
      gamesScheduled: result.gamesScheduled,
      picksGenerated: result.picksGenerated,
      warningCount: result.warnings.length,
    });
  }
}

type ImportPayloadTeam = {
  externalId: string;
  abbr: string;
  city: string;
  name: string;
  conference: string;
  division: string;
  color?: string;
  meta: { provider: string; sourceUrl: string; retrievedAt: string; season: number; licenseNote: string };
};
type ImportPayloadPlayer = {
  externalId: string;
  name: string;
  position: string;
  teamAbbr?: string;
  wikiTitle?: string | null;
  jersey?: number | null;
  age: number;
  heightCm: number | null;
  weightKg: number | null;
  draftYear: number | null;
  yearsPro: number | null;
  potential: number | null;
  potentialLow: number | null;
  potentialHigh: number | null;
  contract: null;
  statLine: Record<string, never>;
  meta: { provider: string; sourceUrl: string; retrievedAt: string; season: number; licenseNote: string };
};

main().catch((e) => {
  console.error("导入失败:", e);
  process.exit(1);
});
