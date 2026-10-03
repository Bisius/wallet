/**
 * Budgets in the ledger (docs/DOMAIN.md, "Budgets"): allocation, carry-over of incremental
 * budgets, settlement of the others, archiving, amount and mode changes, refunds and alerts. Every
 * expected figure is worked out by hand in the comments.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFact,
  budgetLineOf,
  budgetSeries,
  makeFacts,
  monthOf,
  run,
  salary,
  spending,
} from '../testing/facts';
import { expectChainIdentities, expectMonthIdentities } from '../testing/month-identities';
import { alertOf, usagePercentOf } from './ledger';

/** The figures of one month as a tuple: carriedIn, available, spent, remaining, carriedOut, toSavings. */
function figures(line: ReturnType<typeof budgetLineOf>) {
  return [
    line.carriedIn,
    line.available,
    line.spent,
    line.remaining,
    line.carriedOut,
    line.toSavings,
  ];
}

describe('incremental budgets', () => {
  it('carry a surplus from month to month', () => {
    // 100.00 a month, spending 30.00, 140.00 and 50.00, then nothing.
    // Jan: 0 + 10000 = 10000, spend 3000 -> 7000 carried.
    // Feb: 7000 + 10000 = 17000, spend 14000 -> 3000 carried.
    // Mar: 3000 + 10000 = 13000, spend 5000 -> 8000 carried.
    // Apr: 8000 + 10000 = 18000, spend 0 -> 18000 carried.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      spendings: [
        spending(1, '2026-01', 3000),
        spending(1, '2026-02', 14000),
        spending(1, '2026-03', 5000),
      ],
    });
    const ledger = run(facts, '2026-04');
    expect(
      ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 3000, 7000, 7000, 0],
      [7000, 17000, 14000, 3000, 3000, 0],
      [3000, 13000, 5000, 8000, 8000, 0],
      [8000, 18000, 0, 18000, 18000, 0],
    ]);
    expect(ledger.months.map((m) => m.heldInBudgets)).toEqual([7000, 3000, 8000, 18000]);
    // Nothing of an incremental budget goes to savings while it runs.
    expect(ledger.months.map((m) => m.savingsDue.budgetsSettled)).toEqual([0, 0, 0, 0]);
  });

  it('carry a deficit too, and recover from it', () => {
    // Same budget, but February overspends by 70.00:
    // Feb: 7000 + 10000 = 17000, spend 24000 -> -7000 carried.
    // Mar: -7000 + 10000 = 3000, spend 5000 -> -2000 carried.
    // Apr: -2000 + 10000 = 8000, spend 0 -> 8000 carried.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      spendings: [
        spending(1, '2026-01', 3000),
        spending(1, '2026-02', 24000),
        spending(1, '2026-03', 5000),
      ],
    });
    const ledger = run(facts, '2026-04');
    expect(
      ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 3000, 7000, 7000, 0],
      [7000, 17000, 24000, -7000, -7000, 0],
      [-7000, 3000, 5000, -2000, -2000, 0],
      [-2000, 8000, 0, 8000, 8000, 0],
    ]);
    expect(budgetSeries(ledger, 1, 'alert').map(([, v]) => v)).toEqual([
      'ok',
      'over',
      'over',
      'ok',
    ]);
    // 100 * 24000 / 17000 = 141.17 and 100 * 5000 / 3000 = 166.67, rounded down.
    expect(budgetSeries(ledger, 1, 'usagePercent').map(([, v]) => v)).toEqual([30, 141, 166, 0]);
    // The deficit is held by the budget, not taken from savings, so it reduces what is held.
    expect(ledger.months.map((m) => m.heldInBudgets)).toEqual([7000, -7000, -2000, 8000]);
    expect(ledger.months.map((m) => m.savingsDue.budgetsSettled)).toEqual([0, 0, 0, 0]);
  });

  it('can run a deficit with no allocation at all, which later allocations pay off', () => {
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 0, incremental: true, changes: [['2026-02', 5000]] })],
      spendings: [spending(1, '2026-01', 1500)],
    });
    const ledger = run(facts, '2026-03');
    expect(
      ['2026-01', '2026-02', '2026-03'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 0, 1500, -1500, -1500, 0],
      [-1500, 3500, 0, 3500, 3500, 0],
      [3500, 8500, 0, 8500, 8500, 0],
    ]);
  });
});

describe('non-incremental budgets', () => {
  it('send a leftover to savings and start clean', () => {
    // 100.00 a month, spent 40.00 then 55.00: 60.00 and 45.00 move to savings, nothing carries.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: false })],
      spendings: [spending(1, '2026-01', 4000), spending(1, '2026-02', 5500)],
    });
    const ledger = run(facts, '2026-03');
    expect(
      ['2026-01', '2026-02', '2026-03'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 4000, 6000, 0, 6000],
      [0, 10000, 5500, 4500, 0, 4500],
      [0, 10000, 0, 10000, 0, 10000],
    ]);
  });

  it('take an overspend from savings, and the next month starts clean', () => {
    // January spends 150.00 of 100.00: 50.00 is taken from savings. February is not affected.
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [budgetFact(1, { amount: 10000, incremental: false })],
      spendings: [spending(1, '2026-01', 15000), spending(1, '2026-02', 4000)],
    });
    const ledger = run(facts, '2026-02');
    expect(figures(budgetLineOf(ledger, '2026-01', 1))).toEqual([0, 10000, 15000, -5000, 0, -5000]);
    expect(figures(budgetLineOf(ledger, '2026-02', 1))).toEqual([0, 10000, 4000, 6000, 0, 6000]);
    expect(budgetLineOf(ledger, '2026-01', 1).alert).toBe('over');
    // January: unallocated 100000 - 10000 = 90000, minus the 5000 taken from savings.
    expect(monthOf(ledger, '2026-01').savingsDue).toEqual({
      unallocated: 90000,
      budgetsSettled: -5000,
      reservesReleased: 0,
      total: 85000,
    });
    expect(monthOf(ledger, '2026-02').savingsDue.total).toBe(90000 + 6000);
  });
});

describe("changing a budget's mode", () => {
  it('incremental to non-incremental releases the accumulated balance at the end of that month', () => {
    // Incremental through February, non-incremental from March (100.00 a month throughout).
    // Jan: 10000 - 2000 = 8000 carried. Feb: 8000 + 10000 - 3000 = 15000 carried.
    // Mar (non-incremental): 15000 + 10000 = 25000, spend 4000 -> 21000, ALL of it to savings.
    // Apr: starts clean: 10000 - 1000 = 9000 to savings.
    const facts = makeFacts({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: true, changes: [['2026-03', 10000, false]] }),
      ],
      spendings: [
        spending(1, '2026-01', 2000),
        spending(1, '2026-02', 3000),
        spending(1, '2026-03', 4000),
        spending(1, '2026-04', 1000),
      ],
    });
    const ledger = run(facts, '2026-04');
    expect(
      ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 2000, 8000, 8000, 0],
      [8000, 18000, 3000, 15000, 15000, 0],
      [15000, 25000, 4000, 21000, 0, 21000],
      [0, 10000, 1000, 9000, 0, 9000],
    ]);
    expect(budgetSeries(ledger, 1, 'incremental').map(([, v]) => v)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(monthOf(ledger, '2026-03').savingsDue.budgetsSettled).toBe(21000);
  });

  it('non-incremental to incremental starts the balance from nothing', () => {
    // Settled to savings in January and February; from March it accumulates.
    // Mar: 0 + 10000 - 4000 = 6000 carried. Apr: 6000 + 10000 - 0 = 16000 carried.
    const facts = makeFacts({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: false, changes: [['2026-03', 10000, true]] }),
      ],
      spendings: [spending(1, '2026-01', 2000), spending(1, '2026-03', 4000)],
    });
    const ledger = run(facts, '2026-04');
    expect(
      ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 2000, 8000, 0, 8000],
      [0, 10000, 0, 10000, 0, 10000],
      [0, 10000, 4000, 6000, 6000, 0],
      [6000, 16000, 0, 16000, 16000, 0],
    ]);
  });

  it("a deficit carried into the month the budget turns non-incremental is netted against that month's allocation", () => {
    // Feb ends at -3000 (incremental). In March (non-incremental) available is -3000 + 10000 = 7000
    // and all 7000 of the remaining goes to savings: the deficit is paid back out of this month's allocation.
    const facts = makeFacts({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: true, changes: [['2026-03', 10000, false]] }),
      ],
      spendings: [spending(1, '2026-01', 3000), spending(1, '2026-02', 20000)],
    });
    const ledger = run(facts, '2026-03');
    expect(figures(budgetLineOf(ledger, '2026-02', 1))).toEqual([
      7000, 17000, 20000, -3000, -3000, 0,
    ]);
    expect(figures(budgetLineOf(ledger, '2026-03', 1))).toEqual([-3000, 7000, 0, 7000, 0, 7000]);
  });
});

describe('archived budgets', () => {
  it('settle their whole balance with savings in their end month', () => {
    // Incremental, 100.00 a month, archived with endMonth March.
    // Jan: 10000 - 2000 = 8000 carried. Feb: 8000 + 10000 = 18000 carried.
    // Mar: 18000 + 10000 - 1000 = 27000; it ends here, so carriedOut is 0 and 27000 goes to savings.
    // Apr: no line at all.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true, end: '2026-03' })],
      spendings: [spending(1, '2026-01', 2000), spending(1, '2026-03', 1000)],
    });
    const ledger = run(facts, '2026-05');
    expect(
      ['2026-01', '2026-02', '2026-03'].map((m) => figures(budgetLineOf(ledger, m, 1))),
    ).toEqual([
      [0, 10000, 2000, 8000, 8000, 0],
      [8000, 18000, 0, 18000, 18000, 0],
      [18000, 28000, 1000, 27000, 0, 27000],
    ]);
    expect(budgetSeries(ledger, 1, 'endsThisMonth').map(([, v]) => v)).toEqual([
      false,
      false,
      true,
    ]);
    expect(monthOf(ledger, '2026-03').savingsDue.budgetsSettled).toBe(27000);
    expect(monthOf(ledger, '2026-04').budgets).toEqual([]);
    expect(monthOf(ledger, '2026-05').budgets).toEqual([]);
    expect(monthOf(ledger, '2026-04').heldInBudgets).toBe(0);
  });

  it('take a deficit from savings in their end month', () => {
    // March: 18000 + 10000 = 28000 available, spend 30000 -> -2000 to savings, nothing carried.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true, end: '2026-03' })],
      spendings: [spending(1, '2026-01', 2000), spending(1, '2026-03', 30000)],
    });
    const line = budgetLineOf(run(facts, '2026-04'), '2026-03', 1);
    expect(figures(line)).toEqual([18000, 28000, 30000, -2000, 0, -2000]);
    expect(line.alert).toBe('over');
  });

  it('settle the same way whether the end month is in the past, the present or the future', () => {
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true, end: '2026-03' })],
      spendings: [spending(1, '2026-03', 1000)],
    });
    // Current month 2026-01, 2026-03 and 2026-06: the March figures are the same, only the label differs.
    const labels = (today: string) => run(facts, '2026-04', today).months.map((m) => m.status);
    const march = (today: string) => budgetLineOf(run(facts, '2026-04', today), '2026-03', 1);
    expect(figures(march('2026-01-10'))).toEqual(figures(march('2026-03-31')));
    expect(figures(march('2026-03-31'))).toEqual(figures(march('2026-06-01')));
    expect(figures(march('2026-06-01'))).toEqual([20000, 30000, 1000, 29000, 0, 29000]);
    expect(labels('2026-03-31')).toEqual(['closed', 'closed', 'current', 'future']);
  });
});

describe('budget lifecycles and versions', () => {
  it('a budget created mid-timeline has no line before its start month, and carries nothing into it', () => {
    const facts = makeFacts({
      budgets: [
        budgetFact(1, { amount: 10000 }),
        budgetFact(2, { amount: 5000, incremental: true, start: '2026-03' }),
      ],
      spendings: [spending(2, '2026-03', 1000)],
    });
    const ledger = run(facts, '2026-04');
    expect(monthOf(ledger, '2026-01').budgets.map((b) => b.id)).toEqual([1]);
    expect(monthOf(ledger, '2026-02').budgets.map((b) => b.id)).toEqual([1]);
    expect(monthOf(ledger, '2026-03').budgets.map((b) => b.id)).toEqual([1, 2]);
    expect(figures(budgetLineOf(ledger, '2026-03', 2))).toEqual([0, 5000, 1000, 4000, 4000, 0]);
    expect(figures(budgetLineOf(ledger, '2026-04', 2))).toEqual([4000, 9000, 0, 9000, 9000, 0]);
  });

  it('applies an amount change from its month on, not before', () => {
    // 100.00, then 120.00 from March, then 80.00 from June.
    const facts = makeFacts({
      budgets: [
        budgetFact(1, {
          amount: 10000,
          changes: [
            ['2026-03', 12000],
            ['2026-06', 8000],
          ],
        }),
      ],
    });
    const ledger = run(facts, '2026-07');
    expect(budgetSeries(ledger, 1, 'allocated').map(([, v]) => v)).toEqual([
      10000, 10000, 12000, 12000, 12000, 8000, 8000,
    ]);
    expect(ledger.months.map((m) => m.totals.allocated)).toEqual([
      10000, 10000, 12000, 12000, 12000, 8000, 8000,
    ]);
  });

  it('an amount change in an incremental budget affects only the allocation, not the balance already held', () => {
    // 100.00 for Jan and Feb (nothing spent: 20000 held), 60.00 from March.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true, changes: [['2026-03', 6000]] })],
    });
    const ledger = run(facts, '2026-03');
    expect(figures(budgetLineOf(ledger, '2026-03', 1))).toEqual([20000, 26000, 0, 26000, 26000, 0]);
  });

  it('a version dated before the start month is the one in effect at the start month', () => {
    // The start was moved to June and left the older rows where they were (docs/DOMAIN.md,
    // "Versioned values"): 100.00 from February, then 300.00 incremental from May. June is the first
    // month computed and takes the May row; nothing is computed before it.
    const facts = makeFacts({
      budgets: [
        {
          ...budgetFact(1, { amount: 0, start: '2026-06' }),
          versions: [
            { effectiveMonth: '2026-02', amount: 10000, incremental: false },
            { effectiveMonth: '2026-05', amount: 30000, incremental: true },
          ],
        },
      ],
    });
    const ledger = run(facts, '2026-07');
    expect(monthOf(ledger, '2026-05').budgets).toEqual([]);
    expect(budgetSeries(ledger, 1, 'allocated')).toEqual([
      ['2026-06', 30000],
      ['2026-07', 30000],
    ]);
    expect(budgetSeries(ledger, 1, 'incremental').map(([, v]) => v)).toEqual([true, true]);
    // Nothing is carried into June, and 300.00 is carried from June into July.
    expect(figures(budgetLineOf(ledger, '2026-06', 1))).toEqual([0, 30000, 0, 30000, 30000, 0]);
    expect(figures(budgetLineOf(ledger, '2026-07', 1))).toEqual([30000, 60000, 0, 60000, 60000, 0]);
  });

  it('a version dated after the end month is inert, and applies again when the end month moves later', () => {
    const versions = [
      { effectiveMonth: '2026-01', amount: 10000, incremental: false },
      { effectiveMonth: '2026-05', amount: 20000, incremental: false },
    ];
    const withEnd = (end: string) =>
      makeFacts({ budgets: [{ ...budgetFact(1, { amount: 10000, end }), versions }] });

    // Archived in March: the May row is stored but never read.
    const archived = run(withEnd('2026-03'), '2026-06');
    expect(budgetSeries(archived, 1, 'allocated')).toEqual([
      ['2026-01', 10000],
      ['2026-02', 10000],
      ['2026-03', 10000],
    ]);
    // Archived again in June: the same stored rows now give the closed months back, May on at 200.00.
    const later = run(withEnd('2026-06'), '2026-06');
    expect(budgetSeries(later, 1, 'allocated').map(([, v]) => v)).toEqual([
      10000, 10000, 10000, 10000, 20000, 20000,
    ]);
    // The months both runs have are the same, whichever end month was set.
    expect(later.months.slice(0, 2)).toEqual(archived.months.slice(0, 2));
  });

  it('lists the lines ascending by sortOrder, then id, whatever the order of the facts', () => {
    const budgets = [
      budgetFact(1, { amount: 100, sortOrder: 20 }),
      budgetFact(2, { amount: 100, sortOrder: 0 }),
      budgetFact(3, { amount: 100, sortOrder: 20 }),
      budgetFact(4, { amount: 100, sortOrder: 10 }),
    ];
    for (const order of [budgets, [...budgets].reverse()]) {
      const ledger = run(makeFacts({ budgets: order }), '2026-01');
      expect(monthOf(ledger, '2026-01').budgets.map((b) => b.id)).toEqual([2, 4, 1, 3]);
    }
  });

  it('passes name, color and icon through to the line', () => {
    const facts = makeFacts({
      budgets: [budgetFact(7, { name: 'Holiday', amount: 100, color: '#16a34a', icon: 'plane' })],
    });
    expect(budgetLineOf(run(facts, '2026-01'), '2026-01', 7)).toMatchObject({
      id: 7,
      name: 'Holiday',
      color: '#16a34a',
      icon: 'plane',
    });
  });
});

describe('spendings and refunds', () => {
  it('a refund subtracts from what is spent', () => {
    // 100.00 budget: 80.00 spent, 30.00 refunded: 50.00 spent net. Several rows for one month add up.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000 })],
      spendings: [spending(1, '2026-01', 8000), spending(1, '2026-01', -3000)],
    });
    const line = budgetLineOf(run(facts, '2026-01'), '2026-01', 1);
    expect(line).toMatchObject({ spent: 5000, remaining: 5000, toSavings: 5000, usagePercent: 50 });
    expect(line.alert).toBe('ok');
  });

  it('a month with only a refund spends a negative amount and has more available than allocated', () => {
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      spendings: [spending(1, '2026-01', -2500)],
    });
    const ledger = run(facts, '2026-02');
    const january = budgetLineOf(ledger, '2026-01', 1);
    expect(january).toMatchObject({
      spent: -2500,
      remaining: 12500,
      usagePercent: 0, // never negative
      alert: 'ok',
      carriedOut: 12500,
    });
    expect(budgetLineOf(ledger, '2026-02', 1).carriedIn).toBe(12500);
    expect(monthOf(ledger, '2026-01').totals.spent).toBe(-2500);
  });

  it('ignores spendings that belong to no line (unknown budget, or outside its active months)', () => {
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, start: '2026-02', end: '2026-03' })],
      spendings: [
        spending(1, '2026-01', 999), // before the budget starts
        spending(1, '2026-04', 999), // after it ends
        spending(99, '2026-02', 999), // no such budget
        spending(1, '2026-02', 1000),
      ],
    });
    const ledger = run(facts, '2026-04');
    expect(ledger.months.map((m) => m.totals.spent)).toEqual([0, 1000, 0, 0]);
  });
});

describe('alerts', () => {
  // [label, spent, available, warnPercent, usagePercent, alert]
  it.each<[string, number, number, number, number | null, string]>([
    ['nothing spent', 0, 10000, 80, 0, 'ok'],
    ['just under the threshold (79.99%)', 7999, 10000, 80, 79, 'ok'],
    ['exactly at the threshold', 8000, 10000, 80, 80, 'warning'],
    ['just over the threshold', 8001, 10000, 80, 80, 'warning'],
    ['everything spent is not over', 10000, 10000, 80, 100, 'warning'],
    ['one cent over', 10001, 10000, 80, 100, 'over'],
    ['50% over', 15000, 10000, 80, 150, 'over'],
    ['a refund-only month', -300, 10000, 80, 0, 'ok'],
    ['no budget at all (available 0, nothing spent)', 0, 0, 80, null, 'ok'],
    ['available 0 but something spent', 1, 0, 80, null, 'over'],
    ['negative available, nothing spent', 0, -500, 80, null, 'over'],
    ['negative available, a refund', -600, -500, 80, null, 'ok'],
    ['a lower threshold: exactly 50%', 5000, 10000, 50, 50, 'warning'],
    ['a lower threshold: 49.99%', 4999, 10000, 50, 49, 'ok'],
    ['a threshold of 100: not yet', 9999, 10000, 100, 99, 'ok'],
    ['a threshold of 100: all spent', 10000, 10000, 100, 100, 'warning'],
    ['1 of 3 at 33%: floor is 33 and it warns', 1, 3, 33, 33, 'warning'],
    ['1 of 3 at 34%: floor is 33 and it does not', 1, 3, 34, 33, 'ok'],
    ['odd amounts: 19 of 23 is 82.6%', 19, 23, 82, 82, 'warning'],
    ['odd amounts: 19 of 23 at 83%', 19, 23, 83, 82, 'ok'],
  ])('%s', (_label, spent, available, warnPercent, usagePercent, alert) => {
    expect(usagePercentOf(spent, available)).toBe(usagePercent);
    expect(alertOf(spent, available, warnPercent)).toBe(alert);
  });

  it('a displayed percentage never shows a warning that the number does not explain', () => {
    // For an integer threshold, "100 * spent >= threshold * available" is exactly
    // "floor(100 * spent / available) >= threshold", so a displayed 79 never comes with a warning at 80.
    for (const available of [1, 2, 3, 7, 99, 100, 101, 1234, 99999]) {
      for (
        let spent = 0;
        spent <= available + 2;
        spent += Math.max(1, Math.floor(available / 57))
      ) {
        for (const threshold of [1, 33, 50, 79, 80, 81, 99, 100]) {
          const usage = usagePercentOf(spent, available);
          const alert = alertOf(spent, available, threshold);
          if (spent > available) expect(alert).toBe('over');
          else expect(alert === 'warning').toBe((usage ?? 0) >= threshold);
        }
      }
    }
  });

  it("uses the budget's own threshold over the settings one, and reports the one in effect", () => {
    const facts = makeFacts({
      alertWarnPercent: 80,
      budgets: [budgetFact(1, { amount: 10000 }), budgetFact(2, { amount: 10000, warn: 50 })],
      spendings: [spending(1, '2026-01', 6000), spending(2, '2026-01', 6000)],
    });
    const january = monthOf(run(facts, '2026-01'), '2026-01');
    expect(january.budgets.map((b) => [b.id, b.warnPercent, b.usagePercent, b.alert])).toEqual([
      [1, 80, 60, 'ok'],
      [2, 50, 60, 'warning'],
    ]);
  });

  it('judges the alert on the money available, which includes what an incremental budget carries in', () => {
    // 100.00 a month; January leaves 90.00. In February 190.00 is available, so 150.00 spent is 78%: ok.
    const facts = makeFacts({
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      spendings: [spending(1, '2026-01', 1000), spending(1, '2026-02', 15000)],
    });
    expect(budgetLineOf(run(facts, '2026-02'), '2026-02', 1)).toMatchObject({
      available: 19000,
      usagePercent: 78,
      alert: 'ok',
    });
  });
});

describe('budgets and the identities', () => {
  it('keeps every identity through carries, mode changes, amount changes and archiving', () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 250000)],
      budgets: [
        budgetFact(1, {
          amount: 40000,
          incremental: true,
          changes: [
            ['2026-04', 45000, false],
            ['2026-08', 30000, true],
          ],
        }),
        budgetFact(2, { amount: 15000, incremental: true, end: '2026-06' }),
        budgetFact(3, { amount: 20000, start: '2026-03', warn: 60 }),
      ],
      spendings: [
        spending(1, '2026-01', 52000),
        spending(1, '2026-02', 1000),
        spending(1, '2026-04', 46000),
        spending(1, '2026-09', 9000),
        spending(2, '2026-02', 30000),
        spending(2, '2026-06', 4000),
        spending(3, '2026-03', 25000),
        spending(3, '2026-03', -1500),
        spending(3, '2026-05', 12000),
      ],
    });
    const ledger = run(facts, '2026-10', '2026-07-12');
    ledger.months.forEach((m) => expectMonthIdentities(m));
    expectChainIdentities(ledger.months, { startsAtLedgerStart: true });
  });
});
