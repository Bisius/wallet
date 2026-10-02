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
    createdAt: timestamp(),
  },
  (t) => [
    index('savings_transactions_settles_month_idx').on(t.settlesMonth),
    index('savings_transactions_goal_idx').on(t.goalId),
    check('savings_amount_non_zero', sql`${t.amount} <> 0 or ${t.kind} = 'opening'`),
    check(
      'savings_settlement_month',
      sql`(${t.kind} = 'settlement') = (${t.settlesMonth} is not null)`,
    ),
  ],
);
