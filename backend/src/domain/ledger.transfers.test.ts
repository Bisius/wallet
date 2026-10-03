/**
 * Transfers in the ledger (docs/DOMAIN.md, "Transfers" and "Unallocated"). These are unit tests of
 * the pure engine, so they put the transfers straight into the facts, with no database and no
 * endpoint; that also lets them feed the engine transfers that `POST /api/transfers` never stores
 * (a budget that is not active in the month, a budget to itself, the pool to the pool). What the
 * endpoints do with transfers is tested through HTTP in `modules/transfers`.
 *
 * Base case, used by most tests: salary 1000.00, budget A (100.00) and budget B (50.00), both
 * non-incremental and unspent. Without transfers every month has unallocated 850.00, 150.00 of
 * budgets settled to savings, and 1000.00 savings due.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFact,
  budgetLineOf,
  makeFacts,
  monthOf,
  run,
  salary,
  spending,
  transfer,
} from '../testing/facts';
import { expectChainIdentities, expectMonthIdentities } from '../testing/month-identities';

const base = (extra: Parameters<typeof makeFacts>[0] = {}) =>
  makeFacts({
    salary: [salary('2026-01', 100000)],
    budgets: [
      budgetFact(1, { name: 'A', amount: 10000 }),
      budgetFact(2, { name: 'B', amount: 5000 }),
    ],
    ...extra,
  });

/** The numbers of one month that a transfer can move. */
function picture(ledger: ReturnType<typeof run>, month: string) {
  const row = monthOf(ledger, month);
  return {
    unallocated: row.unallocated,
    a: [budgetLineOf(ledger, month, 1).transfersNet, budgetLineOf(ledger, month, 1).available],
    b: [budgetLineOf(ledger, month, 2).transfersNet, budgetLineOf(ledger, month, 2).available],
    totalsTransfersNet: row.totals.transfersNet,
    budgetsSettled: row.savingsDue.budgetsSettled,
    savingsDue: row.savingsDue.total,
  };
}

describe('transfers', () => {
  it('the base case has no transfers', () => {
    expect(picture(run(base(), '2026-02'), '2026-02')).toEqual({
      unallocated: 85000,
      a: [0, 10000],
      b: [0, 5000],
      totalsTransfersNet: 0,
      budgetsSettled: 15000,
      savingsDue: 100000,
    });
  });

  it.each<[string, Parameters<typeof transfer>, ReturnType<typeof picture>]>([
    [
      'pool to budget: the budget has 20.00 more, the pool 20.00 less',
      ['2026-02', null, 1, 2000],
      {
        unallocated: 83000, // 100000 - 15000 - 2000
        a: [2000, 12000],
        b: [0, 5000],
        totalsTransfersNet: 2000,
        budgetsSettled: 17000,
        savingsDue: 100000, // it only moved between two places that both go to savings
      },
    ],
    [
      'budget to pool: the budget has 15.00 less, the pool 15.00 more',
      ['2026-02', 1, null, 1500],
      {
        unallocated: 86500, // 100000 - 15000 + 1500
        a: [-1500, 8500],
        b: [0, 5000],
        totalsTransfersNet: -1500,
        budgetsSettled: 13500,
        savingsDue: 100000,
      },
    ],
    [
      'budget to budget: nothing changes in the totals, only between the two budgets',
      ['2026-02', 1, 2, 1000],
      {
        unallocated: 85000,
        a: [-1000, 9000],
        b: [1000, 6000],
        totalsTransfersNet: 0,
        budgetsSettled: 15000,
        savingsDue: 100000,
      },
    ],
  ])('%s', (_label, [month, from, to, amount], expected) => {
    const ledger = run(base({ transfers: [transfer(month, from, to, amount)] }), '2026-03');
    expect(picture(ledger, '2026-02')).toEqual(expected);
    // Only the month of the transfer is affected.
    expect(picture(ledger, '2026-01')).toEqual(picture(run(base(), '2026-03'), '2026-01'));
    expect(picture(ledger, '2026-03')).toEqual(picture(run(base(), '2026-03'), '2026-03'));
    ledger.months.forEach((m) => expectMonthIdentities(m));
  });

  it('several transfers in a month add up, in any order', () => {
    const transfers = [
      transfer('2026-02', null, 1, 2000),
      transfer('2026-02', 1, 2, 500),
      transfer('2026-02', 2, null, 300),
      transfer('2026-02', null, 1, 100),
    ];
    for (const order of [transfers, [...transfers].reverse()]) {
      const ledger = run(base({ transfers: order }), '2026-02');
      // A: +2000 -500 +100 = +1600. B: +500 -300 = +200.
      // Pool: -2000 -100 +300 = -1800.
      expect(picture(ledger, '2026-02')).toEqual({
        unallocated: 85000 - 1800,
        a: [1600, 11600],
        b: [200, 5200],
        totalsTransfersNet: 1800,
        budgetsSettled: 16800,
        savingsDue: 100000,
      });
    }
  });

  it('what a transfer gives an incremental budget is carried into the next month', () => {
    // One incremental budget (100.00), 30.00 moved in from the pool in January.
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [budgetFact(1, { amount: 10000, incremental: true })],
      transfers: [transfer('2026-01', null, 1, 3000)],
    });
    const ledger = run(facts, '2026-02');
    expect(budgetLineOf(ledger, '2026-01', 1)).toMatchObject({
      transfersNet: 3000,
      available: 13000,
      remaining: 13000,
      carriedOut: 13000,
    });
    expect(budgetLineOf(ledger, '2026-02', 1)).toMatchObject({
      carriedIn: 13000,
      available: 23000,
    });
    // January's unallocated is 1000.00 - 100.00 - 30.00; February's is not reduced again.
    expect(monthOf(ledger, '2026-01').unallocated).toBe(87000);
    expect(monthOf(ledger, '2026-02').unallocated).toBe(90000);
    expectChainIdentities(ledger.months, { startsAtLedgerStart: true });
  });

  it('a transfer from another budget can cover an overspend', () => {
    // A spends 130.00 of 100.00; 40.00 moves in from B. A is then within its 140.00 (92% used) and
    // 10.00 of it moves to savings, instead of 30.00 being taken from savings. B keeps 10.00.
    const facts = base({
      spendings: [spending(1, '2026-01', 13000)],
      transfers: [transfer('2026-01', 2, 1, 4000)],
    });
    const ledger = run(facts, '2026-01');
    expect(budgetLineOf(ledger, '2026-01', 1)).toMatchObject({
      transfersNet: 4000,
      available: 14000,
      spent: 13000,
      remaining: 1000,
      usagePercent: 92,
      alert: 'warning',
      toSavings: 1000,
    });
    expect(budgetLineOf(ledger, '2026-01', 2)).toMatchObject({
      transfersNet: -4000,
      available: 1000,
      remaining: 1000,
      toSavings: 1000,
    });
    // 1000.00 - 150.00 allocated = 850.00 unallocated, plus 20.00 settled by the two budgets:
    // the same as the income less what was actually spent (1000.00 - 130.00 = 870.00).
    expect(monthOf(ledger, '2026-01').savingsDue).toEqual({
      unallocated: 85000,
      budgetsSettled: 2000,
      reservesReleased: 0,
      total: 87000,
    });
  });

  it('keeps a transfer in the month of its date: it does not move money between months', () => {
    const ledger = run(base({ transfers: [transfer('2026-03', null, 2, 1000)] }), '2026-04');
    expect(ledger.months.map((m) => m.totals.transfersNet)).toEqual([0, 0, 1000, 0]);
    expect(ledger.months.map((m) => m.unallocated)).toEqual([85000, 85000, 84000, 85000]);
  });
});

describe('transfers the ledger ignores', () => {
  const baseline = run(
    makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [
        budgetFact(1, { amount: 10000 }),
        budgetFact(3, { amount: 7000, start: '2026-03', end: '2026-04' }),
      ],
    }),
    '2026-06',
  );

  it.each<[string, Parameters<typeof transfer>]>([
    ['to a budget that has not started yet', ['2026-02', null, 3, 500]],
    ['from a budget that has not started yet', ['2026-02', 3, null, 500]],
    ['to a budget that has already ended', ['2026-05', null, 3, 500]],
    ['from a budget that has already ended', ['2026-05', 3, 1, 500]],
    ['to a budget that does not exist', ['2026-02', null, 99, 500]],
    ['from a budget that does not exist', ['2026-02', 99, 1, 500]],
    ['between nothing and nothing', ['2026-02', null, null, 500]],
    ['from a budget to itself', ['2026-03', 1, 1, 500]],
  ])('%s', (_label, args) => {
    // The pool must not pay for money that no budget receives: the whole transfer is void.
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [
        budgetFact(1, { amount: 10000 }),
        budgetFact(3, { amount: 7000, start: '2026-03', end: '2026-04' }),
      ],
      transfers: [transfer(...args)],
    });
    const ledger = run(facts, '2026-06');
    expect(ledger.months).toEqual(baseline.months);
    ledger.months.forEach((m) => expectMonthIdentities(m));
  });

  it("counts a transfer in a budget's first and last active month", () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 100000)],
      budgets: [
        budgetFact(1, { amount: 10000 }),
        budgetFact(3, { amount: 7000, start: '2026-03', end: '2026-04' }),
      ],
      transfers: [transfer('2026-03', null, 3, 500), transfer('2026-04', 3, null, 200)],
    });
    const ledger = run(facts, '2026-05');
    expect(budgetLineOf(ledger, '2026-03', 3).transfersNet).toBe(500);
    expect(budgetLineOf(ledger, '2026-04', 3).transfersNet).toBe(-200);
    expect(monthOf(ledger, '2026-03').unallocated).toBe(100000 - 10000 - 7000 - 500);
    expect(monthOf(ledger, '2026-04').unallocated).toBe(100000 - 10000 - 7000 + 200);
  });
});
