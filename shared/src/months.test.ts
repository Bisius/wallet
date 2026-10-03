import { describe, expect, it } from 'vitest';
import { addMonths } from './month';
import {
  MAX_MONTH_RANGE,
  type MonthBudgetLine,
  type MonthSubscriptionLine,
  type MonthSummary,
  type MonthView,
  monthListQuerySchema,
} from './months';
import { schemaCases } from './test-utils';

describe('monthListQuerySchema (GET /api/months)', () => {
  schemaCases(
    'query',
    monthListQuerySchema,
    [
      ['no range (server defaults)', {}],
      ['only from', { from: '2026-01' }],
      ['only to', { to: '2027-09' }],
      ['one month', { from: '2026-10', to: '2026-10' }],
      ['a year', { from: '2026-01', to: '2026-12' }],
      ['the widest range', { from: '2026-01', to: addMonths('2026-01', MAX_MONTH_RANGE - 1) }],
    ],
    [
      ['a bad from', { from: '2026-13' }, 'from'],
      ['a bad to', { to: '2026' }, 'to'],
      ['garbage next to a valid month', { from: 'garbage', to: '2026-10' }, 'from'],
      ['from after to', { from: '2026-10', to: '2026-09' }, 'to'],
      [
        'a range one month too wide',
        { from: '2026-01', to: addMonths('2026-01', MAX_MONTH_RANGE) },
        'to',
      ],
      ['a huge range', { from: '0001-01', to: '9999-12' }, 'to'],
      ['a date instead of a month', { from: '2026-10-01' }, 'from'],
      ['an unknown key', { month: '2026-10' }, ''],
    ],
  );

  it('does not throw on malformed keys', () => {
    expect(() => monthListQuerySchema.safeParse({ from: 'x', to: 'y' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// A worked example. It type-checks the DTOs and asserts every identity their JSDoc promises, so
// the numbers double as documentation for the frontend and a template for the backend tests.
// ---------------------------------------------------------------------------------------------

const groceries: MonthBudgetLine = {
  id: 1,
  name: 'Groceries',
  color: '#16a34a',
  icon: 'shopping-cart',
  incremental: true,
  endsThisMonth: false,
  carriedIn: 5000,
  allocated: 40000,
  transfersNet: 0,
  available: 45000,
  spent: 36500,
  remaining: 8500,
  usagePercent: 81, // floor(100 * 36500 / 45000) = floor(81.1)
  warnPercent: 80,
  alert: 'warning',
  carriedOut: 8500, // incremental and not ending: the remainder carries over
  toSavings: 0,
};

const fun: MonthBudgetLine = {
  id: 2,
  name: 'Fun',
  color: null,
  icon: null,
  incremental: false,
  endsThisMonth: false,
  carriedIn: 0,
  allocated: 10000,
  transfersNet: 0,
  available: 10000,
  spent: 12000,
  remaining: -2000,
  usagePercent: 120,
  warnPercent: 80,
  alert: 'over',
  carriedOut: 0, // not incremental: starts clean...
  toSavings: -2000, // ...and the deficit is taken from savings
};

const holidays: MonthBudgetLine = {
  id: 3,
  name: 'Old holiday',
  color: null,
  icon: null,
  incremental: true,
  endsThisMonth: true,
  carriedIn: 3000,
  allocated: 2000,
  transfersNet: 0,
  available: 5000,
  spent: 0,
  remaining: 5000,
  usagePercent: 0,
  warnPercent: 80,
  alert: 'ok',
  carriedOut: 0, // archived: nothing carries over...
  toSavings: 5000, // ...the whole balance moves to savings
};

const netflix: MonthSubscriptionLine = {
  id: 1,
  name: 'Netflix',
  color: null,
  frequency: 'monthly',
  price: 1299,
  charge: 1299,
  reserveBalance: 0,
  renewalThisMonth: false,
  nextRenewalMonth: null,
  nextRenewalPrice: null,
  reserveReleased: 0,
  endsThisMonth: false,
};

const domain: MonthSubscriptionLine = {
  id: 2,
  name: 'Domain',
  color: '#2563eb',
  frequency: 'yearly',
  price: 12000, // per year, renews in March
  charge: 2000, // October to March is 6 months: 12000 / 6
  reserveBalance: 2000, // first month of the reserve
  renewalThisMonth: false,
  nextRenewalMonth: '2027-03',
  nextRenewalPrice: 12000,
  reserveReleased: 0,
  endsThisMonth: false,
};

const october: MonthView = {
  month: '2026-10',
  status: 'current',
  income: { salary: 250000, extra: 10000, total: 260000 },
  fixedCosts: 3299,
  subscriptions: [domain, netflix],
  budgets: [groceries, fun, holidays],
  totals: { allocated: 52000, spent: 48500, remaining: 11500, transfersNet: 0 },
  unallocated: 204701,
  overAllocated: false,
  savingsDue: { unallocated: 204701, budgetsSettled: 3000, reservesReleased: 0, total: 207701 },
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function checkIdentities(view: MonthView) {
  const lines = view.budgets;
  expect(view.income.total).toBe(view.income.salary + view.income.extra);
  expect(view.fixedCosts).toBe(sum(view.subscriptions.map((s) => s.charge)));
  expect(view.totals).toEqual({
    allocated: sum(lines.map((b) => b.allocated)),
    spent: sum(lines.map((b) => b.spent)),
    remaining: sum(lines.map((b) => b.remaining)),
    transfersNet: sum(lines.map((b) => b.transfersNet)),
  });
  expect(view.unallocated).toBe(
    view.income.total - view.fixedCosts - view.totals.allocated - view.totals.transfersNet,
  );
  expect(view.overAllocated).toBe(view.unallocated < 0);
  expect(view.savingsDue.unallocated).toBe(view.unallocated);
  expect(view.savingsDue.budgetsSettled).toBe(sum(lines.map((b) => b.toSavings)));
  expect(view.savingsDue.reservesReleased).toBe(
    sum(view.subscriptions.map((s) => s.reserveReleased)),
  );
  expect(view.savingsDue.total).toBe(
    view.savingsDue.unallocated + view.savingsDue.budgetsSettled + view.savingsDue.reservesReleased,
  );
  for (const b of lines) {
    expect(b.available).toBe(b.carriedIn + b.allocated + b.transfersNet);
    expect(b.remaining).toBe(b.available - b.spent);
    expect(b.remaining).toBe(b.carriedOut + b.toSavings); // invariant 1 of DOMAIN.md
    expect(b.alert === 'over').toBe(b.spent > b.available);
    expect(b.usagePercent).toBe(
      b.available > 0 ? Math.max(0, Math.floor((100 * b.spent) / b.available)) : null,
    );
    const shouldWarn = b.available > 0 && 100 * b.spent >= b.warnPercent * b.available;
    expect(b.alert).toBe(b.spent > b.available ? 'over' : shouldWarn ? 'warning' : 'ok');
    expect(b.carriedOut).toBe(b.incremental && !b.endsThisMonth ? b.remaining : 0);
  }
}

function summarize(view: MonthView): MonthSummary {
  return {
    month: view.month,
    status: view.status,
    income: view.income.total,
    fixedCosts: view.fixedCosts,
    allocated: view.totals.allocated,
    spent: view.totals.spent,
    unallocated: view.unallocated,
    savingsDue: view.savingsDue.total,
  };
}

describe('MonthView worked example (2026-10)', () => {
  it('satisfies every documented identity', () => {
    checkIdentities(october);
  });

  it('flags an over-allocated month', () => {
    const overAllocated: MonthView = {
      ...october,
      income: { salary: 40000, extra: 0, total: 40000 },
      unallocated: 40000 - 3299 - 52000,
      overAllocated: true,
      savingsDue: {
        unallocated: 40000 - 3299 - 52000,
        budgetsSettled: 3000,
        reservesReleased: 0,
        total: 40000 - 3299 - 52000 + 3000,
      },
    };
    checkIdentities(overAllocated);
    expect(overAllocated.unallocated).toBeLessThan(0);
  });

  it('summarizes to the same numbers', () => {
    expect(summarize(october)).toEqual({
      month: '2026-10',
      status: 'current',
      income: 260000,
      fixedCosts: 3299,
      allocated: 52000,
      spent: 48500,
      unallocated: 204701,
      savingsDue: 207701,
    });
  });
});
