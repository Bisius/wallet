/**
 * Database schema. See docs/DOMAIN.md for what every table means.
 *
 * Conventions:
 * - Money columns are integer cents.
 * - Months are 'YYYY-MM' text, dates are 'YYYY-MM-DD' text, timestamps are ISO-8601 UTC text.
 * - Columns are camelCase in TS and snake_case in SQLite (casing: 'snake_case').
 * - Values that change over time (salary, budget amount, subscription price) are stored as
 *   "effective from month" history rows, so editing them never rewrites closed months.
 */
import type { ImportMapping } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const id = () => integer().primaryKey({ autoIncrement: true });
const timestamp = () =>
  text()
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

/** Single-row app configuration (id is always 1). Created by the onboarding flow. */
export const settings = sqliteTable(
  'settings',
  {
    id: integer().primaryKey(),
    currency: text().notNull().default('EUR'),
    locale: text().notNull().default('en-US'),
    /** First month the app tracks. Nothing before it is computed or accepted. */
    startMonth: text().notNull(),
    theme: text({ enum: ['system', 'light', 'dark'] })
      .notNull()
      .default('system'),
    /** Budgets show a warning once this % of their available amount is spent. */
    alertWarnPercent: integer().notNull().default(80),
    updatedAt: timestamp(),
  },
  (t) => [check('settings_singleton', sql`${t.id} = 1`)],
);

/** Net monthly salary, effective from a month until the next change. */
export const salaryChanges = sqliteTable(
  'salary_changes',
  {
    id: id(),
    effectiveMonth: text().notNull().unique(),
    amount: integer().notNull(),
    createdAt: timestamp(),
  },
  (t) => [check('salary_amount_non_negative', sql`${t.amount} >= 0`)],
);

/** One-off income (bonus, refund, gift, side job) counted in the month of its date. */
export const incomes = sqliteTable(
  'incomes',
  {
    id: id(),
    date: text().notNull(),
    amount: integer().notNull(),
    description: text().notNull(),
    createdAt: timestamp(),
  },
  (t) => [
    index('incomes_date_idx').on(t.date),
    check('income_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Recurring fixed cost, paid "off the top" of income before budgets. */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: id(),
    name: text().notNull(),
    frequency: text({ enum: ['monthly', 'yearly'] }).notNull(),
    /** A real charge date; day (and month, for yearly) define the billing schedule. */
    anchorDate: text().notNull(),
    /** First month the subscription affects the plan. */
    startMonth: text().notNull(),
    /** Last month it is active (cancelled). Null = ongoing. */
    endMonth: text(),
    color: text(),
    notes: text(),
    createdAt: timestamp(),
  },
  (t) => [
    check(
      'subscription_month_range',
      sql`${t.endMonth} is null or ${t.endMonth} >= ${t.startMonth}`,
    ),
  ],
);

/** Subscription price history. Price for month M = latest row with effectiveMonth <= M. */
export const subscriptionPrices = sqliteTable(
  'subscription_prices',
  {
    id: id(),
    subscriptionId: integer()
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    effectiveMonth: text().notNull(),
    amount: integer().notNull(),
  },
  (t) => [
    uniqueIndex('subscription_prices_sub_month_uq').on(t.subscriptionId, t.effectiveMonth),
    check('subscription_price_positive', sql`${t.amount} > 0`),
  ],
);

/** A slice of income reserved each month for one activity (groceries, fuel, fun, ...). */
export const budgets = sqliteTable(
  'budgets',
  {
    id: id(),
    name: text().notNull(),
    color: text(),
    icon: text(),
    sortOrder: integer().notNull().default(0),
    /** First month the budget receives an allocation. */
    startMonth: text().notNull(),
    /** Last active month (archived). Its whole balance is released to savings when that month closes. */
    endMonth: text(),
    /** Overrides settings.alertWarnPercent for this budget. */
    alertWarnPercent: integer(),
    notes: text(),
    createdAt: timestamp(),
  },
  (t) => [
    check('budget_month_range', sql`${t.endMonth} is null or ${t.endMonth} >= ${t.startMonth}`),
  ],
);

/** Budget amount + rollover mode history. Version for month M = latest row with effectiveMonth <= M. */
export const budgetVersions = sqliteTable(
  'budget_versions',
  {
    id: id(),
    budgetId: integer()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    effectiveMonth: text().notNull(),
    amount: integer().notNull(),
    /** true: leftover (or deficit) carries into next month. false: settled with savings at month end. */
    incremental: integer({ mode: 'boolean' }).notNull(),
  },
  (t) => [
    uniqueIndex('budget_versions_budget_month_uq').on(t.budgetId, t.effectiveMonth),
    check('budget_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

/** Moves money between two budgets, or between a budget and the month's unallocated pool (null side). */
export const budgetTransfers = sqliteTable(
  'budget_transfers',
  {
    id: id(),
    date: text().notNull(),
    fromBudgetId: integer().references(() => budgets.id, { onDelete: 'restrict' }),
    toBudgetId: integer().references(() => budgets.id, { onDelete: 'restrict' }),
    amount: integer().notNull(),
    note: text(),
    createdAt: timestamp(),
  },
  (t) => [
    index('budget_transfers_date_idx').on(t.date),
    check('budget_transfer_amount_positive', sql`${t.amount} > 0`),
    check(
      'budget_transfer_sides',
      sql`(${t.fromBudgetId} is not null or ${t.toBudgetId} is not null) and (${t.fromBudgetId} is null or ${t.toBudgetId} is null or ${t.fromBudgetId} <> ${t.toBudgetId})`,
    ),
  ],
);

/** An expense taken from a budget. Negative amount = refund back into the budget. */
export const spendings = sqliteTable(
  'spendings',
  {
    id: id(),
    date: text().notNull(),
    amount: integer().notNull(),
    budgetId: integer()
      .notNull()
      .references(() => budgets.id, { onDelete: 'restrict' }),
    description: text().notNull(),
    notes: text(),
    /** Set for rows created by CSV import; prevents importing the same bank row twice. */
    importHash: text().unique(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  (t) => [
    index('spendings_date_idx').on(t.date),
    index('spendings_budget_date_idx').on(t.budgetId, t.date),
    check('spending_amount_non_zero', sql`${t.amount} <> 0`),
  ],
);

export const tags = sqliteTable('tags', {
  id: id(),
  name: text().notNull().unique(),
  color: text(),
});

export const spendingTags = sqliteTable(
  'spending_tags',
  {
    spendingId: integer()
      .notNull()
      .references(() => spendings.id, { onDelete: 'cascade' }),
    tagId: integer()
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.spendingId, t.tagId] }),
    index('spending_tags_tag_idx').on(t.tagId),
  ],
);

export const savingsGoals = sqliteTable(
  'savings_goals',
  {
    id: id(),
    name: text().notNull(),
    targetAmount: integer().notNull(),
    deadline: text(),
    color: text(),
    archivedAt: text(),
    createdAt: timestamp(),
  },
  (t) => [check('savings_goal_target_positive', sql`${t.targetAmount} > 0`)],
);

/**
 * Money actually moved into (+) or out of (-) savings. The savings balance is the sum of all rows;
 * a goal's balance is the sum of rows with its goalId (null = unassigned savings).
 */
export const savingsTransactions = sqliteTable(
  'savings_transactions',
  {
    id: id(),
    date: text().notNull(),
    amount: integer().notNull(),
    kind: text({
      enum: ['opening', 'settlement', 'deposit', 'withdrawal', 'reallocation'],
    }).notNull(),
    /** For kind = 'settlement': the closed month whose "move to savings" amount this settles. */
    settlesMonth: text(),
    goalId: integer().references(() => savingsGoals.id, { onDelete: 'set null' }),
    note: text(),
    /**
     * Ties the two rows of a reallocation together: both carry the id of the first (negative) row.
     * Null for every other kind. No foreign key, the number only has to be shared.
     */
    groupId: integer(),
    createdAt: timestamp(),
  },
  (t) => [
    index('savings_transactions_settles_month_idx').on(t.settlesMonth),
    index('savings_transactions_goal_idx').on(t.goalId),
    index('savings_transactions_group_idx').on(t.groupId),
    check('savings_amount_non_zero', sql`${t.amount} <> 0 or ${t.kind} = 'opening'`),
    check(
      'savings_settlement_month',
      sql`(${t.kind} = 'settlement') = (${t.settlesMonth} is not null)`,
    ),
  ],
);

/**
 * A saved CSV import mapping, one per bank, so that the next file of that bank needs no
 * remapping (docs/DOMAIN.md, "CSV import"). It holds no money and no spending refers to it.
 */
export const importProfiles = sqliteTable('import_profiles', {
  id: id(),
  /**
   * Unique ignoring case under the shared name collator (`lib/names.ts`), like a tag name. SQLite's
   * unique index is case-sensitive, so the service checks the rule itself and the index is only a
   * backstop.
   */
  name: text().notNull().unique(),
  /** An `ImportMapping` as JSON text, validated with `importMappingSchema` on every write. */
  mapping: text({ mode: 'json' }).$type<ImportMapping>().notNull(),
  /**
   * The normalized header cells of the file the mapping was made from, as a JSON array of text, or
   * null. `POST /api/import/parse` suggests a profile whose cells at the three mapped columns equal
   * the file's. Always null when `mapping.hasHeader` is false.
   */
  headerSignature: text({ mode: 'json' }).$type<string[]>(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

// --- The Telegram bot (docs/DOMAIN.md, "Telegram bot"; migration 0003_telegram) -------------------
//
// None of these tables holds a fact: they are in no ledger figure, no export and no check of
// `start_month_after_facts` (`earliestFactMonth` reads the fact tables by name). They ARE in the
// backups, which copy the whole database file, so a restore brings the link and the preferences
// back. There is no "delete all my data" feature today; if one is ever added it must clear
// `telegram_entries` and `telegram_notifications` (they describe the deleted facts) and keep the
// link and the preferences (they belong to the install, not to its data).

/** The linked Telegram account: one row at most (id is always 1). */
export const telegramLink = sqliteTable(
  'telegram_link',
  {
    id: integer().primaryKey(),
    /** Telegram's id of the account. The only sender the bot answers. A safe JS integer (52 bits). */
    userId: integer().notNull(),
    /** Where everything the bot sends goes: the private chat with that account. */
    chatId: integer().notNull(),
    firstName: text().notNull(),
    /** Without the `@`. An account may have none. */
    username: text(),
    linkedAt: timestamp(),
  },
  (t) => [check('telegram_link_singleton', sql`${t.id} = 1`)],
);

/** The pending pairing code: one row at most (id is always 1), while a code is open. */
export const telegramPairing = sqliteTable(
  'telegram_pairing',
  {
    id: integer().primaryKey(),
    /** 8 characters from an alphabet without 0, O, 1 and I. */
    code: text().notNull(),
    /** ISO-8601 UTC instant, 10 minutes after the code was made. */
    expiresAt: text().notNull(),
    /** Wrong codes tried since this one was made, from any sender. At 5 the row is deleted. */
    failedAttempts: integer().notNull().default(0),
  },
  (t) => [
    check('telegram_pairing_singleton', sql`${t.id} = 1`),
    check('telegram_pairing_attempts', sql`${t.failedAttempts} >= 0`),
  ],
);

/**
 * The notification preferences: one row at most (id is always 1). The row is created by the first
 * `PUT /api/telegram/notifications`; until then the preferences read as
 * `DEFAULT_TELEGRAM_NOTIFICATIONS`, so the defaults live in one place (the shared contract) and not
 * in SQL. Unlinking keeps it. It lives apart from `settings` because `PUT /api/settings` replaces
 * exactly five fields.
 */
export const telegramSettings = sqliteTable(
  'telegram_settings',
  {
    id: integer().primaryKey(),
    budgetAlerts: integer({ mode: 'boolean' }).notNull(),
    renewalYearlyDays: integer().notNull(),
    renewalMonthlyDays: integer().notNull(),
    monthlyRecap: integer({ mode: 'boolean' }).notNull(),
    /** `HH:MM`, 24-hour, server time zone. */
    notifyAt: text().notNull(),
  },
  (t) => [
    check('telegram_settings_singleton', sql`${t.id} = 1`),
    check(
      'telegram_settings_days',
      sql`${t.renewalYearlyDays} between 0 and 30 and ${t.renewalMonthlyDays} between 0 and 30`,
    ),
  ],
);

/**
 * What the bot created, for `/undo`: one row per spending or income it stored. Exactly one of the
 * two ids is set, and deleting the spending or the income (from anywhere) deletes its row.
 */
export const telegramEntries = sqliteTable(
  'telegram_entries',
  {
    id: id(),
    spendingId: integer().references(() => spendings.id, { onDelete: 'cascade' }),
    incomeId: integer().references(() => incomes.id, { onDelete: 'cascade' }),
    createdAt: timestamp(),
  },
  (t) => [
    // A row is made once per spending or income (SQLite lets several NULLs through a unique index).
    uniqueIndex('telegram_entries_spending_uq').on(t.spendingId),
    uniqueIndex('telegram_entries_income_uq').on(t.incomeId),
    check('telegram_entries_one_target', sql`(${t.spendingId} is null) <> (${t.incomeId} is null)`),
  ],
);

/**
 * The dedupe log of the notifications. A row is written after Telegram accepted the message (or by
 * the baseline, which sends nothing), so a failed send is retried and a sent one never repeated.
 * Keys: `<month>:<budgetId>` for `budget_alert` (value: the highest level notified), and
 * `<subscriptionId>:<billingDate>` for `renewal`, and the month recapped for `recap`.
 */
export const telegramNotifications = sqliteTable(
  'telegram_notifications',
  {
    id: id(),
    kind: text({ enum: ['budget_alert', 'renewal', 'recap'] }).notNull(),
    key: text().notNull(),
    value: text(),
    sentAt: timestamp(),
  },
  (t) => [uniqueIndex('telegram_notifications_kind_key_uq').on(t.kind, t.key)],
);
