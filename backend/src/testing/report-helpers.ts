/**
 * The check behind the promise of the yearly report: it is made of the month views, so it cannot
 * disagree with them. `expectReportMatchesMonthViews` reads `GET /api/months/:month` (and
 * `GET /api/months`) for every month the report includes and compares every figure, line by line
 * and in total, with the sums of the views.
 */
import type { MonthSummary, MonthView, YearlyReportDto } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { paymentsOf } from './month-identities';

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

export async function expectReportMatchesMonthViews(
  app: Express,
  report: YearlyReportDto,
): Promise<MonthView[]> {
  const views: MonthView[] = [];
  for (const row of report.months) {
    const res = await request(app).get(`/api/months/${row.month}`).expect(200);
    views.push(res.body as MonthView);
  }
  expect(report.months.map((row) => row.month)).toEqual(views.map((view) => view.month));
  expect(report.firstMonth).toBe(views[0]?.month);
  expect(report.lastMonth).toBe(views[views.length - 1]?.month);

  // Month by month: every figure of the row is the figure of the view.
  report.months.forEach((row, index) => {
    const view = views[index] as MonthView;
    expect(row, view.month).toEqual({
      month: view.month,
      status: view.status,
      income: view.income,
      fixedCosts: view.fixedCosts,
      allocated: view.totals.allocated,
      spent: view.totals.spent,
      unallocated: view.unallocated,
      saved: view.savingsDue.total,
      savedBreakdown: {
        unallocated: view.savingsDue.unallocated,
        budgetsSettled: view.savingsDue.budgetsSettled,
        reservesReleased: view.savingsDue.reservesReleased,
      },
    });
  });

  // The totals are the sums of the views.
  expect(report.income).toEqual({
    salary: sum(views.map((v) => v.income.salary)),
    extra: sum(views.map((v) => v.income.extra)),
    total: sum(views.map((v) => v.income.total)),
  });
  expect(report.fixedCosts.total).toBe(sum(views.map((v) => v.fixedCosts)));
  expect(report.fixedCosts.paid).toBe(sum(views.map(paymentsOf)));
  expect(report.allocated).toBe(sum(views.map((v) => v.totals.allocated)));
  expect(report.spent).toBe(sum(views.map((v) => v.totals.spent)));
  expect(report.unallocated).toBe(sum(views.map((v) => v.unallocated)));
  expect(report.saved).toBe(sum(views.map((v) => v.savingsDue.total)));
  expect(report.savedBreakdown).toEqual({
    unallocated: sum(views.map((v) => v.savingsDue.unallocated)),
    budgetsSettled: sum(views.map((v) => v.savingsDue.budgetsSettled)),
    reservesReleased: sum(views.map((v) => v.savingsDue.reservesReleased)),
  });
  expect(report.saved).toBe(
    report.savedBreakdown.unallocated +
      report.savedBreakdown.budgetsSettled +
      report.savedBreakdown.reservesReleased,
  );

  // One line per budget and per subscription that has a line in some month, each the sum of its lines.
  const budgetIds = new Set(views.flatMap((v) => v.budgets.map((b) => b.id)));
  expect(report.budgets.map((b) => b.id).sort()).toEqual([...budgetIds].sort());
  for (const line of report.budgets) {
    const own = views.flatMap((v) => v.budgets.filter((b) => b.id === line.id));
    expect(line.spent, `budget ${line.name} spent`).toBe(sum(own.map((b) => b.spent)));
    expect(line.allocated, `budget ${line.name} allocated`).toBe(sum(own.map((b) => b.allocated)));
  }
  expect(sum(report.budgets.map((b) => b.spent))).toBe(report.spent);
  expect(sum(report.budgets.map((b) => b.allocated))).toBe(report.allocated);

  const subscriptionIds = new Set(views.flatMap((v) => v.subscriptions.map((s) => s.id)));
  expect(report.fixedCosts.subscriptions.map((s) => s.id).sort()).toEqual(
    [...subscriptionIds].sort(),
  );
  for (const line of report.fixedCosts.subscriptions) {
    const own = views.flatMap((v) => v.subscriptions.filter((s) => s.id === line.id));
    expect(line.cost, `subscription ${line.name} cost`).toBe(sum(own.map((s) => s.charge)));
    expect(line.paid, `subscription ${line.name} paid`).toBe(
      sum(own.map((s) => (s.frequency === 'monthly' || s.renewalThisMonth ? s.price : 0))),
    );
  }
  expect(sum(report.fixedCosts.subscriptions.map((s) => s.cost))).toBe(report.fixedCosts.total);
  expect(sum(report.fixedCosts.subscriptions.map((s) => s.paid))).toBe(report.fixedCosts.paid);

  // The compact list of the months says the same.
  const summaries = (
    await request(app)
      .get(`/api/months?from=${report.firstMonth}&to=${report.lastMonth}`)
      .expect(200)
  ).body as MonthSummary[];
  expect(summaries.map((s) => s.savingsDue)).toEqual(report.months.map((m) => m.saved));
  expect(summaries.map((s) => s.spent)).toEqual(report.months.map((m) => m.spent));
  return views;
}
