/**
 * A small, independent model of the ledger, written from docs/DOMAIN.md alone for the
 * property-based tests (`*.property.test.ts`).
 *
 * It shares no code with `domain/ledger.ts`, with `testing/ledger-oracle.ts` or with the month and
 * money helpers of `@wallet/shared` (only TYPES are imported). It is a plain walk over the months
 * with the arithmetic done in BigInt, so it is exact whatever the amounts, and every rule is a
 * direct transcription of a sentence of the doc (the sentence is quoted next to it).
 *
 * The model is deliberately naive (it rescans the fact lists for every figure). That is what makes
 * it easy to check against the doc, and the property tests only run it on small scenarios.
 * `prop-model.test.ts` pins it to the worked examples of the doc, so a wrong model fails there
 * first and a disagreement with the engine can be read as the engine's.
 */
import type { MonthView } from '@wallet/shared';
import type { Facts } from '../domain/facts';

// -------------------------------------------------------------------------------------------------
// Months and dates, as plain integers (no shared helpers on purpose)
// -------------------------------------------------------------------------------------------------

/** `YYYY-MM` to a running month number (12 per year), so months subtract and compare as integers. */
export const monthIndex = (month: string): number =>
  Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

/** The inverse of `monthIndex`. */
export const monthKey = (index: number): string =>
  `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;

export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in a month of the Gregorian calendar (`month` is 1 to 12). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// -------------------------------------------------------------------------------------------------
// BigInt arithmetic
// -------------------------------------------------------------------------------------------------

/** Division rounded up, for a positive divisor. BigInt `/` truncates toward zero, which is "up" below 0. */
function ceilDivBig(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  return numerator % divisor > 0n ? quotient + 1n : quotient;
}

function toNumber(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`model: ${what} = ${value} is not a safe integer`);
  return n;
}

const sumBig = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/** The row in effect at `month`: the one with the latest `effectiveMonth` that is not after it. */
function rowAt<T extends { effectiveMonth: string }>(
  rows: readonly T[],
  month: number,
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    const at = monthIndex(row.effectiveMonth);
    if (at <= month && (best === undefined || at > monthIndex(best.effectiveMonth))) best = row;
  }
  return best;
}

function isActive(item: { startMonth: string; endMonth: string | null }, month: number): boolean {
  return (
    monthIndex(item.startMonth) <= month &&
    (item.endMonth === null || month <= monthIndex(item.endMonth))
  );
}

// -------------------------------------------------------------------------------------------------
// The model
// -------------------------------------------------------------------------------------------------

/** One month: the `GET /api/months/:month` body, plus the three sums conservation needs. */
export interface ModelMonth {
  view: MonthView;
  /** Paid to the providers: monthly prices and yearly renewals (not the money set aside). */
  subscriptionPayments: number;
  /** Held in incremental budgets at the end of the month. */
  heldInBudgets: number;
  /** Held in yearly reserves at the end of the month. */
  heldInReserves: number;
}

/**
 * Every month from `facts.startMonth` to `through`, as docs/DOMAIN.md defines them, for the
 * calendar date `today` (`YYYY-MM-DD`).
 */
export function modelLedger(facts: Facts, through: string, today: string): ModelMonth[] {
  const first = monthIndex(facts.startMonth);
  const last = monthIndex(through);
  const currentMonth = monthIndex(today.slice(0, 7));

  // The only two pieces of state there are: what each incremental budget carries out of the month
  // before, and what each yearly subscription holds at the end of the month before. "Nothing is
  // carried into the first month an item is computed in", so both start at 0 (a missing entry).
  const carriedOutOf = new Map<number, bigint>();
  const reserveOf = new Map<number, bigint>();

  const months: ModelMonth[] = [];
  for (let m = first; m <= last; m++) {
    const month = monthKey(m);

    // --- Income -----------------------------------------------------------------------------
    // salary(M) = amount of the salary row effective at M (0 if none)
    // income(M) = salary(M) + sum of the incomes dated in M
    const salary = BigInt(rowAt(facts.salary, m)?.amount ?? 0);
    const extra = sumBig(
      facts.incomes.filter((income) => monthIndex(income.month) === m).map((i) => BigInt(i.amount)),
    );
    const income = salary + extra;

    // --- Budgets active this month: "by sortOrder, then id" ---------------------------------------
    const activeBudgets = facts.budgets
      .filter((budget) => isActive(budget, m))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const activeBudgetIds = new Set(activeBudgets.map((b) => b.id));

    // --- Transfers ------------------------------------------------------------------------------
    // "The ledger counts a transfer only when every budget it names is active in the transfer's
    // month ... Otherwise ... the whole transfer, pool side included, is ignored. A transfer from a
    // budget to itself, or between the pool and the pool, moves nothing."
    const netOfBudget = new Map<number, bigint>();
    let fromPoolToBudgets = 0n; // pool -> budget, minus budget -> pool
    for (const t of facts.transfers) {
      if (monthIndex(t.month) !== m) continue;
      if (t.fromBudgetId === null && t.toBudgetId === null) continue;
      if (t.fromBudgetId === t.toBudgetId) continue;
      const named = [t.fromBudgetId, t.toBudgetId].filter((id): id is number => id !== null);
      if (!named.every((id) => activeBudgetIds.has(id))) continue;
      const amount = BigInt(t.amount);
      if (t.fromBudgetId === null) fromPoolToBudgets += amount;
      else netOfBudget.set(t.fromBudgetId, (netOfBudget.get(t.fromBudgetId) ?? 0n) - amount);
      if (t.toBudgetId === null) fromPoolToBudgets -= amount;
      else netOfBudget.set(t.toBudgetId, (netOfBudget.get(t.toBudgetId) ?? 0n) + amount);
    }

    // --- Budget lines ---------------------------------------------------------------------------
    const budgetLines: MonthView['budgets'] = [];
    for (const budget of activeBudgets) {
      // "A budget with no version counts as an allocation of 0 in a non-incremental budget."
      const version = rowAt(budget.versions, m);
      const allocated = BigInt(version?.amount ?? 0);
      const incremental = version?.incremental ?? false;
      const carriedIn = carriedOutOf.get(budget.id) ?? 0n; // carriedIn(M) = carriedOut(M - 1)
      const transfersNet = netOfBudget.get(budget.id) ?? 0n;
      // spent(M) = sum of the spendings of B dated in M (refunds are negative). Spendings of
      // other months are not read, so one dated outside the active months is "shown nowhere".
      const spent = sumBig(
        facts.spendings
          .filter((s) => s.budgetId === budget.id && monthIndex(s.month) === m)
          .map((s) => BigInt(s.amount)),
      );
      const available = carriedIn + allocated + transfersNet;
      const remaining = available - spent;
      const endsThisMonth = budget.endMonth !== null && monthIndex(budget.endMonth) === m;

      // | incremental and M is not endMonth       | carriedOut = remaining | toSavings = 0         |
      // | non-incremental, or M is endMonth       | carriedOut = 0         | toSavings = remaining |
      const carriedOut = incremental && !endsThisMonth ? remaining : 0n;
      const toSavings = remaining - carriedOut;
      carriedOutOf.set(budget.id, carriedOut);

      // "usagePercent = max(0, floor(100 x spent / available)), or null when available <= 0"
      const usagePercent =
        available > 0n ? (spent > 0n ? Number((100n * spent) / available) : 0) : null;
      // "over if spent > available, else warning if available > 0 and
      // 100 x spent >= warnPercent x available, else ok"
      const warnPercent = budget.alertWarnPercent ?? facts.alertWarnPercent;
      const alert =
        spent > available
          ? 'over'
          : available > 0n && 100n * spent >= BigInt(warnPercent) * available
            ? 'warning'
            : 'ok';

      budgetLines.push({
        id: budget.id,
        name: budget.name,
        color: budget.color,
        icon: budget.icon,
        incremental,
        endsThisMonth,
        carriedIn: toNumber(carriedIn, 'carriedIn'),
        allocated: toNumber(allocated, 'allocated'),
        transfersNet: toNumber(transfersNet, 'transfersNet'),
        available: toNumber(available, 'available'),
        spent: toNumber(spent, 'spent'),
        remaining: toNumber(remaining, 'remaining'),
        usagePercent,
        warnPercent,
        alert,
        carriedOut: toNumber(carriedOut, 'carriedOut'),
        toSavings: toNumber(toSavings, 'toSavings'),
      });
    }

    // --- Subscription lines: "by name ignoring case, then id" ---------------------------------------
    const activeSubscriptions = facts.subscriptions
      .filter((subscription) => isActive(subscription, m))
      .sort((a, b) => {
        const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return x < y ? -1 : x > y ? 1 : a.id - b.id;
      });
    const subscriptionLines: MonthView['subscriptions'] = [];
    let payments = 0n;
    for (const subscription of activeSubscriptions) {
      const price = BigInt(rowAt(subscription.prices, m)?.amount ?? 0);
      const endsThisMonth =
        subscription.endMonth !== null && monthIndex(subscription.endMonth) === m;

      if (subscription.frequency === 'monthly') {
        // "Monthly subscriptions cost price(S, M) in every active month", the end month included.
        payments += price;
        subscriptionLines.push({
          id: subscription.id,
          name: subscription.name,
          color: subscription.color,
          frequency: 'monthly',
          price: toNumber(price, 'price'),
          charge: toNumber(price, 'charge'),
          reserveBalance: 0,
          renewalThisMonth: false,
          nextRenewalMonth: null,
          nextRenewalPrice: null,
          reserveReleased: 0,
          endsThisMonth,
        });
        continue;
      }

      // "Yearly subscriptions renew in the month-of-year of anchorDate."
      const renewalMonthOfYear = Number(subscription.anchorDate.slice(5, 7)); // 1 to 12
      const monthsUntilRenewal = (renewalMonthOfYear - ((m % 12) + 1) + 12) % 12; // 0 to 11
      const renewal = m + monthsUntilRenewal; // N: the first renewal month >= M
      const monthsLeft = BigInt(monthsUntilRenewal + 1); // N - M + 1
      const reserveBefore = reserveOf.get(subscription.id) ?? 0n;

      let contribution: bigint;
      let paid = 0n;
      let released = 0n;
      let reserveAfter: bigint;
      // "In E, if the next renewal N is after E there is no renewal left: the contribution is 0
      // and the whole reserve is released into E's savings due."
      const noRenewalLeft = endsThisMonth && monthsUntilRenewal > 0;
      if (noRenewalLeft) {
        contribution = 0n;
        released = reserveBefore;
        reserveAfter = 0n;
      } else {
        // contribution = max(0, ceilDiv(p - reserveBefore(M), monthsLeft)); reserve += contribution
        const wanted = ceilDivBig(price - reserveBefore, monthsLeft);
        contribution = wanted > 0n ? wanted : 0n;
        reserveAfter = reserveBefore + contribution;
        if (monthsUntilRenewal === 0) {
          // "if M == N: reserve -= p (the renewal is paid, at the price in effect in N)", and "after
          // paying a renewal, a leftover reserve is released ... and the reserve goes back to 0".
          paid = price;
          reserveAfter -= price;
          released = reserveAfter;
          reserveAfter = 0n;
        }
      }
      payments += paid;
      reserveOf.set(subscription.id, reserveAfter);
      subscriptionLines.push({
        id: subscription.id,
        name: subscription.name,
        color: subscription.color,
        frequency: 'yearly',
        price: toNumber(price, 'price'),
        charge: toNumber(contribution, 'charge'),
        reserveBalance: toNumber(reserveAfter, 'reserveBalance'),
        renewalThisMonth: !noRenewalLeft && monthsUntilRenewal === 0,
        nextRenewalMonth: noRenewalLeft ? null : monthKey(renewal),
        nextRenewalPrice: noRenewalLeft ? null : toNumber(price, 'nextRenewalPrice'),
        reserveReleased: toNumber(released, 'reserveReleased'),
        endsThisMonth,
      });
    }

    // --- The month ------------------------------------------------------------------------------
    // fixedCosts(M) = sum of monthly prices + sum of yearly contributions
    const fixedCosts = sumBig(subscriptionLines.map((s) => BigInt(s.charge)));
    const allocatedTotal = sumBig(budgetLines.map((b) => BigInt(b.allocated)));
    // unallocated(M) = income(M) - fixedCosts(M) - sum of allocated(M)
    //                  - sum of pool->budget transfers in M + sum of budget->pool transfers in M
    const unallocated = income - fixedCosts - allocatedTotal - fromPoolToBudgets;
    const budgetsSettled = sumBig(budgetLines.map((b) => BigInt(b.toSavings)));
    const reservesReleased = sumBig(subscriptionLines.map((s) => BigInt(s.reserveReleased)));

    months.push({
      view: {
        month,
        status: m < currentMonth ? 'closed' : m === currentMonth ? 'current' : 'future',
        income: {
          salary: toNumber(salary, 'salary'),
          extra: toNumber(extra, 'extra'),
          total: toNumber(income, 'income'),
        },
        fixedCosts: toNumber(fixedCosts, 'fixedCosts'),
        subscriptions: subscriptionLines,
        budgets: budgetLines,
        totals: {
          allocated: toNumber(allocatedTotal, 'totals.allocated'),
          spent: toNumber(sumBig(budgetLines.map((b) => BigInt(b.spent))), 'totals.spent'),
          remaining: toNumber(
            sumBig(budgetLines.map((b) => BigInt(b.remaining))),
            'totals.remaining',
          ),
          transfersNet: toNumber(
            sumBig(budgetLines.map((b) => BigInt(b.transfersNet))),
            'totals.transfersNet',
          ),
        },
        unallocated: toNumber(unallocated, 'unallocated'),
        overAllocated: unallocated < 0n,
        // savingsDue(M) = unallocated(M) + sum of remaining of budgets settled to savings in M
        //                 + sum of subscription reserves released in M
        savingsDue: {
          unallocated: toNumber(unallocated, 'savingsDue.unallocated'),
          budgetsSettled: toNumber(budgetsSettled, 'savingsDue.budgetsSettled'),
          reservesReleased: toNumber(reservesReleased, 'savingsDue.reservesReleased'),
          total: toNumber(unallocated + budgetsSettled + reservesReleased, 'savingsDue.total'),
        },
      },
      subscriptionPayments: toNumber(payments, 'subscriptionPayments'),
      heldInBudgets: toNumber(
        sumBig(budgetLines.map((b) => BigInt(b.carriedOut))),
        'heldInBudgets',
      ),
      heldInReserves: toNumber(
        sumBig(subscriptionLines.map((s) => BigInt(s.reserveBalance))),
        'heldInReserves',
      ),
    });
  }
  return months;
}
