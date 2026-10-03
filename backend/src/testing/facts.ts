/**
 * Builders for hand-written `Facts`, so an engine test reads as the example it describes. Everything
 * has a default except the amounts, which a test always states.
 */
import type { Cents, IsoDate, MonthKey, SubscriptionFrequency } from '@wallet/shared';
import type {
  BudgetFact,
  Facts,
  IncomeFact,
  SpendingFact,
  SubscriptionFact,
  TransferFact,
} from '../domain/facts';
import { type Ledger, type LedgerMonth, computeLedger } from '../domain/ledger';

/** Facts with nothing in them, starting in 2026-01 with the default 80% warning threshold. */
export function makeFacts(overrides: Partial<Facts> = {}): Facts {
  return {
    startMonth: '2026-01',
    alertWarnPercent: 80,
    salary: [],
    incomes: [],
    subscriptions: [],
    budgets: [],
    spendings: [],
    transfers: [],
    ...overrides,
  };
}

/** A salary that applies from `month` (and the changes after it). */
export const salary = (month: MonthKey, amount: Cents) => ({ effectiveMonth: month, amount });

export interface BudgetOpts {
  name?: string;
  amount: Cents;
  incremental?: boolean;
  /** First active month (default 2026-01). */
  start?: MonthKey;
  /** Last active month (archived); omitted = ongoing. */
  end?: MonthKey | null;
  /** Later versions as `[effectiveMonth, amount, incremental?]` (the mode defaults to the first version's). */
  changes?: [MonthKey, Cents, boolean?][];
  sortOrder?: number;
  /** The budget's own warning threshold. */
  warn?: number | null;
  color?: string | null;
  icon?: string | null;
}

export function budgetFact(id: number, opts: BudgetOpts): BudgetFact {
  const start = opts.start ?? '2026-01';
  const incremental = opts.incremental ?? false;
  return {
    id,
    name: opts.name ?? `Budget ${id}`,
    color: opts.color ?? null,
    icon: opts.icon ?? null,
    sortOrder: opts.sortOrder ?? id * 10,
    startMonth: start,
    endMonth: opts.end ?? null,
    alertWarnPercent: opts.warn ?? null,
    versions: [
      { effectiveMonth: start, amount: opts.amount, incremental },
      ...(opts.changes ?? []).map(([effectiveMonth, amount, mode]) => ({
        effectiveMonth,
        amount,
        incremental: mode ?? incremental,
      })),
    ],
  };
}

export interface SubscriptionOpts {
  name?: string;
  frequency?: SubscriptionFrequency;
  /** Its month is the renewal month of a yearly subscription (default 2026-03-15). */
  anchor?: IsoDate;
  /** The first price: per month for monthly, per year for yearly. */
  price: Cents;
  start?: MonthKey;
  end?: MonthKey | null;
  /** Later prices as `[effectiveMonth, amount]`. */
  priceChanges?: [MonthKey, Cents][];
  color?: string | null;
}

export function subscriptionFact(id: number, opts: SubscriptionOpts): SubscriptionFact {
  const start = opts.start ?? '2026-01';
  return {
    id,
    name: opts.name ?? `Subscription ${id}`,
    color: opts.color ?? null,
    frequency: opts.frequency ?? 'monthly',
    anchorDate: opts.anchor ?? '2026-03-15',
    startMonth: start,
    endMonth: opts.end ?? null,
    prices: [
      { effectiveMonth: start, amount: opts.price },
      ...(opts.priceChanges ?? []).map(([effectiveMonth, amount]) => ({ effectiveMonth, amount })),
    ],
  };
}

export const spending = (budgetId: number, month: MonthKey, amount: Cents): SpendingFact => ({
  budgetId,
  month,
  amount,
});

export const income = (month: MonthKey, amount: Cents): IncomeFact => ({ month, amount });

/** A transfer of `amount` in `month`; `null` is the unallocated pool. */
export const transfer = (
  month: MonthKey,
  fromBudgetId: number | null,
  toBudgetId: number | null,
  amount: Cents,
): TransferFact => ({ month, fromBudgetId, toBudgetId, amount });

/** The default "today" of engine tests: far enough along that the early months are closed. */
export const TODAY = '2026-06-15';

export function run(facts: Facts, through: MonthKey, today: IsoDate = TODAY): Ledger {
  return computeLedger(facts, through, today);
}

/** The row of `month`; fails the test if the ledger does not have it. */
export function monthOf(ledger: Ledger, month: MonthKey): LedgerMonth {
  const row = ledger.months.find((m) => m.month === month);
  if (!row) throw new Error(`no row for ${month} in ${ledger.startMonth}..${ledger.throughMonth}`);
  return row;
}

/** One budget's line in `month`; fails the test if it has none. */
export function budgetLineOf(ledger: Ledger, month: MonthKey, budgetId: number) {
  const line = monthOf(ledger, month).budgets.find((b) => b.id === budgetId);
  if (!line) throw new Error(`budget ${budgetId} has no line in ${month}`);
  return line;
}

/** One subscription's line in `month`; fails the test if it has none. */
export function subscriptionLineOf(ledger: Ledger, month: MonthKey, subscriptionId: number) {
  const line = monthOf(ledger, month).subscriptions.find((s) => s.id === subscriptionId);
  if (!line) throw new Error(`subscription ${subscriptionId} has no line in ${month}`);
  return line;
}

/** A budget's figure in every month it is active, as `[month, value]` pairs. */
export function budgetSeries<K extends keyof LedgerMonth['budgets'][number]>(
  ledger: Ledger,
  budgetId: number,
  field: K,
): [MonthKey, LedgerMonth['budgets'][number][K]][] {
  return ledger.months.flatMap((m) => {
    const line = m.budgets.find((b) => b.id === budgetId);
    return line ? [[m.month, line[field]] as [MonthKey, LedgerMonth['budgets'][number][K]]] : [];
  });
}

/** A subscription's figure in every month it is active, as `[month, value]` pairs. */
export function subscriptionSeries<K extends keyof LedgerMonth['subscriptions'][number]>(
  ledger: Ledger,
  subscriptionId: number,
  field: K,
): [MonthKey, LedgerMonth['subscriptions'][number][K]][] {
  return ledger.months.flatMap((m) => {
    const line = m.subscriptions.find((s) => s.id === subscriptionId);
    return line
      ? [[m.month, line[field]] as [MonthKey, LedgerMonth['subscriptions'][number][K]]]
      : [];
  });
}
