/**
 * An independent check of the ledger, written to share no logic with it: it imports nothing from
 * `domain/ledger.ts` or `lib/versioned.ts`, does its own row lookups, and does its own arithmetic
 * (BigInt, not `ceilDiv`).
 *
 * The yearly reserve is a plain FORWARD SIMULATION of docs/DOMAIN.md, written the way the text
 * reads and not the way the engine is structured: for each month of a subscription it walks
 * forward, month by month, to the next renewal (the engine does modular arithmetic), counts the
 * months left, asks for the smallest contribution that can still reach the price in effect this
 * month, pays the renewal, releases a leftover, and applies the end-month rule. The reserve cannot
 * be written in closed form any more (a price change inside a cycle changes the contributions from
 * its month on), so every month is simulated from the subscription's first month and the result is
 * kept.
 *
 * An incremental budget's balance is still computed the other way round from the engine, in closed
 * form: the sum of its flows since it was last settled with savings. Then conservation of money
 * (docs/DOMAIN.md, invariant 2) says what the savings due of a month must be:
 *
 *   savingsDue(M) = income(M) - spent(M) - subscriptions paid(M) - change in money held(M)
 *
 * Every cent of income is spent, paid to a provider, sent to savings, or still held in an
 * incremental budget or a yearly reserve. The oracle also gives the figures behind the total (what
 * the subscriptions set aside, what each reserve releases, every yearly line), so a test can compare
 * them one by one and not only as a sum.
 *
 * It assumes valid facts (what the API can store): spendings and transfers inside their budgets'
 * active months, and a price and a version in effect at each start month (a row at or before it).
 */
import {
  type Cents,
  type MonthKey,
  type MonthView,
  addMonths,
  monthDiff,
  monthRange,
} from '@wallet/shared';
import type { BudgetFact, Facts, SubscriptionFact } from '../domain/facts';

const monthOfYear = (monthOrDate: string): number => Number(monthOrDate.slice(5, 7));

/** The latest row effective at or before `month` (rows in any order). */
function latest<T extends { effectiveMonth: MonthKey }>(rows: readonly T[], month: MonthKey) {
  let found: T | undefined;
  for (const row of rows) {
    if (row.effectiveMonth <= month && (!found || row.effectiveMonth > found.effectiveMonth)) {
      found = row;
    }
  }
  return found;
}

const isActive = (item: { startMonth: MonthKey; endMonth: MonthKey | null }, month: MonthKey) =>
  month >= item.startMonth && (item.endMonth === null || month <= item.endMonth);

/** What one yearly subscription does in one month, by the book. */
export interface ReserveMonth {
  /** Set aside from the month's income: the line's `charge`. */
  contribution: Cents;
  /** Paid to the provider out of the reserve. */
  payment: Cents;
  /** Returned to savings: the leftover after a renewal, or everything in the last month. */
  released: Cents;
  /** Held at the end of the month, after the payment and the release. */
  held: Cents;
  /** The renewal the contribution saves towards (null in the last month with none left). */
  renewalMonth: MonthKey | null;
  /** The price in effect this month (null with `renewalMonth`). */
  renewalPrice: Cents | null;
}

export interface Oracle {
  income(month: MonthKey): Cents;
  spent(month: MonthKey): Cents;
  /** Paid to the providers: monthly prices and yearly renewals. */
  payments(month: MonthKey): Cents;
  /** What the subscriptions take from the income: monthly prices and yearly contributions. */
  fixedCosts(month: MonthKey): Cents;
  /** Reserves returned to savings this month. */
  reservesReleased(month: MonthKey): Cents;
  /** Held in incremental budgets at the end of `month`. */
  heldInBudgets(month: MonthKey): Cents;
  /** Held in yearly reserves at the end of `month`. */
  heldInReserves(month: MonthKey): Cents;
  /** One yearly subscription in one month; undefined when it is monthly or not active then. */
  reserve(subscriptionId: number, month: MonthKey): ReserveMonth | undefined;
  /** What must go to savings for `month`, by conservation of money. */
  savingsDue(month: MonthKey): Cents;
}

/** The smallest integer `c >= 0` with `c * parts >= need` (exact, whatever the size of the amounts). */
function smallestShare(need: Cents, parts: number): Cents {
  if (need <= 0) return 0;
  const n = BigInt(need);
  const p = BigInt(parts);
  return Number((n + p - 1n) / p);
}

export function createOracle(facts: Facts): Oracle {
  const first = facts.startMonth;
  const sumFacts = (rows: readonly { month: MonthKey; amount: Cents }[], month: MonthKey) =>
    rows.reduce((total, row) => total + (row.month === month ? row.amount : 0), 0);

  const income = (month: MonthKey): Cents =>
    (latest(facts.salary, month)?.amount ?? 0) + sumFacts(facts.incomes, month);

  const spent = (month: MonthKey): Cents => sumFacts(facts.spendings, month);

  // ---- Yearly reserves: simulate forward, once per subscription, as far as asked ------------------

  interface Simulation {
    firstMonth: MonthKey;
    steps: ReserveMonth[];
  }
  const simulations = new Map<SubscriptionFact, Simulation>();

  function simulateMonth(sub: SubscriptionFact, month: MonthKey, held: Cents): ReserveMonth {
    // Walk forward to the month of the year the subscription renews in, counting the months from
    // this one to it inclusive.
    const renewsIn = monthOfYear(sub.anchorDate);
    let renewal = month;
    let monthsLeft = 1;
    while (monthOfYear(renewal) !== renewsIn) {
      renewal = addMonths(renewal, 1);
      monthsLeft++;
    }

    // The last month, and the next renewal comes after it: nothing to save towards, so the whole
    // reserve is released. (In any other month the end month changes nothing.)
    if (sub.endMonth === month && renewal !== month) {
      return {
        contribution: 0,
        payment: 0,
        released: held,
        held: 0,
        renewalMonth: null,
        renewalPrice: null,
      };
    }

    const price = latest(sub.prices, month)?.amount ?? 0;
    const contribution = smallestShare(price - held, monthsLeft);
    let reserve = held + contribution;
    let payment = 0;
    let released = 0;
    if (renewal === month) {
      payment = price;
      reserve -= price;
      if (reserve > 0) {
        released = reserve;
        reserve = 0;
      }
    }
    return {
      contribution,
      payment,
      released,
      held: reserve,
      renewalMonth: renewal,
      renewalPrice: price,
    };
  }

  function reserveOf(sub: SubscriptionFact, month: MonthKey): ReserveMonth | undefined {
    if (sub.frequency !== 'yearly' || !isActive(sub, month)) return undefined;
    const firstMonth = sub.startMonth > first ? sub.startMonth : first;
    if (month < firstMonth) return undefined;

    let simulation = simulations.get(sub);
    if (!simulation) {
      simulation = { firstMonth, steps: [] };
      simulations.set(sub, simulation);
    }
    const index = monthDiff(firstMonth, month);
    while (simulation.steps.length <= index) {
      const next = addMonths(firstMonth, simulation.steps.length);
      const held = simulation.steps.at(-1)?.held ?? 0;
      simulation.steps.push(simulateMonth(sub, next, held));
    }
    return simulation.steps[index];
  }

  const yearlySum = (month: MonthKey, pick: (step: ReserveMonth) => Cents): Cents =>
    facts.subscriptions.reduce((total, sub) => {
      const step = reserveOf(sub, month);
      return step ? total + pick(step) : total;
    }, 0);

  const monthlySum = (month: MonthKey): Cents =>
    facts.subscriptions.reduce(
      (total, sub) =>
        sub.frequency === 'monthly' && isActive(sub, month)
          ? total + (latest(sub.prices, month)?.amount ?? 0)
          : total,
      0,
    );

  const payments = (month: MonthKey): Cents =>
    monthlySum(month) + yearlySum(month, (step) => step.payment);
  const fixedCosts = (month: MonthKey): Cents =>
    monthlySum(month) + yearlySum(month, (step) => step.contribution);
  const reservesReleased = (month: MonthKey): Cents => yearlySum(month, (step) => step.released);
  const heldInReserves = (month: MonthKey): Cents =>
    month < first ? 0 : yearlySum(month, (step) => step.held);

  // ---- Incremental budgets: closed form, the sum of the flows since the last settlement ---------

  /** What a budget takes in or gives out in `month` besides its spendings: allocation and transfers. */
  function netFlow(budget: BudgetFact, month: MonthKey): Cents {
    const allocated = latest(budget.versions, month)?.amount ?? 0;
    const transfers = facts.transfers.reduce(
      (total, t) =>
        t.month !== month
          ? total
          : total +
            (t.toBudgetId === budget.id ? t.amount : 0) -
            (t.fromBudgetId === budget.id ? t.amount : 0),
      0,
    );
    const spendings = facts.spendings.reduce(
      (total, s) => (s.budgetId === budget.id && s.month === month ? total + s.amount : total),
      0,
    );
    return allocated + transfers - spendings;
  }

  /**
   * An incremental budget's balance at the end of `month`: the sum of its flows since it was last
   * settled with savings (a month under a non-incremental version settles everything), or since it
   * started. A budget that is not incremental in `month`, or that ends in it, holds nothing.
   */
  function heldInBudget(budget: BudgetFact, month: MonthKey): Cents {
    if (!isActive(budget, month)) return 0;
    if (!(latest(budget.versions, month)?.incremental ?? false)) return 0;
    if (budget.endMonth === month) return 0;

    const firstMonth = budget.startMonth > first ? budget.startMonth : first;
    let from = firstMonth;
    for (let m = month; m >= firstMonth; m = addMonths(m, -1)) {
      if (m < month && !(latest(budget.versions, m)?.incremental ?? false)) {
        from = addMonths(m, 1);
        break;
      }
    }
    return monthRange(from, month).reduce((total, m) => total + netFlow(budget, m), 0);
  }

  const heldInBudgets = (month: MonthKey): Cents =>
    month < first ? 0 : facts.budgets.reduce((total, b) => total + heldInBudget(b, month), 0);

  // ---- Conservation -------------------------------------------------------------------------------

  const savingsDue = (month: MonthKey): Cents => {
    const before = addMonths(month, -1);
    return (
      income(month) -
      spent(month) -
      payments(month) -
      (heldInBudgets(month) - heldInBudgets(before)) -
      (heldInReserves(month) - heldInReserves(before))
    );
  };

  return {
    income,
    spent,
    payments,
    fixedCosts,
    reservesReleased,
    heldInBudgets,
    heldInReserves,
    reserve: (subscriptionId, month) => {
      const sub = facts.subscriptions.find((s) => s.id === subscriptionId);
      return sub ? reserveOf(sub, month) : undefined;
    },
    savingsDue,
  };
}

/**
 * What differs between a month the ledger (or the API) reports and what the oracle derives from
 * the facts: the income, the spendings, what was paid to the providers, what is held in budgets and
 * in reserves, the fixed costs and the reserves released, the savings due, and every field of every
 * yearly line that the reserve rule decides. Empty when they agree. Each entry names the month, the
 * figure and both numbers.
 */
export function oracleDifferences(
  view: MonthView,
  oracle: Oracle,
  paidToProviders: Cents,
): string[] {
  const month = view.month;
  const found: string[] = [];
  const check = (what: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) {
      found.push(`${month} ${what}: ledger ${String(actual)}, oracle ${String(expected)}`);
    }
  };

  check('income', view.income.total, oracle.income(month));
  check('spent', view.totals.spent, oracle.spent(month));
  check('paid to providers', paidToProviders, oracle.payments(month));
  check(
    'held in incremental budgets',
    view.budgets.reduce((total, b) => total + b.carriedOut, 0),
    oracle.heldInBudgets(month),
  );
  check(
    'held in yearly reserves',
    view.subscriptions.reduce((total, s) => total + s.reserveBalance, 0),
    oracle.heldInReserves(month),
  );
  check('fixed costs', view.fixedCosts, oracle.fixedCosts(month));
  check('reserves released', view.savingsDue.reservesReleased, oracle.reservesReleased(month));
  check('savings due', view.savingsDue.total, oracle.savingsDue(month));

  for (const line of view.subscriptions) {
    if (line.frequency !== 'yearly') continue;
    const step = oracle.reserve(line.id, month);
    const where = `subscription ${line.id}`;
    if (!step) {
      found.push(`${month} ${where}: the ledger has a yearly line, the oracle has no active month`);
      continue;
    }
    check(`${where} charge`, line.charge, step.contribution);
    check(`${where} reserve at the end of the month`, line.reserveBalance, step.held);
    check(`${where} reserve released`, line.reserveReleased, step.released);
    check(`${where} renewal paid`, line.renewalThisMonth ? line.price : 0, step.payment);
    check(`${where} renewal month`, line.nextRenewalMonth, step.renewalMonth);
    check(`${where} renewal price`, line.nextRenewalPrice, step.renewalPrice);
  }
  return found;
}
