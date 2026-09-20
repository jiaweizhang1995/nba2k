import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import type {
  PlayerRatings,
  PlayerSource,
  SeasonStatLine,
  Contract,
  InjuryState,
  DevelopmentState,
  BoxScoreJson,
  Protection,
} from "@/domain/types";

export const saves = sqliteTable("saves", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  season: integer("season").notNull(), // season label, e.g. 2027 == 2026-27
  phase: text("phase").notNull().default("REGULAR_SEASON"),
  currentDate: text("current_date").notNull(),
  seed: integer("seed").notNull(),
  godMode: integer("god_mode", { mode: "boolean" }).notNull().default(false),
  godOpCounter: integer("god_op_counter").notNull().default(0),
  ruleVersion: text("rule_version").notNull(),
  ratingVersion: text("rating_version").notNull(),
  dataProvider: text("data_provider").notNull().default("DEMO"),
  dataStatus: text("data_status").notNull().default("DEMO"),
  phaseState: text("phase_state", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    abbr: text("abbr").notNull(),
    city: text("city").notNull(),
    name: text("name").notNull(),
    conference: text("conference").notNull(),
    division: text("division").notNull(),
    colorPrimary: text("color_primary").notNull().default("#38bdf8"),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    playoffAppearances: integer("playoff_appearances").notNull().default(0),
    championships: integer("championships").notNull().default(0),
    aiPhase: text("ai_phase").notNull().default("BUBBLE"),
    aiRisk: real("ai_risk").notNull().default(0.5),
    source: text("source", { mode: "json" }).$type<PlayerSource | null>(),
  },
  (t) => [index("teams_save_idx").on(t.saveId)],
);

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    name: text("name").notNull(),
    teamId: text("team_id"),
    // Team he last finished a contract with — enables Bird-rights re-signing
    // once he reaches free agency. Cleared on waiver (waived players have no bird).
    lastTeamId: text("last_team_id"),
    position: text("position").notNull(),
    secondPosition: text("second_position"),
    age: integer("age").notNull(),
    heightCm: integer("height_cm").notNull(),
    weightKg: integer("weight_kg").notNull(),
    draftYear: integer("draft_year"),
    draftRound: integer("draft_round"),
    draftPick: integer("draft_pick"),
    yearsPro: integer("years_pro").notNull().default(0),
    ratings: text("ratings", { mode: "json" }).$type<PlayerRatings>().notNull(),
    seasonStats: text("season_stats", { mode: "json" }).$type<SeasonStatLine[]>().notNull(),
    careerStats: text("career_stats", { mode: "json" }).$type<SeasonStatLine[]>().notNull(),
    contract: text("contract", { mode: "json" }).$type<Contract>().notNull(),
    status: text("status").notNull().default("ACTIVE"),
    role: text("role").notNull().default("ROTATION"),
    satisfaction: real("satisfaction").notNull().default(70),
    injury: text("injury", { mode: "json" }).$type<InjuryState | null>(),
    development: text("development", { mode: "json" }).$type<DevelopmentState>().notNull(),
    tenure: integer("tenure").notNull().default(0),
    stamina: real("stamina").notNull().default(1),
    lastGameDate: text("last_game_date"),
    // Real-world baseline statistics (imported facts, shown in the UI; kept
    // separate from in-sim seasonStats so the two are never conflated).
    baselineStats: text("baseline_stats", { mode: "json" }).$type<Record<string, unknown> | null>(),
    source: text("source", { mode: "json" }).$type<PlayerSource>().notNull(),
  },
  (t) => [index("players_save_idx").on(t.saveId), index("players_team_idx").on(t.saveId, t.teamId)],
);

export const draftPicks = sqliteTable(
  "draft_picks",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    year: integer("year").notNull(),
    round: integer("round").notNull(),
    originalTeamId: text("original_team_id").notNull(),
    holderTeamId: text("holder_team_id").notNull(),
    status: text("status").notNull().default("OWNED"),
    protection: text("protection", { mode: "json" }).$type<Protection | null>(),
    resolved: text("resolved"),
  },
  (t) => [index("picks_save_idx").on(t.saveId), index("picks_holder_idx").on(t.saveId, t.holderTeamId)],
);

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    date: text("date").notNull(),
    season: integer("season").notNull(),
    type: text("type").notNull(),
    round: text("round"),
    seriesId: text("series_id"),
    gameNo: integer("game_no"),
    homeTeamId: text("home_team_id").notNull(),
    awayTeamId: text("away_team_id").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    status: text("status").notNull().default("SCHEDULED"),
    box: text("box", { mode: "json" }).$type<BoxScoreJson | null>(),
  },
  (t) => [index("games_save_date_idx").on(t.saveId, t.date), index("games_save_season_idx").on(t.saveId, t.season)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    at: text("at").notNull(),
    category: text("category").notNull(),
    godMode: integer("god_mode", { mode: "boolean" }).notNull().default(false),
    actor: text("actor").notNull().default("USER"),
    message: text("message").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => [index("events_save_idx").on(t.saveId), index("events_save_at_idx").on(t.saveId, t.at)],
);

export const faOffers = sqliteTable(
  "fa_offers",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    playerId: text("player_id").notNull(),
    teamId: text("team_id").notNull(),
    years: integer("years").notNull(),
    avgSalary: real("avg_salary").notNull(),
    status: text("status").notNull().default("PENDING"),
    createdAt: text("created_at").notNull(),
    note: text("note"),
  },
  (t) => [index("fa_save_idx").on(t.saveId)],
);

export const godSnapshots = sqliteTable(
  "god_snapshots",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    at: text("at").notNull(),
    label: text("label").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("god_snap_save_idx").on(t.saveId)],
);

export const dataSources = sqliteTable(
  "data_sources",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id"),
    provider: text("provider").notNull(),
    sourceUrl: text("source_url"),
    retrievedAt: text("retrieved_at"),
    season: integer("season"),
    licenseNote: text("license_note").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull().default("LEAGUE"),
    records: integer("records").notNull().default(0),
  },
  (t) => [index("ds_save_idx").on(t.saveId)],
);

export const awards = sqliteTable(
  "awards",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    season: integer("season").notNull(),
    type: text("type").notNull(),
    teamId: text("team_id"),
    playerId: text("player_id"),
    detail: text("detail"),
  },
  (t) => [index("awards_save_idx").on(t.saveId)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    saveId: text("save_id").notNull(),
    at: text("at").notNull(),
    context: text("context").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
  },
  (t) => [index("chat_save_idx").on(t.saveId)],
);

export type SaveRow = typeof saves.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type PickRow = typeof draftPicks.$inferSelect;
export type GameRow = typeof games.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type FaOfferRow = typeof faOffers.$inferSelect;
export type DataSourceRow = typeof dataSources.$inferSelect;
export type AwardRow = typeof awards.$inferSelect;
