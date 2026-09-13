// CSV / JSON import adapter — user-supplied data.
// Accepts JSON payloads matching the ImportPayload schema, or CSVs.
//
// CSV format (players.csv):
//   name,position,age,height_cm,weight_kg,team_abbr,season,g,mp,pts,reb,ast,stl,blk,tov,fgm,fga,tpm,tpa,ftm,fta,salary,contract_years,draft_year
// CSV format (teams.csv):
//   abbr,city,name,conference,division
//
// Provenance is attached by the importer from user input (sourceUrl etc.).

import { assertProvenance, type ImportPayload, type ImportedPlayerRecord, type ImportedTeamRecord, type ProvenanceMeta } from "./types";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const numOr = (v: string | undefined, d: number | null = null): number | null => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function parsePlayersCsv(text: string, meta: ProvenanceMeta): ImportedPlayerRecord[] {
  assertProvenance(meta);
  return parseCsv(text).map((r) => {
    const contractYears = numOr(r.contract_years, 0) ?? 0;
    const salary = numOr(r.salary, 0) ?? 0;
    return {
      externalId: r.external_id ?? `csv-${r.name}`,
      name: r.name ?? "未知球员",
      position: (r.position ?? "SF").toUpperCase(),
      age: numOr(r.age, 0) ?? 0,
      heightCm: numOr(r.height_cm),
      weightKg: numOr(r.weight_kg),
      draftYear: numOr(r.draft_year),
      yearsPro: numOr(r.years_pro),
      potential: numOr(r.potential),
      potentialLow: numOr(r.potential_low),
      potentialHigh: numOr(r.potential_high),
      contract:
        contractYears > 0 && salary > 0
          ? {
              years: Array.from({ length: contractYears }, (_, i) => ({ season: (meta.season ?? 0) + i, salary })),
              type: "VETERAN" as const,
              birdRights: false,
              noTrade: false,
              option: null,
              signedSeason: meta.season ?? 0,
            }
          : null,
      statLine: {
        season: meta.season ?? 0,
        teamAbbr: r.team_abbr ?? "N/A",
        g: numOr(r.g, 0) ?? 0,
        mp: numOr(r.mp, 0) ?? 0,
        pts: numOr(r.pts, 0) ?? 0,
        reb: numOr(r.reb, 0) ?? 0,
        ast: numOr(r.ast, 0) ?? 0,
        stl: numOr(r.stl, 0) ?? 0,
        blk: numOr(r.blk, 0) ?? 0,
        tov: numOr(r.tov, 0) ?? 0,
        fgm: numOr(r.fgm, 0) ?? 0,
        fga: numOr(r.fga, 0) ?? 0,
        tpm: numOr(r.tpm, 0) ?? 0,
        tpa: numOr(r.tpa, 0) ?? 0,
        ftm: numOr(r.ftm, 0) ?? 0,
        fta: numOr(r.fta, 0) ?? 0,
      },
      meta,
    };
  });
}

export function parseTeamsCsv(text: string, meta: ProvenanceMeta): ImportedTeamRecord[] {
  assertProvenance(meta);
  return parseCsv(text).map((r) => ({
    externalId: r.external_id ?? `csv-${r.abbr}`,
    abbr: (r.abbr ?? "TBD").toUpperCase(),
    city: r.city ?? "未知",
    name: r.name ?? "未知",
    conference: (r.conference ?? "EAST").toUpperCase(),
    division: r.division ?? "未知",
    meta,
  }));
}

export function parseImportJson(text: string): ImportPayload {
  const json = JSON.parse(text) as ImportPayload;
  if (!Array.isArray(json.players)) throw new Error("JSON 缺少 players 数组");
  for (const p of json.players) assertProvenance(p.meta);
  return { teams: json.teams ?? [], players: json.players };
}
