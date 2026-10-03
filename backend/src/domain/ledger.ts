/**
 * The ledger engine: a PURE function from the stored facts to every month's figures, implementing
 * docs/DOMAIN.md. Nothing here reads a clock, a database or the environment: "today" is a
 * `YYYY-MM-DD` string the caller passes in, and the same facts always give the same ledger, in
 * whatever order the rows come.
 *
 * It walks the months from `facts.startMonth` to `throughMonth` once, carrying the only two pieces
 * of state there are: each incremental budget's balance and each yearly subscription's reserve.
 * Every rule applies to every month the same way. Whether a month is closed, current or future
 * only labels it (`status`): the current month is "as if it ended today", and future months extend
 * that projection by carrying the projected balances forward.
 *
 * A `LedgerMonth` is a `MonthView` (the API's read model) plus three sums the conservation
 * identity of docs/DOMAIN.md needs. Later phases read the same rows: savings outstanding takes
 * `savingsDue.total` of the closed months, the dashboard and the yearly report take the lines.
 */
import {
  type BudgetAlert,
  type Cents,
  type IsoDate,
  type MonthBudgetLine,
  type MonthKey,
  type MonthStatus,
  type MonthSubscriptionLine,
  type MonthSummary,
  type MonthView,
  addMonths,
  ceilDiv,
  isMonthKey,
  monthDiff,
} from '@wallet/shared';
import { nameCollator } from '../lib/names';
import { effectiveAt, isWithinActiveMonths } from '../lib/versioned';
import type {
  BudgetFact,
  BudgetVersionFact,
  Facts,
  PriceFact,
  SalaryChangeFact,
  SubscriptionFact,
  TransferFact,
} from './facts';

const MONTHS_PER_YEAR = 12;

// -------------------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------------------

/**
 * One month of the ledger: everything `MonthView` has, plus what the conservation identity needs.
 * `toMonthView` and `toMonthSummary` build the API shapes from it.
 */
export interface LedgerMonth extends MonthView {
  /**
   * Paid to the providers this month: monthly prices, plus each yearly renewal (which comes out of
   * the reserve, so it differs from `fixedCosts`, the money set aside).
   */
  subscriptionPayments: Cents;
  /** Money held in incremental budgets at the end of the month: the sum of their `carriedOut`. */
  heldInBudgets: Cents;
  /** Money held in yearly reserves at the end of the month: the sum of their `reserveBalance`. */
  heldInReserves: Cents;
}

/** The months `startMonth..throughMonth`, ascending. Empty when `throughMonth` is before `startMonth`. */
export interface Ledger {
  startMonth: MonthKey;
  throughMonth: MonthKey;
  /** The month of `today`. */
  currentMonth: MonthKey;
  months: LedgerMonth[];
}

/** The row of `month`, or undefined when it is outside the ledger. */
export function ledgerMonth(ledger: Ledger, month: MonthKey): LedgerMonth | undefined {
  if (!isMonthKey(month)) return undefined;
  const index = monthDiff(ledger.startMonth, month);
  return index >= 0 ? ledger.months[index] : undefined;
}

/** The `GET /api/months/:month` body: the row without the engine-only sums. */
export function toMonthView(row: LedgerMonth): MonthView {
  return {
    month: row.month,
    status: row.status,
    income: row.income,
    fixedCosts: row.fixedCosts,
    subscriptions: row.subscriptions,
    budgets: row.budgets,
    totals: row.totals,
    unallocated: row.unallocated,
    overAllocated: row.overAllocated,
    savingsDue: row.savingsDue,
  };
}

/** One element of the `GET /api/months` body. */
export function toMonthSummary(row: LedgerMonth): MonthSummary {
  return {
    month: row.month,
    status: row.status,
    income: row.income.total,
    fixedCosts: row.fixedCosts,
    allocated: row.totals.allocated,
    spent: row.totals.spent,
    unallocated: row.unallocated,
    savingsDue: row.savingsDue.total,
  };
}

// -------------------------------------------------------------------------------------------------
// Small rules
// -------------------------------------------------------------------------------------------------

/**
 * `floor(100 * spent / available)`, at least 0 and not capped, or null when `available <= 0`.
 * Exact integer arithmetic (BigInt, so even absurd sums cannot lose precision); it rounds down on
 * purpose, so a displayed 79 never comes with a warning at 80.
 */
export function usagePercentOf(spent: Cents, available: Cents): number | null {
  if (available <= 0) return null;
  if (spent <= 0) return 0;
  return Number((100n * BigInt(spent)) / BigInt(available));
}

/**
 * `over` when spent > available (the same as remaining < 0); else `warning` when available > 0 and
 * `100 * spent >= warnPercent * available`; else `ok`. Because `warnPercent` is an integer this is
 * exactly "the floored usage reached the threshold".
 */
export function alertOf(spent: Cents, available: Cents, warnPercent: number): BudgetAlert {
  if (spent > available) return 'over';
  if (available > 0 && 100n * BigInt(spent) >= BigInt(warnPercent) * BigInt(available)) {
    return 'warning';
  }
  return 'ok';
}

const monthOfYear = (month: MonthKey): number => Number(month.slice(5, 7));

/** The price in effect in `month` (0 when there is none: only corrupt data has a gap). */
function priceAt(prices: readonly PriceFact[], month: MonthKey): Cents {
  return effectiveAt(prices, month)?.amount ?? 0;
}

// -------------------------------------------------------------------------------------------------
// The yearly reserve (docs/DOMAIN.md, "Subscriptions")
// -------------------------------------------------------------------------------------------------

export interface YearlyReserveInput {
  /** The month being computed: an active month of the subscription. */
  month: MonthKey;
  /** The month-of-year (1 to 12) of the anchor date: the month the subscription renews in. */
  renewalMonthOfYear: number;
  /** Last active month, or null. It only matters in that month itself. */
  endMonth: MonthKey | null;
  /** The price history, ascending by effective month. */
  prices: readonly PriceFact[];
  /** The reserve at the end of the previous month (0 in the first month). */
  reserveBefore: Cents;
}

export interface YearlyReserveStep {
  /**
   * The first renewal month on or after `month`: the renewal this month saves towards. null only in
   * the end month, when the next renewal is after it (no renewal is left).
   */
  nextRenewalMonth: MonthKey | null;
  /** The price in effect this month, which the reserve is saving towards. null with `nextRenewalMonth`. */
  nextRenewalPrice: Cents | null;
  renewalThisMonth: boolean;
  /** Taken from this month's income into the reserve. It is the line's `charge`. */
  contribution: Cents;
  /** Paid out of the reserve to the provider (the price in effect, in a renewal month). */
  renewalPayment: Cents;
  /** Returned to savings: what is still held after a renewal, or all of it at the end month. */
  reserveReleased: Cents;
  /** The reserve at the end of this month, after the renewal and the release. */
  reserveAfter: Cents;
}

/**
 * One month of a yearly subscription's sinking fund, exactly as docs/DOMAIN.md writes it. The rule
 * is CAUSAL: it looks at the price in effect in `month` and never at a later one, so a price
 * change dated in a month cannot move an earlier month.
 *
 *   N            = first renewal month >= M                       (the renewal this month saves towards)
 *   p            = price(S, M)                                    (the price in effect this month)
 *   monthsLeft   = N - M + 1
 *   contribution = max(0, ceilDiv(p - reserveBefore, monthsLeft))
 *   reserve     += contribution
 *   if M == N:     reserve -= p                                   (the renewal is paid)
 *
 * After the renewal a reserve still positive (the price dropped) is released: the amount moves to
 * the month's savings due and the reserve goes back to 0. So the reserve is 0 after every renewal.
 *
 * `endMonth` only matters in that month itself. There, if the next renewal is after it, no
 * renewal is left: the contribution is 0 and the whole reserve is released. If the end month is a
 * renewal month the rule above applies unchanged. Earlier months are computed as if the
 * subscription went on.
 *
 * Pure and exported so the rule can be tested on its own, including starting states
 * (`reserveBefore` above the price) that the facts of one subscription never lead to.
 */
export function stepYearlyReserve(input: YearlyReserveInput): YearlyReserveStep {
  const { month, endMonth, prices, reserveBefore } = input;
  const monthsToRenewal =
    (input.renewalMonthOfYear - monthOfYear(month) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  const renewalThisMonth = monthsToRenewal === 0;

  if (endMonth === month && !renewalThisMonth) {
    // The last month, and the next renewal is after it: there is nothing left to save towards, so
    // whatever is held goes back to savings.
    return {
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      renewalThisMonth: false,
      contribution: 0,
      renewalPayment: 0,
      reserveReleased: reserveBefore,
      reserveAfter: 0,
    };
  }

  const price = priceAt(prices, month);
  const contribution = Math.max(0, ceilDiv(price - reserveBefore, monthsToRenewal + 1));
  const renewalPayment = renewalThisMonth ? price : 0;
  const held = reserveBefore + contribution - renewalPayment;
  const reserveReleased = renewalThisMonth && held > 0 ? held : 0;
  return {
    nextRenewalMonth: addMonths(month, monthsToRenewal),
    nextRenewalPrice: price,
    renewalThisMonth,
    contribution,
    renewalPayment,
    reserveReleased,
    reserveAfter: held - reserveReleased,
  };
}

// -------------------------------------------------------------------------------------------------
// Preparing the facts
// -------------------------------------------------------------------------------------------------

interface BudgetState {
  fact: BudgetFact;
  /** Ascending by effective month. */
  versions: BudgetVersionFact[];
  warnPercent: number;
  spent: Map<MonthKey, Cents>;
  transfersIn: Map<MonthKey, Cents>;
  transfersOut: Map<MonthKey, Cents>;
  /** The running balance: `carriedOut` of the last month computed (0 before the first). */
  carry: Cents;
}

interface SubscriptionState {
  fact: SubscriptionFact;
  /** Ascending by effective month. */
  prices: PriceFact[];
  renewalMonthOfYear: number;
  /** The running reserve at the end of the last month computed (0 before the first). */
  reserve: Cents;
}

const byEffectiveMonth = (a: { effectiveMonth: MonthKey }, b: { effectiveMonth: MonthKey }) =>
  a.effectiveMonth < b.effectiveMonth ? -1 : a.effectiveMonth > b.effectiveMonth ? 1 : 0;

function addTo<K>(map: Map<K, Cents>, key: K, amount: Cents): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function compileBudgets(facts: Facts): BudgetState[] {
  const states = [...facts.budgets]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((fact): BudgetState => ({
      fact,
      versions: [...fact.versions].sort(byEffectiveMonth),
      warnPercent: fact.alertWarnPercent ?? facts.alertWarnPercent,
      spent: new Map(),
      transfersIn: new Map(),
      transfersOut: new Map(),
      carry: 0,
    }));
  const byId = new Map(states.map((state) => [state.fact.id, state]));

  // A spending of an unknown budget is dropped. One dated outside its budget's active months is
  // kept here but never read: a line only looks up its own months, so it shows up nowhere. The API
  // never stores either.
  for (const spending of facts.spendings) {
    const budget = byId.get(spending.budgetId);
    if (budget) addTo(budget.spent, spending.month, spending.amount);
  }
  return states;
}

/**
 * Adds each transfer to its budgets and returns the pool side per month. A transfer counts only
 * when every budget side is active in the transfer's month: otherwise its money would leave one
 * side and arrive nowhere, so the whole transfer is ignored. (The API never stores one: see
 * "Transfers" in docs/DOMAIN.md.)
 */
function applyTransfers(transfers: readonly TransferFact[], budgets: readonly BudgetState[]) {
  const byId = new Map(budgets.map((state) => [state.fact.id, state]));
  const poolIn = new Map<MonthKey, Cents>(); // budget -> pool: unallocated goes up
  const poolOut = new Map<MonthKey, Cents>(); // pool -> budget: unallocated goes down

  const side = (id: number | null, month: MonthKey): BudgetState | null | undefined => {
    if (id === null) return null;
    const budget = byId.get(id);
    return budget && isWithinActiveMonths(budget.fact.startMonth, budget.fact.endMonth, month)
      ? budget
      : undefined;
  };

  for (const transfer of transfers) {
    const { month, amount } = transfer;
    const from = side(transfer.fromBudgetId, month);
    const to = side(transfer.toBudgetId, month);
    if (from === undefined || to === undefined) continue; // a side that is not an active budget
    if (from === null && to === null) continue; // moves nothing between nothing
    if (from !== null && from === to) continue; // a budget to itself: no change

    if (from) addTo(from.transfersOut, month, amount);
    else addTo(poolOut, month, amount);
    if (to) addTo(to.transfersIn, month, amount);
    else addTo(poolIn, month, amount);
  }
  return { poolIn, poolOut };
}

function compileSubscriptions(facts: Facts): SubscriptionState[] {
  return [...facts.subscriptions]
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
    .map((fact): SubscriptionState => ({
      fact,
      prices: [...fact.prices].sort(byEffectiveMonth),
      renewalMonthOfYear: Number(fact.anchorDate.slice(5, 7)),
      reserve: 0,
    }));
}

function subscriptionLine(state: SubscriptionState, month: MonthKey) {
  const { fact } = state;
  const price = priceAt(state.prices, month);
  const endsThisMonth = fact.endMonth === month;
  const base = { id: fact.id, name: fact.name, color: fact.color, frequency: fact.frequency };

  if (fact.frequency === 'monthly') {
    const line: MonthSubscriptionLine = {
      ...base,
      price,
      charge: price,
      reserveBalance: 0,
      renewalThisMonth: false,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      reserveReleased: 0,
      endsThisMonth,
    };
    return { line, payment: price };
  }

  const step = stepYearlyReserve({
    month,
    renewalMonthOfYear: state.renewalMonthOfYear,
    endMonth: fact.endMonth,
    prices: state.prices,
    reserveBefore: state.reserve,
  });
  state.reserve = step.reserveAfter;
  const line: MonthSubscriptionLine = {
    ...base,
    price,
    charge: step.contribution,
    reserveBalance: step.reserveAfter,
    renewalThisMonth: step.renewalThisMonth,
    nextRenewalMonth: step.nextRenewalMonth,
    nextRenewalPrice: step.nextRenewalPrice,
    reserveReleased: step.reserveReleased,
    endsThisMonth,
  };
  return { line, payment: step.renewalPayment };
}

function budgetLine(state: BudgetState, month: MonthKey): MonthBudgetLine {
  const { fact } = state;
  const version = effectiveAt(state.versions, month);
  const incremental = version?.incremental ?? false;
  const allocated = version?.amount ?? 0;
  const endsThisMonth = fact.endMonth === month;

  const carriedIn = state.carry;
  const transfersNet = (state.transfersIn.get(month) ?? 0) - (state.transfersOut.get(month) ?? 0);
  const available = carriedIn + allocated + transfersNet;
  const spent = state.spent.get(month) ?? 0;
  const remaining = available - spent;

  // An incremental budget keeps its balance (a deficit too) until it ends; every other case is
  // settled with savings: a surplus moves to them, a deficit is taken from them.
  const carriedOut = incremental && !endsThisMonth ? remaining : 0;
  state.carry = carriedOut;

  return {
    id: fact.id,
    name: fact.name,
    color: fact.color,
    icon: fact.icon,
    incremental,
    endsThisMonth,
    carriedIn,
    allocated,
    transfersNet,
    available,
    spent,
    remaining,
    usagePercent: usagePercentOf(spent, available),
    warnPercent: state.warnPercent,
    alert: alertOf(spent, available, state.warnPercent),
    carriedOut,
    toSavings: remaining - carriedOut,
  };
}

function statusOf(month: MonthKey, currentMonth: MonthKey): MonthStatus {
  return month < currentMonth ? 'closed' : month === currentMonth ? 'current' : 'future';
}

// -------------------------------------------------------------------------------------------------
// The ledger
// -------------------------------------------------------------------------------------------------

/**
 * Computes every month from `facts.startMonth` through `throughMonth` (inclusive). `today` is the
 * date (`YYYY-MM-DD`) the "current month" comes from. Pure and deterministic: the result depends
 * only on the arguments, and not on the order of the rows in `facts`.
 *
 * Facts that cannot belong to any line are ignored rather than failing a whole request: a spending
 * or transfer for a budget outside its active months, and a missing price or version (read as 0 or
 * a non-incremental budget). The API never stores such facts.
 */
export function computeLedger(facts: Facts, throughMonth: MonthKey, today: IsoDate): Ledger {
  if (!isMonthKey(facts.startMonth)) {
    throw new RangeError(`computeLedger: invalid start month ${facts.startMonth}`);
  }
  if (!isMonthKey(throughMonth)) {
    throw new RangeError(`computeLedger: invalid month ${throughMonth}`);
  }
  const currentMonth = today.slice(0, 7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !isMonthKey(currentMonth)) {
    throw new RangeError(`computeLedger: today must be a YYYY-MM-DD date, got ${today}`);
  }

  const salary: SalaryChangeFact[] = [...facts.salary].sort(byEffectiveMonth);
  const extraIncome = new Map<MonthKey, Cents>();
  for (const income of facts.incomes) addTo(extraIncome, income.month, income.amount);

  const budgets = compileBudgets(facts);
  const subscriptions = compileSubscriptions(facts);
  const { poolIn, poolOut } = applyTransfers(facts.transfers, budgets);

  const months: LedgerMonth[] = [];
  for (let month = facts.startMonth; month <= throughMonth; month = addMonths(month, 1)) {
    // Income.
    const salaryAmount = effectiveAt(salary, month)?.amount ?? 0;
    const extra = extraIncome.get(month) ?? 0;
    const income = { salary: salaryAmount, extra, total: salaryAmount + extra };

    // Subscriptions come off the top.
    const subscriptionLines: MonthSubscriptionLine[] = [];
    let fixedCosts = 0;
    let subscriptionPayments = 0;
    let heldInReserves = 0;
    let reservesReleased = 0;
    for (const state of subscriptions) {
      if (!isWithinActiveMonths(state.fact.startMonth, state.fact.endMonth, month)) continue;
      const { line, payment } = subscriptionLine(state, month);
      subscriptionLines.push(line);
      fixedCosts += line.charge;
      subscriptionPayments += payment;
      heldInReserves += line.reserveBalance;
      reservesReleased += line.reserveReleased;
    }

    // Budgets.
    const budgetLines: MonthBudgetLine[] = [];
    const totals = { allocated: 0, spent: 0, remaining: 0, transfersNet: 0 };
    let budgetsSettled = 0;
    let heldInBudgets = 0;
    for (const state of budgets) {
      if (!isWithinActiveMonths(state.fact.startMonth, state.fact.endMonth, month)) continue;
      const line = budgetLine(state, month);
      budgetLines.push(line);
      totals.allocated += line.allocated;
      totals.spent += line.spent;
      totals.remaining += line.remaining;
      totals.transfersNet += line.transfersNet;
      budgetsSettled += line.toSavings;
      heldInBudgets += line.carriedOut;
    }

    // What is left of the income once the subscriptions, the allocations and the pool's side of the
    // transfers are taken; it goes to savings when the month closes, below zero or not.
    const unallocated =
      income.total -
      fixedCosts -
      totals.allocated -
      (poolOut.get(month) ?? 0) +
      (poolIn.get(month) ?? 0);

    months.push({
      month,
      status: statusOf(month, currentMonth),
      income,
      fixedCosts,
      subscriptions: subscriptionLines,
      budgets: budgetLines,
      totals,
      unallocated,
      overAllocated: unallocated < 0,
      savingsDue: {
        unallocated,
        budgetsSettled,
        reservesReleased,
        total: unallocated + budgetsSettled + reservesReleased,
      },
      subscriptionPayments,
      heldInBudgets,
      heldInReserves,
    });
  }

  return { startMonth: facts.startMonth, throughMonth, currentMonth, months };
}
