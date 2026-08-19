CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `copy_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`cid` integer NOT NULL,
	`amount` real NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`reference_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `current_positions` (
	`username` text NOT NULL,
	`position_id` text NOT NULL,
	`open_timestamp` text NOT NULL,
	`open_rate` real,
	`instrument_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`is_buy` integer NOT NULL,
	`leverage` real,
	`investment_pct` real,
	`net_profit` real,
	`take_profit_rate` real,
	`stop_loss_rate` real,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`username`, `position_id`)
);
--> statement-breakpoint
CREATE TABLE `tracked_investors` (
	`slot` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`cid` integer NOT NULL,
	`full_name` text NOT NULL,
	`avatar_url` text,
	`risk_score` integer,
	`daily_gain` real,
	`copiers` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_investors_username_unique` ON `tracked_investors` (`username`);--> statement-breakpoint
CREATE TABLE `trade_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`detected_at` text NOT NULL,
	`position_id` text NOT NULL,
	`instrument_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`is_buy` integer NOT NULL,
	`open_rate` real,
	`leverage` real,
	`investment_pct` real,
	`net_profit` real,
	`precision` text NOT NULL,
	`note` text NOT NULL
);
