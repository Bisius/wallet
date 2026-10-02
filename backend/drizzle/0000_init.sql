CREATE TABLE `budget_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`from_budget_id` integer,
	`to_budget_id` integer,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`from_budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "budget_transfer_amount_positive" CHECK("budget_transfers"."amount" > 0),
	CONSTRAINT "budget_transfer_sides" CHECK(("budget_transfers"."from_budget_id" is not null or "budget_transfers"."to_budget_id" is not null) and ("budget_transfers"."from_budget_id" is null or "budget_transfers"."to_budget_id" is null or "budget_transfers"."from_budget_id" <> "budget_transfers"."to_budget_id"))
);
--> statement-breakpoint
CREATE INDEX `budget_transfers_date_idx` ON `budget_transfers` (`date`);--> statement-breakpoint
CREATE TABLE `budget_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`budget_id` integer NOT NULL,
	`effective_month` text NOT NULL,
	`amount` integer NOT NULL,
	`incremental` integer NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budget_amount_non_negative" CHECK("budget_versions"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_versions_budget_month_uq` ON `budget_versions` (`budget_id`,`effective_month`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`alert_warn_percent` integer,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "budget_month_range" CHECK("budgets"."end_month" is null or "budgets"."end_month" >= "budgets"."start_month")
);
--> statement-breakpoint
CREATE TABLE `incomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "income_amount_positive" CHECK("incomes"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `incomes_date_idx` ON `incomes` (`date`);--> statement-breakpoint
CREATE TABLE `salary_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_month` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "salary_amount_non_negative" CHECK("salary_changes"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `salary_changes_effectiveMonth_unique` ON `salary_changes` (`effective_month`);--> statement-breakpoint
CREATE TABLE `savings_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target_amount` integer NOT NULL,
	`deadline` text,
	`color` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "savings_goal_target_positive" CHECK("savings_goals"."target_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `savings_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`kind` text NOT NULL,
	`settles_month` text,
	`goal_id` integer,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `savings_goals`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "savings_amount_non_zero" CHECK("savings_transactions"."amount" <> 0 or "savings_transactions"."kind" = 'opening'),
	CONSTRAINT "savings_settlement_month" CHECK(("savings_transactions"."kind" = 'settlement') = ("savings_transactions"."settles_month" is not null))
);
--> statement-breakpoint
CREATE INDEX `savings_transactions_settles_month_idx` ON `savings_transactions` (`settles_month`);--> statement-breakpoint
CREATE INDEX `savings_transactions_goal_idx` ON `savings_transactions` (`goal_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`start_month` text NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`alert_warn_percent` integer DEFAULT 80 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `spending_tags` (
	`spending_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`spending_id`, `tag_id`),
	FOREIGN KEY (`spending_id`) REFERENCES `spendings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `spending_tags_tag_idx` ON `spending_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `spendings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`budget_id` integer NOT NULL,
	`description` text NOT NULL,
	`notes` text,
	`import_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "spending_amount_non_zero" CHECK("spendings"."amount" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spendings_importHash_unique` ON `spendings` (`import_hash`);--> statement-breakpoint
CREATE INDEX `spendings_date_idx` ON `spendings` (`date`);--> statement-breakpoint
CREATE INDEX `spendings_budget_date_idx` ON `spendings` (`budget_id`,`date`);--> statement-breakpoint
CREATE TABLE `subscription_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`effective_month` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subscription_price_positive" CHECK("subscription_prices"."amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_prices_sub_month_uq` ON `subscription_prices` (`subscription_id`,`effective_month`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`anchor_date` text NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`color` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "subscription_month_range" CHECK("subscriptions"."end_month" is null or "subscriptions"."end_month" >= "subscriptions"."start_month")
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);