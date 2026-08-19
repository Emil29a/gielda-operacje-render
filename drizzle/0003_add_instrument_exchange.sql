ALTER TABLE `current_positions` ADD `exchange_id` integer;--> statement-breakpoint
ALTER TABLE `current_positions` ADD `exchange_name` text;--> statement-breakpoint
ALTER TABLE `trade_events` ADD `exchange_id` integer;--> statement-breakpoint
ALTER TABLE `trade_events` ADD `exchange_name` text;
