/**
 * The month as a whole (docs/DOMAIN.md: "Income", "Unallocated", "Savings", "Month states"):
 * income, unallocated and over-allocation, the savings due breakdown, empty months, the labels
 * closed / current / future, and late edits to closed months.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFact,
  budgetLineOf,
  income,
  makeFacts,
  monthOf,
  run,
  salary,
  spending,
  subscriptionFact,
} from '../testing/facts';
import { expectChainIdentities, expectMonthIdentities } from '../testing/month-identities';
import { computeLedger, ledgerMonth, toMonthSummary, toMonthView } from './ledger';

describe('income', () => {
  it('is the salary in effect plus the one-off incomes dated in the month', () => {
    // No salary before March (0), 2000.00 from March, 2200.00 from July. Incomes add up per month.
    const facts = makeFacts({
      salary: [salary('2026-07', 220000), salary('2026-03', 200000)],
      incomes: [
        income('2026-02', 5000),
        income('2026-03', 10000),
        income('2026-03', 2500),
        income('2026-07', 1),
      ],
    });
    const ledger = run(facts, '2026-08');
    expect(ledger.months.map((m) => [m.month, m.income])).toEqual([
      ['2026-01', { salary: 0, extra: 0, total: 0 }],
      ['2026-02', { salary: 0, extra: 5000, total: 5000 }],
      ['2026-03', { salary: 200000, extra: 12500, total: 212500 }],
      ['2026-04', { salary: 200000, extra: 0, total: 200000 }],
      ['2026-05', { salary: 200000, extra: 0, total: 200000 }],
      ['2026-06', { salary: 200000, extra: 0, total: 200000 }],
      ['2026-07', { salary: 220000, extra: 1, total: 220001 }],
      ['2026-08', { salary: 220000, extra: 0, total: 220000 }],
    ]);
  });

  it('a salary effective before the start month applies from the start month', () => {
    const facts = makeFacts({
      startMonth: '2026-03',
      salary: [salary('2025-06', 150000)],
      incomes: [income('2026-02', 999)], // before the start month: never computed
    });
    const ledger = run(facts, '2026-04');
    expect(ledger.months.map((m) => m.income.total)).toEqual([150000, 150000]);
  });
});

describe('unallocated and over-allocation', () => {
  it('is the income less subscriptions and allocations, and goes to savings in full', () => {
    // 3000.00 - 12.99 subscription - 400.00 - 150.00 allocated = 2437.01.
    const facts = makeFacts({
      salary: [salary('2026-01', 300000)],
      subscriptions: [subscriptionFact(1, { price: 1299 })],
      budgets: [
        budgetFact(1, { amount: 40000 }),
        budgetFact(2, { amount: 15000, incremental: true }),
      ],
    });
    const january = monthOf(run(facts, '2026-01'), '2026-01');
    expect(january.unallocated).toBe(243701);
    expect(january.overAllocated).toBe(false);
    expect(january.savingsDue.unallocated).toBe(243701);
    // Nothing spent: the non-incremental 400.00 also moves to savings, the incremental 150.00 stays.
    expect(january.savingsDue).toEqual({
      unallocated: 243701,
      budgetsSettled: 40000,
      reservesReleased: 0,
      total: 283701,
    });
  });

  it('is negative when more is planned than earned, and the shortfall is taken from savings', () => {
    // 1000.00 income, 50.00 subscription, 800.00 + 500.00 allocated: -350.00. Nothing is spent, so
    // both budgets settle in full (1300.00 to savings) and the month nets +950.00 = 1000 - 50.
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      subscriptions: [subscriptionFact(1, { price: 5000 })],
      budgets: [budgetFact(1, { amount: 80000 }), budgetFact(2, { amount: 50000 })],
    });
    const january = monthOf(run(facts, '2026-01'), '2026-01');
    expect(january.unallocated).toBe(-35000);
    expect(january.overAllocated).toBe(true);
    expect(january.savingsDue).toEqual({
      unallocated: -35000,
      budgetsSettled: 130000,
      reservesReleased: 0,
      total: 95000,
    });
    expectMonthIdentities(january);
  });

  it('flows into the savings due together with what the budgets overspend', () => {
    // Same, but budget 1 spends 900.00 of its 800.00: -100.00 taken from savings too.
    // Savings due: -350.00 (unallocated) + (-100.00 + 500.00) (budgets) = 50.00 = 1000 - 50 - 900.
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      subscriptions: [subscriptionFact(1, { price: 5000 })],
      budgets: [budgetFact(1, { amount: 80000 }), budgetFact(2, { amount: 50000 })],
      spendings: [spending(1, '2026-01', 90000)],
    });
    const january = monthOf(run(facts, '2026-01'), '2026-01');
    expect(january.savingsDue).toEqual({
      unallocated: -35000,
      budgetsSettled: 40000,
      reservesReleased: 0,
      total: 5000,
    });
    expect(january.overAllocated).toBe(true);
  });

  it('a month with no income and no budgets owes nothing; with fixed costs only it is negative', () => {
    const facts = makeFacts({
      subscriptions: [subscriptionFact(1, { price: 1000, start: '2026-02' })],
    });
    const ledger = run(facts, '2026-03');
    expect(ledger.months.map((m) => [m.unallocated, m.overAllocated, m.savingsDue.total])).toEqual([
      [0, false, 0],
      [-1000, true, -1000],
      [-1000, true, -1000],
    ]);
  });
});

describe('empty months', () => {
  it('have no lines and zero everywhere', () => {
    const ledger = run(makeFacts(), '2026-03');
    expect(ledger.months).toHaveLength(3);
    for (const m of ledger.months) {
      expect(m).toMatchObject({
        income: { salary: 0, extra: 0, total: 0 },
        fixedCosts: 0,
        subscriptions: [],
        budgets: [],
        totals: { allocated: 0, spent: 0, remaining: 0, transfersNet: 0 },
        unallocated: 0,
        overAllocated: false,
        savingsDue: { unallocated: 0, budgetsSettled: 0, reservesReleased: 0, total: 0 },
        subscriptionPayments: 0,
        heldInBudgets: 0,
        heldInReserves: 0,
      });
      expectMonthIdentities(m);
    }
  });

  it('covers exactly startMonth..throughMonth, and nothing when through is before the start', () => {
    const facts = makeFacts({ startMonth: '2026-03' });
    expect(run(facts, '2026-03').months.map((m) => m.month)).toEqual(['2026-03']);
    expect(run(facts, '2026-06').months.map((m) => m.month)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    expect(run(facts, '2026-02').months).toEqual([]);
    expect(run(makeFacts({ startMonth: '2025-11' }), '2026-02').months.map((m) => m.month)).toEqual(
      ['2025-11', '2025-12', '2026-01', '2026-02'],
    );
  });

  it('finds a row by month', () => {
    const ledger = run(makeFacts({ startMonth: '2025-11' }), '2026-02');
    expect(ledgerMonth(ledger, '2026-01')?.month).toBe('2026-01');
    expect(ledgerMonth(ledger, '2025-10')).toBeUndefined();
    expect(ledgerMonth(ledger, '2026-03')).toBeUndefined();
    expect(ledgerMonth(ledger, 'nope')).toBeUndefined();
  });
});

describe('month states', () => {
  const statuses = (today: string) =>
    run(makeFacts(), '2026-05', today).months.map((m) => m.status);

  it.each<[string, string, string[]]>([
    [
      'before the start month everything is still ahead',
      '2025-12-31',
      ['future', 'future', 'future', 'future', 'future'],
    ],
    [
      'on the first day of the first month',
      '2026-01-01',
      ['current', 'future', 'future', 'future', 'future'],
    ],
    ['mid-March', '2026-03-15', ['closed', 'closed', 'current', 'future', 'future']],
    ['on the last day of March', '2026-03-31', ['closed', 'closed', 'current', 'future', 'future']],
    [
      'on the first day of April',
      '2026-04-01',
      ['closed', 'closed', 'closed', 'current', 'future'],
    ],
    ['on the last day of May', '2026-05-31', ['closed', 'closed', 'closed', 'closed', 'current']],
    ['a year later', '2027-05-01', ['closed', 'closed', 'closed', 'closed', 'closed']],
  ])('%s', (_label, today, expected) => {
    expect(statuses(today)).toEqual(expected);
  });

  it('only labels: closed, current and future months follow exactly the same rules', () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 250000)],
      subscriptions: [
        subscriptionFact(1, { price: 999 }),
        subscriptionFact(2, {
          name: 'Yearly',
          frequency: 'yearly',
          price: 12000,
          anchor: '2025-09-01',
        }),
      ],
      budgets: [
        budgetFact(1, { amount: 30000, incremental: true, end: '2026-07' }),
        budgetFact(2, { amount: 20000, changes: [['2026-04', 25000, true]] }),
      ],
      spendings: [
        spending(1, '2026-02', 35000),
        spending(2, '2026-05', 4000),
        spending(2, '2026-06', 90000),
      ],
    });
    const unlabelled = (today: string) =>
      run(facts, '2026-12', today).months.map((m) => ({ ...m, status: '' }));
    const reference = unlabelled('2026-04-10');
    for (const today of ['2025-01-01', '2026-01-31', '2026-06-30', '2026-12-31', '2030-01-01']) {
      expect(unlabelled(today)).toEqual(reference);
    }
  });

  it('projects a future month from the current one as if the current month ended as it stands', () => {
    // Incremental, 100.00 a month; January leaves 100.00. Today is in February with 40.00 spent so
    // far: February is projected to carry 100.00 + 100.00 - 40.00 = 160.00 and March starts from
    // that (260.00 available).
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      spendings: [spending(1, '2026-02', 4000)],
    });
    const ledger = run(facts, '2026-04', '2026-02-10');
    expect(monthOf(ledger, '2026-02')).toMatchObject({ status: 'current' });
    expect(budgetLineOf(ledger, '2026-02', 1)).toMatchObject({
      remaining: 16000,
      carriedOut: 16000,
    });
    expect(budgetLineOf(ledger, '2026-03', 1)).toMatchObject({
      carriedIn: 16000,
      available: 26000,
    });
    expect(monthOf(ledger, '2026-03').status).toBe('future');
    expect(monthOf(ledger, '2026-04').status).toBe('future');
  });
});

describe('a late edit to a closed month', () => {
  // Three closed months (today is in April). Budget 1 settles every month; budget 2 is incremental
  // and archived after March.
  const before = makeFacts({
    salary: [salary('2026-01', 100000)],
    budgets: [
      budgetFact(1, { amount: 40000 }),
      budgetFact(2, { amount: 10000, incremental: true, end: '2026-03' }),
    ],
    spendings: [
      spending(1, '2026-01', 30000),
      spending(1, '2026-02', 20000),
      spending(1, '2026-03', 10000),
      spending(2, '2026-01', 4000),
      spending(2, '2026-02', 1000),
      spending(2, '2026-03', 2000),
    ],
  });
  const today = '2026-04-10';
  const savingsDue = (facts: typeof before) =>
    run(facts, '2026-03', today).months.map((m) => m.savingsDue.total);

  it('the starting point', () => {
    // Unallocated is 1000.00 - 400.00 - 100.00 = 500.00 every month.
    // Jan: budget 1 settles 100.00, budget 2 carries 60.00.          -> 500 + 100 = 600.00
    // Feb: budget 1 settles 200.00, budget 2 carries 60 + 90 = 150.00. -> 500 + 200 = 700.00
    // Mar: budget 1 settles 300.00, budget 2: 150 + 100 - 20 = 230.00 settles (archived). -> 500 + 300 + 230 = 1030.00
    expect(savingsDue(before)).toEqual([60000, 70000, 103000]);
    expect(run(before, '2026-03', today).months.map((m) => m.status)).toEqual([
      'closed',
      'closed',
      'closed',
    ]);
  });

  it("a forgotten spending on a settling budget changes that month's savings due, and only that month", () => {
    // 40.00 more spent in February on budget 1: February owes 40.00 less.
    const after = { ...before, spendings: [...before.spendings, spending(1, '2026-02', 4000)] };
    expect(savingsDue(after)).toEqual([60000, 66000, 103000]);
    expect(budgetLineOf(run(after, '2026-03', today), '2026-02', 1).toSavings).toBe(16000);
  });

  it('a forgotten spending on an incremental budget moves into the month where the budget settles', () => {
    // 30.00 more spent in February on budget 2: February's carry shrinks by 30.00, so March has
    // 30.00 less available and settles 30.00 less. February and January owe the same as before.
    const after = { ...before, spendings: [...before.spendings, spending(2, '2026-02', 3000)] };
    const ledger = run(after, '2026-03', today);
    expect(savingsDue(after)).toEqual([60000, 70000, 100000]);
    expect(budgetLineOf(ledger, '2026-02', 2)).toMatchObject({
      remaining: 12000,
      carriedOut: 12000,
    });
    expect(budgetLineOf(ledger, '2026-03', 2)).toMatchObject({
      carriedIn: 12000,
      toSavings: 20000,
    });
    ledger.months.forEach((m) => expectMonthIdentities(m));
  });

  it('a forgotten income changes that month and nothing else', () => {
    const after = { ...before, incomes: [income('2026-02', 25000)] };
    expect(savingsDue(after)).toEqual([60000, 95000, 103000]);
  });

  it('a deleted spending gives the money back to that month', () => {
    const after = {
      ...before,
      spendings: before.spendings.filter((s) => !(s.budgetId === 1 && s.month === '2026-03')),
    };
    expect(savingsDue(after)).toEqual([60000, 70000, 113000]);
  });
});

describe('missing or odd facts', () => {
  it('reads a missing price as 0 and a missing version as an unallocated, non-incremental budget', () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      subscriptions: [
        { ...subscriptionFact(1, { price: 1 }), prices: [] },
        { ...subscriptionFact(2, { price: 1, frequency: 'yearly' }), prices: [] },
      ],
      budgets: [{ ...budgetFact(1, { amount: 1 }), versions: [] }],
      spendings: [spending(1, '2026-01', 500)],
    });
    const january = monthOf(run(facts, '2026-01'), '2026-01');
    expect(january.fixedCosts).toBe(0);
    expect(january.budgets[0]).toMatchObject({
      allocated: 0,
      incremental: false,
      available: 0,
      spent: 500,
      remaining: -500,
      usagePercent: null,
      alert: 'over',
      toSavings: -500,
    });
    expectMonthIdentities(january);
  });

  it('rejects an invalid month or date instead of looping or guessing', () => {
    expect(() => computeLedger(makeFacts(), '2026-13', '2026-01-01')).toThrow(RangeError);
    expect(() => computeLedger(makeFacts(), '2026-03', '2026-3-1')).toThrow(RangeError);
    expect(() => computeLedger(makeFacts(), '2026-03', '2026-03')).toThrow(RangeError);
    expect(() => computeLedger(makeFacts({ startMonth: 'soon' }), '2026-03', '2026-01-01')).toThrow(
      RangeError,
    );
  });

  it('does not change the facts it is given', () => {
    const facts = makeFacts({
      salary: [salary('2026-03', 1), salary('2026-01', 2)],
      budgets: [
        budgetFact(2, { amount: 5, changes: [['2026-03', 7]] }),
        budgetFact(1, { amount: 9 }),
      ],
      subscriptions: [
        subscriptionFact(2, { name: 'b', price: 1 }),
        subscriptionFact(1, { name: 'a', price: 1 }),
      ],
    });
    const copy = structuredClone(facts);
    run(facts, '2026-06');
    expect(facts).toEqual(copy);
  });
});

describe('the API shapes', () => {
  it('toMonthView keeps exactly the MonthView fields, and toMonthSummary the summary fields', () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [budgetFact(1, { amount: 10000 })],
    });
    const row = monthOf(run(facts, '2026-01'), '2026-01');
    const view = toMonthView(row);
    expect(Object.keys(view).sort()).toEqual([
      'budgets',
      'fixedCosts',
      'income',
      'month',
      'overAllocated',
      'savingsDue',
      'status',
      'subscriptions',
      'totals',
      'unallocated',
    ]);
    expect(toMonthSummary(row)).toEqual({
      month: '2026-01',
      status: 'closed',
      income: 100000,
      fixedCosts: 0,
      allocated: 10000,
      spent: 0,
      unallocated: 90000,
      savingsDue: 100000,
    });
    expectChainIdentities([view], { startsAtLedgerStart: true });
  });
});
