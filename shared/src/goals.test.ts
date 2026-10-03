import { describe, expect, it } from 'vitest';
import { type GoalDto, type GoalStatus, goalCreateSchema, goalUpdateSchema } from './goals';
import { MAX_CENTS } from './limits';
import { ceilDiv } from './money';
import { type MonthKey, monthDiff } from './month';
import { chars, parseCases, schemaCases } from './test-utils';

const holiday = { name: 'Holiday', targetAmount: 120000 };

describe('goal schemas', () => {
  schemaCases(
    'goalCreateSchema (POST /api/goals)',
    goalCreateSchema,
    [
      ['a name and a target', holiday],
      ['a full body', { ...holiday, deadline: '2027-03-15', color: '#3b82f6' }],
      ['null deadline and color', { ...holiday, deadline: null, color: null }],
      ['one cent', { ...holiday, targetAmount: 1 }],
      ['the largest target', { ...holiday, targetAmount: MAX_CENTS }],
      ['the longest name', { ...holiday, name: chars(60) }],
      ['a deadline in the past', { ...holiday, deadline: '2020-01-31' }],
      ['an upper-case color', { ...holiday, color: '#3B82F6' }],
    ],
    [
      ['an empty body', {}, 'name'],
      ['a missing name', { targetAmount: 100 }, 'name'],
      ['a blank name', { ...holiday, name: '  ' }, 'name'],
      ['a too long name', { ...holiday, name: chars(61) }, 'name'],
      ['a number as name', { ...holiday, name: 7 }, 'name'],
      ['a missing target', { name: 'x' }, 'targetAmount'],
      ['a zero target', { ...holiday, targetAmount: 0 }, 'targetAmount'],
      ['a negative target', { ...holiday, targetAmount: -100 }, 'targetAmount'],
      ['a fractional target', { ...holiday, targetAmount: 10.5 }, 'targetAmount'],
      ['a string target', { ...holiday, targetAmount: '1200.00' }, 'targetAmount'],
      ['a target above the cap', { ...holiday, targetAmount: MAX_CENTS + 1 }, 'targetAmount'],
      ['a deadline that is not a date', { ...holiday, deadline: '2027-02-30' }, 'deadline'],
      ['a month as deadline', { ...holiday, deadline: '2027-03' }, 'deadline'],
      ['a text deadline', { ...holiday, deadline: 'soon' }, 'deadline'],
      ['a short color', { ...holiday, color: '#fff' }, 'color'],
      ['a color name', { ...holiday, color: 'blue' }, 'color'],
      ['an empty color', { ...holiday, color: '' }, 'color'],
      ['archived at creation', { ...holiday, archived: true }, ''],
      ['a balance', { ...holiday, balance: 5000 }, ''],
    ],
  );
  parseCases('goalCreateSchema output', goalCreateSchema, [
    [
      'trims the name and lower-cases the color',
      { name: ' Holiday ', targetAmount: 5, color: '#3B82F6' },
      { name: 'Holiday', targetAmount: 5, color: '#3b82f6' },
    ],
    [
      'leaves omitted optional fields out',
      { name: 'Car', targetAmount: 5 },
      { name: 'Car', targetAmount: 5 },
    ],
  ]);

  schemaCases(
    'goalUpdateSchema (PATCH /api/goals/:id)',
    goalUpdateSchema,
    [
      ['only the name', { name: 'Trip' }],
      ['only the target', { targetAmount: 150000 }],
      ['a deadline', { deadline: '2027-06-30' }],
      ['clearing the deadline', { deadline: null }],
      ['a color', { color: '#16a34a' }],
      ['clearing the color', { color: null }],
      ['archiving', { archived: true }],
      ['bringing it back', { archived: false }],
      ['every field', { ...holiday, deadline: '2027-03-15', color: '#3b82f6', archived: false }],
    ],
    [
      ['an empty body', {}, ''],
      ['a null name', { name: null }, 'name'],
      ['a blank name', { name: ' ' }, 'name'],
      ['a null target', { targetAmount: null }, 'targetAmount'],
      ['a zero target', { targetAmount: 0 }, 'targetAmount'],
      ['a fractional target', { targetAmount: 1.5 }, 'targetAmount'],
      ['a bad deadline', { deadline: '2027-13-01' }, 'deadline'],
      ['a bad color', { color: 'green' }, 'color'],
      ['a null archived', { archived: null }, 'archived'],
      ['a text archived', { archived: 'yes' }, 'archived'],
      ['a numeric archived', { archived: 1 }, 'archived'],
      ['a balance', { balance: 100 }, ''],
      ['an id', { id: 3 }, ''],
    ],
  );
});

// ---------------------------------------------------------------------------------------------
// A worked example. It type-checks the DTO and asserts every figure their JSDoc promises, from the
// formulas of docs/DOMAIN.md ("Goals"), so the numbers double as documentation for the frontend
// and a template for the backend tests.
// ---------------------------------------------------------------------------------------------

type GoalFacts = Pick<GoalDto, 'targetAmount' | 'balance' | 'deadline' | 'archived'>;

/** The figures of a goal, from the rules of docs/DOMAIN.md. */
function figuresOf(goal: GoalFacts, currentMonth: MonthKey) {
  const remaining = Math.max(0, goal.targetAmount - goal.balance);
  const reached = goal.balance >= goal.targetAmount;
  const deadlineMonth = goal.deadline === null ? null : goal.deadline.slice(0, 7);
  const overdue = deadlineMonth !== null && deadlineMonth < currentMonth;
  const status: GoalStatus = goal.archived
    ? 'archived'
    : reached
      ? 'reached'
      : overdue
        ? 'overdue'
        : 'active';
  const monthsLeft =
    deadlineMonth === null ? null : Math.max(1, monthDiff(currentMonth, deadlineMonth) + 1);
  return {
    progressPercent: Math.max(0, Math.floor((100 * goal.balance) / goal.targetAmount)),
    remaining,
    reached,
    monthsLeft,
    monthlyNeeded:
      monthsLeft !== null && !reached && !goal.archived ? ceilDiv(remaining, monthsLeft) : null,
    status,
  };
}

function checkFigures(goal: GoalDto, currentMonth: MonthKey) {
  const { monthsLeft: _monthsLeft, ...expected } = figuresOf(goal, currentMonth);
  expect({
    progressPercent: goal.progressPercent,
    remaining: goal.remaining,
    reached: goal.reached,
    monthlyNeeded: goal.monthlyNeeded,
    status: goal.status,
  }).toEqual(expected);
  // The equivalences the JSDoc states.
  expect(goal.reached).toBe(goal.remaining === 0);
  expect(goal.reached).toBe(goal.progressPercent >= 100);
  expect(goal.monthlyNeeded !== null).toBe(
    goal.deadline !== null && (goal.status === 'active' || goal.status === 'overdue'),
  );
}

const base: GoalDto = {
  id: 1,
  name: 'Holiday',
  targetAmount: 100000,
  deadline: '2027-03-15',
  color: '#3b82f6',
  archived: false,
  balance: 0,
  progressPercent: 0,
  remaining: 100000,
  reached: false,
  monthlyNeeded: 16667, // 1,000.00 over October to March: ceilDiv(100000, 6)
  status: 'active',
};

describe('GoalDto worked example (today is 2026-10-02)', () => {
  const october = '2026-10';

  const examples: [label: string, goal: GoalDto, currentMonth: MonthKey][] = [
    ['an empty goal with a deadline', base, october],
    [
      'a goal part of the way (the deadline month counts)',
      {
        ...base,
        balance: 30000,
        progressPercent: 30,
        remaining: 70000,
        monthlyNeeded: 11667, // ceilDiv(70000, 6): the last month needs a little less
      },
      october,
    ],
    [
      'a goal without a deadline',
      {
        ...base,
        deadline: null,
        balance: 25050,
        progressPercent: 25,
        remaining: 74950,
        monthlyNeeded: null,
      },
      october,
    ],
    [
      'a goal that is reached exactly',
      {
        ...base,
        balance: 100000,
        progressPercent: 100,
        remaining: 0,
        reached: true,
        monthlyNeeded: null,
        status: 'reached',
      },
      october,
    ],
    [
      'a goal beyond its target (not capped)',
      {
        ...base,
        balance: 150000,
        progressPercent: 150,
        remaining: 0,
        reached: true,
        monthlyNeeded: null,
        status: 'reached',
      },
      october,
    ],
    [
      'a goal one cent short',
      { ...base, balance: 99999, progressPercent: 99, remaining: 1, monthlyNeeded: 1 },
      october,
    ],
    [
      'a deadline in the current month: all of it now',
      {
        ...base,
        deadline: '2026-10-31',
        balance: 40000,
        progressPercent: 40,
        remaining: 60000,
        monthlyNeeded: 60000,
      },
      october,
    ],
    [
      'a deadline month that has passed: overdue, all of it now',
      {
        ...base,
        deadline: '2026-08-31',
        balance: 40000,
        progressPercent: 40,
        remaining: 60000,
        monthlyNeeded: 60000,
        status: 'overdue',
      },
      october,
    ],
    [
      'a reached goal past its deadline is reached, not overdue',
      {
        ...base,
        deadline: '2026-08-31',
        balance: 100000,
        progressPercent: 100,
        remaining: 0,
        reached: true,
        monthlyNeeded: null,
        status: 'reached',
      },
      october,
    ],
    [
      'an archived goal: no monthly amount',
      {
        ...base,
        archived: true,
        balance: 30000,
        progressPercent: 30,
        remaining: 70000,
        monthlyNeeded: null,
        status: 'archived',
      },
      october,
    ],
    [
      'an archived goal that was reached',
      {
        ...base,
        archived: true,
        balance: 100000,
        progressPercent: 100,
        remaining: 0,
        reached: true,
        monthlyNeeded: null,
        status: 'archived',
      },
      october,
    ],
    [
      'a negative balance (a settlement took more than it held)',
      {
        ...base,
        balance: -5000,
        progressPercent: 0,
        remaining: 105000,
        monthlyNeeded: 17500, // ceilDiv(105000, 6)
      },
      october,
    ],
    [
      'the same goal six months later (one month left)',
      { ...base, balance: 30000, progressPercent: 30, remaining: 70000, monthlyNeeded: 70000 },
      '2027-03',
    ],
  ];

  it.each(examples)('%s', (_label, goal, currentMonth) => {
    checkFigures(goal, currentMonth);
  });

  it('counts the months from the current one to the deadline month, both included', () => {
    expect(figuresOf(base, '2026-10').monthsLeft).toBe(6); // Oct, Nov, Dec, Jan, Feb, Mar
    expect(figuresOf(base, '2027-02').monthsLeft).toBe(2);
    expect(figuresOf(base, '2027-03').monthsLeft).toBe(1);
    expect(figuresOf(base, '2027-04').monthsLeft).toBe(1); // passed: at least 1
    expect(figuresOf(base, '2030-01').monthsLeft).toBe(1);
    expect(figuresOf({ ...base, deadline: null }, '2026-10').monthsLeft).toBeNull();
  });

  it.each([
    [0, 1000, 0],
    [999, 1000, 99],
    [1000, 1000, 100],
    [1001, 1000, 100],
    [1, 3, 33],
    [2, 3, 66],
    [3, 3, 100],
    [-1, 1000, 0],
    [-1000, 1000, 0],
  ])('rounds the progress of %i towards %i down, to %i', (balance, targetAmount, expected) => {
    const goal = { targetAmount, balance, deadline: null, archived: false };
    expect(figuresOf(goal, '2026-10').progressPercent).toBe(expected);
    // "100 or more" is exactly "reached".
    expect(figuresOf(goal, '2026-10').progressPercent >= 100).toBe(balance >= targetAmount);
  });
});
