CREATE INDEX `idx_current_positions_username` ON `current_positions` (`username`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_occurred_at` ON `trade_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_username_occurred_at` ON `trade_events` (`username`,`occurred_at`);