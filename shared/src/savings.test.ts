import { describe, expect, it } from 'vitest';
import type { GoalDto } from './goals';
import {
  MANUAL_SAVINGS_KINDS,
  MAX_CENTS,
  MAX_SETTLEMENT_ALLOCATIONS,
  SAVINGS_TRANSACTIONS_DEFAULT_LIMIT,
  SAVINGS_TRANSACTIONS_MAX_LIMIT,
  SAVINGS_TRANSACTION_KINDS,
} from './limits';
import type { MonthSavingsDue } from './months';
import {
  type OutstandingMonthDto,
  type SavingsDto,
  type SavingsDueBreakdown,
  type SavingsTransactionDto,
  savingsAllocationSchema,
  savingsDepositSchema,
  savingsOpeningSchema,
  savingsReallocationSchema,
  savingsSettleSchema,
  savingsTransactionCreateSchema,
  savingsTransactionListQuerySchema,
  savingsWithdrawalSchema,
} from './savings';
import { chars, parseCases, schemaCases } from './test-utils';

// ---------------------------------------------------------------------------------------------
// Settling a month
// ---------------------------------------------------------------------------------------------

const split = {
  amount: 31240,
  allocations: [
    { goalId: 1, amount: 20000 },
    { goalId: 2, amount: 10000 },
    { goalId: null, amount: 1240 },
  ],
};

describe('settle schemas', () => {
  schemaCases(
    'savingsAllocationSchema',
    savingsAllocationSchema,
    [
      ['a goal', { goalId: 3, amount: 500 }],
      ['unassigned savings', { goalId: null, amount: 500 }],
      ['a negative slice (taken from the goal)', { goalId: 3, amount: -500 }],
    ],
    [
      ['an empty slice', {}, 'goalId'],
      ['a missing goalId', { amount: 500 }, 'goalId'],
      ['an omitted goalId is not "unassigned"', { goalId: undefined, amount: 500 }, 'goalId'],
      ['a missing amount', { goalId: 3 }, 'amount'],
      ['a zero amount', { goalId: 3, amount: 0 }, 'amount'],
      ['a fractional amount', { goalId: 3, amount: 0.5 }, 'amount'],
      ['a zero goalId', { goalId: 0, amount: 5 }, 'goalId'],
      ['a negative goalId', { goalId: -1, amount: 5 }, 'goalId'],
      ['a string goalId', { goalId: '3', amount: 5 }, 'goalId'],
      ['a boolean goalId', { goalId: false, amount: 5 }, 'goalId'],
      ['an unknown key', { goalId: 3, amount: 5, note: 'x' }, ''],
    ],
  );

  schemaCases(
    'savingsSettleSchema (POST /api/savings/settle/:month)',
    savingsSettleSchema,
    [
      ['the whole amount to unassigned savings', { amount: 31240 }],
      ['a negative amount (take from savings)', { amount: -1200 }],
      [
        'one allocation to unassigned savings',
        { amount: 500, allocations: [{ goalId: null, amount: 500 }] },
      ],
      ['a split across goals', split],
      [
        'a negative split',
        {
          amount: -300,
          allocations: [
            { goalId: 1, amount: -100 },
            { goalId: null, amount: -200 },
          ],
        },
      ],
      ['the largest amount', { amount: MAX_CENTS }],
      // The sum and the sign of the allocations are checked by the service (422 `allocation_mismatch`),
      // because the schema cannot tell the user which rule they broke. Pin that the schema leaves it.
      ['allocations that do not add up', { amount: 100, allocations: [{ goalId: 1, amount: 40 }] }],
      [
        'an allocation of the opposite sign',
        { amount: 100, allocations: [{ goalId: 1, amount: -100 }] },
      ],
      [
        'the most allocations',
        {
          amount: MAX_SETTLEMENT_ALLOCATIONS,
          allocations: Array.from({ length: MAX_SETTLEMENT_ALLOCATIONS }, (_unused, index) => ({
            goalId: index + 1,
            amount: 1,
          })),
        },
      ],
    ],
    [
      ['an empty body', {}, 'amount'],
      ['a missing amount', { allocations: [{ goalId: null, amount: 5 }] }, 'amount'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['a fractional amount', { amount: 12.5 }, 'amount'],
      ['a string amount', { amount: '312.40' }, 'amount'],
      ['a null amount', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: MAX_CENTS + 1 }, 'amount'],
      ['no allocations at all', { amount: 5, allocations: [] }, 'allocations'],
      ['null allocations', { amount: 5, allocations: null }, 'allocations'],
      [
        'an object as allocations',
        { amount: 5, allocations: { goalId: null, amount: 5 } },
        'allocations',
      ],
      [
        'an allocation without a goalId',
        { amount: 5, allocations: [{ amount: 5 }] },
        'allocations.0.goalId',
      ],
      [
        'a zero allocation',
        { amount: 5, allocations: [{ goalId: 1, amount: 0 }] },
        'allocations.0.amount',
      ],
      [
        'a bad goalId in the second allocation',
        {
          amount: 5,
          allocations: [
            { goalId: 1, amount: 2 },
            { goalId: 'x', amount: 3 },
          ],
        },
        'allocations.1.goalId',
      ],
      [
        'an unknown key in an allocation',
        { amount: 5, allocations: [{ goalId: 1, amount: 5, note: 'x' }] },
        'allocations.0',
      ],
      [
        'the same goal twice',
        {
          amount: 5,
          allocations: [
            { goalId: 1, amount: 2 },
            { goalId: 1, amount: 3 },
          ],
        },
        'allocations.1.goalId',
      ],
      [
        'unassigned savings twice',
        {
          amount: 5,
          allocations: [
            { goalId: null, amount: 2 },
            { goalId: null, amount: 3 },
          ],
        },
        'allocations.1.goalId',
      ],
      [
        'a goal repeated after another one',
        {
          amount: 6,
          allocations: [
            { goalId: 1, amount: 2 },
            { goalId: 2, amount: 2 },
            { goalId: 1, amount: 2 },
          ],
        },
        'allocations.2.goalId',
      ],
      [
        'one allocation too many',
        {
          amount: MAX_SETTLEMENT_ALLOCATIONS + 1,
          allocations: Array.from({ length: MAX_SETTLEMENT_ALLOCATIONS + 1 }, (_unused, index) => ({
            goalId: index + 1,
            amount: 1,
          })),
        },
        'allocations',
      ],
      ['an unknown key', { amount: 5, month: '2026-09' }, ''],
      ['a month in the body', { ...split, month: '2026-09' }, ''],
    ],
  );
  parseCases('savingsSettleSchema output', savingsSettleSchema, [
    ['leaves omitted allocations out', { amount: 500 }, { amount: 500 }],
    ['keeps the allocations in order', split, split],
  ]);
});

// ---------------------------------------------------------------------------------------------
// Manual money
// ---------------------------------------------------------------------------------------------

const deposit = { kind: 'deposit', amount: 5000 };
const withdrawal = { kind: 'withdrawal', amount: 20000, goalId: 1 };
const reallocation = { kind: 'reallocation', amount: 2500, fromGoalId: 1, toGoalId: 2 };

describe('manual transaction schemas', () => {
  schemaCases(
    'savingsTransactionCreateSchema (POST /api/savings/transactions)',
    savingsTransactionCreateSchema,
    [
      ['a deposit to unassigned savings (no goal)', deposit],
      ['a deposit with a null goal', { ...deposit, goalId: null }],
      ['a deposit to a goal', { ...deposit, goalId: 3 }],
      ['a full deposit', { ...deposit, goalId: 3, date: '2026-09-30', note: 'Birthday money' }],
      ['a withdrawal from a goal', withdrawal],
      ['a withdrawal from unassigned savings', { kind: 'withdrawal', amount: 100, goalId: null }],
      ['a withdrawal with a date and a note', { ...withdrawal, date: '2026-08-01', note: 'Hotel' }],
      ['a reallocation between two goals', reallocation],
      ['a reallocation from a goal to unassigned savings', { ...reallocation, toGoalId: null }],
      ['a reallocation from unassigned savings to a goal', { ...reallocation, fromGoalId: null }],
      ['a reallocation with a date and a note', { ...reallocation, date: '2026-10-01', note: 'x' }],
      ['one cent', { ...deposit, amount: 1 }],
      ['the largest amount', { ...deposit, amount: MAX_CENTS }],
      ['the first of a month', { ...deposit, date: '2026-10-01' }],
      ['the last day of February', { ...deposit, date: '2028-02-29' }],
      ['null note', { ...deposit, note: null }],
      ['the longest note', { ...deposit, note: chars(1000) }],
    ],
    [
      ['an empty body', {}, 'kind'],
      ['a missing kind', { amount: 5000 }, 'kind'],
      ['an unknown kind', { ...deposit, kind: 'transfer' }, 'kind'],
      ['the opening kind', { kind: 'opening', amount: 5000 }, 'kind'],
      ['the settlement kind', { kind: 'settlement', amount: 5000 }, 'kind'],
      ['a kind in the wrong case', { ...deposit, kind: 'Deposit' }, 'kind'],
      ['a numeric kind', { ...deposit, kind: 1 }, 'kind'],
      ['a body that is not an object', 'deposit', ''],
      ['a null body', null, ''],
      ['a missing amount', { kind: 'deposit' }, 'amount'],
      ['a zero amount', { ...deposit, amount: 0 }, 'amount'],
      ['a negative withdrawal (the sign is the kind)', { ...withdrawal, amount: -20000 }, 'amount'],
      ['a negative deposit', { ...deposit, amount: -1 }, 'amount'],
      ['a fractional amount', { ...deposit, amount: 12.5 }, 'amount'],
      ['a string amount', { ...deposit, amount: '50.00' }, 'amount'],
      ['an amount above the cap', { ...deposit, amount: MAX_CENTS + 1 }, 'amount'],
      ['a zero goalId', { ...deposit, goalId: 0 }, 'goalId'],
      ['a negative goalId', { ...withdrawal, goalId: -2 }, 'goalId'],
      ['a string goalId', { ...deposit, goalId: '3' }, 'goalId'],
      ['a boolean goalId', { ...deposit, goalId: true }, 'goalId'],
      ['a date that does not exist', { ...deposit, date: '2026-02-30' }, 'date'],
      ['a month as date', { ...deposit, date: '2026-10' }, 'date'],
      ['a text date', { ...deposit, date: 'today' }, 'date'],
      ['a null date', { ...deposit, date: null }, 'date'],
      ['a too long note', { ...deposit, note: chars(1001) }, 'note'],
      ['a numeric note', { ...deposit, note: 5 }, 'note'],
      ['from and to on a deposit', { ...deposit, fromGoalId: 1 }, ''],
      ['a goal-less key on a reallocation', { ...reallocation, goalId: 1 }, ''],
      ['a settlement month', { ...deposit, settlesMonth: '2026-09' }, ''],
      ['a group id', { ...deposit, groupId: 4 }, ''],
      ['a reallocation without a source', { ...reallocation, fromGoalId: undefined }, 'fromGoalId'],
      [
        'a reallocation without a destination',
        { ...reallocation, toGoalId: undefined },
        'toGoalId',
      ],
      ['a reallocation within one goal', { ...reallocation, toGoalId: 1 }, 'toGoalId'],
      [
        'a reallocation within unassigned savings',
        { ...reallocation, fromGoalId: null, toGoalId: null },
        'toGoalId',
      ],
      ['a bad source goal', { ...reallocation, fromGoalId: 0 }, 'fromGoalId'],
      ['a bad destination goal', { ...reallocation, toGoalId: 'x' }, 'toGoalId'],
      ['a zero reallocation', { ...reallocation, amount: 0 }, 'amount'],
    ],
  );

  parseCases('savingsTransactionCreateSchema output', savingsTransactionCreateSchema, [
    ['keeps a deposit as sent', deposit, deposit],
    ['trims the note and nulls a blank one', { ...deposit, note: ' ' }, { ...deposit, note: null }],
    ['trims a note', { ...deposit, note: ' Gift ' }, { ...deposit, note: 'Gift' }],
    ['keeps a reallocation as sent', reallocation, reallocation],
  ]);

  it('has one schema per manual kind, in the order of MANUAL_SAVINGS_KINDS', () => {
    const kinds = [savingsDepositSchema, savingsWithdrawalSchema, savingsReallocationSchema].map(
      (schema) => schema.shape.kind.value,
    );
    expect(kinds).toEqual([...MANUAL_SAVINGS_KINDS]);
    expect(savingsTransactionCreateSchema.options).toHaveLength(MANUAL_SAVINGS_KINDS.length);
  });

  it('lists the manual kinds among all the kinds of a savings transaction', () => {
    expect([...SAVINGS_TRANSACTION_KINDS].sort()).toEqual(
      ['opening', 'settlement', ...MANUAL_SAVINGS_KINDS].sort(),
    );
  });
});

describe('savingsTransactionListQuerySchema (GET /api/savings/transactions)', () => {
  schemaCases(
    'query',
    savingsTransactionListQuerySchema,
    [
      ['no filter', {}],
      ['a goal (as in a query string)', { goalId: '3' }],
      ['unassigned savings', { unassigned: 'true' }],
      ['unassigned set to false', { unassigned: 'false' }],
      ['unassigned set to false next to a goal', { goalId: '3', unassigned: 'false' }],
      ...SAVINGS_TRANSACTION_KINDS.map((kind): [string, unknown] => [`the ${kind} kind`, { kind }]),
      ['the largest page', { limit: String(SAVINGS_TRANSACTIONS_MAX_LIMIT) }],
      ['the smallest page', { limit: '1' }],
      ['a numeric limit and offset', { limit: 20, offset: 40 }],
      [
        'every filter',
        { goalId: '2', unassigned: 'false', kind: 'deposit', limit: '10', offset: '0' },
      ],
    ],
    [
      ['a zero goalId', { goalId: '0' }, 'goalId'],
      ['a text goalId', { goalId: 'holiday' }, 'goalId'],
      ['a fractional goalId', { goalId: '1.5' }, 'goalId'],
      ['an empty goalId', { goalId: '' }, 'goalId'],
      ['yes as unassigned', { unassigned: 'yes' }, 'unassigned'],
      ['1 as unassigned', { unassigned: '1' }, 'unassigned'],
      ['an empty unassigned', { unassigned: '' }, 'unassigned'],
      ['a boolean unassigned (query strings carry text)', { unassigned: true }, 'unassigned'],
      ['a goal together with unassigned', { goalId: '3', unassigned: 'true' }, 'unassigned'],
      ['an unknown kind', { kind: 'transfer' }, 'kind'],
      ['a kind in the wrong case', { kind: 'Deposit' }, 'kind'],
      ['an empty kind', { kind: '' }, 'kind'],
      ['a zero limit', { limit: '0' }, 'limit'],
      ['a limit above the maximum', { limit: String(SAVINGS_TRANSACTIONS_MAX_LIMIT + 1) }, 'limit'],
      ['a text limit', { limit: 'many' }, 'limit'],
      ['an empty limit', { limit: '' }, 'limit'],
      ['a fractional limit', { limit: '1.5' }, 'limit'],
      ['a negative offset', { offset: '-1' }, 'offset'],
      ['a text offset', { offset: 'x' }, 'offset'],
      ['an unknown filter', { month: '2026-10' }, ''],
      ['a search', { q: 'holiday' }, ''],
    ],
  );
  parseCases('output', savingsTransactionListQuerySchema, [
    ['applies the defaults', {}, { limit: SAVINGS_TRANSACTIONS_DEFAULT_LIMIT, offset: 0 }],
    [
      'coerces query strings',
      { goalId: '3', unassigned: 'false', kind: 'withdrawal', limit: '10', offset: '20' },
      { goalId: 3, unassigned: false, kind: 'withdrawal', limit: 10, offset: 20 },
    ],
    [
      'reads unassigned=true as the boolean',
      { unassigned: 'true' },
      { unassigned: true, limit: SAVINGS_TRANSACTIONS_DEFAULT_LIMIT, offset: 0 },
    ],
  ]);

  it('has the documented page limits', () => {
    expect(SAVINGS_TRANSACTIONS_DEFAULT_LIMIT).toBe(50);
    expect(SAVINGS_TRANSACTIONS_MAX_LIMIT).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Opening balance
// ---------------------------------------------------------------------------------------------

describe('savingsOpeningSchema (PUT /api/savings/opening)', () => {
  schemaCases(
    'body',
    savingsOpeningSchema,
    [
      ['zero', { amount: 0 }],
      ['a balance', { amount: 50000 }],
      ['the largest amount', { amount: MAX_CENTS }],
    ],
    [
      ['an empty body', {}, 'amount'],
      ['a negative amount', { amount: -1 }, 'amount'],
      ['a fractional amount', { amount: 500.5 }, 'amount'],
      ['a string amount', { amount: '500' }, 'amount'],
      ['null', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: MAX_CENTS + 1 }, 'amount'],
      [
        'a date (it always is the first day of the start month)',
        { amount: 0, date: '2026-01-01' },
        '',
      ],
    ],
  );
});

// ---------------------------------------------------------------------------------------------
// A worked example. It type-checks the DTOs and asserts every identity their JSDoc promises, so
// the numbers double as documentation for the frontend and a template for the backend tests.
//
// Today is 2026-10-02 and tracking started in 2026-07, so July, August and September are closed:
//  - July was settled in full, so it is not listed.
//  - August was settled with 280.00, then a forgotten 12.00 spending moved its savings due to
//    268.00: 12.00 has to be taken back. That is an adjustment.
//  - September was never settled: 312.40 is to be moved.
//  - The savings hold 1,750.00: 1,200.00 unassigned, 400.00 in Holiday, 100.00 in Car and 50.00
//    in the archived Old laptop.
// ---------------------------------------------------------------------------------------------

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const august: OutstandingMonthDto = {
  month: '2026-08',
  savingsDue: 26800,
  settled: 28000,
  outstanding: -1200,
  direction: 'take',
  breakdown: { unallocated: 26000, budgetsSettled: 800, reservesReleased: 0 },
  adjustment: true,
};

const september: OutstandingMonthDto = {
  month: '2026-09',
  savingsDue: 31240,
  settled: 0,
  outstanding: 31240,
  direction: 'move',
  breakdown: { unallocated: 29000, budgetsSettled: 2000, reservesReleased: 240 },
  adjustment: false,
};

const goal = (id: number, over: Partial<GoalDto>): GoalDto => ({
  id,
  name: `Goal ${id}`,
  targetAmount: 100000,
  deadline: null,
  color: null,
  archived: false,
  balance: 0,
  progressPercent: 0,
  remaining: 100000,
  reached: false,
  monthlyNeeded: null,
  status: 'active',
  ...over,
});

const goals: GoalDto[] = [
  goal(1, { name: 'Holiday', balance: 40000, progressPercent: 40, remaining: 60000 }),
  goal(2, { name: 'Car', balance: 10000, progressPercent: 10, remaining: 90000 }),
  goal(3, {
    name: 'Old laptop',
    archived: true,
    balance: 5000,
    progressPercent: 5,
    remaining: 95000,
    status: 'archived',
  }),
];

const savings: SavingsDto = {
  balance: 175000,
  unassigned: 120000,
  goals,
  outstanding: [august, september],
  outstandingTotal: 30040,
};

function checkOutstanding(month: OutstandingMonthDto) {
  expect(month.outstanding).toBe(month.savingsDue - month.settled);
  expect(month.outstanding).not.toBe(0);
  expect(month.direction).toBe(month.outstanding > 0 ? 'move' : 'take');
  expect(sum(Object.values(month.breakdown))).toBe(month.savingsDue);
  expect(month.adjustment).toBe(month.settled !== 0);
}

function checkSavings(dto: SavingsDto) {
  expect(dto.balance).toBe(dto.unassigned + sum(dto.goals.map((g) => g.balance)));
  expect(dto.outstandingTotal).toBe(sum(dto.outstanding.map((m) => m.outstanding)));
  const months = dto.outstanding.map((m) => m.month);
  expect(months).toEqual([...months].sort());
  const archived = dto.goals.map((g) => g.archived);
  expect(archived).toEqual([...archived].sort()); // false first, archived goals last
  for (const month of dto.outstanding) checkOutstanding(month);
}

describe('SavingsDto worked example (2026-10)', () => {
  it('satisfies every documented identity', () => {
    checkSavings(savings);
  });

  it('lists the months that are outstanding, oldest first, with their direction', () => {
    expect(savings.outstanding.map((m) => [m.month, m.direction])).toEqual([
      ['2026-08', 'take'],
      ['2026-09', 'move'],
    ]);
    expect(savings.outstandingTotal).toBe(31240 - 1200);
  });

  it('shares the breakdown shape with the month view', () => {
    // MonthView.savingsDue is the breakdown plus its total, so a month's breakdown is that view
    // without `total`.
    const monthView: MonthSavingsDue = { ...september.breakdown, total: september.savingsDue };
    const { total: _total, ...breakdown } = monthView;
    const typed: SavingsDueBreakdown = breakdown;
    expect(typed).toEqual(september.breakdown);
  });

  it('is empty when everything is settled', () => {
    const settled: SavingsDto = { ...savings, outstanding: [], outstandingTotal: 0 };
    checkSavings(settled);
  });
});

describe('SavingsTransactionDto worked example', () => {
  /** Settling September with a split: one row per allocation, in order, dated today. */
  const settlement: SavingsTransactionDto[] = [
    {
      id: 11,
      date: '2026-10-02',
      kind: 'settlement',
      amount: 20000,
      goalId: 1,
      settlesMonth: '2026-09',
      note: null,
      groupId: null,
    },
    {
      id: 12,
      date: '2026-10-02',
      kind: 'settlement',
      amount: 11240,
      goalId: null,
      settlesMonth: '2026-09',
      note: null,
      groupId: null,
    },
  ];

  /** A reallocation: `-amount` from the source first, then `+amount` to the destination. */
  const reallocated: SavingsTransactionDto[] = [
    {
      id: 13,
      date: '2026-10-02',
      kind: 'reallocation',
      amount: -2500,
      goalId: 1,
      settlesMonth: null,
      note: 'Car needs it more',
      groupId: 13,
    },
    {
      id: 14,
      date: '2026-10-02',
      kind: 'reallocation',
      amount: 2500,
      goalId: 2,
      settlesMonth: null,
      note: 'Car needs it more',
      groupId: 13,
    },
  ];

  it('settles exactly the amount that was confirmed', () => {
    expect(sum(settlement.map((row) => row.amount))).toBe(september.outstanding);
    for (const row of settlement) {
      expect(row.kind).toBe('settlement');
      expect(row.settlesMonth).toBe(september.month);
      expect(row.groupId).toBeNull();
    }
    // The month is then fully settled: nothing is outstanding any more.
    expect(september.savingsDue - (september.settled + sum(settlement.map((r) => r.amount)))).toBe(
      0,
    );
  });

  it('keeps the two rows of a reallocation together and at zero', () => {
    expect(sum(reallocated.map((row) => row.amount))).toBe(0);
    expect(new Set(reallocated.map((row) => row.groupId)).size).toBe(1);
    expect(reallocated[0]?.amount).toBeLessThan(0); // the source first
    expect(reallocated[1]?.amount).toBeGreaterThan(0);
  });
});
