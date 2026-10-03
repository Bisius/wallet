/**
 * Pins the independent savings model (`savings-model.ts`) to the worked examples of docs/DOMAIN.md and
 * to arithmetic done by hand in the comments, so that when the operation fuzz finds the API and the
 * model disagreeing, the model has already been checked against the doc and the API is the suspect.
 */
import { describe, expect, it } from 'vitest';
import type { Facts } from '../domain/facts';
import {
  type ModelGoal,
  type ModelRow,
  type World,
  dueByMonth,
  earliestFact,
  expectedGoals,
  expectedOpening,
  expectedPage,
  expectedSavings,
  goalFigures,
  moveStart,
  outstandingList,
  predictDeleteRow,
  predictManual,
  predictMoveStart,
  predictSettle,
  predictUndo,
} from './savings-model';

const goal = (overrides: Partial<ModelGoal> = {}): ModelGoal => ({
  id: 1,
  name: 'Holiday',
  targetAmount: 100000,
  deadline: null,
  color: null,
  archived: false,
  ...overrides,
});

let nextId = 1;
const row = (overrides: Partial<ModelRow>): ModelRow => ({
  id: nextId++,
  date: '2026-01-01',
  kind: 'deposit',
  amount: 0,
  goalId: null,
  settlesMonth: null,
  note: null,
  groupId: null,
  ...overrides,
});

// -------------------------------------------------------------------------------------------------
// Goals
// -------------------------------------------------------------------------------------------------

describe('goalFigures: the worked example of the doc, 1,000.00 by 15 March 2027', () => {
  const holiday = goal({ deadline: '2027-03-15' });

  // "The deadline's month, 2027-03, is 5 months after 2026-10, so monthsLeft is 6 (October to
  // March)": ceilDiv(100000, 6) = 16666.67 -> 16667 (166.67). With 300.00 saved, remaining is 700.00
  // and ceilDiv(70000, 6) = 11666.67 -> 11667 (116.67). "In February 2027 monthsLeft is 2 and in
  // March it is 1, so the whole remainder is needed. From April 2027 it stays at 1, and the goal is
  // overdue unless it is reached."
  it.each([
    ['2026-10', 0, 16667, 'active'],
    ['2026-10', 30000, 11667, 'active'],
    ['2026-11', 30000, 14000, 'active'], // 5 months: 70000 / 5, exact
    ['2027-02', 30000, 35000, 'active'], // 2 months: 70000 / 2
    ['2027-03', 30000, 70000, 'active'], // 1 month: everything, and the deadline's month is on time
    ['2027-04', 30000, 70000, 'overdue'], // stays at 1
    ['2030-01', 30000, 70000, 'overdue'],
    ['2027-04', 100000, null, 'reached'], // "A reached goal past its deadline is reached, not overdue"
    ['2026-10', 100000, null, 'reached'],
  ] as const)('in %s with %i saved: monthlyNeeded %s, %s', (month, balance, needed, status) => {
    const figures = goalFigures(holiday, balance, month);
    expect(figures.monthlyNeeded).toBe(needed);
    expect(figures.status).toBe(status);
  });

  it('the last month needs a little less: ceiling division never falls short', () => {
    // 100000 over 6 months: 16667 x 5 = 83335, and the sixth month needs only 16665.
    expect(goalFigures(holiday, 0, '2026-10').monthlyNeeded! * 5).toBe(83335);
    expect(goalFigures(holiday, 83335, '2027-03').monthlyNeeded).toBe(16665);
  });
});

describe('goalFigures: progress, remaining and reached', () => {
  // [balance, target, progressPercent, remaining, reached]; progress is an exact integer floor.
  it.each([
    [0, 100000, 0, 100000, false],
    [-5000, 100000, 0, 105000, false], // a goal below 0 has no progress and misses more than its target
    [99999, 100000, 99, 1, false], // floor(99.999): a displayed 100 always means reached
    [100000, 100000, 100, 0, true],
    [100001, 100000, 100, 0, true], // floor(100.001)
    [150000, 100000, 150, 0, true], // "not capped: 150 means 50% over"
    [29, 100, 29, 71, false], // the float trap: 29 / 100 * 100 is 28.999999999999996
    [57, 100, 57, 43, false], // 0.57 * 100 is 56.99999999999999
    [58, 100, 58, 42, false],
    [1, 3, 33, 2, false],
    [2, 3, 66, 1, false],
    [3, 3, 100, 0, true],
    [1_000_000_000_000, 3, 33_333_333_333_333, 0, true], // floor(1e14 / 3)
  ] as const)(
    'balance %i of %i: %i%%, %i missing, reached %s',
    (balance, target, progress, remaining, reached) => {
      const figures = goalFigures(goal({ targetAmount: target }), balance, '2026-10');
      expect(figures.progressPercent).toBe(progress);
      expect(figures.remaining).toBe(remaining);
      expect(figures.reached).toBe(reached);
      expect(figures.monthlyNeeded).toBeNull(); // no deadline
    },
  );
});

describe('goalFigures: status, the first that applies (archived, reached, overdue, active)', () => {
  const past = '2026-05-31'; // the deadline's month is before 2026-10
  it.each([
    // [what, goal, balance, status, monthlyNeeded]
    [
      'archived beats reached and overdue',
      goal({ archived: true, deadline: past }),
      200000,
      'archived',
      null,
    ],
    [
      'archived, not reached',
      goal({ archived: true, deadline: '2027-01-01' }),
      0,
      'archived',
      null,
    ],
    ['reached beats overdue', goal({ deadline: past }), 100000, 'reached', null],
    ['overdue needs all of what is missing now', goal({ deadline: past }), 40000, 'overdue', 60000],
    [
      'active with a deadline in the current month',
      goal({ deadline: '2026-10-01' }),
      40000,
      'active',
      60000,
    ],
    ['active without a deadline has no monthly amount', goal(), 40000, 'active', null],
  ] as const)('%s', (_what, g, balance, status, needed) => {
    const figures = goalFigures(g, balance, '2026-10');
    expect(figures.status).toBe(status);
    expect(figures.monthlyNeeded).toBe(needed);
  });
});

// -------------------------------------------------------------------------------------------------
// A world with two closed months, worked out by hand
// -------------------------------------------------------------------------------------------------

/**
 * Tracking since 2026-01, today is 2026-03-15. Salary 3,000.00. Groceries 400.00 (not incremental),
 * Netflix 12.99 monthly, Insurance 120.00 yearly renewing in June and cancelled with endMonth 2026-02.
 * Spent on Groceries: 310.00 in January and 450.00 in February.
 *
 *   January:  fixed = 1299 + ceilDiv(12000, 6 months to June) 2000 = 3299
 *             unallocated = 300000 - 3299 - 40000 = 256701, Groceries remaining 40000 - 31000 = 9000
 *             savingsDue  = 256701 + 9000 + 0 = 265701
 *   February: fixed = 1299 (insurance: no renewal left, sets nothing aside)
 *             unallocated = 300000 - 1299 - 40000 = 258701, Groceries remaining 40000 - 45000 = -5000,
 *             the 2000 held is released: savingsDue = 258701 - 5000 + 2000 = 255701
 */
function twoMonthWorld(): World {
  const facts: Facts = {
    startMonth: '2026-01',
    alertWarnPercent: 80,
    salary: [{ effectiveMonth: '2026-01', amount: 300000 }],
    incomes: [],
    subscriptions: [
      {
        id: 1,
        name: 'Netflix',
        color: null,
        frequency: 'monthly',
        anchorDate: '2026-01-15',
        startMonth: '2026-01',
        endMonth: null,
        prices: [{ effectiveMonth: '2026-01', amount: 1299 }],
      },
      {
        id: 2,
        name: 'Insurance',
        color: null,
        frequency: 'yearly',
        anchorDate: '2026-06-15',
        startMonth: '2026-01',
        endMonth: '2026-02',
        prices: [{ effectiveMonth: '2026-01', amount: 12000 }],
      },
    ],
    budgets: [
      {
        id: 1,
        name: 'Groceries',
        color: null,
        icon: null,
        sortOrder: 0,
        startMonth: '2026-01',
        endMonth: null,
        alertWarnPercent: null,
        versions: [{ effectiveMonth: '2026-01', amount: 40000, incremental: false }],
      },
    ],
    spendings: [
      { budgetId: 1, month: '2026-01', amount: 31000 },
      { budgetId: 1, month: '2026-02', amount: 45000 },
    ],
    transfers: [],
  };
  nextId = 1;
  return {
    today: '2026-03-15',
    facts,
    goals: [goal({ id: 1, name: 'Holiday' }), goal({ id: 2, name: 'Old', archived: true })],
    rows: [row({ kind: 'opening', date: '2026-01-01', amount: 50000 })],
  };
}

describe('savings due and the outstanding list', () => {
  it('has the two closed months worked out by hand, and not the current one', () => {
    const world = twoMonthWorld();
    const due = dueByMonth(world);
    expect([...due.keys()]).toEqual(['2026-01', '2026-02']);
    expect(due.get('2026-01')).toEqual({
      unallocated: 256701,
      budgetsSettled: 9000,
      reservesReleased: 0,
      total: 265701,
    });
    expect(due.get('2026-02')).toEqual({
      unallocated: 258701,
      budgetsSettled: -5000,
      reservesReleased: 2000,
      total: 255701,
    });
    expect(outstandingList(world).map((entry) => [entry.month, entry.outstanding])).toEqual([
      ['2026-01', 265701],
      ['2026-02', 255701],
    ]);
  });

  it('subtracts what was settled, flags an adjustment and leaves a settled month out', () => {
    const world = twoMonthWorld();
    // January settled in full (two slices), February by 200000 of its 255701.
    world.rows.push(
      row({
        kind: 'settlement',
        date: '2026-03-02',
        amount: 200000,
        goalId: 1,
        settlesMonth: '2026-01',
      }),
      row({ kind: 'settlement', date: '2026-03-02', amount: 65701, settlesMonth: '2026-01' }),
      row({ kind: 'settlement', date: '2026-03-02', amount: 200000, settlesMonth: '2026-02' }),
    );
    expect(outstandingList(world)).toEqual([
      {
        month: '2026-02',
        savingsDue: 255701,
        settled: 200000,
        outstanding: 55701,
        direction: 'move',
        breakdown: { unallocated: 258701, budgetsSettled: -5000, reservesReleased: 2000 },
        adjustment: true,
      },
    ]);
    // A forgotten 10.00 spending in January moves its Groceries remaining from 9000 to 8000, so its
    // savings due is 264701 and it is outstanding by -1000 ("take"), an adjustment of 265701 settled.
    world.facts.spendings.push({ budgetId: 1, month: '2026-01', amount: 1000 });
    expect(outstandingList(world)[0]).toMatchObject({
      month: '2026-01',
      savingsDue: 264701,
      settled: 265701,
      outstanding: -1000,
      direction: 'take',
      adjustment: true,
    });
  });

  it('a month whose settlements net to 0 is still an adjustment, though settled is 0', () => {
    const world = twoMonthWorld();
    world.rows.push(
      row({ kind: 'settlement', amount: 500, settlesMonth: '2026-01' }),
      row({ kind: 'settlement', amount: -500, settlesMonth: '2026-01' }),
    );
    expect(outstandingList(world)[0]).toMatchObject({
      month: '2026-01',
      settled: 0,
      outstanding: 265701,
      adjustment: true,
    });
  });

  it('a settlement of the current month or of a month before the start counts only in the balance', () => {
    const world = twoMonthWorld();
    world.rows.push(
      row({ kind: 'settlement', amount: 1234, settlesMonth: '2026-03' }),
      row({ kind: 'settlement', amount: 4321, settlesMonth: '2025-12' }),
    );
    expect(outstandingList(world).map((entry) => entry.month)).toEqual(['2026-01', '2026-02']);
    expect(expectedSavings(world).balance).toBe(50000 + 1234 + 4321);
  });

  it('balance = unassigned + the goals, archived ones last, and the outstanding total is signed', () => {
    const world = twoMonthWorld();
    world.rows.push(
      row({ amount: 30000, goalId: 1 }), // Holiday
      row({ amount: 7000, goalId: 2 }), // the archived goal
      row({ kind: 'withdrawal', amount: -2500 }), // unassigned: 50000 - 2500
    );
    const savings = expectedSavings(world);
    expect(savings.balance).toBe(50000 + 30000 + 7000 - 2500); // 84500
    expect(savings.unassigned).toBe(47500);
    expect(savings.goals.map((g) => [g.id, g.balance])).toEqual([
      [1, 30000],
      [2, 7000],
    ]);
    expect(savings.outstandingTotal).toBe(265701 + 255701);
  });
});

// -------------------------------------------------------------------------------------------------
// Settling a month: the order of the checks
// -------------------------------------------------------------------------------------------------

describe('predictSettle, the checks in the order of the doc', () => {
  const world = twoMonthWorld(); // goal 1 active, goal 2 archived, no goal 9
  const refusalOf = (month: string, body: Parameters<typeof predictSettle>[2]) => {
    const verdict = predictSettle(world, month, body);
    if (verdict.ok) throw new Error('expected a refusal');
    return verdict.refusal;
  };

  it('1. the month must exist (404) and be closed (422 month_not_closed), before anything else', () => {
    expect(refusalOf('2025-12', { amount: 5 }).status).toBe(404); // before the start month
    expect(refusalOf('2036-04', { amount: 5 })).toMatchObject({ status: 404 }); // 121 months ahead
    expect(refusalOf('2036-03', { amount: 5 })).toMatchObject({
      status: 422,
      rule: 'month_not_closed', // exactly 120 months ahead exists, and is not closed
      field: 'month',
    });
    expect(refusalOf('2026-03', { amount: 999 })).toMatchObject({ rule: 'month_not_closed' });
  });

  it('2. nothing_to_settle, 3. outstanding_changed, 4. allocation_mismatch, then the goals', () => {
    const settledWorld = twoMonthWorld();
    settledWorld.rows.push(row({ kind: 'settlement', amount: 265701, settlesMonth: '2026-01' }));
    const nothing = predictSettle(settledWorld, '2026-01', { amount: 1 });
    expect(nothing).toEqual({ ok: false, refusal: { status: 409, code: 'nothing_to_settle' } });

    expect(refusalOf('2026-01', { amount: 265700 })).toEqual({
      status: 409,
      code: 'outstanding_changed',
      details: { month: '2026-01', outstanding: 265701 },
    });
    // The right figure with the wrong sign is stale too.
    expect(refusalOf('2026-01', { amount: -265701 }).code).toBe('outstanding_changed');
    // A mismatch (the slices add up to 100 less) comes before an unknown goal.
    expect(
      refusalOf('2026-01', {
        amount: 265701,
        allocations: [{ goalId: 9, amount: 265601 }],
      }),
    ).toMatchObject({ rule: 'allocation_mismatch', field: 'allocations' });
    // A slice with the opposite sign is a mismatch even when they add up.
    expect(
      refusalOf('2026-01', {
        amount: 265701,
        allocations: [
          { goalId: null, amount: -1 },
          { goalId: 1, amount: 265702 },
        ],
      }).rule,
    ).toBe('allocation_mismatch');
    // The first offending slice, in order, decides: an archived goal before an unknown one.
    expect(
      refusalOf('2026-01', {
        amount: 265701,
        allocations: [
          { goalId: 1, amount: 1 },
          { goalId: 2, amount: 100 },
          { goalId: 9, amount: 265600 },
        ],
      }),
    ).toMatchObject({ rule: 'goal_archived', field: 'allocations.1.goalId' });
    expect(
      refusalOf('2026-01', {
        amount: 265701,
        allocations: [
          { goalId: 9, amount: 100 },
          { goalId: 2, amount: 265601 },
        ],
      }),
    ).toMatchObject({ rule: 'unknown_goal', field: 'allocations.0.goalId' });
  });

  it('a malformed body is a 400 whatever the month says, and a repeated goal (or null) is one too', () => {
    expect(refusalOf('2026-03', { amount: 0 }).status).toBe(400);
    expect(refusalOf('2026-03', { amount: 5, allocations: [] }).status).toBe(400);
    expect(
      refusalOf('2026-01', {
        amount: 265701,
        allocations: [
          { goalId: null, amount: 1 },
          { goalId: null, amount: 265700 },
        ],
      }).status,
    ).toBe(400);
    expect(
      refusalOf('2026-01', { amount: 5, allocations: [{ goalId: 1, amount: 0 }] }).status,
    ).toBe(400);
  });

  it('accepts the exact figure, split across a goal and unassigned savings, dated today', () => {
    const verdict = predictSettle(world, '2026-02', {
      amount: 255701,
      allocations: [
        { goalId: 1, amount: 100000 },
        { goalId: null, amount: 155701 },
      ],
    });
    expect(verdict).toEqual({
      ok: true,
      value: [
        {
          date: '2026-03-15',
          kind: 'settlement',
          amount: 100000,
          goalId: 1,
          settlesMonth: '2026-02',
          note: null,
        },
        {
          date: '2026-03-15',
          kind: 'settlement',
          amount: 155701,
          goalId: null,
          settlesMonth: '2026-02',
          note: null,
        },
      ],
    });
  });

  it('a negative month is settled with negative slices, whatever the balances hold', () => {
    const negative = twoMonthWorld();
    negative.facts.spendings.push({ budgetId: 1, month: '2026-02', amount: 600000 });
    // February: Groceries remaining 40000 - 645000 = -605000, so savings due = 258701 - 605000 + 2000
    // = -344299 (take 3,442.99).
    expect(outstandingList(negative)[1]).toMatchObject({
      month: '2026-02',
      outstanding: -344299,
      direction: 'take',
    });
    const verdict = predictSettle(negative, '2026-02', {
      amount: -344299,
      allocations: [{ goalId: 1, amount: -344299 }],
    });
    expect(verdict.ok).toBe(true);
  });

  it('undo answers 404 without settlement rows, otherwise lists every row of the month', () => {
    const w = twoMonthWorld();
    expect(predictUndo(w, '2026-01')).toMatchObject({ ok: false, refusal: { status: 404 } });
    w.rows.push(
      row({ kind: 'settlement', amount: 1, settlesMonth: '2026-01' }),
      row({ kind: 'settlement', amount: 2, settlesMonth: '2026-01' }),
      row({ kind: 'settlement', amount: 3, settlesMonth: '2026-02' }),
    );
    const verdict = predictUndo(w, '2026-01');
    expect(verdict).toEqual({ ok: true, value: w.rows.slice(1, 3).map((r) => r.id) });
  });
});

// -------------------------------------------------------------------------------------------------
// Manual money
// -------------------------------------------------------------------------------------------------

describe('predictManual, the checks in the order of the doc: date, goals, balance', () => {
  const world = twoMonthWorld();
  world.rows.push(row({ amount: 3000, goalId: 1 }), row({ amount: 800, goalId: 2 }));
  // Unassigned holds the 50000 opening; goal 1 holds 3000; the archived goal 2 holds 800.
  const verdictOf = (body: Parameters<typeof predictManual>[1]) => predictManual(world, body);
  const refusal = (body: Parameters<typeof predictManual>[1]) => {
    const verdict = verdictOf(body);
    if (verdict.ok) throw new Error('expected a refusal');
    return verdict.refusal;
  };

  it('the date comes first, then the goals, then the balance', () => {
    expect(
      refusal({ kind: 'withdrawal', amount: 10 ** 9, goalId: 9, date: '2026-03-16' }),
    ).toMatchObject({
      rule: 'date_in_future',
      field: 'date',
    });
    expect(refusal({ kind: 'deposit', amount: 5, goalId: 9, date: '2025-12-31' })).toMatchObject({
      rule: 'before_start_month',
    });
    expect(refusal({ kind: 'withdrawal', amount: 10 ** 9, goalId: 9 })).toMatchObject({
      rule: 'unknown_goal',
      field: 'goalId',
    });
    expect(refusal({ kind: 'withdrawal', amount: 3001, goalId: 1 })).toMatchObject({
      rule: 'insufficient_balance',
      field: 'amount',
    });
  });

  it('accepts today and the first day of the start month as dates, and the exact balance', () => {
    expect(verdictOf({ kind: 'deposit', amount: 1, date: '2026-03-15' }).ok).toBe(true);
    expect(verdictOf({ kind: 'deposit', amount: 1, date: '2026-01-01' }).ok).toBe(true);
    expect(verdictOf({ kind: 'withdrawal', amount: 3000, goalId: 1 }).ok).toBe(true);
    expect(verdictOf({ kind: 'withdrawal', amount: 50000 }).ok).toBe(true);
    expect(refusal({ kind: 'withdrawal', amount: 50001 })).toMatchObject({
      rule: 'insufficient_balance',
    });
  });

  it('an archived goal can give money but not receive it', () => {
    expect(refusal({ kind: 'deposit', amount: 5, goalId: 2 })).toMatchObject({
      rule: 'goal_archived',
      field: 'goalId',
    });
    expect(verdictOf({ kind: 'withdrawal', amount: 800, goalId: 2 }).ok).toBe(true);
    expect(verdictOf({ kind: 'reallocation', amount: 800, fromGoalId: 2, toGoalId: null }).ok).toBe(
      true,
    );
    expect(
      refusal({ kind: 'reallocation', amount: 5, fromGoalId: null, toGoalId: 2 }),
    ).toMatchObject({
      rule: 'goal_archived',
      field: 'toGoalId',
    });
  });

  it('a reallocation checks from exists, to exists, to is not archived, then the balance', () => {
    const r = (fromGoalId: number | null, toGoalId: number | null, amount: number) =>
      refusal({ kind: 'reallocation', amount, fromGoalId, toGoalId });
    expect(r(9, 2, 5)).toMatchObject({ rule: 'unknown_goal', field: 'fromGoalId' });
    expect(r(1, 9, 10 ** 9)).toMatchObject({ rule: 'unknown_goal', field: 'toGoalId' });
    expect(r(1, 2, 10 ** 9)).toMatchObject({ rule: 'goal_archived', field: 'toGoalId' });
    expect(r(1, null, 3001)).toMatchObject({ rule: 'insufficient_balance', field: 'amount' });
    // A reallocation to itself is not well formed (400), whatever else is wrong with it.
    expect(refusal({ kind: 'reallocation', amount: 5, fromGoalId: 9, toGoalId: 9 }).status).toBe(
      400,
    );
    expect(
      refusal({ kind: 'reallocation', amount: 5, fromGoalId: null, toGoalId: null }).status,
    ).toBe(400);
  });

  it('stores a withdrawal as -amount and a reallocation as -amount for the source, then +amount', () => {
    expect(verdictOf({ kind: 'withdrawal', amount: 700, goalId: 1, note: '  rent ' })).toEqual({
      ok: true,
      value: [
        {
          date: '2026-03-15',
          kind: 'withdrawal',
          amount: -700,
          goalId: 1,
          settlesMonth: null,
          note: 'rent',
        },
      ],
    });
    expect(
      verdictOf({
        kind: 'reallocation',
        amount: 300,
        fromGoalId: 1,
        toGoalId: null,
        date: '2026-02-10',
        note: '  ',
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          date: '2026-02-10',
          kind: 'reallocation',
          amount: -300,
          goalId: 1,
          settlesMonth: null,
          note: null,
        },
        {
          date: '2026-02-10',
          kind: 'reallocation',
          amount: 300,
          goalId: null,
          settlesMonth: null,
          note: null,
        },
      ],
    });
  });

  it('a zero or negative amount is not well formed (400)', () => {
    expect(refusal({ kind: 'deposit', amount: 0 }).status).toBe(400);
    expect(refusal({ kind: 'withdrawal', amount: -5 }).status).toBe(400);
  });

  it('deleting: unknown 404, opening and settlement 409, a reallocation goes with its partner', () => {
    const w = twoMonthWorld();
    const settlement = row({ kind: 'settlement', amount: 1, settlesMonth: '2026-01' });
    const first = row({ kind: 'reallocation', amount: -5, goalId: 1 });
    const second = row({ kind: 'reallocation', amount: 5, goalId: null });
    first.groupId = second.groupId = first.id;
    const deposit = row({ amount: 9 });
    w.rows.push(settlement, first, second, deposit);
    expect(predictDeleteRow(w, 999)).toMatchObject({ ok: false, refusal: { status: 404 } });
    expect(predictDeleteRow(w, w.rows[0]!.id)).toMatchObject({
      ok: false,
      refusal: { status: 409, code: 'not_deletable' },
    });
    expect(predictDeleteRow(w, settlement.id)).toMatchObject({
      ok: false,
      refusal: { status: 409 },
    });
    expect(predictDeleteRow(w, second.id)).toEqual({ ok: true, value: [first.id, second.id] });
    expect(predictDeleteRow(w, deposit.id)).toEqual({ ok: true, value: [deposit.id] });
  });
});

// -------------------------------------------------------------------------------------------------
// Lists, opening, start month
// -------------------------------------------------------------------------------------------------

describe('the transaction list and the opening balance', () => {
  it('lists newest first (date, then id, descending), filters combine, and the page slices', () => {
    const w = twoMonthWorld();
    const a = row({ date: '2026-02-01', amount: 1, goalId: 1 });
    const b = row({ date: '2026-02-01', amount: 2, goalId: null });
    const c = row({ date: '2026-03-01', kind: 'withdrawal', amount: -3, goalId: 1 });
    w.rows.push(a, b, c);
    const all = expectedPage(w, { limit: 50, offset: 0 });
    expect(all.items.map((r) => r.id)).toEqual([c.id, b.id, a.id, w.rows[0]!.id]);
    expect(all.total).toBe(4);
    expect(expectedPage(w, { goalId: 1, limit: 50, offset: 0 }).items.map((r) => r.id)).toEqual([
      c.id,
      a.id,
    ]);
    expect(expectedPage(w, { unassigned: true, limit: 50, offset: 0 }).total).toBe(2);
    expect(expectedPage(w, { goalId: 1, kind: 'deposit', limit: 50, offset: 0 }).items).toEqual([
      a,
    ]);
    expect(expectedPage(w, { limit: 2, offset: 1 })).toMatchObject({
      total: 4,
      limit: 2,
      offset: 1,
      items: [{ id: b.id }, { id: a.id }],
    });
  });

  it('the opening balance is the opening row (0 without one), dated the 1st of the start month', () => {
    const w = twoMonthWorld();
    expect(expectedOpening(w)).toEqual({ amount: 50000, date: '2026-01-01' });
    moveStart(w, '2025-10');
    expect(expectedOpening(w)).toEqual({ amount: 50000, date: '2025-10-01' }); // the amount does not move
    w.rows.length = 0;
    expect(expectedOpening(w)).toEqual({ amount: 0, date: '2025-10-01' });
  });
});

describe('predictMoveStart', () => {
  const refusalOf = (w: World, month: string) => {
    const verdict = predictMoveStart(w, month);
    if (verdict.ok) throw new Error('expected a refusal');
    return verdict.refusal.rule;
  };

  it('moving earlier is allowed within 240 months, after the current month is not', () => {
    const w = twoMonthWorld();
    expect(predictMoveStart(w, '2025-06').ok).toBe(true);
    expect(refusalOf(w, '2026-04')).toBe('start_month_in_future');
    // 2026-03 minus 240 months is 2006-03: allowed; one month more is too old.
    expect(predictMoveStart(w, '2006-03').ok).toBe(true);
    expect(refusalOf(w, '2006-02')).toBe('start_month_too_old');
  });

  it('moving later is refused while any fact is dated before the new month, whatever kind of fact', () => {
    const w = twoMonthWorld();
    expect(earliestFact(w)).toBe('2026-01');
    expect(refusalOf(w, '2026-02')).toBe('start_month_after_facts'); // the salary, the budget, ...
    w.facts.salary[0]!.effectiveMonth = '2026-03';
    w.facts.subscriptions.forEach((s) => (s.startMonth = '2026-03'));
    w.facts.budgets.forEach((b) => (b.startMonth = '2026-03'));
    w.facts.spendings.length = 0;
    expect(earliestFact(w)).toBe('2026-03'); // the opening row (2026-01-01) is not a fact
    expect(predictMoveStart(w, '2026-02').ok).toBe(true);
    // Each other kind of fact, on its own, blocks it again.
    w.facts.incomes.push({ month: '2026-01', amount: 5 });
    expect(refusalOf(w, '2026-02')).toBe('start_month_after_facts');
    w.facts.incomes.length = 0;
    w.rows.push(row({ date: '2026-01-31', amount: 5 }));
    expect(refusalOf(w, '2026-02')).toBe('start_month_after_facts');
    w.rows.pop();
    w.rows.push(
      row({ kind: 'settlement', date: '2026-03-02', amount: 5, settlesMonth: '2026-01' }),
    );
    expect(refusalOf(w, '2026-02')).toBe('start_month_after_facts'); // the month it settles
    expect(predictMoveStart(w, '2026-01').ok).toBe(true); // staying put is never refused
  });
});

describe('expectedGoals', () => {
  it('lists archived goals last, each group in creation order', () => {
    const w = twoMonthWorld();
    w.goals = [
      goal({ id: 1, archived: true }),
      goal({ id: 2 }),
      goal({ id: 3, archived: true }),
      goal({ id: 4 }),
    ];
    expect(expectedGoals(w).map((g) => g.id)).toEqual([2, 4, 1, 3]);
  });
});
