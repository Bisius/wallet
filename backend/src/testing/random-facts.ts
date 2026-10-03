/**
 * Valid random `Facts` from a seed, for tests that check the ledger on many shapes of data without
 * a property-testing library. "Valid" means what the API can store: every spending and transfer is
 * inside its budget's active months, each budget has a version in effect at its start month, each
 * subscription a price in effect at its start month, and amounts have the signs the schema allows.
 * Rows are never deleted (docs/DOMAIN.md, "Versioned values"), so some items also carry rows the
 * API leaves behind: older ones, dated before the start month (the start was moved later; the
 * latest of them is the one in effect at the start month), and inert ones, dated after the end
 * month (the item was archived or cancelled with a plan still stored). The same seed always gives
 * the same scenario, so a failure names the seed and can be replayed.
 */
import { type IsoDate, type MonthKey, addMonths, monthRange } from '@wallet/shared';
import type {
  BudgetFact,
  BudgetVersionFact,
  Facts,
  PriceFact,
  SpendingFact,
  SubscriptionFact,
  TransferFact,
} from '../domain/facts';

/** mulberry32: a tiny seeded generator. The floats it makes are only used to pick, never as money. */
export function prng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const chance = (probability: number): boolean => next() < probability;
  return { next, int, pick, chance };
}
export type Prng = ReturnType<typeof prng>;

export interface RandomScenario {
  facts: Facts;
  /** The last month to compute. */
  through: MonthKey;
  today: IsoDate;
}

const NAMES = ['Alpha', 'alpha', 'Beta', 'gamma', 'Étude', 'Delta', 'delta'];

/** `count` distinct months from `months`, in no particular order. */
function distinctMonths(r: Prng, months: readonly MonthKey[], count: number): MonthKey[] {
  const pool = [...months];
  const picked: MonthKey[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(...pool.splice(r.int(0, pool.length - 1), 1));
  }
  return picked;
}

/**
 * The months of one item's version or price rows. A row is in effect at the start month: usually
 * dated at it, sometimes older (a start moved later leaves the older rows where they were), then
 * 0 to `extra` rows inside the active months, and sometimes inert rows after the end month.
 */
function rowMonths(
  r: Prng,
  start: MonthKey,
  end: MonthKey | null,
  through: MonthKey,
  active: readonly MonthKey[],
  extra = 3,
): MonthKey[] {
  const months: MonthKey[] = [];
  if (r.chance(0.25)) {
    // One or two rows older than the start month; the latest of them is in effect at the start.
    const older = distinctMonths(
      r,
      [1, 2, 3, 4, 5].map((back) => addMonths(start, -back)),
      r.int(1, 2),
    );
    months.push(...older);
    if (r.chance(0.3)) months.push(start); // ... and sometimes one at the start month too
  } else {
    months.push(start);
  }
  months.push(
    ...distinctMonths(
      r,
      active.filter((m) => m !== start),
      r.int(0, extra),
    ),
  );
  if (end !== null && r.chance(0.35)) {
    const afterEnd = monthRange(addMonths(end, 1), addMonths(through, 3));
    months.push(...distinctMonths(r, afterEnd, r.int(1, 2)));
  }
  return months;
}

export function randomScenario(seed: number): RandomScenario {
  const r = prng(seed);
  const startMonth = addMonths('2025-01', r.int(0, 23));
  const through = addMonths(startMonth, r.int(0, 30));
  const months = monthRange(startMonth, through);
  const randomMonth = () => r.pick(months);
  const todayMonth = randomMonth();
  const today = `${todayMonth}-${String(r.int(1, 28)).padStart(2, '0')}`;

  // Salary and one-off incomes.
  const salary = distinctMonths(
    r,
    months.filter((m) => m !== startMonth),
    r.int(0, 3),
  ).map((effectiveMonth) => ({ effectiveMonth, amount: r.int(0, 500000) }));
  if (r.chance(0.9)) salary.push({ effectiveMonth: startMonth, amount: r.int(0, 500000) });
  const incomes = Array.from({ length: r.int(0, 6) }, () => ({
    month: randomMonth(),
    amount: r.int(1, 100000),
  }));

  // Budgets, with versions and spendings inside their active months.
  const budgets: BudgetFact[] = [];
  const spendings: SpendingFact[] = [];
  const budgetCount = r.int(0, 5);
  for (let id = 1; id <= budgetCount; id++) {
    const start = randomMonth();
    const end = r.chance(0.4) ? r.pick(monthRange(start, through)) : null;
    const active = monthRange(start, end ?? through);
    const versions: BudgetVersionFact[] = [
      ...rowMonths(r, start, end, through, active).map((effectiveMonth) => ({
        effectiveMonth,
        amount: r.int(0, 60000),
        incremental: r.chance(0.5),
      })),
    ];
    budgets.push({
      id,
      name: `Budget ${id}`,
      color: null,
      icon: null,
      sortOrder: r.pick([0, 10, 20]),
      startMonth: start,
      endMonth: end,
      alertWarnPercent: r.chance(0.2) ? r.int(1, 100) : null,
      versions,
    });
    for (const month of active) {
      for (let k = r.int(0, 2); k > 0; k--) {
        spendings.push({
          budgetId: id,
          month,
          amount: r.chance(0.15) ? -r.int(1, 8000) : r.int(1, 40000),
        });
      }
    }
  }

  // Transfers between active budgets, or between one and the pool.
  const transfers: TransferFact[] = [];
  for (let k = r.int(0, 6); k > 0; k--) {
    const month = randomMonth();
    const active = budgets.filter(
      (b) => b.startMonth <= month && (b.endMonth === null || month <= b.endMonth),
    );
    if (active.length === 0) continue;
    const from = r.pick(active);
    const kind = r.int(0, 2);
    const amount = r.int(1, 15000);
    if (kind === 0) transfers.push({ month, fromBudgetId: null, toBudgetId: from.id, amount });
    else if (kind === 1) transfers.push({ month, fromBudgetId: from.id, toBudgetId: null, amount });
    else {
      const others = active.filter((b) => b.id !== from.id);
      if (others.length > 0) {
        transfers.push({ month, fromBudgetId: from.id, toBudgetId: r.pick(others).id, amount });
      }
    }
  }

  // Subscriptions, monthly and yearly, with price changes inside their active months.
  const subscriptions: SubscriptionFact[] = [];
  const subscriptionCount = r.int(0, 4);
  for (let id = 1; id <= subscriptionCount; id++) {
    const start = randomMonth();
    const end = r.chance(0.4) ? r.pick(monthRange(start, through)) : null;
    const active = monthRange(start, end ?? through);
    const prices: PriceFact[] = rowMonths(r, start, end, through, active, 2).map(
      (effectiveMonth) => ({ effectiveMonth, amount: r.int(100, 30000) }),
    );
    subscriptions.push({
      id,
      name: r.pick(NAMES),
      color: null,
      frequency: r.chance(0.6) ? 'yearly' : 'monthly',
      anchorDate: `2025-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
      startMonth: start,
      endMonth: end,
      prices,
    });
  }

  return {
    facts: {
      startMonth,
      alertWarnPercent: r.pick([50, 80, 90, 100]),
      salary,
      incomes,
      subscriptions,
      budgets,
      spendings,
      transfers,
    },
    through,
    today,
  };
}

/** The same facts with every list in a random order (and the rows of each version/price list too). */
export function shuffledFacts(facts: Facts, seed: number): Facts {
  const r = prng(seed);
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = r.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  };
  return {
    ...facts,
    salary: shuffle(facts.salary),
    incomes: shuffle(facts.incomes),
    subscriptions: shuffle(facts.subscriptions).map((s) => ({ ...s, prices: shuffle(s.prices) })),
    budgets: shuffle(facts.budgets).map((b) => ({ ...b, versions: shuffle(b.versions) })),
    spendings: shuffle(facts.spendings),
    transfers: shuffle(facts.transfers),
  };
}
