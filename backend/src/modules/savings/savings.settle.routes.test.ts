import {
  MAX_CENTS,
  MAX_SETTLEMENT_ALLOCATIONS,
  type OutstandingChangedDetails,
} from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
} from '../../testing/helpers';
import {
  addGoal,
  allTransactions,
  expectSavingsIdentities,
  getSavings,
  setUpTwoClosedMonths,
  settle,
  settleOk,
  undoSettlement,
} from '../../testing/savings-helpers';

// The savings due of the world of `setUpTwoClosedMonths`: January 2,657.01 and February 2,557.01,
// with 500.00 of opening savings (transaction id 1).
const JAN = 265701;
const FEB = 255701;

describe('POST /api/savings/settle/:month', () => {
  describe('happy path', () => {
    it('settles a month in full to unassigned savings when there are no allocations (201)', async () => {
      const { app } = await setUpTwoClosedMonths();
      const res = await settle(app, '2026-01', { amount: JAN }).expect(201);
      expect(res.body).toEqual([
        {
          id: 2,
          date: '2026-03-15',
          kind: 'settlement',
          amount: JAN,
          goalId: null,
          settlesMonth: '2026-01',
          note: null,
          groupId: null,
        },
      ]);
      const savings = await expectSavingsIdentities(app);
      expect(savings.outstanding.map((entry) => entry.month)).toEqual(['2026-02']);
      expect(savings).toMatchObject({
        balance: 50000 + JAN,
        unassigned: 50000 + JAN,
        outstandingTotal: FEB,
      });
    });

    it('stores one row per allocation, in order, each with its own goal and the month it settles', async () => {
      const { app } = await setUpTwoClosedMonths();
      const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 500000 });
      const car = await addGoal(app, { name: 'Car', targetAmount: 500000 });
      // 1,000.00 to the car, 157.01 unassigned, 1,500.00 to the holiday: 2,657.01 in all.
      const res = await settle(app, '2026-01', {
        amount: JAN,
        allocations: [
          { goalId: car.id, amount: 100000 },
          { goalId: null, amount: 15701 },
          { goalId: holiday.id, amount: 150000 },
        ],
      }).expect(201);
      expect(res.body).toEqual([
        {
          id: 2,
          date: '2026-03-15',
          kind: 'settlement',
          amount: 100000,
          goalId: car.id,
          settlesMonth: '2026-01',
          note: null,
          groupId: null,
        },
        {
          id: 3,
          date: '2026-03-15',
          kind: 'settlement',
          amount: 15701,
          goalId: null,
          settlesMonth: '2026-01',
          note: null,
          groupId: null,
        },
        {
          id: 4,
          date: '2026-03-15',
          kind: 'settlement',
          amount: 150000,
          goalId: holiday.id,
          settlesMonth: '2026-01',
          note: null,
          groupId: null,
        },
      ]);
      const savings = await expectSavingsIdentities(app);
      expect(savings.unassigned).toBe(50000 + 15701);
      expect(savings.goals.map((goal) => [goal.name, goal.balance])).toEqual([
        ['Holiday', 150000],
        ['Car', 100000],
      ]);
    });

    it('dates the rows the day the settlement is made, not the month they settle', async () => {
      const { app, clock } = await setUpTwoClosedMonths();
      clock.set('2026-03-22T18:00:00Z');
      const [row] = await settleOk(app, '2026-02', { amount: FEB });
      expect(row).toMatchObject({ date: '2026-03-22', settlesMonth: '2026-02' });
    });

    it('accepts a single allocation that names a goal, and one that names unassigned savings', async () => {
      const { app } = await setUpTwoClosedMonths();
      const goal = await addGoal(app);
      const toGoal = await settleOk(app, '2026-01', {
        amount: JAN,
        allocations: [{ goalId: goal.id, amount: JAN }],
      });
      expect(toGoal.map((row) => row.goalId)).toEqual([goal.id]);
      const toUnassigned = await settleOk(app, '2026-02', {
        amount: FEB,
        allocations: [{ goalId: null, amount: FEB }],
      });
      expect(toUnassigned.map((row) => row.goalId)).toEqual([null]);
    });

    it('lets two months be settled in any order, each exactly once', async () => {
      const { app } = await setUpTwoClosedMonths();
      await settleOk(app, '2026-02', { amount: FEB });
      await settleOk(app, '2026-01', { amount: JAN });
      const savings = await expectSavingsIdentities(app);
      expect(savings.outstanding).toEqual([]);
      expect(savings.balance).toBe(50000 + JAN + FEB);
    });
  });

  describe('validation (400)', () => {
    it.each(['abc', '2026-13', '2026-1', '202601', '2026-01-15', '2026-00'])(
      'rejects the month %s',
      async (month) => {
        const { app } = await setUpTwoClosedMonths();
        expectValidationError(await settle(app, month, { amount: JAN }), 'month');
      },
    );

    it.each([
      ['an empty body', {}, 'amount'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['a fractional amount', { amount: 10.5 }, 'amount'],
      ['a text amount', { amount: '100' }, 'amount'],
      ['a null amount', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: MAX_CENTS + 1 }, 'amount'],
      ['an unknown key', { amount: JAN, note: 'hello' }, ''],
      ['empty allocations', { amount: JAN, allocations: [] }, 'allocations'],
      [
        'an allocation of 0',
        { amount: JAN, allocations: [{ goalId: null, amount: 0 }] },
        'allocations.0.amount',
      ],
      [
        'a fractional allocation',
        { amount: JAN, allocations: [{ goalId: null, amount: 1.5 }] },
        'allocations.0.amount',
      ],
      [
        'an allocation with no goalId',
        { amount: JAN, allocations: [{ amount: JAN }] },
        'allocations.0.goalId',
      ],
      [
        'a goalId of 0',
        { amount: JAN, allocations: [{ goalId: 0, amount: JAN }] },
        'allocations.0.goalId',
      ],
      [
        'a negative goalId',
        { amount: JAN, allocations: [{ goalId: -1, amount: JAN }] },
        'allocations.0.goalId',
      ],
      [
        'a text goalId',
        { amount: JAN, allocations: [{ goalId: '1', amount: JAN }] },
        'allocations.0.goalId',
      ],
      [
        'an unknown key in an allocation',
        { amount: JAN, allocations: [{ goalId: null, amount: JAN, note: 'x' }] },
        'allocations.0',
      ],
      [
        'the same goal twice',
        {
          amount: 100,
          allocations: [
            { goalId: 1, amount: 40 },
            { goalId: 2, amount: 20 },
            { goalId: 1, amount: 40 },
          ],
        },
        'allocations.2.goalId',
      ],
      [
        'unassigned savings twice',
        {
          amount: 100,
          allocations: [
            { goalId: null, amount: 60 },
            { goalId: null, amount: 40 },
          ],
        },
        'allocations.1.goalId',
      ],
      [
        `more than ${MAX_SETTLEMENT_ALLOCATIONS} allocations`,
        {
          amount: MAX_SETTLEMENT_ALLOCATIONS + 1,
          allocations: Array.from({ length: MAX_SETTLEMENT_ALLOCATIONS + 1 }, (_, i) => ({
            goalId: i + 1,
            amount: 1,
          })),
        },
        'allocations',
      ],
    ])('rejects %s and stores nothing', async (_label, body, path) => {
      const { app } = await setUpTwoClosedMonths();
      expectValidationError(await settle(app, '2026-01', body), path);
      expect((await allTransactions(app)).filter((row) => row.kind === 'settlement')).toEqual([]);
    });

    it('rejects a request with no body at all', async () => {
      const { app } = await setUpTwoClosedMonths();
      expectValidationError(await request(app).post('/api/savings/settle/2026-01'), '');
    });

    it('validates the request before it looks at the month: a bad body for an unknown month is a 400', async () => {
      const { app } = await setUpTwoClosedMonths();
      expectValidationError(await settle(app, '2020-01', {}), 'amount');
    });
  });

  describe('404 not_found', () => {
    it('refuses a month before settings.startMonth', async () => {
      const { app } = await setUpTwoClosedMonths();
      expectNotFound(await settle(app, '2025-12', { amount: 100 }));
      expectNotFound(await settle(app, '1999-01', { amount: 100 }));
    });

    it('accepts the start month itself', async () => {
      const { app } = await setUpTwoClosedMonths();
      await settle(app, '2026-01', { amount: JAN }).expect(201);
    });

    it('refuses a month more than 120 months after the current one, and not the 120th', async () => {
      const { app } = await setUpTwoClosedMonths();
      // Today is in 2026-03, so the horizon is 2036-03.
      expectRuleViolation(
        await settle(app, '2036-03', { amount: 100 }),
        'month_not_closed',
        'month',
      );
      expectNotFound(await settle(app, '2036-04', { amount: 100 }));
      expectNotFound(await settle(app, '9999-12', { amount: 100 }));
    });

    it('is checked before the month is judged closed', async () => {
      const { app } = await setUpTwoClosedMonths();
      // A month before the start is in the past, but it does not exist: 404, not a closed month.
      expectNotFound(await settle(app, '2025-06', { amount: 100 }));
    });
  });

  describe('422 month_not_closed', () => {
    it.each([
      ['the current month', '2026-03'],
      ['the next month', '2026-04'],
      ['a month far ahead', '2030-07'],
    ])('refuses %s (field "month") and stores nothing', async (_label, month) => {
      const { app } = await setUpTwoClosedMonths();
      expectRuleViolation(
        await settle(app, month, { amount: 298701 }),
        'month_not_closed',
        'month',
      );
      expect((await getSavings(app)).balance).toBe(50000);
    });

    it('is checked before the outstanding: an amount that cannot match changes nothing', async () => {
      const { app } = await setUpTwoClosedMonths();
      expectRuleViolation(await settle(app, '2026-03', { amount: 5 }), 'month_not_closed', 'month');
    });

    it('lets a month be settled once the clock has moved past it', async () => {
      const { app, clock } = await setUpTwoClosedMonths();
      expectRuleViolation(
        await settle(app, '2026-03', { amount: 298701 }),
        'month_not_closed',
        'month',
      );
      clock.set('2026-04-01T08:00:00Z');
      // March is closed now. Nothing was spent in it: 298701 = 258701 unallocated + 40000 left.
      const [row] = await settleOk(app, '2026-03', { amount: 298701 });
      expect(row).toMatchObject({ amount: 298701, settlesMonth: '2026-03', date: '2026-04-01' });
    });
  });

  describe('409 nothing_to_settle', () => {
    it('refuses a closed month with nothing due', async () => {
      const { app } = await setUpTwoClosedMonths();
      // Start tracking two months earlier: November and December 2025 have no salary, so no money.
      await request(app)
        .put('/api/settings')
        .send({
          currency: 'EUR',
          locale: 'en-US',
          startMonth: '2025-11',
          theme: 'system',
          alertWarnPercent: 80,
        })
        .expect(200);
      expectApiError(await settle(app, '2025-12', { amount: 100 }), 'nothing_to_settle');
    });

    it('refuses a month that was settled in full, and stores nothing more', async () => {
      const { app } = await setUpTwoClosedMonths();
      await settleOk(app, '2026-01', { amount: JAN });
      const before = await getSavings(app);
      expectApiError(await settle(app, '2026-01', { amount: JAN }), 'nothing_to_settle');
      expect(await getSavings(app)).toEqual(before);
    });

    it('is checked before the amount and the allocations', async () => {
      const { app } = await setUpTwoClosedMonths();
      await settleOk(app, '2026-01', { amount: JAN });
      expectApiError(await settle(app, '2026-01', { amount: 1 }), 'nothing_to_settle');
      expectApiError(
        await settle(app, '2026-01', { amount: 1, allocations: [{ goalId: 99, amount: 5 }] }),
        'nothing_to_settle',
      );
    });
  });

  describe('409 outstanding_changed', () => {
    it('refuses an amount that is not the outstanding, and says what it is now', async () => {
      const { app } = await setUpTwoClosedMonths();
      const res = await settle(app, '2026-01', { amount: JAN - 1 });
      expectApiError(res, 'outstanding_changed');
      const details: OutstandingChangedDetails = { month: '2026-01', outstanding: JAN };
      expect(res.body.error.details).toEqual(details);
      expect((await getSavings(app)).balance).toBe(50000);
    });

    it('refuses the right figure with the wrong sign', async () => {
      const { app } = await setUpTwoClosedMonths();
      const res = await settle(app, '2026-01', { amount: -JAN });
      expectApiError(res, 'outstanding_changed');
      expect(res.body.error.details).toEqual({ month: '2026-01', outstanding: JAN });
    });

    it('is checked before the allocations', async () => {
      const { app } = await setUpTwoClosedMonths();
      const res = await settle(app, '2026-01', {
        amount: 5,
        // These neither add up nor name a goal that exists, but the amount is the first thing wrong.
        allocations: [{ goalId: 99, amount: -7 }],
      });
      expectApiError(res, 'outstanding_changed');
    });

    it('reports the outstanding of a month that was settled before, not its whole savings due', async () => {
      const { app, groceries } = await setUpTwoClosedMonths();
      await settleOk(app, '2026-01', { amount: JAN });
      // A forgotten 50.00 spending in January: 5000 less is due, so 5000 has to be taken back.
      await request(app)
        .post('/api/spendings')
        .send({ budgetId: groceries.id, date: '2026-01-20', amount: 5000 })
        .expect(201);
      const res = await settle(app, '2026-01', { amount: JAN });
      expectApiError(res, 'outstanding_changed');
      expect(res.body.error.details).toEqual({ month: '2026-01', outstanding: -5000 });
    });
  });

  describe('422 allocation_mismatch', () => {
    it.each([
      ['allocations that add up to less', [{ goalId: null, amount: 100000 }]],
      ['allocations that add up to more', [{ goalId: null, amount: JAN + 1 }]],
      [
        'allocations that add up to more, in two slices',
        [
          { goalId: null, amount: JAN },
          { goalId: 1, amount: 1 },
        ],
      ],
      [
        'an allocation with the opposite sign, though the total is right',
        [
          { goalId: 1, amount: JAN + 500 },
          { goalId: null, amount: -500 },
        ],
      ],
      ['only opposite signs', [{ goalId: null, amount: -JAN }]],
    ])('refuses %s (field "allocations") and stores nothing', async (_label, allocations) => {
      const { app } = await setUpTwoClosedMonths();
      await addGoal(app);
      const res = await settle(app, '2026-01', { amount: JAN, allocations });
      expectRuleViolation(res, 'allocation_mismatch', 'allocations');
      expect((await allTransactions(app)).filter((row) => row.kind === 'settlement')).toEqual([]);
    });

    it('is checked before the goals: a mismatch with an unknown goal is a mismatch', async () => {
      const { app } = await setUpTwoClosedMonths();
      const res = await settle(app, '2026-01', {
        amount: JAN,
        allocations: [{ goalId: 999, amount: 1 }],
      });
      expectRuleViolation(res, 'allocation_mismatch', 'allocations');
    });
  });

  describe('422 unknown_goal and goal_archived', () => {
    it('refuses a goal that does not exist, at the allocation that names it', async () => {
      const { app } = await setUpTwoClosedMonths();
      const goal = await addGoal(app);
      const res = await settle(app, '2026-01', {
        amount: JAN,
        allocations: [
          { goalId: goal.id, amount: 100000 },
          { goalId: 999, amount: JAN - 100000 },
        ],
      });
      expectRuleViolation(res, 'unknown_goal', 'allocations.1.goalId');
    });

    it('refuses an archived goal, at the allocation that names it', async () => {
      const { app } = await setUpTwoClosedMonths();
      const goal = await addGoal(app);
      await request(app).patch(`/api/goals/${goal.id}`).send({ archived: true }).expect(200);
      const res = await settle(app, '2026-01', {
        amount: JAN,
        allocations: [
          { goalId: null, amount: 1000 },
          { goalId: goal.id, amount: JAN - 1000 },
        ],
      });
      expectRuleViolation(res, 'goal_archived', 'allocations.1.goalId');
    });

    it('reports the first offending allocation, whichever way it is wrong', async () => {
      const { app } = await setUpTwoClosedMonths();
      const [open, archived] = [
        await addGoal(app, { name: 'Open' }),
        await addGoal(app, { name: 'Old' }),
      ];
      await request(app).patch(`/api/goals/${archived.id}`).send({ archived: true }).expect(200);
      // Every list below adds up to JAN, so only the goals can be wrong.
      const slice = (goalId: number | null) => ({ goalId, amount: 100 });
      const rest = (slices: number) => ({ goalId: null, amount: JAN - 100 * slices });

      expectRuleViolation(
        await settle(app, '2026-01', {
          amount: JAN,
          allocations: [slice(999), slice(archived.id), rest(2)],
        }),
        'unknown_goal',
        'allocations.0.goalId',
      );
      expectRuleViolation(
        await settle(app, '2026-01', {
          amount: JAN,
          allocations: [slice(archived.id), slice(999), rest(2)],
        }),
        'goal_archived',
        'allocations.0.goalId',
      );
      expectRuleViolation(
        await settle(app, '2026-01', {
          amount: JAN,
          allocations: [slice(open.id), slice(archived.id), slice(999), rest(3)],
        }),
        'goal_archived',
        'allocations.1.goalId',
      );
    });

    it('stores none of the rows when a later allocation is refused (all or nothing)', async () => {
      const { app } = await setUpTwoClosedMonths();
      const goal = await addGoal(app);
      const before = await getSavings(app);
      expectRuleViolation(
        await settle(app, '2026-01', {
          amount: JAN,
          allocations: [
            { goalId: goal.id, amount: 100000 },
            { goalId: 999, amount: JAN - 100000 },
          ],
        }),
        'unknown_goal',
        'allocations.1.goalId',
      );
      expect(await getSavings(app)).toEqual(before);
      expect((await allTransactions(app)).map((row) => row.kind)).toEqual(['opening']);
    });
  });

  describe('a settlement that takes money is never refused for lack of balance', () => {
    it('takes a negative outstanding from a goal that holds less, which goes below 0', async () => {
      const { app } = await setUpTwoClosedMonths();
      await settleOk(app, '2026-01', { amount: JAN });
      // 120.00 over-spent in January's Groceries after it was settled: 120.00 is to be taken back.
      const budget = await addBudget(app, {
        name: 'Fun',
        amount: 0,
        incremental: false,
        startMonth: '2026-01',
      });
      await request(app)
        .post('/api/spendings')
        .send({ budgetId: budget.id, date: '2026-01-25', amount: 12000 })
        .expect(201);
      const goal = await addGoal(app, { name: 'Holiday' });
      const res = await settle(app, '2026-01', {
        amount: -12000,
        allocations: [{ goalId: goal.id, amount: -12000 }],
      }).expect(201);
      expect(res.body).toMatchObject([{ amount: -12000, goalId: goal.id }]);
      const savings = await expectSavingsIdentities(app);
      expect(savings.goals[0]).toMatchObject({
        balance: -12000,
        progressPercent: 0,
        remaining: 112000,
      });
    });
  });
});

describe('DELETE /api/savings/settle/:month', () => {
  it('removes every settlement row of the month and nothing else, and answers 204', async () => {
    const { app } = await setUpTwoClosedMonths();
    const goal = await addGoal(app);
    await settleOk(app, '2026-01', {
      amount: JAN,
      allocations: [
        { goalId: goal.id, amount: 100000 },
        { goalId: null, amount: JAN - 100000 },
      ],
    });
    await settleOk(app, '2026-02', { amount: FEB });

    const res = await request(app).delete('/api/savings/settle/2026-01').expect(204);
    expect(res.text).toBe('');
    const rows = await allTransactions(app);
    // The opening row and February's settlement are still there.
    expect(rows.map((row) => [row.kind, row.settlesMonth, row.amount]).sort()).toEqual(
      [
        ['opening', null, 50000],
        ['settlement', '2026-02', FEB],
      ].sort(),
    );
    const savings = await expectSavingsIdentities(app);
    expect(
      savings.outstanding.map((entry) => [entry.month, entry.outstanding, entry.adjustment]),
    ).toEqual([['2026-01', JAN, false]]);
  });

  it('answers 404 when the month has no settlement, and for a second undo', async () => {
    const { app } = await setUpTwoClosedMonths();
    expectNotFound(await request(app).delete('/api/savings/settle/2026-01'));
    await settleOk(app, '2026-01', { amount: JAN });
    await undoSettlement(app, '2026-01');
    expectNotFound(await request(app).delete('/api/savings/settle/2026-01'));
  });

  it('answers 404 for months outside the tracked ones too (they have no settlement)', async () => {
    const { app } = await setUpTwoClosedMonths();
    expectNotFound(await request(app).delete('/api/savings/settle/2025-12'));
    expectNotFound(await request(app).delete('/api/savings/settle/2040-01'));
    expectNotFound(await request(app).delete('/api/savings/settle/2026-03'));
  });

  it.each(['abc', '2026-13', '2026-1', '2026-01-15'])(
    'rejects the month %s with a 400',
    async (month) => {
      const { app } = await setUpTwoClosedMonths();
      expectValidationError(await request(app).delete(`/api/savings/settle/${month}`), 'month');
    },
  );

  it('undoes a settlement of a month that is not closed any more (a clock that moved back)', async () => {
    const { app, clock } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-02', { amount: FEB });
    clock.set('2026-02-10T10:00:00Z');
    await undoSettlement(app, '2026-02');
    expect((await getSavings(app)).balance).toBe(50000);
  });

  it('is not limited by the balances: undoing what was moved to a goal may leave it below 0', async () => {
    const { app } = await setUpTwoClosedMonths();
    const goal = await addGoal(app, { targetAmount: 500000 });
    await settleOk(app, '2026-01', {
      amount: JAN,
      allocations: [{ goalId: goal.id, amount: JAN }],
    });
    // The money moved out of the goal as a withdrawal, then the settlement is undone.
    await request(app)
      .post('/api/savings/transactions')
      .send({ kind: 'withdrawal', amount: 200000, goalId: goal.id })
      .expect(201);
    await undoSettlement(app, '2026-01');
    const savings = await expectSavingsIdentities(app);
    expect(savings.goals[0]?.balance).toBe(-200000);
  });
});
