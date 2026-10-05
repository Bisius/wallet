CREATE TABLE `telegram_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`spending_id` integer,
	`income_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`spending_id`) REFERENCES `spendings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`income_id`) REFERENCES `incomes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "telegram_entries_one_target" CHECK(("telegram_entries"."spending_id" is null) <> ("telegram_entries"."income_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_entries_spending_uq` ON `telegram_entries` (`spending_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_entries_income_uq` ON `telegram_entries` (`income_id`);--> statement-breakpoint
CREATE TABLE `telegram_link` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`username` text,
	`linked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "telegram_link_singleton" CHECK("telegram_link"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `telegram_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`sent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_notifications_kind_key_uq` ON `telegram_notifications` (`kind`,`key`);--> statement-breakpoint
CREATE TABLE `telegram_pairing` (
	`id` integer PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`expires_at` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "telegram_pairing_singleton" CHECK("telegram_pairing"."id" = 1),
	CONSTRAINT "telegram_pairing_attempts" CHECK("telegram_pairing"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `telegram_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`budget_alerts` integer NOT NULL,
	`renewal_yearly_days` integer NOT NULL,
	`renewal_monthly_days` integer NOT NULL,
	`monthly_recap` integer NOT NULL,
	`notify_at` text NOT NULL,
	CONSTRAINT "telegram_settings_singleton" CHECK("telegram_settings"."id" = 1),
	CONSTRAINT "telegram_settings_days" CHECK("telegram_settings"."renewal_yearly_days" between 0 and 30 and "telegram_settings"."renewal_monthly_days" between 0 and 30)
);
