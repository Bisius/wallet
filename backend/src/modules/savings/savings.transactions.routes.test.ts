import {
  MAX_CENTS,
  NOTES_MAX_LENGTH,
  SAVINGS_TRANSACTIONS_MAX_LIMIT,
  type Page,
  type SavingsTransactionDto,
} from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import {
  addGoal,
  addTransaction,
  allTransactions,
  expectSavingsIdentities,
  getSavings,
  postTransaction,
  setUpTwoClosedMonths,
  settleOk,
} from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

type TestApp = ReturnType<typeof createTestApp>['app'];

/**
 * Today is 2026-03-15 and tracking started in 2026-01. Unassigned savings hold 500.00 (the opening
 * balance, transaction 1). Goals: Holiday (1) holds 300.00, Car (2) holds 100.00 and Old (3) holds
 * 200.00 and is archived, which is why its deposit comes first.
 */
let app: TestApp;
let HOLIDAY: number;
let CAR: number;
let OLD: number;

beforeEach(async () => {
  ({ app } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01', salary: 0, openingSavings: 50000 });
  HOLIDAY = (await addGoal(app, { name: 'Holiday', targetAmount: 100000 })).id;
  CAR = (await addGoal(app, { name: 'Car', targetAmount: 500000 })).id;
  OLD = (await addGoal(app, { name: 'Old', targetAmount: 100000 })).id;
  await addTransaction(app, { kind: 'deposit', amount: 30000, goalId: HOLIDAY });
  await addTransaction(app, { kind: 'deposit', amount: 10000, goalId: CAR });
  await addTransaction(app, { kind: 'deposit', amount: 20000, goalId: OLD });
  await request(app).patch(`/api/goals/${OLD}`).send({ archived: true }).expect(200);
});

const balanceOfGoal = async (id: number | null) => {
  const savings = await getSavings(app);
  return id === null ? savings.unassigned : savings.goals.find((goal) => goal.id === id)?.balance;
};

describe('POST /api/savings/transactions: deposit', () => {
  it('puts money into a goal: one positive row, dated today by default (201)', async () => {
    const res = await postTransaction(app, { kind: 'deposit', amount: 2500, goalId: HOLIDAY });
    expect(res.status).toBe(201);
    expect(res.body).toEqual([
      {
        id: 5,
        date: '2026-03-15',
        kind: 'deposit',
        amount: 2500,
        goalId: HOLIDAY,
        settlesMonth: null,
        note: null,
        groupId: null,
      },
    ]);
    expect(await balanceOfGoal(HOLIDAY)).toBe(32500);
    expect((await getSavings(app)).balance).toBe(50000 + 30000 + 10000 + 20000 + 2500);
  });

  it('puts money into unassigned savings when goalId is omitted or null', async () => {
    const omitted = await addTransaction(app, { kind: 'deposit', amount: 1000 });
    const explicit = await addTransaction(app, { kind: 'deposit', amount: 200, goalId: null });
    expect(omitted[0]?.goalId).toBeNull();
    expect(explicit[0]?.goalId).toBeNull();
    expect(await balanceOfGoal(null)).toBe(51200);
  });

  it('keeps the date and the note it is given, trimming the note and turning a blank into null', async () => {
    const [dated] = await addTransaction(app, {
      kind: 'deposit',
      amount: 100,
      date: '2026-02-10',
      note: '  birthday money  ',
    });
    expect(dated).toMatchObject({ date: '2026-02-10', note: 'birthday money' });
    const [blank] = await addTransaction(app, { kind: 'deposit', amount: 100, note: '   ' });
    expect(blank?.note).toBeNull();
    const [nulled] = await addTransaction(app, { kind: 'deposit', amount: 100, note: null });
    expect(nulled?.note).toBeNull();
  });

  it('accepts today and the first day of the start month as dates, and the largest amount', async () => {
    await addTransaction(app, { kind: 'deposit', amount: 1, date: '2026-03-15' });
    await addTransaction(app, { kind: 'deposit', amount: 1, date: '2026-01-01' });
    await addTransaction(app, { kind: 'deposit', amount: MAX_CENTS });
  });

  it('takes the default date from the server clock and its time zone', async () => {
    const { app: late } = createTestApp(mutableClock('2026-03-31T23:30:00Z'));
    await onboard(late, { startMonth: '2026-01', openingSavings: 0 });
    // The tests run in UTC, where it is still March 31st...
    const [utc] = await addTransaction(late, { kind: 'deposit', amount: 5 });
    expect(utc?.date).toBe('2026-03-31');
    // ...but in Rome (UTC+2) it is already April 1st.
    const [rome] = await withTimeZone('Europe/Rome', () =>
      addTransaction(late, { kind: 'deposit', amount: 5 }),
    );
    expect(rome?.date).toBe('2026-04-01');
  });

  it('has no balance check: it can be any size', async () => {
    await addTransaction(app, { kind: 'deposit', amount: 99_999_999, goalId: CAR });
  });
});

describe('POST /api/savings/transactions: withdrawal', () => {
  it('takes money out of a goal: one negative row, the amount in the body is positive', async () => {
    const res = await postTransaction(app, {
      kind: 'withdrawal',
      amount: 12000,
      goalId: HOLIDAY,
      note: 'flights',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual([
      {
        id: 5,
        date: '2026-03-15',
        kind: 'withdrawal',
        amount: -12000,
        goalId: HOLIDAY,
        settlesMonth: null,
        note: 'flights',
        groupId: null,
      },
    ]);
    expect(await balanceOfGoal(HOLIDAY)).toBe(18000);
    expect((await getSavings(app)).balance).toBe(110000 - 12000);
  });

  it('takes money out of unassigned savings when goalId is omitted or null', async () => {
    const omitted = await addTransaction(app, { kind: 'withdrawal', amount: 1000 });
    const explicit = await addTransaction(app, { kind: 'withdrawal', amount: 500, goalId: null });
    expect(omitted[0]).toMatchObject({ amount: -1000, goalId: null });
    expect(explicit[0]).toMatchObject({ amount: -500, goalId: null });
    expect(await balanceOfGoal(null)).toBe(48500);
  });

  it('may take everything the source holds, to the cent', async () => {
    await addTransaction(app, { kind: 'withdrawal', amount: 30000, goalId: HOLIDAY });
    expect(await balanceOfGoal(HOLIDAY)).toBe(0);
    await addTransaction(app, { kind: 'withdrawal', amount: 50000 });
    expect(await balanceOfGoal(null)).toBe(0);
  });

  it('may take money out of an ARCHIVED goal: its leftover money is never frozen', async () => {
    const [row] = await addTransaction(app, { kind: 'withdrawal', amount: 20000, goalId: OLD });
    expect(row).toMatchObject({ amount: -20000, goalId: OLD });
    expect(await balanceOfGoal(OLD)).toBe(0);
  });

  it('counts every row of the source, whatever its date (the balance as it is now)', async () => {
    // The 300.00 of Holiday were deposited today; a withdrawal dated a month earlier still sees them.
    const [row] = await addTransaction(app, {
      kind: 'withdrawal',
      amount: 30000,
      goalId: HOLIDAY,
      date: '2026-02-01',
    });
    expect(row).toMatchObject({ amount: -30000, date: '2026-02-01' });
  });
});

describe('POST /api/savings/transactions: reallocation', () => {
  it('moves money between two goals as two rows that share a group id and sum to 0', async () => {
    const before = await getSavings(app);
    const res = await postTransaction(app, {
      kind: 'reallocation',
      amount: 5000,
      fromGoalId: HOLIDAY,
      toGoalId: CAR,
      date: '2026-03-10',
      note: 'car needs it more',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual([
      {
        id: 5,
        date: '2026-03-10',
        kind: 'reallocation',
        amount: -5000,
        goalId: HOLIDAY,
        settlesMonth: null,
        note: 'car needs it more',
        groupId: 5,
      },
      {
        id: 6,
        date: '2026-03-10',
        kind: 'reallocation',
        amount: 5000,
        goalId: CAR,
        settlesMonth: null,
        note: 'car needs it more',
        groupId: 5,
      },
    ]);
    const after = await expectSavingsIdentities(app);
    expect(after.balance).toBe(before.balance); // a reallocation never changes the balance
    expect(after.unassigned).toBe(before.unassigned);
    expect(await balanceOfGoal(HOLIDAY)).toBe(25000);
    expect(await balanceOfGoal(CAR)).toBe(15000);
  });

  it('moves money from a goal to unassigned savings, and from unassigned savings to a goal', async () => {
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 4000,
      fromGoalId: HOLIDAY,
      toGoalId: null,
    });
    expect(await balanceOfGoal(HOLIDAY)).toBe(26000);
    expect(await balanceOfGoal(null)).toBe(54000);

    const rows = await addTransaction(app, {
      kind: 'reallocation',
      amount: 54000,
      fromGoalId: null,
      toGoalId: CAR,
    });
    expect(rows.map((row) => [row.amount, row.goalId])).toEqual([
      [-54000, null],
      [54000, CAR],
    ]);
    expect(await balanceOfGoal(null)).toBe(0);
    expect(await balanceOfGoal(CAR)).toBe(64000);
    await expectSavingsIdentities(app);
  });

  it('may move the money OUT of an archived goal, never into one', async () => {
    const rows = await addTransaction(app, {
      kind: 'reallocation',
      amount: 20000,
      fromGoalId: OLD,
      toGoalId: CAR,
    });
    expect(rows.map((row) => [row.amount, row.goalId])).toEqual([
      [-20000, OLD],
      [20000, CAR],
    ]);
    expect(await balanceOfGoal(OLD)).toBe(0);
    expect(await balanceOfGoal(CAR)).toBe(30000);
    expectRuleViolation(
      await postTransaction(app, {
        kind: 'reallocation',
        amount: 100,
        fromGoalId: CAR,
        toGoalId: OLD,
      }),
      'goal_archived',
      'toGoalId',
    );
  });

  it('the group id is the id of the first (negative) row, whatever ids the rows get', async () => {
    await addTransaction(app, { kind: 'deposit', amount: 100 });
    const rows = await addTransaction(app, {
      kind: 'reallocation',
      amount: 100,
      fromGoalId: HOLIDAY,
      toGoalId: CAR,
    });
    expect(rows[0]?.id).toBe(6);
    expect(rows.map((row) => row.groupId)).toEqual([6, 6]);
    const next = await addTransaction(app, {
      kind: 'reallocation',
      amount: 100,
      fromGoalId: CAR,
      toGoalId: HOLIDAY,
    });
    expect(next.map((row) => row.groupId)).toEqual([8, 8]);
  });

  it('may take everything the source holds', async () => {
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 30000,
      fromGoalId: HOLIDAY,
      toGoalId: CAR,
    });
    expect(await balanceOfGoal(HOLIDAY)).toBe(0);
  });
});

describe('POST /api/savings/transactions: validation (400)', () => {
  const D = { kind: 'deposit', amount: 100 };
  const R = { kind: 'reallocation', amount: 100, fromGoalId: 1, toGoalId: 2 };
  it.each([
    ['an empty body', {}, 'kind'],
    ['a missing kind', { amount: 100 }, 'kind'],
    ['an unknown kind', { kind: 'transfer', amount: 100 }, 'kind'],
    ['the kind "opening" (it has its own endpoint)', { kind: 'opening', amount: 100 }, 'kind'],
    [
      'the kind "settlement" (it has its own endpoint)',
      { kind: 'settlement', amount: 100 },
      'kind',
    ],
    ['a kind in the wrong case', { kind: 'Deposit', amount: 100 }, 'kind'],
    ['a missing amount', { kind: 'deposit' }, 'amount'],
    ['a zero amount', { ...D, amount: 0 }, 'amount'],
    ['a negative deposit', { ...D, amount: -100 }, 'amount'],
    ['a negative withdrawal', { kind: 'withdrawal', amount: -100 }, 'amount'],
    ['a fractional amount', { ...D, amount: 10.5 }, 'amount'],
    ['a text amount', { ...D, amount: '100' }, 'amount'],
    ['an amount above the cap', { ...D, amount: MAX_CENTS + 1 }, 'amount'],
    ['a goalId of 0', { ...D, goalId: 0 }, 'goalId'],
    ['a negative goalId', { ...D, goalId: -1 }, 'goalId'],
    ['a text goalId', { ...D, goalId: '1' }, 'goalId'],
    ['a fractional goalId', { ...D, goalId: 1.5 }, 'goalId'],
    ['a date that does not exist', { ...D, date: '2026-02-30' }, 'date'],
    ['a month instead of a date', { ...D, date: '2026-02' }, 'date'],
    ['a date with a time', { ...D, date: '2026-02-10T10:00:00Z' }, 'date'],
    ['a note that is too long', { ...D, note: 'x'.repeat(NOTES_MAX_LENGTH + 1) }, 'note'],
    ['a numeric note', { ...D, note: 5 }, 'note'],
    ['an unknown key', { ...D, settlesMonth: '2026-01' }, ''],
    ['a reallocation key on a deposit', { ...D, fromGoalId: 1 }, ''],
    ['a goalId on a reallocation', { ...R, goalId: 1 }, ''],
    ['a reallocation with no fromGoalId', { ...R, fromGoalId: undefined }, 'fromGoalId'],
    ['a reallocation with no toGoalId', { ...R, toGoalId: undefined }, 'toGoalId'],
    ['a reallocation within one goal', { ...R, fromGoalId: 2, toGoalId: 2 }, 'toGoalId'],
    [
      'a reallocation within unassigned savings',
      { ...R, fromGoalId: null, toGoalId: null },
      'toGoalId',
    ],
    ['a reallocation of nothing', { ...R, amount: 0 }, 'amount'],
  ])('rejects %s and stores nothing', async (_label, body, path) => {
    const before = await allTransactions(app);
    expectValidationError(await postTransaction(app, body), path);
    expect(await allTransactions(app)).toEqual(before);
  });

  it('rejects a request with no body at all', async () => {
    expectValidationError(await request(app).post('/api/savings/transactions'), '');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await request(app)
      .post('/api/savings/transactions')
      .set('Content-Type', 'application/json')
      .send('{"kind":');
    expectApiError(res, 'invalid_json');
  });
});

describe('POST /api/savings/transactions: 422 rules', () => {
  const WITHDRAWAL = { kind: 'withdrawal', amount: 100 } as const;
  const REALLOCATION = { kind: 'reallocation', amount: 100 } as const;

  describe('the date (field "date")', () => {
    it.each([
      ['a deposit', { kind: 'deposit', amount: 100 }],
      ['a withdrawal', WITHDRAWAL],
      ['a reallocation', { ...REALLOCATION, fromGoalId: 1, toGoalId: 2 }],
    ])('refuses a date before the first day of the start month, for %s', async (_label, body) => {
      const before = await allTransactions(app);
      expectRuleViolation(
        await postTransaction(app, { ...body, date: '2025-12-31' }),
        'before_start_month',
        'date',
      );
      expectRuleViolation(
        await postTransaction(app, { ...body, date: '2020-06-15' }),
        'before_start_month',
        'date',
      );
      expect(await allTransactions(app)).toEqual(before);
    });

    it.each([
      ['a deposit', { kind: 'deposit', amount: 100 }],
      ['a withdrawal', WITHDRAWAL],
      ['a reallocation', { ...REALLOCATION, fromGoalId: 1, toGoalId: 2 }],
    ])('refuses a date after today, for %s', async (_label, body) => {
      const before = await allTransactions(app);
      expectRuleViolation(
        await postTransaction(app, { ...body, date: '2026-03-16' }),
        'date_in_future',
        'date',
      );
      expectRuleViolation(
        await postTransaction(app, { ...body, date: '2030-01-01' }),
        'date_in_future',
        'date',
      );
      expect(await allTransactions(app)).toEqual(before);
    });

    it('judges "today" with the server clock: tomorrow is the future, today is not', async () => {
      expectRuleViolation(
        await postTransaction(app, { kind: 'deposit', amount: 1, date: '2026-03-16' }),
        'date_in_future',
        'date',
      );
      await postTransaction(app, { kind: 'deposit', amount: 1, date: '2026-03-15' }).expect(201);
    });

    it('is checked before the goals and the balance', async () => {
      expectRuleViolation(
        await postTransaction(app, { kind: 'deposit', amount: 1, goalId: 999, date: '2026-04-01' }),
        'date_in_future',
        'date',
      );
      expectRuleViolation(
        await postTransaction(app, {
          kind: 'withdrawal',
          amount: 99_999_999,
          goalId: OLD,
          date: '2025-01-01',
        }),
        'before_start_month',
        'date',
      );
      expectRuleViolation(
        await postTransaction(app, {
          kind: 'reallocation',
          amount: 99_999_999,
          fromGoalId: 999,
          toGoalId: OLD,
          date: '2026-04-01',
        }),
        'date_in_future',
        'date',
      );
    });
  });

  describe('the goals (fields "goalId", "fromGoalId", "toGoalId")', () => {
    it('refuses a goal that does not exist', async () => {
      expectRuleViolation(
        await postTransaction(app, { kind: 'deposit', amount: 100, goalId: 999 }),
        'unknown_goal',
        'goalId',
      );
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, goalId: 999 }),
        'unknown_goal',
        'goalId',
      );
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: 999, toGoalId: CAR }),
        'unknown_goal',
        'fromGoalId',
      );
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: HOLIDAY, toGoalId: 999 }),
        'unknown_goal',
        'toGoalId',
      );
    });

    it('refuses to put money into an archived goal: a deposit, or the destination of a reallocation', async () => {
      expectRuleViolation(
        await postTransaction(app, { kind: 'deposit', amount: 100, goalId: OLD }),
        'goal_archived',
        'goalId',
      );
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: HOLIDAY, toGoalId: OLD }),
        'goal_archived',
        'toGoalId',
      );
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: null, toGoalId: OLD }),
        'goal_archived',
        'toGoalId',
      );
    });

    it('lets an archived goal be the source of a withdrawal or of a reallocation', async () => {
      await postTransaction(app, { ...WITHDRAWAL, goalId: OLD }).expect(201);
      await postTransaction(app, { ...REALLOCATION, fromGoalId: OLD, toGoalId: null }).expect(201);
      await postTransaction(app, { ...REALLOCATION, fromGoalId: OLD, toGoalId: HOLIDAY }).expect(
        201,
      );
    });

    it('un-archiving a goal lets it receive money again', async () => {
      await request(app).patch(`/api/goals/${OLD}`).send({ archived: false }).expect(200);
      await postTransaction(app, { kind: 'deposit', amount: 100, goalId: OLD }).expect(201);
      await postTransaction(app, { ...REALLOCATION, fromGoalId: HOLIDAY, toGoalId: OLD }).expect(
        201,
      );
    });

    it('checks a reallocation in this order: from exists, to exists, to is not archived', async () => {
      // Both unknown: the source is reported first.
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: 998, toGoalId: 999 }),
        'unknown_goal',
        'fromGoalId',
      );
      // Unknown source and archived destination: the unknown source comes first.
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: 999, toGoalId: OLD }),
        'unknown_goal',
        'fromGoalId',
      );
      // Archived source (fine) and unknown destination.
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: OLD, toGoalId: 999 }),
        'unknown_goal',
        'toGoalId',
      );
      // An archived source is fine, an archived destination is not, even between two archived goals.
      const older = (await addGoal(app, { name: 'Older' })).id;
      await request(app).patch(`/api/goals/${older}`).send({ archived: true }).expect(200);
      expectRuleViolation(
        await postTransaction(app, { ...REALLOCATION, fromGoalId: OLD, toGoalId: older }),
        'goal_archived',
        'toGoalId',
      );
    });

    it('is checked before the balance', async () => {
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 99_999_999, goalId: 999 }),
        'unknown_goal',
        'goalId',
      );
      expectRuleViolation(
        await postTransaction(app, {
          ...REALLOCATION,
          amount: 99_999_999,
          fromGoalId: HOLIDAY,
          toGoalId: OLD,
        }),
        'goal_archived',
        'toGoalId',
      );
    });
  });

  describe('the balance (field "amount")', () => {
    it('refuses a withdrawal of more than a goal holds', async () => {
      const before = await allTransactions(app);
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 30001, goalId: HOLIDAY }),
        'insufficient_balance',
        'amount',
      );
      expect(await allTransactions(app)).toEqual(before);
    });

    it('refuses a withdrawal of more than the unassigned savings hold', async () => {
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 50001 }),
        'insufficient_balance',
        'amount',
      );
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 50001, goalId: null }),
        'insufficient_balance',
        'amount',
      );
    });

    it('refuses a withdrawal of more than an archived goal holds', async () => {
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 20001, goalId: OLD }),
        'insufficient_balance',
        'amount',
      );
    });

    it('refuses a reallocation of more than its source holds, goal or unassigned', async () => {
      expectRuleViolation(
        await postTransaction(app, {
          ...REALLOCATION,
          amount: 10001,
          fromGoalId: CAR,
          toGoalId: HOLIDAY,
        }),
        'insufficient_balance',
        'amount',
      );
      expectRuleViolation(
        await postTransaction(app, {
          ...REALLOCATION,
          amount: 50001,
          fromGoalId: null,
          toGoalId: HOLIDAY,
        }),
        'insufficient_balance',
        'amount',
      );
      // The destination's balance does not matter, only the source's.
      await postTransaction(app, {
        ...REALLOCATION,
        amount: 10000,
        fromGoalId: CAR,
        toGoalId: HOLIDAY,
      }).expect(201);
    });

    it('refuses any amount from a source that holds nothing, or less than nothing', async () => {
      const empty = (await addGoal(app, { name: 'Empty' })).id;
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 1, goalId: empty }),
        'insufficient_balance',
        'amount',
      );
      // A deletion is not limited by the balances, so it can leave a goal below 0.
      const [deposit] = await addTransaction(app, { kind: 'deposit', amount: 500, goalId: empty });
      await addTransaction(app, { kind: 'withdrawal', amount: 500, goalId: empty });
      await request(app).delete(`/api/savings/transactions/${deposit?.id}`).expect(204);
      expect(await balanceOfGoal(empty)).toBe(-500);
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 1, goalId: empty }),
        'insufficient_balance',
        'amount',
      );
      expectRuleViolation(
        await postTransaction(app, {
          ...REALLOCATION,
          amount: 1,
          fromGoalId: empty,
          toGoalId: CAR,
        }),
        'insufficient_balance',
        'amount',
      );
    });

    it('stores none of the rows of a refused reallocation', async () => {
      const before = await allTransactions(app);
      expectRuleViolation(
        await postTransaction(app, {
          ...REALLOCATION,
          amount: 99_999_999,
          fromGoalId: HOLIDAY,
          toGoalId: CAR,
        }),
        'insufficient_balance',
        'amount',
      );
      expect(await allTransactions(app)).toEqual(before);
    });

    it('counts the opening balance in what the unassigned savings hold', async () => {
      // 500.00 are held, so 500.01 is refused and 500.00 is not.
      expectRuleViolation(
        await postTransaction(app, { ...WITHDRAWAL, amount: 50001 }),
        'insufficient_balance',
        'amount',
      );
      await postTransaction(app, { ...WITHDRAWAL, amount: 50000 }).expect(201);
      expect(await balanceOfGoal(null)).toBe(0);
    });
  });
});

describe('GET /api/savings/transactions', () => {
  /** Rows (id: date, kind, goal, amount): 1 opening 01-01, 2-4 deposits (03-15) of the beforeEach. */
  async function addMoreRows() {
    await addTransaction(app, { kind: 'deposit', amount: 100, date: '2026-03-01' }); // 5
    await addTransaction(app, {
      kind: 'withdrawal',
      amount: 200,
      goalId: HOLIDAY,
      date: '2026-03-10',
    }); // 6
    await addTransaction(app, { kind: 'deposit', amount: 300, goalId: CAR, date: '2026-03-10' }); // 7
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 400,
      fromGoalId: HOLIDAY,
      toGoalId: null,
      date: '2026-02-20',
    }); // 8, 9
  }
  const get = (query = '') => request(app).get(`/api/savings/transactions${query}`);
  const ids = (res: { body: Page<SavingsTransactionDto> }) => res.body.items.map((row) => row.id);

  it('lists every row newest first (date, then id, descending) as a page', async () => {
    await addMoreRows();
    const res = await get().expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['items', 'limit', 'offset', 'total']);
    expect(res.body).toMatchObject({ total: 9, limit: 50, offset: 0 });
    // 03-15: ids 4, 3, 2 | 03-10: ids 7, 6 | 03-01: id 5 | 02-20: ids 9, 8 | 01-01: id 1
    expect(ids(res)).toEqual([4, 3, 2, 7, 6, 5, 9, 8, 1]);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['amount', 'date', 'goalId', 'groupId', 'id', 'kind', 'note', 'settlesMonth'].sort(),
    );
  });

  it('pages with limit and offset, and the total counts every match', async () => {
    await addMoreRows();
    const first = await get('?limit=4').expect(200);
    expect(first.body).toMatchObject({ total: 9, limit: 4, offset: 0 });
    expect(ids(first)).toEqual([4, 3, 2, 7]);
    const second = await get('?limit=4&offset=4').expect(200);
    expect(second.body).toMatchObject({ total: 9, limit: 4, offset: 4 });
    expect(ids(second)).toEqual([6, 5, 9, 8]);
    const last = await get('?limit=4&offset=8').expect(200);
    expect(ids(last)).toEqual([1]);
    expect(ids(await get('?offset=100').expect(200))).toEqual([]);
  });

  it('filters by goal, by unassigned and by kind, and the filters combine', async () => {
    await addMoreRows();
    expect(ids(await get(`?goalId=${HOLIDAY}`).expect(200))).toEqual([2, 6, 8]);
    expect(ids(await get('?unassigned=true').expect(200))).toEqual([5, 9, 1]);
    expect(ids(await get('?kind=deposit').expect(200))).toEqual([4, 3, 2, 7, 5]);
    expect(ids(await get('?kind=reallocation').expect(200))).toEqual([9, 8]);
    expect(ids(await get('?kind=opening').expect(200))).toEqual([1]);
    expect(ids(await get(`?goalId=${HOLIDAY}&kind=deposit`).expect(200))).toEqual([2]);
    expect(ids(await get('?unassigned=true&kind=deposit').expect(200))).toEqual([5]);
    expect(ids(await get(`?goalId=${CAR}&kind=reallocation`).expect(200))).toEqual([]);
    const filtered = await get(`?goalId=${HOLIDAY}&limit=1&offset=1`).expect(200);
    expect(filtered.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(ids(filtered)).toEqual([6]);
  });

  it('treats unassigned=false as no filter, and an unknown goal as matching nothing', async () => {
    await addMoreRows();
    expect((await get('?unassigned=false').expect(200)).body.total).toBe(9);
    const none = await get('?goalId=999').expect(200);
    expect(none.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  });

  it('includes the settlement rows with the month they settle', async () => {
    const { app: world } = await setUpTwoClosedMonths();
    await settleOk(world, '2026-01', { amount: 265701 });
    const res = await request(world).get('/api/savings/transactions?kind=settlement').expect(200);
    expect(res.body.items).toEqual([
      {
        id: 2,
        date: '2026-03-15',
        kind: 'settlement',
        amount: 265701,
        goalId: null,
        settlesMonth: '2026-01',
        note: null,
        groupId: null,
      },
    ]);
  });

  describe('validation (400)', () => {
    it.each([
      ['a zero limit', '?limit=0', 'limit'],
      ['a limit above the maximum', `?limit=${SAVINGS_TRANSACTIONS_MAX_LIMIT + 1}`, 'limit'],
      ['a text limit', '?limit=many', 'limit'],
      ['a fractional limit', '?limit=1.5', 'limit'],
      ['a negative offset', '?offset=-1', 'offset'],
      ['a text goal', '?goalId=abc', 'goalId'],
      ['a goal of 0', '?goalId=0', 'goalId'],
      ['a text unassigned', '?unassigned=yes', 'unassigned'],
      ['a goal together with unassigned=true', '?goalId=1&unassigned=true', 'unassigned'],
      ['an unknown kind', '?kind=transfer', 'kind'],
      ['an unknown filter', '?month=2026-03', ''],
    ])('rejects %s', async (_label, query, path) => {
      expectValidationError(await get(query), path);
    });

    it('accepts the largest limit', async () => {
      await get(`?limit=${SAVINGS_TRANSACTIONS_MAX_LIMIT}`).expect(200);
    });
  });
});

describe('DELETE /api/savings/transactions/:id', () => {
  it('deletes a deposit and answers 204 with no body', async () => {
    const [row] = await addTransaction(app, { kind: 'deposit', amount: 700, goalId: CAR });
    const res = await request(app).delete(`/api/savings/transactions/${row?.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await balanceOfGoal(CAR)).toBe(10000);
    expect((await allTransactions(app)).some((r) => r.id === row?.id)).toBe(false);
  });

  it('deletes a withdrawal, which gives the money back', async () => {
    const [row] = await addTransaction(app, { kind: 'withdrawal', amount: 7000, goalId: HOLIDAY });
    expect(await balanceOfGoal(HOLIDAY)).toBe(23000);
    await request(app).delete(`/api/savings/transactions/${row?.id}`).expect(204);
    expect(await balanceOfGoal(HOLIDAY)).toBe(30000);
  });

  it("deletes both rows of a reallocation, whichever row's id is given", async () => {
    const first = await addTransaction(app, {
      kind: 'reallocation',
      amount: 5000,
      fromGoalId: HOLIDAY,
      toGoalId: CAR,
    });
    const second = await addTransaction(app, {
      kind: 'reallocation',
      amount: 700,
      fromGoalId: CAR,
      toGoalId: null,
    });
    const total = (await getSavings(app)).balance;

    // By the id of the first (negative) row.
    await request(app).delete(`/api/savings/transactions/${first[0]?.id}`).expect(204);
    let rows = await allTransactions(app);
    expect(rows.filter((row) => row.kind === 'reallocation').map((row) => row.id)).toEqual([
      second[1]?.id,
      second[0]?.id,
    ]);
    expect(await balanceOfGoal(HOLIDAY)).toBe(30000);
    expect(await balanceOfGoal(CAR)).toBe(10000 - 700);

    // By the id of the second (positive) row.
    await request(app).delete(`/api/savings/transactions/${second[1]?.id}`).expect(204);
    rows = await allTransactions(app);
    expect(rows.some((row) => row.kind === 'reallocation')).toBe(false);
    expect(await balanceOfGoal(CAR)).toBe(10000);
    expect((await getSavings(app)).balance).toBe(total); // a reallocation never moved the balance
  });

  it('is not limited by the balances: deleting a deposit may leave a goal below 0', async () => {
    const [deposit] = await addTransaction(app, { kind: 'deposit', amount: 5000, goalId: CAR });
    await addTransaction(app, { kind: 'withdrawal', amount: 15000, goalId: CAR });
    expect(await balanceOfGoal(CAR)).toBe(0);
    await request(app).delete(`/api/savings/transactions/${deposit?.id}`).expect(204);
    expect(await balanceOfGoal(CAR)).toBe(-5000);
    await expectSavingsIdentities(app);
  });

  it('answers 409 not_deletable for the opening row, and deletes nothing', async () => {
    const before = await allTransactions(app);
    const opening = before.find((row) => row.kind === 'opening');
    const res = await request(app).delete(`/api/savings/transactions/${opening?.id}`);
    expectApiError(res, 'not_deletable');
    expect(res.body.error.message).toContain('PUT /api/savings/opening');
    expect(await allTransactions(app)).toEqual(before);
  });

  it('answers 409 not_deletable for a settlement row, and deletes nothing', async () => {
    const { app: world } = await setUpTwoClosedMonths();
    const [row] = await settleOk(world, '2026-01', { amount: 265701 });
    const res = await request(world).delete(`/api/savings/transactions/${row?.id}`);
    expectApiError(res, 'not_deletable');
    expect(res.body.error.message).toContain('DELETE /api/savings/settle/:month');
    expect((await allTransactions(world)).some((r) => r.id === row?.id)).toBe(true);
  });

  it('answers 404 for an unknown id, and for a row that was deleted already', async () => {
    expectNotFound(await request(app).delete('/api/savings/transactions/999'));
    const [row] = await addTransaction(app, { kind: 'deposit', amount: 1 });
    await request(app).delete(`/api/savings/transactions/${row?.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/savings/transactions/${row?.id}`));
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects the id %s with a 400', async (id) => {
    expectValidationError(await request(app).delete(`/api/savings/transactions/${id}`), 'id');
  });
});
