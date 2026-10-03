/**
 * Assertions of the identities the contract in shared/src/months.ts promises (its JSDoc), plus the
 * ones that tie consecutive months together. Used by the engine tests and by the HTTP scenarios, on
 * every month they produce.
 *
 * The checks are plain comparisons that collect what is wrong and assert once at the end, because
 * the randomised tests run them on thousands of months and a `expect` per figure would be slow. A
 * failure still names the month, the budget or the subscription and both numbers.
 */
import { type MonthSummary, type MonthView, addMonths, monthDiff } from '@wallet/shared';
import { expect } from 'vitest';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const nameCollator = new Intl.Collator('en', { sensitivity: 'accent' });

/** Collects failures: `eq` for two numbers or values that must be equal, `ok` for a condition. */
function collector() {
  const failures: string[] = [];
  return {
    failures,
    eq(actual: unknown, expected: unknown, what: string) {
      if (!Object.is(actual, expected)) {
        failures.push(`${what}: expected ${String(expected)}, got ${String(actual)}`);
      }
    },
    ok(condition: boolean, what: string) {
      if (!condition) failures.push(what);
    },
  };
}
type Collector = ReturnType<typeof collector>;

/** Every number in `value` is a safe integer: money is integer cents, never a float. */
function onlyIntegers(value: unknown, path: string, c: Collector): void {
  if (typeof value === 'number') {
    c.ok(Number.isSafeInteger(value), `${path} = ${value} is not a safe integer`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => onlyIntegers(item, `${path}[${index}]`, c));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) onlyIntegers(item, `${path}.${key}`, c);
  }
}

/** What is wrong with one month, from the JSDoc of `MonthView`, `MonthBudgetLine` and friends. */
export function monthViolations(view: MonthView): string[] {
  const c = collector();
  const lines = view.budgets;
  const m = view.month;
  onlyIntegers(view, m, c);

  c.eq(view.income.total, view.income.salary + view.income.extra, `${m} income.total`);
  c.eq(view.fixedCosts, sum(view.subscriptions.map((s) => s.charge)), `${m} fixedCosts`);
  c.eq(view.totals.allocated, sum(lines.map((b) => b.allocated)), `${m} totals.allocated`);
  c.eq(view.totals.spent, sum(lines.map((b) => b.spent)), `${m} totals.spent`);
  c.eq(view.totals.remaining, sum(lines.map((b) => b.remaining)), `${m} totals.remaining`);
  c.eq(view.totals.transfersNet, sum(lines.map((b) => b.transfersNet)), `${m} totals.transfersNet`);
  c.eq(
    view.unallocated,
    view.income.total - view.fixedCosts - view.totals.allocated - view.totals.transfersNet,
    `${m} unallocated`,
  );
  c.eq(view.overAllocated, view.unallocated < 0, `${m} overAllocated`);

  const due = view.savingsDue;
  c.eq(due.unallocated, view.unallocated, `${m} savingsDue.unallocated`);
  c.eq(due.budgetsSettled, sum(lines.map((b) => b.toSavings)), `${m} savingsDue.budgetsSettled`);
  c.eq(
    due.reservesReleased,
    sum(view.subscriptions.map((s) => s.reserveReleased)),
    `${m} savingsDue.reservesReleased`,
  );
  c.eq(
    due.total,
    due.unallocated + due.budgetsSettled + due.reservesReleased,
    `${m} savingsDue.total`,
  );

  for (const b of lines) {
    const w = `${m} budget ${b.id}`;
    c.eq(b.available, b.carriedIn + b.allocated + b.transfersNet, `${w} available`);
    c.eq(b.remaining, b.available - b.spent, `${w} remaining`);
    c.eq(
      b.remaining,
      b.carriedOut + b.toSavings,
      `${w} remaining = carriedOut + toSavings (invariant 1)`,
    );
    c.eq(b.alert === 'over', b.spent > b.available, `${w} over <=> spent > available`);
    c.eq(b.alert === 'over', b.remaining < 0, `${w} over <=> remaining < 0`);
    c.eq(
      b.usagePercent,
      b.available > 0 ? Math.max(0, Math.floor((100 * b.spent) / b.available)) : null,
      `${w} usagePercent`,
    );
    const warns = b.available > 0 && 100 * b.spent >= b.warnPercent * b.available;
    c.eq(b.alert, b.spent > b.available ? 'over' : warns ? 'warning' : 'ok', `${w} alert`);
    c.eq(b.carriedOut, b.incremental && !b.endsThisMonth ? b.remaining : 0, `${w} carriedOut`);
  }

  const subscriptions = view.subscriptions;
  for (let i = 1; i < subscriptions.length; i++) {
    const [a, b] = [subscriptions[i - 1]!, subscriptions[i]!];
    const order = nameCollator.compare(a.name, b.name);
    c.ok(
      order < 0 || (order === 0 && a.id < b.id),
      `${m}: subscriptions ascending by name, then id`,
    );
  }
  for (const s of subscriptions) {
    const w = `${m} subscription ${s.id}`;
    if (s.frequency === 'monthly') {
      c.eq(s.charge, s.price, `${w} monthly charge`);
      c.eq(
        JSON.stringify([
          s.reserveBalance,
          s.renewalThisMonth,
          s.nextRenewalMonth,
          s.nextRenewalPrice,
          s.reserveReleased,
        ]),
        JSON.stringify([0, false, null, null, 0]),
        `${w} monthly has no reserve or renewal`,
      );
    } else {
      c.eq(s.nextRenewalMonth === null, s.nextRenewalPrice === null, `${w} renewal month/price`);
      if (s.renewalThisMonth) {
        c.eq(s.nextRenewalMonth, m, `${w} renews this month`);
        c.eq(s.reserveBalance, 0, `${w} reserve after the renewal`);
      }
      c.ok(s.reserveBalance >= 0, `${w} reserve is not negative`);
      if (s.nextRenewalPrice !== null) {
        // The reserve saves towards the price in effect THIS month (docs/DOMAIN.md, "Causality").
        c.eq(s.nextRenewalPrice, s.price, `${w} saves towards the price in effect this month`);
      }
      if (s.nextRenewalMonth !== null) {
        const ahead = monthDiff(m, s.nextRenewalMonth);
        c.ok(
          ahead >= 0 && ahead <= 11,
          `${w} next renewal ${s.nextRenewalMonth} is 0 to 11 months ahead`,
        );
        c.eq(
          s.renewalThisMonth,
          ahead === 0,
          `${w} renewalThisMonth <=> next renewal is this month`,
        );
      } else {
        // No renewal is left only in the last month, which then sets nothing aside and holds nothing.
        c.ok(s.endsThisMonth, `${w} has no renewal left but is not in its end month`);
        c.eq(s.renewalThisMonth, false, `${w} renews with no renewal left`);
        c.eq(s.charge, 0, `${w} sets something aside with no renewal left`);
        c.eq(s.reserveBalance, 0, `${w} holds something with no renewal left`);
      }
      c.ok(
        s.reserveReleased === 0 || s.renewalThisMonth || s.nextRenewalMonth === null,
        `${w} releases its reserve outside a renewal month and its last month`,
      );
    }
  }
  return c.failures;
}

/** The identities of one month (see `monthViolations`). */
export function expectMonthIdentities(view: MonthView): void {
  expect(monthViolations(view)).toEqual([]);
}

/** A summary is the same figures as its view. */
export function expectSummaryMatchesView(summary: MonthSummary, view: MonthView): void {
  expect(summary).toEqual({
    month: view.month,
    status: view.status,
    income: view.income.total,
    fixedCosts: view.fixedCosts,
    allocated: view.totals.allocated,
    spent: view.totals.spent,
    unallocated: view.unallocated,
    savingsDue: view.savingsDue.total,
  });
}

/** What the subscriptions paid the providers in a month: monthly prices and yearly renewals. */
export function paymentsOf(view: MonthView): number {
  return sum(
    view.subscriptions.map((s) =>
      s.frequency === 'monthly' ? s.charge : s.renewalThisMonth ? s.price : 0,
    ),
  );
}

const heldInBudgets = (view: MonthView) => sum(view.budgets.map((b) => b.carriedOut));
const heldInReserves = (view: MonthView) => sum(view.subscriptions.map((s) => s.reserveBalance));

/**
 * What is wrong with the way consecutive months tie together. `views` are consecutive months,
 * ascending; `startsAtLedgerStart` says the first of them is the first month the ledger computes
 * (so nothing is carried into it). For every pair of neighbours:
 *
 *  - a budget's `carriedIn` is the previous month's `carriedOut` (0 in its first month);
 *  - a yearly reserve grows by the charge and shrinks by the renewal paid and by what is released;
 *  - conservation: income = spent + subscriptions paid + savings due + the change in what is held
 *    in incremental budgets and in yearly reserves. Summed over months this is invariant 2 of
 *    docs/DOMAIN.md.
 */
export function chainViolations(
  views: readonly MonthView[],
  { startsAtLedgerStart = false }: { startsAtLedgerStart?: boolean } = {},
): string[] {
  const c = collector();
  views.forEach((view, index) => {
    const previous = index > 0 ? views[index - 1]! : undefined;
    if (previous) c.eq(view.month, addMonths(previous.month, 1), 'consecutive months');
    if (!previous && !startsAtLedgerStart) return;

    for (const b of view.budgets) {
      const before = previous?.budgets.find((p) => p.id === b.id);
      c.eq(b.carriedIn, before?.carriedOut ?? 0, `${view.month} budget ${b.id} carriedIn`);
    }
    for (const s of view.subscriptions) {
      if (s.frequency !== 'yearly') continue;
      const before = previous?.subscriptions.find((p) => p.id === s.id);
      const paid = s.renewalThisMonth ? s.price : 0;
      c.eq(
        s.reserveBalance,
        (before?.reserveBalance ?? 0) + s.charge - paid - s.reserveReleased,
        `${view.month} subscription ${s.id} reserve`,
      );
    }

    const budgetsBefore = previous ? heldInBudgets(previous) : 0;
    const reservesBefore = previous ? heldInReserves(previous) : 0;
    c.eq(
      view.income.total,
      view.totals.spent +
        paymentsOf(view) +
        view.savingsDue.total +
        (heldInBudgets(view) - budgetsBefore) +
        (heldInReserves(view) - reservesBefore),
      `${view.month} conservation of money`,
    );
  });
  return c.failures;
}

export function expectChainIdentities(
  views: readonly MonthView[],
  options: { startsAtLedgerStart?: boolean } = {},
): void {
  expect(chainViolations(views, options)).toEqual([]);
}
