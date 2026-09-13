// Data source adapter interface. All real-data adapters must fill provenance
// metadata; records without provenance are rejected by the import pipeline.

import type { SeasonStatLine } from "@/domain/types";

export type ProviderId = "BALLDONTLIE" | "SPORTRADAR" | "CSV_JSON" | "DEMO";

export interface ProvenanceMeta {
  provider: ProviderId | string;
  sourceUrl: string;
  retrievedAt: string; // ISO datetime
  season: number; // season label the data belongs to
  licenseNote: string;
}

export interface ImportedPlayerRecord {
  externalId: string;
  name: string;
  position: string; // PG/SG/SF/PF/C, or a raw provider token (G/GF/F/FC…) resolved at import
  secondPosition?: string | null; // optional explicit secondary slot; inferred when absent
  teamAbbr?: string; // maps the player to an imported team (by abbr)
  age: number;
  heightCm: number | null;
  weightKg: number | null;
  draftYear: number | null;
  yearsPro: number | null;
  potential: number | null;
  potentialLow: number | null;
  potentialHigh: number | null;
  contract: {
    years: { season: number; salary: number }[];
    type: "ROOKIE" | "VETERAN" | "MAX" | "MINIMUM" | "EXTENSION";
    birdRights: boolean;
    noTrade: boolean;
    option: "PO" | "TO" | null;
    signedSeason: number;
  } | null;
  statLine: Partial<SeasonStatLine>; // season aggregate from the provider
  perGame?: ImportedPerGameStats; // real observed per-game line (preferred for ratings)
  meta: ProvenanceMeta;
}

export interface ImportedTeamRecord {
  externalId: string;
  abbr: string;
  city: string;
  name: string;
  conference: "EAST" | "WEST" | string;
  division: string;
  color?: string;
  meta: ProvenanceMeta;
}

/** Real observed per-game season statistics (e.g. from Wikipedia career tables). */
export interface ImportedPerGameStats {
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

export interface ImportPayload {
  teams: ImportedTeamRecord[];
  players: ImportedPlayerRecord[];
}

export interface DataSourceAdapter {
  id: ProviderId;
  label: string;
  docsUrl: string;
  requiresApiKey: boolean;
  apiKeyEnvVar: string | null;
  licenseNote: string;
  /** Fetch + normalize one season of rosters & season stats. */
  fetchSeason(season: number, opts: { apiKey?: string }): Promise<ImportPayload>;
}

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function assertProvenance(meta: ProvenanceMeta) {
  if (!meta.sourceUrl || !meta.retrievedAt || !meta.season || !meta.licenseNote) {
    throw new ProviderError("PROVENANCE_MISSING", "导入数据缺少来源元数据（sourceUrl/retrievedAt/season/licenseNote）");
  }
  const t = Date.parse(meta.retrievedAt);
  if (Number.isNaN(t)) throw new ProviderError("PROVENANCE_INVALID", "retrievedAt 不是合法的 ISO 时间");
}
