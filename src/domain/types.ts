// Core domain types shared by the engine, DB layer and UI.

export type Position = "PG" | "SG" | "SF" | "PF" | "C";
export type Conference = "EAST" | "WEST";
export type PlayerRole = "STAR" | "STARTER" | "SIXTH_MAN" | "ROTATION" | "BENCH" | "STASH";
export type PlayerStatus = "ACTIVE" | "INJURED" | "FREE_AGENT" | "PROSPECT" | "RETIRED";
export type TeamPhase = "CONTENDER" | "PLAYOFF" | "BUBBLE" | "REBUILD";
export type SeasonPhase = "REGULAR_SEASON" | "PLAYOFFS" | "OFFSEASON" | "FREE_AGENCY" | "DRAFT";
export type GameType = "REGULAR" | "PLAYOFF";

export interface PlayerSource {
  provider: string;
  sourceUrl: string | null;
  retrievedAt: string | null;
  season: number | null;
  licenseNote: string;
  status: "DEMO" | "IMPORTED" | "UNKNOWN";
  ratingVersion: string;
}

export interface PlayerRatings {
  overall: number;
  inside: number;
  finishing: number;
  shooting: number;
  threePoint: number;
  freeThrow: number;
  playmaking: number;
  rebounding: number;
  perimeterD: number;
  interiorD: number;
  usageTendency: number; // share of possessions the player seeks, 0-1
  potential: number | null; // scouting estimate, may be null = unknown
  potentialLow: number | null;
  potentialHigh: number | null;
  confidence: number; // 0-1 sample-size confidence
  ratingVersion: string;
}

export interface SeasonStatLine {
  season: number;
  teamAbbr: string;
  g: number;
  mp: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
}

export interface ContractYear {
  season: number;
  salary: number; // in millions USD
}

export type ContractOption = "PO" | "TO" | null;

export interface Contract {
  type: "ROOKIE" | "VETERAN" | "MAX" | "MINIMUM" | "EXTENSION";
  years: ContractYear[];
  birdRights: boolean;
  noTrade: boolean;
  option: ContractOption;
  signedSeason: number;
}

export interface InjuryState {
  description: string;
  weeksRemaining: number;
  severity: "MINOR" | "MODERATE" | "SEVERE";
}

export interface DevelopmentState {
  trajectory: "GROWING" | "PEAK" | "DECLINING" | "STABLE";
  growthLeft: number; // expected total remaining growth in rating points
  lastDelta: number;
}

export interface ScoutingReport {
  strengths: string[];
  weaknesses: string[];
  comparison: string;
  floor: number;
  ceiling: number;
  note: string;
}

export interface Protection {
  type: "LOTTERY_TOP_X" | "NONE";
  x: number | null; // protected top-X
  yearShift: number; // if conveyed, shifts to first unprotected year
}

export interface BoxPlayerLine {
  playerId: string;
  name: string;
  teamId: string;
  mp: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
}

export interface BoxScoreJson {
  home: BoxPlayerLine[];
  away: BoxPlayerLine[];
  homeTotals: { pts: number; reb: number; ast: number };
  awayTotals: { pts: number; reb: number; ast: number };
  notes: string[]; // engine-generated explanations
}

export interface TeamTotalsStats {
  offRating: number;
  defRating: number;
  pace: number;
}

export interface ChemistryFactor {
  key: string;
  label: string;
  score: number;
  note: string;
}

export interface ChemistryResult {
  overall: number;
  factors: ChemistryFactor[];
}

export interface TradeAssetPlayer {
  kind: "PLAYER";
  id: string;
}

export interface TradeAssetPick {
  kind: "PICK";
  id: string;
}

export type TradeAsset = TradeAssetPlayer | TradeAssetPick;

export interface TradeParty {
  teamId: string;
  gives: TradeAsset[];
  receives: TradeAsset[];
}

export interface TradeProposal {
  saveId: string;
  parties: TradeParty[];
}

export interface TradeRuleIssue {
  code: string;
  severity: "BLOCKER" | "WARNING";
  message: string;
}

export interface TradeValidation {
  legal: boolean;
  issues: TradeRuleIssue[];
  salaryCheck: {
    partyTeamId: string;
    incoming: number;
    outgoing: number;
    band: string;
    ok: boolean;
  }[];
}

export interface AiGmVerdict {
  accept: boolean;
  valueDelta: number; // per receiving team, positive = good for them
  feedback: string;
  reasons: string[];
}

export type EventCategory =
  | "SYSTEM"
  | "SIM"
  | "TRADE"
  | "DRAFT"
  | "FA"
  | "GOD"
  | "AI"
  | "NEWS";
