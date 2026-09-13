CREATE TABLE `eval_seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`season` integer NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`playoff_result` text DEFAULT 'DNQ' NOT NULL,
	`champion_team_id` text,
	`champion_name` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `eval_seasons_idx` ON `eval_seasons` (`evaluation_id`,`season`);--> statement-breakpoint
CREATE TABLE `eval_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`stage` text NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`params` text,
	`decision` text,
	`goals` text,
	`expected` text,
	`risks` text,
	`result_summary` text,
	`ok` integer DEFAULT true NOT NULL,
	`legal` integer,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`error` text,
	`raw_response` text
);
--> statement-breakpoint
CREATE INDEX `eval_turns_idx` ON `eval_turns` (`evaluation_id`,`turn_index`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_save_id` text NOT NULL,
	`save_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text,
	`model` text,
	`api_key_masked` text,
	`api_key_enc` text,
	`team_short_id` text NOT NULL,
	`team_full_id` text NOT NULL,
	`seed` integer NOT NULL,
	`years` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`stage` text DEFAULT 'SEASON' NOT NULL,
	`seasons_done` integer DEFAULT 0 NOT NULL,
	`turn_index` integer DEFAULT 0 NOT NULL,
	`strategy` text,
	`call_count` integer DEFAULT 0 NOT NULL,
	`action_count` integer DEFAULT 0 NOT NULL,
	`legal_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`latency_ms_sum` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`score` text,
	`replay_of` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `eval_created_idx` ON `evaluations` (`created_at`);