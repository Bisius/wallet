/**
 * fast-check generators of realistic ledger scenarios for the property tests.
 *
 * Shape of the design: fast-check generates only RAW SELECTORS (small integers, booleans, short
 * lists of them), and `buildScenario` maps them into valid facts with modular arithmetic ("the
 * month is the start plus selector mod length"). The facts are therefore valid by construction
 * (every spending inside its budget's active months, every price row where the API could have
 * stored it, ...) and shrinking is effective: all selectors shrink to 0, which is the simplest
 * scenario, and lists shrink by dropping entries. The counterexample fast-check prints is the
 * built scenario, i.e. plain facts.
 *
 * "Valid" means what the API can store (docs/DOMAIN.md, "Editing rules" and "Versioned values"),
 * and the generator covers what real data looks like and what breaks engines:
 *  - a start month anywhere in a few years, a timeline of 1 to `maxMonths` months, and a `today`
 *    anywhere in it (or after it), so closed, current and future months all occur;
 *  - a salary history (sometimes with no row at the start month), one-off incomes;
 *  - budgets, incremental or not, starting mid-timeline, with amount and mode changes, archived
 *    (an end month) or not, with regular and one-off spendings (refunds, overspending, amounts
 *    right at the warning threshold and at the available amount), and with version rows older
 *    than the start month or after the end month, which the API leaves behind;
 *  - monthly and yearly subscriptions: anchors on every month of the year and on days 29 to 31,
 *    price changes (also in the renewal month and the month before it), end months in every
 *    position relative to the renewal (before, on and after it), names that collide ignoring case;
 *  - transfers between budgets and the pool, both sides active;
 *  - on request, "junk" the engine must ignore (spendings outside the active months or for an
 *    unknown budget, transfers naming an inactive budget, to itself, or pool to pool).
 */
import fc from 'fast-check';
import type {
  BudgetFact,
  BudgetVersionFact,
  Facts,
  PriceFact,
  SalaryChangeFact,
  SpendingFact,
  SubscriptionFact,
  TransferFact,
} from '../domain/facts';
import { daysInMonth, monthIndex, monthKey } from './prop-model';

// -------------------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------------------

/** Facts the ledger must ignore ("shown nowhere"). Kept apart so a test can add them or not. */
export interface JunkFacts {
  spendings: SpendingFact[];
  transfers: TransferFact[];
}

export interface Scenario {
  facts: Facts;
  /** The last month to compute. */
  through: string;
  /** `YYYY-MM-DD`. */
  today: string;
  junk: JunkFacts;
}

/** The facts with the junk added. */
export function withJunk(scenario: Scenario): Facts {
  return {
    ...scenario.facts,
    spendings: [...scenario.facts.spendings, ...scenario.junk.spendings],
    transfers: [...scenario.facts.transfers, ...scenario.junk.transfers],
  };
}

export interface GenOptions {
  /** Version and price rows older than the item's start month (a start moved later leaves them). */
  olderRows: boolean;
  /** Version and price rows after the item's end month (an archive or a cancel leaves them). */
  inertRows: boolean;
  /** Give each budget and subscription the id the API would (1, 2, ... in creation order). */
  sequentialIds: boolean;
  /** The longest timeline, in months. */
  maxMonths: number;
  maxBudgets: number;
  maxSubscriptions: number;
}

export const DEFAULT_OPTIONS: GenOptions = {
  olderRows: true,
  inertRows: true,
  sequentialIds: false,
  maxMonths: 40,
  maxBudgets: 5,
  maxSubscriptions: 5,
};

// -------------------------------------------------------------------------------------------------
// Raw selectors
// -------------------------------------------------------------------------------------------------

/** A selector, mapped into a range by `within`. */
const sel = fc.integer({ min: 0, max: 9_999 });

/** `raw` mapped into `low..high` (inclusive), 0 giving `low`. */
export const within = (raw: number, low: number, high: number): number =>
  low + (raw % (high - low + 1));

/** Cents, at least 1: mostly small and medium, sometimes large, rarely huge (50 million). */
const cents: fc.Arbitrary<number> = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 5_000 }) },
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 200_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 5_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 5_000_000_000 }) },
);

/** Cents, 0 in one case of ten (an allocation or a salary of nothing is allowed). */
const centsOrZero: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 9, arbitrary: cents },
);

interface RawRow {
  at: number;
  amount: number;
  incremental: boolean;
  /** How the amount of a price relates to the first one: 0 absolute, 1 to 3 a fraction of it. */
  scale: number;
  /** Where a price change goes relative to the renewal month (yearly only). */
  place: number;
}
const rawRow: fc.Arbitrary<RawRow> = fc.record({
  at: sel,
  amount: centsOrZero,
  incremental: fc.boolean(),
  scale: fc.integer({ min: 0, max: 3 }),
  place: fc.integer({ min: 0, max: 3 }),
});

interface RawSpending {
  at: number;
  kind: number;
  a: number;
  b: number;
}
const rawSpending: fc.Arbitrary<RawSpending> = fc.record({
  at: sel,
  kind: fc.integer({ min: 0, max: 5 }),
  a: sel,
  b: sel,
});

interface RawBudget {
  id: number;
  sort: number;
  startAt: number;
  endKind: number;
  endAt: number;
  warn: number | null;
  first: RawRow;
  versions: RawRow[];
  older: RawRow[];
  olderOnly: boolean;
  inert: RawRow[];
  /** Spend this percentage of the allocation every month, or not at all. */
  habit: number | null;
  spendings: RawSpending[];
}
const rawBudget = (opts: GenOptions): fc.Arbitrary<RawBudget> =>
  fc.record({
    id: fc.integer({ min: 0, max: 40 }),
    // Few distinct values, so that sort orders tie and the id breaks the tie.
    sort: fc.integer({ min: 0, max: 3 }),
    startAt: sel,
    endKind: fc.integer({ min: 0, max: 9 }),
    endAt: sel,
    warn: fc.oneof(
      { weight: 7, arbitrary: fc.constant(null) },
      { weight: 3, arbitrary: fc.integer({ min: 1, max: 100 }) },
    ),
    first: rawRow,
    versions: fc.array(rawRow, { maxLength: 3 }),
    older: fc.array(rawRow, { maxLength: opts.olderRows ? 2 : 0 }),
    olderOnly: fc.boolean(),
    inert: fc.array(rawRow, { maxLength: opts.inertRows ? 2 : 0 }),
    habit: fc.oneof(
      { weight: 6, arbitrary: fc.constant(null) },
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 160 }) },
    ),
    spendings: fc.oneof(
      { weight: 3, arbitrary: fc.constant<RawSpending[]>([]) },
      { weight: 7, arbitrary: fc.array(rawSpending, { maxLength: 16 }) },
    ),
  });

interface RawSubscription {
  id: number;
  name: number;
  yearly: boolean;
  anchorMonth: number;
  anchorDay: number;
  anchorYear: number;
  startAt: number;
  endKind: number;
  endPlace: number;
  endAt: number;
  first: RawRow;
  changes: RawRow[];
  older: RawRow[];
  olderOnly: boolean;
  inert: RawRow[];
}
const rawSubscription = (opts: GenOptions): fc.Arbitrary<RawSubscription> =>
  fc.record({
    id: fc.integer({ min: 0, max: 40 }),
    name: fc.integer({ min: 0, max: 8 }),
    yearly: fc.boolean(),
    anchorMonth: sel,
    anchorDay: sel,
    anchorYear: sel,
    startAt: sel,
    endKind: fc.integer({ min: 0, max: 9 }),
    endPlace: fc.integer({ min: 0, max: 4 }),
    endAt: sel,
    first: rawRow,
    changes: fc.array(rawRow, { maxLength: 3 }),
    older: fc.array(rawRow, { maxLength: opts.olderRows ? 2 : 0 }),
    olderOnly: fc.boolean(),
    inert: fc.array(rawRow, { maxLength: opts.inertRows ? 2 : 0 }),
  });

interface RawTransfer {
  at: number;
  kind: number;
  a: number;
  b: number;
  amount: number;
}
const rawTransfer: fc.Arbitrary<RawTransfer> = fc.record({
  at: sel,
  kind: fc.integer({ min: 0, max: 2 }),
  a: sel,
  b: sel,
  amount: cents,
});

interface RawJunk {
  kind: number;
  at: number;
  a: number;
  amount: number;
}
const rawJunk: fc.Arbitrary<RawJunk> = fc.record({
  kind: fc.integer({ min: 0, max: 5 }),
  at: sel,
  a: sel,
  amount: cents,
});

interface RawScenario {
  startYear: number;
  startMonthOfYear: number;
  length: number;
  todayAt: number;
  todayDay: number;
  warnDefault: number;
  firstSalary: number | null;
  salaries: { at: number; amount: number }[];
  incomes: { at: number; amount: number }[];
  budgets: RawBudget[];
  subscriptions: RawSubscription[];
  transfers: RawTransfer[];
  junk: RawJunk[];
}

const rawScenario = (opts: GenOptions): fc.Arbitrary<RawScenario> =>
  fc.record({
    startYear: fc.integer({ min: 2023, max: 2028 }),
    startMonthOfYear: fc.integer({ min: 1, max: 12 }),
    length: fc.integer({ min: 1, max: opts.maxMonths }),
    todayAt: sel,
    todayDay: sel,
    warnDefault: fc.oneof(
      { weight: 3, arbitrary: fc.constant(80) },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 100 }) },
    ),
    firstSalary: fc.option(centsOrZero, { nil: null, freq: 9 }),
    salaries: fc.array(fc.record({ at: sel, amount: centsOrZero }), { maxLength: 4 }),
    incomes: fc.array(fc.record({ at: sel, amount: cents }), { maxLength: 8 }),
    budgets: fc.array(rawBudget(opts), { maxLength: opts.maxBudgets }),
    subscriptions: fc.array(rawSubscription(opts), { maxLength: opts.maxSubscriptions }),
    transfers: fc.array(rawTransfer, { maxLength: 8 }),
    junk: fc.array(rawJunk, { maxLength: 4 }),
  });

// -------------------------------------------------------------------------------------------------
// Building facts from selectors
// -------------------------------------------------------------------------------------------------

const SUBSCRIPTION_NAMES = [
  'Alpha',
  'alpha',
  'ALPHA',
  'Beta',
  'beta',
  'Gamma',
  'Zeta 1',
  'zeta 1',
  'delta',
];
/** Billing days worth trying: the first, a middle one, and the awkward end of the month. */
const ANCHOR_DAYS = [1, 2, 15, 28, 29, 30, 31];

/** A hex colour that is unique per item, so a test can follow an item whatever its id becomes. */
const tag = (serial: number): string => `#${(0x100000 + serial).toString(16)}`;

/** The row of `rows` in effect at `month` (index), by the same rule as the doc: latest not after it. */
function effective<T extends { effectiveMonth: string }>(rows: readonly T[], month: number) {
  let best: T | undefined;
  for (const row of rows) {
    const at = monthIndex(row.effectiveMonth);
    if (at <= month && (best === undefined || at > monthIndex(best.effectiveMonth))) best = row;
  }
  return best;
}

/**
 * Distinct months from selectors, each mapped into `low..high`, with the index of the selector each
 * came from; a selector is dropped when the range is empty or full.
 */
function distinctMonths(
  raws: readonly number[],
  low: number,
  high: number,
  taken: Set<number>,
): { month: number; index: number }[] {
  const months: { month: number; index: number }[] = [];
  if (high < low) return months;
  raws.forEach((raw, index) => {
    let month = within(raw, low, high);
    // Walk forward to a free month, so every selector gives a row unless the range is full.
    for (let tries = 0; tries <= high - low && taken.has(month); tries++) {
      month = month === high ? low : month + 1;
    }
    if (taken.has(month)) return;
    taken.add(month);
    months.push({ month, index });
  });
  return months;
}

/** What the older rows of an item are: months before its start, not before the ledger start. */
function olderMonths(rows: readonly RawRow[], start: number, ledgerStart: number) {
  if (start <= ledgerStart) return [];
  return distinctMonths(
    rows.map((r) => r.at),
    ledgerStart,
    start - 1,
    new Set(),
  );
}

/** Build a scenario from raw selectors. Pure and total: every selector gives valid facts. */
function buildScenario(raw: RawScenario, opts: GenOptions): Scenario {
  const ledgerStart = raw.startYear * 12 + (raw.startMonthOfYear - 1);
  const last = ledgerStart + raw.length - 1;
  const mk = monthKey;
  let serial = 0;

  // --- today: in the timeline, or the month after it (then every month is closed) ---------------
  const todayMonth = ledgerStart + within(raw.todayAt, 0, raw.length);
  const todayYear = Math.floor(todayMonth / 12);
  const todayMonthOfYear = (todayMonth % 12) + 1;
  const today = `${mk(todayMonth)}-${String(
    within(raw.todayDay, 1, daysInMonth(todayYear, todayMonthOfYear)),
  ).padStart(2, '0')}`;

  // --- income -------------------------------------------------------------------------------------
  const salary: SalaryChangeFact[] = [];
  const salaryTaken = new Set<number>();
  if (raw.firstSalary !== null) {
    salary.push({ effectiveMonth: mk(ledgerStart), amount: raw.firstSalary });
    salaryTaken.add(ledgerStart);
  }
  const salaryMonths = distinctMonths(
    raw.salaries.map((s) => s.at),
    ledgerStart,
    last,
    salaryTaken,
  );
  salaryMonths.forEach(({ month, index }) =>
    salary.push({ effectiveMonth: mk(month), amount: raw.salaries[index]!.amount }),
  );
  const incomes = raw.incomes.map((i) => ({
    month: mk(ledgerStart + within(i.at, 0, raw.length - 1)),
    amount: i.amount,
  }));

  // --- budgets ------------------------------------------------------------------------------------
  const budgets: BudgetFact[] = [];
  const spendings: SpendingFact[] = [];
  const usedBudgetIds = new Set<number>();
  raw.budgets.forEach((b, index) => {
    const id = opts.sequentialIds ? index + 1 : freeId(usedBudgetIds, 1 + b.id);
    usedBudgetIds.add(id);
    const start = ledgerStart + within(b.startAt, 0, raw.length - 1);
    const end = b.endKind < 4 ? start + within(b.endAt, 0, last - start) : null;
    const lastActive = end ?? last;

    // Version rows: the first at the start month (or only older ones), then changes inside the
    // active months, and rows after the end month that are inert.
    const versions: BudgetVersionFact[] = [];
    const older = olderMonths(b.older, start, ledgerStart);
    const taken = new Set<number>();
    if (!(b.olderOnly && older.length > 0)) {
      versions.push({
        effectiveMonth: mk(start),
        amount: b.first.amount,
        incremental: b.first.incremental,
      });
      taken.add(start);
    }
    older.forEach(({ month, index }) =>
      versions.push({
        effectiveMonth: mk(month),
        amount: b.older[index]!.amount,
        incremental: b.older[index]!.incremental,
      }),
    );
    distinctMonths(
      b.versions.map((v) => v.at),
      start + 1,
      lastActive,
      taken,
    ).forEach(({ month, index }) =>
      versions.push({
        effectiveMonth: mk(month),
        amount: b.versions[index]!.amount,
        incremental: b.versions[index]!.incremental,
      }),
    );
    if (end !== null) {
      b.inert.forEach((row, i) =>
        versions.push({
          effectiveMonth: mk(end + 1 + (row.at % 4) + (i % 2) * 5),
          amount: row.amount,
          incremental: row.incremental,
        }),
      );
    }
    serial++;
    const fact: BudgetFact = {
      id,
      name: `Budget ${serial}`,
      color: tag(serial),
      icon: serial % 3 === 0 ? 'wallet' : null,
      sortOrder: b.sort * 10,
      startMonth: mk(start),
      endMonth: end === null ? null : mk(end),
      alertWarnPercent: b.warn,
      versions: dedupeByMonth(versions),
    };
    budgets.push(fact);

    // Spendings, only inside the active months: a regular habit, and one-off ones.
    const warn = b.warn ?? raw.warnDefault;
    const allocationAt = (month: number) => effective(fact.versions, month)?.amount ?? 0;
    if (b.habit !== null) {
      for (let month = start; month <= lastActive; month++) {
        const amount = Math.floor((allocationAt(month) * b.habit) / 100);
        if (amount > 0) spendings.push({ budgetId: id, month: mk(month), amount });
      }
    }
    for (const s of b.spendings) {
      const month = start + within(s.at, 0, lastActive - start);
      const allocation = allocationAt(month);
      let amount: number;
      switch (s.kind) {
        case 0:
          amount = 1 + (s.a % 3_000);
          break;
        case 1:
          amount = 1 + (s.a % 150_000);
          break;
        case 2: // a share of the allocation, give or take a cent
          amount = Math.floor((allocation * (s.a % 161)) / 100) + (s.b % 3) - 1;
          break;
        case 3: // right at the warning threshold, give or take a cent
          amount = Math.floor((allocation * warn) / 100) + (s.b % 3) - 1;
          break;
        case 4: // a refund
          amount = -(1 + (s.a % 5_000));
          break;
        default:
          amount = 1 + s.a * 100_000;
      }
      spendings.push({ budgetId: id, month: mk(month), amount: amount === 0 ? 1 : amount });
    }
  });

  // --- transfers: both sides active in the month ------------------------------------------------
  const transfers: TransferFact[] = [];
  for (const t of raw.transfers) {
    const month = ledgerStart + within(t.at, 0, raw.length - 1);
    const active = budgets.filter(
      (b) =>
        monthIndex(b.startMonth) <= month &&
        (b.endMonth === null || month <= monthIndex(b.endMonth)),
    );
    if (active.length === 0) continue;
    const from = active[t.a % active.length]!;
    if (t.kind === 0) {
      transfers.push({
        month: mk(month),
        fromBudgetId: null,
        toBudgetId: from.id,
        amount: t.amount,
      });
    } else if (t.kind === 1) {
      transfers.push({
        month: mk(month),
        fromBudgetId: from.id,
        toBudgetId: null,
        amount: t.amount,
      });
    } else if (active.length > 1) {
      const others = active.filter((b) => b.id !== from.id);
      const to = others[t.b % others.length]!;
      transfers.push({
        month: mk(month),
        fromBudgetId: from.id,
        toBudgetId: to.id,
        amount: t.amount,
      });
    }
  }

  // --- subscriptions ------------------------------------------------------------------------------
  const subscriptions: SubscriptionFact[] = [];
  const usedSubscriptionIds = new Set<number>();
  raw.subscriptions.forEach((s, index) => {
    const id = opts.sequentialIds ? index + 1 : freeId(usedSubscriptionIds, 1 + s.id);
    usedSubscriptionIds.add(id);
    const anchorMonthOfYear = within(s.anchorMonth, 1, 12);
    const anchorYear = 2018 + within(s.anchorYear, 0, 11); // 2020, 2024 and 2028 are leap years
    const anchorDay = Math.min(
      ANCHOR_DAYS[s.anchorDay % ANCHOR_DAYS.length]!,
      daysInMonth(anchorYear, anchorMonthOfYear),
    );
    const anchorDate = `${String(anchorYear).padStart(4, '0')}-${String(anchorMonthOfYear).padStart(2, '0')}-${String(anchorDay).padStart(2, '0')}`;
    const start = ledgerStart + within(s.startAt, 0, raw.length - 1);
    const renewalsFrom = (from: number, to: number): number[] => {
      const found: number[] = [];
      for (let month = from; month <= to; month++) {
        if ((month % 12) + 1 === anchorMonthOfYear) found.push(month);
      }
      return found;
    };

    // The end month, in a position relative to the renewals (the month before one, one, the month
    // after one), because that is where yearly subscriptions are interesting.
    let end: number | null = null;
    if (s.endKind < 4) {
      const renewals = s.yearly ? renewalsFrom(start, last) : [];
      const pick = renewals.length > 0 ? renewals[s.endAt % renewals.length]! : undefined;
      const wanted =
        s.endPlace === 0 || pick === undefined
          ? start + within(s.endAt, 0, last - start)
          : s.endPlace === 1
            ? pick - 1
            : s.endPlace === 2
              ? pick
              : s.endPlace === 3
                ? pick + 1
                : start;
      end = Math.min(last, Math.max(start, wanted));
    }
    const lastActive = end ?? last;

    // Price rows.
    const prices: PriceFact[] = [];
    const older = olderMonths(s.older, start, ledgerStart);
    const taken = new Set<number>();
    const firstAmount = Math.max(1, s.first.amount);
    if (!(s.olderOnly && older.length > 0)) {
      prices.push({ effectiveMonth: mk(start), amount: firstAmount });
      taken.add(start);
    }
    older.forEach(({ month, index }) =>
      prices.push({ effectiveMonth: mk(month), amount: Math.max(1, s.older[index]!.amount) }),
    );
    // Changes inside the active months. `place` steers a change to the renewal month, the month
    // before it or the month after it; `scale` makes it a rise or a drop of the first price.
    for (const change of s.changes) {
      const renewals = s.yearly ? renewalsFrom(start + 1, lastActive + 1) : [];
      const aroundRenewal =
        renewals.length > 0 ? renewals[change.at % renewals.length]! : undefined;
      let month =
        change.place === 0 || aroundRenewal === undefined
          ? start + 1 + (change.at % Math.max(1, lastActive - start))
          : change.place === 1
            ? aroundRenewal
            : change.place === 2
              ? aroundRenewal - 1
              : aroundRenewal + 1;
      if (month <= start || month > lastActive) continue;
      while (taken.has(month) && month <= lastActive) month++;
      if (month > lastActive || taken.has(month)) continue;
      taken.add(month);
      prices.push({
        effectiveMonth: mk(month),
        amount:
          change.scale === 0
            ? Math.max(1, change.amount)
            : Math.max(
                1,
                Math.floor((firstAmount * (40 + ((change.at + change.scale) % 161))) / 100),
              ),
      });
    }
    if (end !== null) {
      s.inert.forEach((row, i) =>
        prices.push({
          effectiveMonth: mk(end! + 1 + (row.at % 4) + (i % 2) * 5),
          amount: Math.max(1, row.amount),
        }),
      );
    }
    serial++;
    subscriptions.push({
      id,
      name: SUBSCRIPTION_NAMES[s.name % SUBSCRIPTION_NAMES.length]!,
      color: tag(serial),
      frequency: s.yearly ? 'yearly' : 'monthly',
      anchorDate,
      startMonth: mk(start),
      endMonth: end === null ? null : mk(end),
      prices: dedupeByMonth(prices),
    });
  });

  // --- junk ---------------------------------------------------------------------------------------
  const junk: JunkFacts = { spendings: [], transfers: [] };
  for (const j of raw.junk) {
    const month = ledgerStart + within(j.at, 0, raw.length - 1);
    const isActive = (b: BudgetFact, m: number) =>
      monthIndex(b.startMonth) <= m && (b.endMonth === null || m <= monthIndex(b.endMonth));
    const inactive = budgets.filter((b) => !isActive(b, month));
    const active = budgets.filter((b) => isActive(b, month));
    switch (j.kind) {
      case 0: // a spending for a budget that does not exist
        junk.spendings.push({ budgetId: 9_000 + (j.a % 50), month: mk(month), amount: j.amount });
        break;
      case 1: // a spending of a real budget in a month it is not active
        if (inactive.length > 0) {
          const budget = inactive[j.a % inactive.length]!;
          junk.spendings.push({ budgetId: budget.id, month: mk(month), amount: j.amount });
        }
        break;
      case 2: // a transfer naming a budget that is not active that month
        if (inactive.length > 0) {
          const named = inactive[j.a % inactive.length]!;
          const other = active.length > 0 ? active[j.a % active.length]!.id : null;
          junk.transfers.push(
            j.a % 2 === 0
              ? { month: mk(month), fromBudgetId: other, toBudgetId: named.id, amount: j.amount }
              : { month: mk(month), fromBudgetId: named.id, toBudgetId: other, amount: j.amount },
          );
        }
        break;
      case 3: // a transfer of a budget to itself
        if (active.length > 0) {
          const budget = active[j.a % active.length]!;
          junk.transfers.push({
            month: mk(month),
            fromBudgetId: budget.id,
            toBudgetId: budget.id,
            amount: j.amount,
          });
        }
        break;
      case 4: // pool to pool
        junk.transfers.push({
          month: mk(month),
          fromBudgetId: null,
          toBudgetId: null,
          amount: j.amount,
        });
        break;
      default: // a transfer from an unknown budget
        junk.transfers.push({
          month: mk(month),
          fromBudgetId: 9_000 + (j.a % 50),
          toBudgetId: active.length > 0 ? active[j.a % active.length]!.id : null,
          amount: j.amount,
        });
    }
  }

  return {
    facts: {
      startMonth: mk(ledgerStart),
      alertWarnPercent: raw.warnDefault,
      salary,
      incomes,
      subscriptions,
      budgets,
      spendings,
      transfers,
    },
    through: mk(last),
    today,
    junk,
  };
}

/** The lowest free id at or above `wanted`. */
function freeId(used: ReadonlySet<number>, wanted: number): number {
  let id = wanted;
  while (used.has(id)) id++;
  return id;
}

/** Rows have one entry per month (the API upserts), the first one winning. */
function dedupeByMonth<T extends { effectiveMonth: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.effectiveMonth)) return false;
    seen.add(row.effectiveMonth);
    return true;
  });
}

/** Scenarios for the property tests; override any of `DEFAULT_OPTIONS`. */
export function scenarioArb(overrides: Partial<GenOptions> = {}): fc.Arbitrary<Scenario> {
  const opts = { ...DEFAULT_OPTIONS, ...overrides };
  return rawScenario(opts).map((raw) => buildScenario(raw, opts));
}

// -------------------------------------------------------------------------------------------------
// Shuffling
// -------------------------------------------------------------------------------------------------

/** A tiny seeded generator (mulberry32), for shuffles that replay from the shrunk counterexample. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in an order decided by `seed` (Fisher-Yates). */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** The same facts with every list, and every version and price list, in another order. */
export function shuffleFacts(facts: Facts, seed: number): Facts {
  return {
    ...facts,
    salary: shuffle(facts.salary, seed + 1),
    incomes: shuffle(facts.incomes, seed + 2),
    subscriptions: shuffle(facts.subscriptions, seed + 3).map((s, i) => ({
      ...s,
      prices: shuffle(s.prices, seed + 100 + i),
    })),
    budgets: shuffle(facts.budgets, seed + 4).map((b, i) => ({
      ...b,
      versions: shuffle(b.versions, seed + 200 + i),
    })),
    spendings: shuffle(facts.spendings, seed + 5),
    transfers: shuffle(facts.transfers, seed + 6),
  };
}
