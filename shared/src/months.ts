import { z } from 'zod';
import { MAX_MONTH_RANGE, type SubscriptionFrequency } from './limits';
import type { Cents } from './money';
import { type MonthKey, compareMonths, isMonthKey, monthDiff } from './month';
import { monthKeySchema } from './schemas';

// The constants live in './limits' (no zod); they are re-exported so existing imports keep working.
export { MAX_MONTH_RANGE, MAX_MONTHS_AHEAD } from './limits';

/**
 * GET /api/months query → 200 MonthSummary[] (ascending). Defaults: `to` = current month + 11;
 * `from` = settings.startMonth, but never earlier than `to` - 119. At most MAX_MONTH_RANGE months
 * may be requested: `from` after `to` (the default `to` included), or a range wider than that (an
 * explicit `from` more than 119 months before the default `to` included), is a 400
 * validation_error. The range is then cut to [settings.startMonth, current month +
 * MAX_MONTHS_AHEAD]; an empty result is `[]`.
 */
export const monthListQuerySchema = z
  .strictObject({
    from: monthKeySchema.optional(),
    to: monthKeySchema.optional(),
  })
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      !isMonthKey(q.from) ||
      !isMonthKey(q.to) ||
      compareMonths(q.from, q.to) <= 0,
    { message: '`from` must not be after `to`', path: ['to'] },
  )
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      !isMonthKey(q.from) ||
      !isMonthKey(q.to) ||
      monthDiff(q.from, q.to) < MAX_MONTH_RANGE,
    { message: `The range is limited to ${MAX_MONTH_RANGE} months`, path: ['to'] },
  );
export type MonthListQuery = z.infer<typeof monthListQuerySchema>;

/**
 * `closed`: before the current month, its figures are final (a late edit to its facts changes
 * them). `current`: the month containing today, provisional and live. `future`: a projection that
 * assumes the current month ends as it stands now.
 */
export type MonthStatus = 'closed' | 'current' | 'future';

/** `over`: spent > available. `warning`: not over but usage reached the warning threshold. */
export type BudgetAlert = 'ok' | 'warning' | 'over';

/** `MonthView.income`: `total` = `salary` + `extra`. */
export interface MonthIncome {
  /** The salary in effect this month (0 if none). */
  salary: Cents;
  /** One-off incomes dated in this month. */
  extra: Cents;
  total: Cents;
}

/**
 * One subscription's figures for one month (an element of `MonthView.subscriptions`). A
 * subscription has a line in every month in which it is active (startMonth..endMonth).
 */
export interface MonthSubscriptionLine {
  /** The subscription's id. */
  id: number;
  name: string;
  color: string | null;
  frequency: SubscriptionFrequency;
  /** The price in effect this month: per month for monthly, per year for yearly. */
  price: Cents;
  /**
   * What this subscription takes from the month's income (counts in `fixedCosts`): the price for
   * monthly, the yearly reserve contribution for yearly. For a yearly one the renewal itself is
   * paid out of the reserve, so a renewal month's `charge` is only the top-up; it is 0 in the
   * endMonth of one whose next renewal is after it.
   */
  charge: Cents;
  /**
   * Yearly only (0 for monthly): the reserve held at the end of this month, after any renewal has
   * been paid and any release made. So it is 0 in a renewal month.
   */
  reserveBalance: Cents;
  /** Yearly only: this month is a renewal month, so `price` is paid out of the reserve. */
  renewalThisMonth: boolean;
  /**
   * Yearly only: the first renewal month on or after this month (this month when
   * `renewalThisMonth`): the renewal this month's contribution saves towards. null for monthly,
   * and in the endMonth of a yearly one whose next renewal is after it (no renewal is left). Months
   * before the endMonth are computed as if the subscription went on, so they still name a renewal
   * that comes after the endMonth.
   */
  nextRenewalMonth: MonthKey | null;
  /**
   * Yearly only: the price `reserveBalance` is saving towards this month, which is the price in
   * effect this month (the same as `price`). A price change dated in a later month only counts
   * from that month on, so it never moves the months before it (docs/DOMAIN.md, "Causality").
   * null whenever `nextRenewalMonth` is null.
   */
  nextRenewalPrice: Cents | null;
  /**
   * Reserve returned to savings this month: what is still held after a renewal because the price
   * dropped, or the whole reserve in the endMonth of a yearly subscription whose next renewal is
   * after it. Counted in `MonthView.savingsDue.reservesReleased`.
   */
  reserveReleased: Cents;
  /** This month is its endMonth: its last month (the last time a monthly one is charged). */
  endsThisMonth: boolean;
}

/**
 * One budget's figures for one month (an element of `MonthView.budgets`). A budget has a line in
 * every month in which it is active (startMonth..endMonth). For the current and future months
 * `carriedOut` and `toSavings` are projections as if the month ended as it stands.
 *
 * Identities: available = carriedIn + allocated + transfersNet; remaining = available - spent;
 * remaining = carriedOut + toSavings.
 */
export interface MonthBudgetLine {
  /** The budget's id. */
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  /** The mode in effect this month. */
  incremental: boolean;
  /** This month is the budget's endMonth: its whole balance is settled with savings. */
  endsThisMonth: boolean;
  /** carriedOut of the previous month. 0 in the budget's first month. */
  carriedIn: Cents;
  /** The amount of the version in effect this month. */
  allocated: Cents;
  /**
   * Transfers into this budget minus transfers out of it, dated in this month (`POST
   * /api/transfers`, docs/DOMAIN.md, "Transfers"). Only the budget's own side counts here: the
   * pool side of a transfer shows in `MonthView.unallocated`.
   */
  transfersNet: Cents;
  available: Cents;
  /** Spendings dated in this month. Refunds subtract. */
  spent: Cents;
  /** Negative when overspent. */
  remaining: Cents;
  /**
   * floor(100 * spent / available), at least 0 and not capped (150 means 50% over). null when
   * available <= 0. Rounded down so a displayed 79% never comes with a warning at 80%.
   */
  usagePercent: number | null;
  /** The warning threshold in effect: the budget's own alertWarnPercent, else the settings one. */
  warnPercent: number;
  /**
   * `over` when spent > available (same as remaining < 0). Otherwise `warning` when
   * available > 0 and 100 * spent >= warnPercent * available. Otherwise `ok`.
   */
  alert: BudgetAlert;
  /** Carries into next month: `remaining` if incremental and not `endsThisMonth`, else 0. */
  carriedOut: Cents;
  /** Moves to savings (positive) or is taken from savings (negative): `remaining - carriedOut`. */
  toSavings: Cents;
}

/** `MonthView.totals`: sums over `MonthView.budgets`. */
export interface MonthTotals {
  allocated: Cents;
  spent: Cents;
  remaining: Cents;
  /**
   * The sum of `transfersNet` over the budget lines: the transfers from the pool into budgets
   * minus those from budgets into the pool. A transfer between two budgets adds 0 here
   * (docs/DOMAIN.md, invariant 8).
   */
  transfersNet: Cents;
}

/** `MonthView.savingsDue`: `total` = `unallocated` + `budgetsSettled` + `reservesReleased`. */
export interface MonthSavingsDue {
  /** The month's `unallocated` (negative when over-allocated: taken from savings). */
  unallocated: Cents;
  /** Sum of `toSavings` over the budget lines. */
  budgetsSettled: Cents;
  /** Sum of `reserveReleased` over the subscription lines. */
  reservesReleased: Cents;
  total: Cents;
}

/**
 * GET /api/months/:month → 200 MonthView. 404 not_found when the month is before
 * settings.startMonth or more than MAX_MONTHS_AHEAD months after the current month.
 *
 * Identities: fixedCosts = sum of subscriptions[].charge; each `totals` field = the sum of that
 * field over budgets[]; unallocated = income.total - fixedCosts - totals.allocated -
 * totals.transfersNet; overAllocated = unallocated < 0.
 */
export interface MonthView {
  month: MonthKey;
  status: MonthStatus;
  income: MonthIncome;
  /** What the subscriptions take off the top of the income. */
  fixedCosts: Cents;
  /** Active subscriptions, ascending by name ignoring case, then id. */
  subscriptions: MonthSubscriptionLine[];
  /** Active budgets, ascending by sortOrder, then id. */
  budgets: MonthBudgetLine[];
  totals: MonthTotals;
  /** Income not assigned to fixed costs or budgets. Negative when over-allocated. */
  unallocated: Cents;
  /** unallocated < 0: the UI must warn that more is planned than the month earns. */
  overAllocated: boolean;
  /** What moves to savings (positive) or is taken from savings (negative) once the month closes. */
  savingsDue: MonthSavingsDue;
}

/**
 * Element of GET /api/months → 200 MonthSummary[]: the compact row for charts and history.
 * Equals the same fields of `MonthView` for that month: income = income.total, allocated =
 * totals.allocated, spent = totals.spent, savingsDue = savingsDue.total.
 */
export interface MonthSummary {
  month: MonthKey;
  status: MonthStatus;
  income: Cents;
  fixedCosts: Cents;
  allocated: Cents;
  spent: Cents;
  unallocated: Cents;
  savingsDue: Cents;
}
