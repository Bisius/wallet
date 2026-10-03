/**
 * The savings rules of docs/DOMAIN.md as pure functions: the "move to savings" list and the goal
 * figures (`savings.ts`), plus the grouped-sum loader (`savings-facts.ts`) against a real database.
 * Every figure is worked out by hand, in cents.
 */
import { MAX_CENTS } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../db/client';
import { savingsGoals, savingsTransactions } from '../db/schema';
import { budgetFact, makeFacts, run, salary, spending } from '../testing/facts';
import {
  type GoalFacts,
  goalFigures,
  monthsLeftFor,
  outstandingMonths,
  outstandingOf,
  progressPercentOf,
} from './savings';
import { balanceOf, loadSavingsFacts } from './savings-facts';

describe('progressPercentOf', () => {
  it.each([
    // [balance, target, expected]: max(0, floor(100 * balance / target))
    [0, 100000, 0],
    [1, 100000, 0],
    [999, 100000, 0], // 0.999
    [1000, 100000, 1],
    [30000, 100000, 30],
    [99999, 100000, 99], // one cent short is never shown as 100
    [100000, 100000, 100],
    [100001, 100000, 100],
    [150000, 100000, 150], // not capped
    [1, 300, 0],
    [100, 300, 33],
    [199, 300, 66],
    [299, 300, 99],
    [1, 3, 33],
    [2, 3, 66],
    [-1, 100, 0], // a goal below 0 has no progress
    [-5000, 100, 0],
  ])('balance %i of %i is %i%%', (balance, target, expected) => {
    expect(progressPercentOf(balance, target)).toBe(expected);
  });

  it('is exact where a float quotient is not', () => {
    // 100 * 41 / 100 would be fine, but 0.57 * 100 = 56.99999999999999 in floating point. The
    // percentage of 57 out of 100 must be exactly 57.
    expect(progressPercentOf(57, 100)).toBe(57);
    expect(progressPercentOf(29, 100)).toBe(29);
    expect(progressPercentOf(58, 100)).toBe(58);
    // Large sums: 100 * balance leaves the safe-integer range, and the result is still exact.
    expect(progressPercentOf(MAX_CENTS * 1000, MAX_CENTS)).toBe(100_000);
    expect(progressPercentOf(MAX_CENTS - 1, MAX_CENTS)).toBe(99);
    expect(progressPercentOf(9_007_199_254_740_991, 9_007_199_254_740_991)).toBe(100);
    expect(progressPercentOf(9_007_199_254_740_990, 9_007_199_254_740_991)).toBe(99);
  });
});

describe('monthsLeftFor', () => {
  it.each([
    // [deadline, current month, months left]: both months count, at least 1
    ['2027-03-15', '2026-10', 6], // the worked example of docs/DOMAIN.md
    ['2027-03-15', '2026-11', 5],
    ['2027-03-15', '2027-02', 2],
    ['2027-03-15', '2027-03', 1], // the deadline's own month
    ['2027-03-01', '2027-03', 1], // whatever the day
    ['2027-03-31', '2027-03', 1],
    ['2027-03-15', '2027-04', 1], // passed: stays at 1
    ['2027-03-15', '2030-01', 1],
    ['2026-10-31', '2026-10', 1],
    ['2027-10-01', '2026-10', 13], // a year ahead: 12 months later, 13 months in all
    ['2036-10-01', '2026-10', 121],
  ])('deadline %s seen from %s leaves %i months', (deadline, current, expected) => {
    expect(monthsLeftFor(deadline, current)).toBe(expected);
  });
});

describe('goalFigures', () => {
  const goal = (over: Partial<GoalFacts> = {}): GoalFacts => ({
    id: 1,
    name: 'Holiday',
    targetAmount: 100000,
    deadline: null,
    color: null,
    archived: false,
    ...over,
  });

  it('copies the stored fields and derives the rest', () => {
    expect(
      goalFigures(goal({ color: '#3b82f6', deadline: '2027-03-15' }), 30000, '2026-10'),
    ).toEqual({
      id: 1,
      name: 'Holiday',
      targetAmount: 100000,
      deadline: '2027-03-15',
      color: '#3b82f6',
      archived: false,
      balance: 30000,
      progressPercent: 30,
      remaining: 70000,
      reached: false,
      monthlyNeeded: 11667, // ceilDiv(70000, 6)
      status: 'active',
    });
  });

  it('works out the worked example of docs/DOMAIN.md to the cent', () => {
    // 1,000.00 by 15 March 2027, nothing saved, on 2026-10-02: 6 months, ceilDiv(100000, 6) = 16667.
    const g = goal({ deadline: '2027-03-15' });
    expect(goalFigures(g, 0, '2026-10').monthlyNeeded).toBe(16667);
    // With 300.00 saved: 700.00 is missing, ceilDiv(70000, 6) = 11667.
    expect(goalFigures(g, 30000, '2026-10').monthlyNeeded).toBe(11667);
    // February 2027: 2 months left. March: 1, the whole remainder. April: still 1, and overdue.
    expect(goalFigures(g, 30000, '2027-02')).toMatchObject({
      monthlyNeeded: 35000,
      status: 'active',
    });
    expect(goalFigures(g, 30000, '2027-03')).toMatchObject({
      monthlyNeeded: 70000,
      status: 'active',
    });
    expect(goalFigures(g, 30000, '2027-04')).toMatchObject({
      monthlyNeeded: 70000,
      status: 'overdue',
    });
  });

  it('rounds the monthly amount up, so the months never fall short and the last one needs less', () => {
    const g = goal({ targetAmount: 100000, deadline: '2027-03-15' });
    const monthly = goalFigures(g, 0, '2026-10').monthlyNeeded ?? 0;
    expect(monthly).toBe(16667);
    expect(monthly * 6).toBe(100002); // 2 cents more than the target: the last month needs 2 less
    expect(monthly * 5).toBeLessThan(100000);
    expect(goalFigures(g, 0, '2026-12').monthlyNeeded).toBe(25000); // 4 months, exact
    expect(
      goalFigures(goal({ targetAmount: 1, deadline: '2027-03-15' }), 0, '2026-10').monthlyNeeded,
    ).toBe(1);
  });

  describe('status, the first that applies: archived, reached, overdue, active', () => {
    const late = { deadline: '2026-08-31' };
    it.each([
      // [label, goal, balance, status]
      ['a plain goal', goal(), 0, 'active'],
      ['a goal with a future deadline', goal({ deadline: '2027-03-15' }), 0, 'active'],
      ['a deadline in the current month', goal({ deadline: '2026-10-01' }), 0, 'active'],
      ['a deadline in an earlier month', goal(late), 0, 'overdue'],
      ['a reached goal', goal(), 100000, 'reached'],
      ['a goal over its target', goal(), 250000, 'reached'],
      ['a reached goal past its deadline', goal(late), 100000, 'reached'],
      ['an archived goal', goal({ archived: true }), 0, 'archived'],
      ['an archived goal that was reached', goal({ archived: true }), 100000, 'archived'],
      ['an archived goal past its deadline', goal({ ...late, archived: true }), 0, 'archived'],
      ['a goal below 0', goal(), -300, 'active'],
    ])('%s is %s', (_label, g, balance, status) => {
      expect(goalFigures(g as GoalFacts, balance as number, '2026-10').status).toBe(status);
    });
  });

  describe('monthlyNeeded is set exactly for an active or overdue goal with a deadline', () => {
    const deadline = '2027-03-15';
    it.each([
      ['active with a deadline', goal({ deadline }), 30000, 11667],
      ['overdue', goal({ deadline: '2026-08-31' }), 30000, 70000],
      ['without a deadline', goal(), 30000, null],
      ['reached', goal({ deadline }), 100000, null],
      ['over its target', goal({ deadline }), 120000, null],
      ['reached and past its deadline', goal({ deadline: '2026-08-31' }), 100000, null],
      ['archived', goal({ deadline, archived: true }), 30000, null],
      ['archived and overdue', goal({ deadline: '2026-08-31', archived: true }), 30000, null],
      ['below 0: the whole target and more is missing', goal({ deadline }), -500, 16750], // 100500 / 6
      ['one cent short', goal({ deadline }), 99999, 1],
    ])('%s: %s', (_label, g, balance, expected) => {
      expect(goalFigures(g as GoalFacts, balance as number, '2026-10').monthlyNeeded).toBe(
        expected,
      );
    });
  });

  it('keeps reached, remaining and progress consistent for the balances around 0, half and the target', () => {
    for (const target of [1, 2, 3, 7, 300, 100000]) {
      const half = Math.floor(target / 2);
      const balances = new Set<number>();
      for (const centre of [0, half, target]) {
        for (let delta = -3; delta <= 3; delta++) balances.add(centre + delta);
      }
      for (const balance of balances) {
        const figures = goalFigures(goal({ targetAmount: target }), balance, '2026-10');
        expect(figures.remaining).toBe(Math.max(0, target - balance));
        expect(figures.reached).toBe(balance >= target);
        // reached <=> nothing remaining <=> a displayed 100% or more
        expect(figures.reached).toBe(figures.remaining === 0);
        expect(figures.reached).toBe(figures.progressPercent >= 100);
      }
    }
  });
});

describe('outstandingOf and outstandingMonths', () => {
  /**
   * Salary 3,000.00 from January and a budget of 400.00 (not incremental), 310.00 spent in
   * January and 450.00 in February. Today is 2026-06-15, so the months through May are closed.
   *
   *   January:  unallocated 2,600.00, Groceries remaining +90.00  -> savings due 2,690.00
   *   February: unallocated 2,600.00, Groceries remaining -50.00  -> savings due 2,550.00
   *   March..May: unallocated 2,600.00, Groceries remaining +400  -> savings due 3,000.00
   */
  const facts = makeFacts({
    startMonth: '2026-01',
    salary: [salary('2026-01', 300000)],
    budgets: [budgetFact(1, { name: 'Groceries', amount: 40000 })],
    spendings: [spending(1, '2026-01', 31000), spending(1, '2026-02', 45000)],
  });
  const ledger = run(facts, '2026-08'); // closed through May, June is current, July and August are future

  it('lists every closed month with money due, ascending, with its breakdown and direction', () => {
    const list = outstandingMonths(ledger, new Map());
    expect(list.map((m) => [m.month, m.savingsDue, m.settled, m.outstanding, m.direction])).toEqual(
      [
        ['2026-01', 269000, 0, 269000, 'move'],
        ['2026-02', 255000, 0, 255000, 'move'],
        ['2026-03', 300000, 0, 300000, 'move'],
        ['2026-04', 300000, 0, 300000, 'move'],
        ['2026-05', 300000, 0, 300000, 'move'],
      ],
    );
    expect(list[0]).toEqual({
      month: '2026-01',
      savingsDue: 269000,
      settled: 0,
      outstanding: 269000,
      direction: 'move',
      breakdown: { unallocated: 260000, budgetsSettled: 9000, reservesReleased: 0 },
      adjustment: false,
    });
    expect(list[1]?.breakdown).toEqual({
      unallocated: 260000,
      budgetsSettled: -5000,
      reservesReleased: 0,
    });
  });

  it('never lists the current month or a future one', () => {
    const months = outstandingMonths(ledger, new Map()).map((m) => m.month);
    expect(months).not.toContain('2026-06');
    expect(months).not.toContain('2026-07');
    expect(months).not.toContain('2026-08');
  });

  it('lists the months from the start month on: a month with nothing due is left out', () => {
    // Tracking from November 2025: November and December have no salary yet, so nothing is due.
    const earlier = run({ ...facts, startMonth: '2025-11' }, '2026-08');
    const list = outstandingMonths(earlier, new Map());
    expect(list.map((m) => m.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
    ]);
  });

  it('subtracts what was settled and flags the month as an adjustment', () => {
    // January was settled with 2,700.00 before a forgotten edit: 10.00 too much was moved.
    const list = outstandingMonths(ledger, new Map([['2026-01', { settled: 270000, rows: 2 }]]));
    expect(list[0]).toEqual({
      month: '2026-01',
      savingsDue: 269000,
      settled: 270000,
      outstanding: -1000,
      direction: 'take',
      breakdown: { unallocated: 260000, budgetsSettled: 9000, reservesReleased: 0 },
      adjustment: true,
    });
  });

  it('leaves a month out once it is settled exactly, and keeps the others', () => {
    const list = outstandingMonths(
      ledger,
      new Map([
        ['2026-01', { settled: 269000, rows: 1 }],
        ['2026-03', { settled: 300000, rows: 3 }],
      ]),
    );
    expect(list.map((m) => m.month)).toEqual(['2026-02', '2026-04', '2026-05']);
  });

  it('is an adjustment when the month has settlement rows, even if they net to 0', () => {
    const list = outstandingMonths(ledger, new Map([['2026-02', { settled: 0, rows: 2 }]]));
    expect(list[1]).toMatchObject({
      month: '2026-02',
      settled: 0,
      outstanding: 255000,
      adjustment: true,
    });
  });

  it('ignores a settlement of a month that is not closed', () => {
    const list = outstandingMonths(
      ledger,
      new Map([
        ['2026-06', { settled: 123, rows: 1 }], // the current month
        ['2026-07', { settled: 456, rows: 1 }], // a future month
      ]),
    );
    expect(list.map((m) => m.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
    ]);
  });

  it('is empty when no month has closed yet', () => {
    const fresh = run(
      makeFacts({ startMonth: '2026-06', salary: [salary('2026-06', 300000)] }),
      '2026-06',
    );
    expect(outstandingMonths(fresh, new Map())).toEqual([]);
    const empty = run(makeFacts({ startMonth: '2026-06' }), '2026-05'); // through before the start
    expect(empty.months).toEqual([]);
    expect(outstandingMonths(empty, new Map())).toEqual([]);
  });

  it('outstandingOf is null when the month is settled exactly or nothing is due', () => {
    const january = ledger.months[0];
    if (!january) throw new Error('no January');
    expect(outstandingOf(january, { settled: 269000, rows: 1 })).toBeNull();
    expect(outstandingOf(january, undefined)).toMatchObject({ outstanding: 269000 });
    const idle = run(makeFacts({ startMonth: '2026-01' }), '2026-02').months[0];
    if (!idle) throw new Error('no idle month');
    expect(outstandingOf(idle, undefined)).toBeNull();
  });

  it('identity: savingsDue - settled = outstanding, and the breakdown adds up to savingsDue', () => {
    const settlements = new Map([
      ['2026-01', { settled: 100000, rows: 1 }],
      ['2026-02', { settled: 255000 + 777, rows: 2 }],
    ]);
    for (const entry of outstandingMonths(ledger, settlements)) {
      expect(entry.outstanding).toBe(entry.savingsDue - entry.settled);
      expect(entry.outstanding).not.toBe(0);
      expect(
        entry.breakdown.unallocated +
          entry.breakdown.budgetsSettled +
          entry.breakdown.reservesReleased,
      ).toBe(entry.savingsDue);
    }
  });
});

describe('loadSavingsFacts and balanceOf', () => {
  function database() {
    const db = createDb(':memory:');
    runMigrations(db);
    return db;
  }
  const row = (
    over: Partial<typeof savingsTransactions.$inferInsert> & { amount: number },
  ): typeof savingsTransactions.$inferInsert => ({
    date: '2026-03-01',
    kind: 'deposit',
    ...over,
  });

  it('is empty for an empty table', () => {
    const db = database();
    expect(loadSavingsFacts(db)).toEqual({ balances: new Map(), settlements: new Map() });
    expect(balanceOf(db, null)).toBe(0);
    expect(balanceOf(db, 7)).toBe(0);
  });

  it('sums every goal and the unassigned rows, and the settlement rows per month', () => {
    const db = database();
    db.insert(savingsGoals)
      .values([
        { name: 'A', targetAmount: 1 },
        { name: 'B', targetAmount: 1 },
      ])
      .run();
    db.insert(savingsTransactions)
      .values([
        row({ kind: 'opening', amount: 50000, date: '2026-01-01' }),
        row({ amount: 300, goalId: 1 }),
        row({ kind: 'withdrawal', amount: -100, goalId: 1 }),
        row({ amount: 40, goalId: 2 }),
        row({ kind: 'settlement', amount: 1000, settlesMonth: '2026-01' }),
        row({ kind: 'settlement', amount: -250, settlesMonth: '2026-01', goalId: 2 }),
        row({ kind: 'settlement', amount: 30, settlesMonth: '2026-02', goalId: 1 }),
      ])
      .run();

    const facts = loadSavingsFacts(db);
    expect(facts.balances).toEqual(
      new Map([
        [null, 51000],
        [1, 230],
        [2, -210],
      ]),
    );
    expect(facts.settlements).toEqual(
      new Map([
        ['2026-01', { settled: 750, rows: 2 }],
        ['2026-02', { settled: 30, rows: 1 }],
      ]),
    );
    expect(balanceOf(db, null)).toBe(51000);
    expect(balanceOf(db, 1)).toBe(230);
    expect(balanceOf(db, 2)).toBe(-210);
    expect(balanceOf(db, 99)).toBe(0);
  });

  it('keeps a goal that holds nothing out of the balances (it reads as 0)', () => {
    const db = database();
    db.insert(savingsGoals).values({ name: 'A', targetAmount: 1 }).run();
    expect(loadSavingsFacts(db).balances.get(1)).toBeUndefined();
    expect(balanceOf(db, 1)).toBe(0);
  });
});
