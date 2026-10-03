/**
 * The ledger's input: every stored fact the month figures are derived from (docs/DOMAIN.md), as
 * plain data. `computeLedger` (ledger.ts) is a pure function of a `Facts` value, so it is tested
 * without a database; `loadFacts` is the only place that reads the database for it.
 *
 * Spendings, incomes and transfers arrive already summed per month (the engine only ever asks for
 * "the total of B in M"), so the input stays small however many rows there are and a test builds it
 * by hand in one line per figure. The engine adds up duplicates, so a month can be given as one
 * entry or as several. Row order never matters.
 */
import type { Cents, IsoDate, MonthKey, SubscriptionFrequency } from '@wallet/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  budgetTransfers,
  budgetVersions,
  budgets,
  incomes,
  salaryChanges,
  settings,
  spendings,
  subscriptionPrices,
  subscriptions,
} from '../db/schema';
import { notOnboarded } from '../lib/errors';

/** The salary from `effectiveMonth` until the next change. */
export interface SalaryChangeFact {
  effectiveMonth: MonthKey;
  amount: Cents;
}

/** One-off income dated in `month` (several entries for a month add up). */
export interface IncomeFact {
  month: MonthKey;
  amount: Cents;
}

/** A subscription's price from `effectiveMonth` until the next price. */
export interface PriceFact {
  effectiveMonth: MonthKey;
  amount: Cents;
}

export interface SubscriptionFact {
  id: number;
  name: string;
  color: string | null;
  frequency: SubscriptionFrequency;
  /** Only its month-of-year matters to the ledger (the renewal month of a yearly subscription). */
  anchorDate: IsoDate;
  startMonth: MonthKey;
  /** Last charged month; null = ongoing. */
  endMonth: MonthKey | null;
  prices: PriceFact[];
}

/** A budget's amount and mode from `effectiveMonth` until the next version. */
export interface BudgetVersionFact {
  effectiveMonth: MonthKey;
  amount: Cents;
  incremental: boolean;
}

export interface BudgetFact {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  startMonth: MonthKey;
  /** Last active month (archived); null = ongoing. */
  endMonth: MonthKey | null;
  /** Overrides `Facts.alertWarnPercent`. */
  alertWarnPercent: number | null;
  versions: BudgetVersionFact[];
}

/** Spendings of one budget dated in `month`, summed (refunds are negative). */
export interface SpendingFact {
  budgetId: number;
  month: MonthKey;
  amount: Cents;
}

/**
 * Money moved in `month` between two budgets, or between a budget and the unallocated pool (the
 * null side). `amount` is positive. At least one side is a budget.
 */
export interface TransferFact {
  month: MonthKey;
  fromBudgetId: number | null;
  toBudgetId: number | null;
  amount: Cents;
}

export interface Facts {
  /** `settings.startMonth`: the first month computed. */
  startMonth: MonthKey;
  /** `settings.alertWarnPercent`: the default warning threshold of a budget. */
  alertWarnPercent: number;
  salary: SalaryChangeFact[];
  incomes: IncomeFact[];
  subscriptions: SubscriptionFact[];
  budgets: BudgetFact[];
  spendings: SpendingFact[];
  transfers: TransferFact[];
}

/** "The month of a date is its first 7 characters" (docs/DOMAIN.md), done in SQL. */
const monthOfColumn = (column: unknown): SQL<string> => sql<string>`substr(${column}, 1, 7)`;
const sumOf = (column: unknown): SQL<number> => sql<number>`sum(${column})`.mapWith(Number);

/** Groups the child rows of `rows` (budget versions, prices) under their parent id. */
function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * Reads every fact in nine queries, however much data there is: the settings row, the history
 * tables read whole (salary, subscriptions and their prices, budgets and their versions), and the
 * dated facts summed per month in SQL (incomes, spendings per budget, transfers per pair), nothing
 * per row. Throws the 409 `not_onboarded` error when the settings do not exist.
 */
export function loadFacts(db: DbOrTx): Facts {
  const config = db
    .select({ startMonth: settings.startMonth, alertWarnPercent: settings.alertWarnPercent })
    .from(settings)
    .limit(1)
    .get();
  if (!config) throw notOnboarded();

  const salary = db
    .select({ effectiveMonth: salaryChanges.effectiveMonth, amount: salaryChanges.amount })
    .from(salaryChanges)
    .all();

  const incomeRows = db
    .select({ month: monthOfColumn(incomes.date), amount: sumOf(incomes.amount) })
    .from(incomes)
    .groupBy(monthOfColumn(incomes.date))
    .all();

  const subscriptionRows = db.select().from(subscriptions).all();
  const pricesBySubscription = groupBy(
    db
      .select({
        subscriptionId: subscriptionPrices.subscriptionId,
        effectiveMonth: subscriptionPrices.effectiveMonth,
        amount: subscriptionPrices.amount,
      })
      .from(subscriptionPrices)
      .all(),
    (row) => row.subscriptionId,
  );

  const budgetRows = db.select().from(budgets).all();
  const versionsByBudget = groupBy(
    db
      .select({
        budgetId: budgetVersions.budgetId,
        effectiveMonth: budgetVersions.effectiveMonth,
        amount: budgetVersions.amount,
        incremental: budgetVersions.incremental,
      })
      .from(budgetVersions)
      .all(),
    (row) => row.budgetId,
  );

  const spendingRows = db
    .select({
      budgetId: spendings.budgetId,
      month: monthOfColumn(spendings.date),
      amount: sumOf(spendings.amount),
    })
    .from(spendings)
    .groupBy(spendings.budgetId, monthOfColumn(spendings.date))
    .all();

  const transferRows = db
    .select({
      month: monthOfColumn(budgetTransfers.date),
      fromBudgetId: budgetTransfers.fromBudgetId,
      toBudgetId: budgetTransfers.toBudgetId,
      amount: sumOf(budgetTransfers.amount),
    })
    .from(budgetTransfers)
    .groupBy(
      monthOfColumn(budgetTransfers.date),
      budgetTransfers.fromBudgetId,
      budgetTransfers.toBudgetId,
    )
    .all();

  return {
    startMonth: config.startMonth,
    alertWarnPercent: config.alertWarnPercent,
    salary,
    incomes: incomeRows,
    subscriptions: subscriptionRows.map((row): SubscriptionFact => ({
      id: row.id,
      name: row.name,
      color: row.color,
      frequency: row.frequency,
      anchorDate: row.anchorDate,
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      prices: (pricesBySubscription.get(row.id) ?? []).map(({ effectiveMonth, amount }) => ({
        effectiveMonth,
        amount,
      })),
    })),
    budgets: budgetRows.map((row): BudgetFact => ({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      sortOrder: row.sortOrder,
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      alertWarnPercent: row.alertWarnPercent,
      versions: (versionsByBudget.get(row.id) ?? []).map(
        ({ effectiveMonth, amount, incremental }) => ({ effectiveMonth, amount, incremental }),
      ),
    })),
    spendings: spendingRows,
    transfers: transferRows,
  };
}
