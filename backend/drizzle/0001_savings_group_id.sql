ALTER TABLE `savings_transactions` ADD `group_id` integer;--> statement-breakpoint
CREATE INDEX `savings_transactions_group_idx` ON `savings_transactions` (`group_id`);