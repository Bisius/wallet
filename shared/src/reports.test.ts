import { describe, expect, it } from 'vitest';
import { type YearlyReportDto, type YearlyReportMonth, yearParamsSchema } from './reports';
import { parseCases, schemaCases } from './test-utils';

describe('yearParamsSchema (GET /api/reports/yearly/:year)', () => {
  schemaCases(
    'path',
    yearParamsSchema,
    [
      ['a year', { year: '2026' }],
      ['the first year', { year: '0001' }],
      ['the last year', { year: '9999' }],
    ],
    [
      ['two digits', { year: '26' }, 'year'],
      ['five digits', { year: '02026' }, 'year'],
      ['year zero', { year: '0000' }, 'year'],
      ['a fraction', { year: '2026.5' }, 'year'],
      ['a sign', { year: '+2026' }, 'year'],
      ['a negative year', { year: '-2026' }, 'year'],
      ['a month', { year: '2026-10' }, 'year'],
      ['text', { year: 'abc' }, 'year'],
      ['a blank', { year: '' }, 'year'],
      ['an unknown key', { year: '2026', month: '10' }, ''],
    ],
  );

  parseCases('output', yearParamsSchema, [['a number', { year: '2026' }, { year: 2026 }]]);
});

describe('YearlyReportDto', () => {
  // A worked example of a two-month year: it type-checks the DTO and asserts the identities its
  // JSDoc promises, so the numbers document the contract for the frontend.
  const month = (m: Partial<YearlyReportMonth> & Pick<YearlyReportMonth, 'month'>) =>
    ({
      status: 'closed',
      income: { salary: 300000, extra: 0, total: 300000 },
      fixedCosts: 2000,
      allocated: 40000,
      spent: 35000,
      unallocated: 258000,
      saved: 263000,
      savedBreakdown: { unallocated: 258000, budgetsSettled: 5000, reservesReleased: 0 },
      ...m,
    }) satisfies YearlyReportMonth;

  const report: YearlyReportDto = {
    year: 2026,
    firstMonth: '2026-11',
    lastMonth: '2026-12',
    months: [month({ month: '2026-11' }), month({ month: '2026-12', status: 'future' })],
    income: { salary: 600000, extra: 0, total: 600000 },
    fixedCosts: {
      total: 4000,
      paid: 2598,
      subscriptions: [
        { id: 1, name: 'Netflix', color: null, frequency: 'monthly', cost: 2598, paid: 2598 },
        { id: 2, name: 'Domain', color: null, frequency: 'yearly', cost: 1402, paid: 0 },
      ],
    },
    budgets: [
      { id: 1, name: 'Groceries', color: null, icon: null, allocated: 80000, spent: 70000 },
    ],
    allocated: 80000,
    spent: 70000,
    unallocated: 516000,
    saved: 526000,
    savedBreakdown: { unallocated: 516000, budgetsSettled: 10000, reservesReleased: 0 },
  };

  it('adds up', () => {
    const sum = (pick: (m: YearlyReportMonth) => number) =>
      report.months.reduce((total, m) => total + pick(m), 0);
    expect(report.income.total).toBe(report.income.salary + report.income.extra);
    expect(report.income.total).toBe(sum((m) => m.income.total));
    expect(report.fixedCosts.total).toBe(sum((m) => m.fixedCosts));
    expect(report.fixedCosts.total).toBe(
      report.fixedCosts.subscriptions.reduce((total, line) => total + line.cost, 0),
    );
    expect(report.spent).toBe(sum((m) => m.spent));
    expect(report.spent).toBe(report.budgets.reduce((total, line) => total + line.spent, 0));
    expect(report.saved).toBe(sum((m) => m.saved));
    expect(report.saved).toBe(
      report.savedBreakdown.unallocated +
        report.savedBreakdown.budgetsSettled +
        report.savedBreakdown.reservesReleased,
    );
    for (const m of report.months) {
      expect(m.saved).toBe(
        m.savedBreakdown.unallocated +
          m.savedBreakdown.budgetsSettled +
          m.savedBreakdown.reservesReleased,
      );
    }
  });
});
