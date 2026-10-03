import {
  MAX_MONTHS_AHEAD,
  type SavingsDueBreakdown,
  type YearlyReportBudget,
  type YearlyReportDto,
  type YearlyReportMonth,
  type YearlyReportSubscription,
  addMonths,
  toMonthKey,
} from '@wallet/shared';
import { loadFacts } from '../../domain/facts';
import { type LedgerMonth, computeLedger } from '../../domain/ledger';
import type { Deps } from '../../lib/deps';
import { apiError } from '../../lib/errors';
import { nameCollator } from '../../lib/names';
import { currentMonthOf, todayOf } from '../../lib/today';

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

const toReportMonth = (row: LedgerMonth): YearlyReportMonth => ({
  month: row.month,
  status: row.status,
  income: row.income,
  fixedCosts: row.fixedCosts,
  allocated: row.totals.allocated,
  spent: row.totals.spent,
  unallocated: row.unallocated,
  saved: row.savingsDue.total,
  savedBreakdown: {
    unallocated: row.savingsDue.unallocated,
    budgetsSettled: row.savingsDue.budgetsSettled,
    reservesReleased: row.savingsDue.reservesReleased,
  },
});

/**
 * GET /api/reports/yearly/:year (docs/DOMAIN.md, "Yearly report"). Everything is a sum over the
 * ledger rows of the INCLUDED months, the months of the year from `startMonth` to the current month
 * + MAX_MONTHS_AHEAD: the same rows `GET /api/months/:month` is made of, from one run of the
 * engine, so the report cannot disagree with the month views. A year with no included month is a
 * 404.
 */
export function getYearlyReport(deps: Deps, year: number): YearlyReportDto {
  const facts = loadFacts(deps.db);
  const horizon = addMonths(currentMonthOf(deps.clock), MAX_MONTHS_AHEAD);
  const january = toMonthKey(year, 1);
  const december = toMonthKey(year, 12);
  const firstMonth = january > facts.startMonth ? january : facts.startMonth;
  const lastMonth = december < horizon ? december : horizon;
  if (firstMonth > lastMonth) {
    throw apiError(
      'not_found',
      `No tracked month in ${year} (the tracked months are ${facts.startMonth} to ${horizon})`,
    );
  }

  const ledger = computeLedger(facts, lastMonth, todayOf(deps.clock));
  const rows = ledger.months.filter((row) => row.month >= firstMonth);
  const months = rows.map(toReportMonth);

  // One line per subscription and per budget that is active in at least one included month.
  const subscriptions = new Map<number, YearlyReportSubscription>();
  const budgets = new Map<number, YearlyReportBudget>();
  for (const row of rows) {
    for (const line of row.subscriptions) {
      const entry = subscriptions.get(line.id) ?? {
        id: line.id,
        name: line.name,
        color: line.color,
        frequency: line.frequency,
        cost: 0,
        paid: 0,
      };
      entry.cost += line.charge;
      // What the provider is paid: a monthly price every month, a yearly price in its renewal month.
      entry.paid += line.frequency === 'monthly' || line.renewalThisMonth ? line.price : 0;
      subscriptions.set(line.id, entry);
    }
    for (const line of row.budgets) {
      const entry = budgets.get(line.id) ?? {
        id: line.id,
        name: line.name,
        color: line.color,
        icon: line.icon,
        allocated: 0,
        spent: 0,
      };
      entry.allocated += line.allocated;
      entry.spent += line.spent;
      budgets.set(line.id, entry);
    }
  }

  const sortOrder = new Map(facts.budgets.map((budget) => [budget.id, budget.sortOrder]));
  const subscriptionLines = [...subscriptions.values()].sort(
    (a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id,
  );
  const budgetLines = [...budgets.values()].sort(
    (a, b) => (sortOrder.get(a.id) ?? 0) - (sortOrder.get(b.id) ?? 0) || a.id - b.id,
  );

  const savedBreakdown: SavingsDueBreakdown = {
    unallocated: sum(months.map((month) => month.savedBreakdown.unallocated)),
    budgetsSettled: sum(months.map((month) => month.savedBreakdown.budgetsSettled)),
    reservesReleased: sum(months.map((month) => month.savedBreakdown.reservesReleased)),
  };
  const salary = sum(months.map((month) => month.income.salary));
  const extra = sum(months.map((month) => month.income.extra));

  return {
    year,
    firstMonth,
    lastMonth,
    months,
    income: { salary, extra, total: salary + extra },
    fixedCosts: {
      total: sum(months.map((month) => month.fixedCosts)),
      paid: sum(subscriptionLines.map((line) => line.paid)),
      subscriptions: subscriptionLines,
    },
    budgets: budgetLines,
    allocated: sum(months.map((month) => month.allocated)),
    spent: sum(months.map((month) => month.spent)),
    unallocated: sum(months.map((month) => month.unallocated)),
    saved: sum(months.map((month) => month.saved)),
    savedBreakdown,
  };
}
