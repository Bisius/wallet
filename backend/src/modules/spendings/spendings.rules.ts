import type { IsoDate, MonthKey } from '@wallet/shared';
import { monthOfDate } from '../../lib/today';
import { isWithinActiveMonths } from '../../lib/versioned';

/** The rules of docs/DOMAIN.md that a spending's date and budget must satisfy, in their order. */
export const SPENDING_RULES = [
  'unknown_budget',
  'before_start_month',
  'outside_active_months',
] as const;
export type SpendingRule = (typeof SPENDING_RULES)[number];

/** The part of a budget these rules read. */
export interface SpendingBudget {
  name: string;
  startMonth: MonthKey;
  endMonth: MonthKey | null;
}

/** The date's month is before `settings.startMonth`: nothing before it is accepted (`before_start_month`). */
export const isBeforeStartMonth = (date: IsoDate, startMonth: MonthKey): boolean =>
  monthOfDate(date) < startMonth;

/** A broken rule, as `ruleViolation` wants it: the rule, a message and the request field. */
export interface SpendingRuleBreak {
  rule: SpendingRule;
  message: string;
  field: 'budgetId' | 'date';
}

/**
 * THE check of docs/DOMAIN.md ("Editing rules") for where a spending may go: `POST` and `PATCH
 * /api/spendings` throw the first break (`assertSpendingAllowed`) and `POST /api/import/commit`
 * reports every one of them for a row, so the two can never disagree. It is pure: the caller has
 * loaded the budget (`undefined` when there is none with that id) and `settings.startMonth`, which
 * lets a commit of 10,000 rows check them without one query per row. A `date` of null (the importer
 * could not read the cell) skips the two rules about the date.
 *
 * Every rule that applies, in the documented order:
 *  1. `unknown_budget`: the budget exists.
 *  2. `before_start_month`: the date is not before `startMonth`.
 *  3. `outside_active_months`: the budget exists, the date is not before `startMonth` (that case is
 *     already reported by rule 2) and the date's month is outside the budget's active months.
 * The fourth rule of a spending, `unknown_tag`, comes after these and is not about the date.
 */
export function spendingRuleBreaks(
  target: { date: IsoDate | null; budgetId: number },
  budget: SpendingBudget | undefined,
  startMonth: MonthKey,
): SpendingRuleBreak[] {
  const breaks: SpendingRuleBreak[] = [];
  if (!budget) {
    breaks.push({
      rule: 'unknown_budget',
      message: `Budget ${target.budgetId} does not exist`,
      field: 'budgetId',
    });
  }

  if (target.date === null) return breaks;

  if (isBeforeStartMonth(target.date, startMonth)) {
    breaks.push({
      rule: 'before_start_month',
      message: `A spending cannot be dated ${target.date}, before the start month ${startMonth}`,
      field: 'date',
    });
  } else if (
    budget &&
    !isWithinActiveMonths(budget.startMonth, budget.endMonth, monthOfDate(target.date))
  ) {
    breaks.push({
      rule: 'outside_active_months',
      message:
        `${target.date} is outside the active months of "${budget.name}" ` +
        `(${budget.startMonth} to ${budget.endMonth ?? 'no end'})`,
      field: 'date',
    });
  }
  return breaks;
}
