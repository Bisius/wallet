import { z } from 'zod';
import type { SubscriptionFrequency } from './limits';
import type { Cents } from './money';
import type { MonthKey } from './month';
import type { MonthIncome, MonthStatus } from './months';
import type { SavingsDueBreakdown } from './savings';

/**
 * Path `/:year` of GET /api/reports/yearly/:year: exactly four digits, 0001 to 9999 ("2026" becomes
 * 2026). Anything else ("26", "02026", "2026.5", "abc") is a 400 validation_error at `year`. A
 * well-formed year with no tracked month is a 404 (see `YearlyReportDto`).
 */
export const yearParamsSchema = z.strictObject({
  year: z
    .string()
    .regex(/^\d{4}$/, 'Expected a year of four digits')
    .transform(Number)
    .refine((year) => year >= 1, 'Expected a year from 0001'),
});
export type YearParams = z.infer<typeof yearParamsSchema>;

/**
 * One month of the yearly report: the figures of `MonthSummary` plus the split of the income, each
 * equal to the same figure of `GET /api/months/:month` for that month.
 */
export interface YearlyReportMonth {
  month: MonthKey;
  /** closed, current or future (a projection), as in the month view. */
  status: MonthStatus;
  /** = `MonthView.income`. */
  income: MonthIncome;
  /** = `MonthView.fixedCosts`: what the subscriptions take off the top (yearly ones: the top-up). */
  fixedCosts: Cents;
  /** = `MonthView.totals.allocated`. */
  allocated: Cents;
  /** = `MonthView.totals.spent`. */
  spent: Cents;
  /** = `MonthView.unallocated` (negative when over-allocated). */
  unallocated: Cents;
  /**
   * = `MonthView.savingsDue.total`: what moves to savings (positive) or is taken from savings
   * (negative) when the month closes. It is the amount DUE, whether or not it was settled yet, so
   * it never depends on the settlement rows.
   */
  saved: Cents;
  /** = `MonthView.savingsDue` without the total: `saved` = the sum of the three lines. */
  savedBreakdown: SavingsDueBreakdown;
}

/**
 * One subscription's line of the yearly report: its cost in the included months of the year. It
 * has a line when it is active in at least one of them. A subscription that is deleted has none.
 */
export interface YearlyReportSubscription {
  id: number;
  name: string;
  color: string | null;
  frequency: SubscriptionFrequency;
  /**
   * The sum of its `MonthSubscriptionLine.charge` over the included months: what it took off the
   * income, so the `cost` of all lines add up to `fixedCosts.total`. For a yearly subscription
   * this is the money SET ASIDE (the top-ups), not what the provider was paid.
   */
  cost: Cents;
  /**
   * What the provider was paid in those months: the monthly price of a monthly subscription, the
   * renewal price of a yearly one in its renewal month (taken from its reserve). 0 for a yearly
   * subscription whose renewal is outside the included months.
   */
  paid: Cents;
}

/** `YearlyReportDto.fixedCosts`. */
export interface YearlyReportFixedCosts {
  /** The sum of `MonthView.fixedCosts` over the included months = the sum of `subscriptions[].cost`. */
  total: Cents;
  /** The sum of `subscriptions[].paid`: what the providers were paid in those months. */
  paid: Cents;
  /** Ascending by name ignoring case, then id. */
  subscriptions: YearlyReportSubscription[];
}

/**
 * One budget's line of the yearly report. It has a line when it is active in at least one of the
 * included months, even if nothing was spent.
 */
export interface YearlyReportBudget {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  /** The sum of `MonthBudgetLine.allocated` over the included months in which it is active. */
  allocated: Cents;
  /** The sum of `MonthBudgetLine.spent` over the included months in which it is active. */
  spent: Cents;
}

/**
 * GET /api/reports/yearly/:year → 200 YearlyReportDto. It is derived from the same ledger run as
 * `GET /api/months/:month`, so every figure is the sum of the month views of the included months
 * and can never disagree with them. 400 validation_error for a malformed `:year`
 * (`yearParamsSchema`).
 *
 * Which months are INCLUDED: those of the year from `settings.startMonth` to the current month + 120
 * (the months that exist, `MAX_MONTHS_AHEAD`). A month before the start month is not tracked and
 * not counted (it is not shown as zero); a month beyond the horizon does not exist. `status` tells
 * a final closed month from the current one and from a future projection (which assumes the current
 * month ends as it stands), and the totals cover ALL included months, projections too. 404
 * not_found when no month of the year is included (a year before the start month's year, or after
 * the horizon's).
 *
 * Identities: `income.total` = `income.salary` + `income.extra`; `spent` = the sum of
 * `budgets[].spent` = the sum of `months[].spent`; `saved` = the sum of `months[].saved`;
 * `fixedCosts.total` = the sum of `fixedCosts.subscriptions[].cost`; `saved` = `savedBreakdown`'s
 * three lines added up; and each month's figures are those of its month view.
 */
export interface YearlyReportDto {
  year: number;
  /** The first and the last included month: January or the start month, December or the horizon. */
  firstMonth: MonthKey;
  lastMonth: MonthKey;
  /** One entry per included month, ascending. */
  months: YearlyReportMonth[];
  /** The sums of `months[].income`. */
  income: MonthIncome;
  fixedCosts: YearlyReportFixedCosts;
  /** Ascending by `sortOrder`, then id (as in the month view). */
  budgets: YearlyReportBudget[];
  /** The sum of `months[].allocated`. */
  allocated: Cents;
  /** The sum of `months[].spent`: the net of spendings and refunds, = the sum of `budgets[].spent`. */
  spent: Cents;
  /** The sum of `months[].unallocated`. */
  unallocated: Cents;
  /** The sum of `months[].saved`: the savings due of the included months. */
  saved: Cents;
  /** The sums of `months[].savedBreakdown`: `saved` = the sum of the three lines. */
  savedBreakdown: SavingsDueBreakdown;
}
