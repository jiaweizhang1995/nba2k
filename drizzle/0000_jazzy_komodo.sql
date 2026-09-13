CREATE TABLE `awards` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`season` integer NOT NULL,
	`type` text NOT NULL,
	`team_id` text,
	`player_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `awards_save_idx` ON `awards` (`save_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`at` text NOT NULL,
	`context` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_save_idx` ON `chat_messages` (`save_id`);--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text,
	`provider` text NOT NULL,
	`source_url` text,
	`retrieved_at` text,
	`season` integer,
	`license_note` text NOT NULL,
	`status` text NOT NULL,
	`scope` text DEFAULT 'LEAGUE' NOT NULL,
	`records` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ds_save_idx` ON `data_sources` (`save_id`);--> statement-breakpoint
CREATE TABLE `draft_picks` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`year` integer NOT NULL,
	`round` integer NOT NULL,
	`original_team_id` text NOT NULL,
	`holder_team_id` text NOT NULL,
	`status` text DEFAULT 'OWNED' NOT NULL,
	`protection` text,
	`resolved` text
);
--> statement-breakpoint
CREATE INDEX `picks_save_idx` ON `draft_picks` (`save_id`);--> statement-breakpoint
CREATE INDEX `picks_holder_idx` ON `draft_picks` (`save_id`,`holder_team_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`at` text NOT NULL,
	`category` text NOT NULL,
	`god_mode` integer DEFAULT false NOT NULL,
	`actor` text DEFAULT 'USER' NOT NULL,
	`message` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `events_save_idx` ON `events` (`save_id`);--> statement-breakpoint
CREATE INDEX `events_save_at_idx` ON `events` (`save_id`,`at`);--> statement-breakpoint
CREATE TABLE `fa_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`player_id` text NOT NULL,
	`team_id` text NOT NULL,
	`years` integer NOT NULL,
	`avg_salary` real NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `fa_save_idx` ON `fa_offers` (`save_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`date` text NOT NULL,
	`season` integer NOT NULL,
	`type` text NOT NULL,
	`round` text,
	`series_id` text,
	`game_no` integer,
	`home_team_id` text NOT NULL,
	`away_team_id` text NOT NULL,
	`home_score` integer,
	`away_score` integer,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	`box` text
);
--> statement-breakpoint
CREATE INDEX `games_save_date_idx` ON `games` (`save_id`,`date`);--> statement-breakpoint
CREATE INDEX `games_save_season_idx` ON `games` (`save_id`,`season`);--> statement-breakpoint
CREATE TABLE `god_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`at` text NOT NULL,
	`label` text NOT NULL,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `god_snap_save_idx` ON `god_snapshots` (`save_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`name` text NOT NULL,
	`team_id` text,
	`position` text NOT NULL,
	`second_position` text,
	`age` integer NOT NULL,
	`height_cm` integer NOT NULL,
	`weight_kg` integer NOT NULL,
	`draft_year` integer,
	`draft_round` integer,
	`draft_pick` integer,
	`years_pro` integer DEFAULT 0 NOT NULL,
	`ratings` text NOT NULL,
	`season_stats` text NOT NULL,
	`career_stats` text NOT NULL,
	`contract` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`role` text DEFAULT 'ROTATION' NOT NULL,
	`satisfaction` real DEFAULT 70 NOT NULL,
	`injury` text,
	`development` text NOT NULL,
	`tenure` integer DEFAULT 0 NOT NULL,
	`stamina` real DEFAULT 1 NOT NULL,
	`last_game_date` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `players_save_idx` ON `players` (`save_id`);--> statement-breakpoint
CREATE INDEX `players_team_idx` ON `players` (`save_id`,`team_id`);--> statement-breakpoint
CREATE TABLE `saves` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`season` integer NOT NULL,
	`phase` text DEFAULT 'REGULAR_SEASON' NOT NULL,
	`current_date` text NOT NULL,
	`seed` integer NOT NULL,
	`god_mode` integer DEFAULT false NOT NULL,
	`god_op_counter` integer DEFAULT 0 NOT NULL,
	`rule_version` text NOT NULL,
	`rating_version` text NOT NULL,
	`data_provider` text DEFAULT 'DEMO' NOT NULL,
	`data_status` text DEFAULT 'DEMO' NOT NULL,
	`phase_state` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`save_id` text NOT NULL,
	`abbr` text NOT NULL,
	`city` text NOT NULL,
	`name` text NOT NULL,
	`conference` text NOT NULL,
	`division` text NOT NULL,
	`color_primary` text DEFAULT '#38bdf8' NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`playoff_appearances` integer DEFAULT 0 NOT NULL,
	`championships` integer DEFAULT 0 NOT NULL,
	`ai_phase` text DEFAULT 'BUBBLE' NOT NULL,
	`ai_risk` real DEFAULT 0.5 NOT NULL,
	`source` text
);
--> statement-breakpoint
CREATE INDEX `teams_save_idx` ON `teams` (`save_id`);