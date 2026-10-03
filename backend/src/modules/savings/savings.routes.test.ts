import { MAX_CENTS, type OutstandingMonthDto, type SavingsDto } from '@wallet/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { savingsTransactions } from '../../db/schema';
import { fixedClock } from '../../lib/clock';
import { expectValidationError, onboard, withTimeZone } from '../../testing/helpers';
import {
  addGoal,
  addTransaction,
  expectSavingsIdentities,
  getSavings,
  setUpTwoClosedMonths,
  settleOk,
} from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

describe('GET /api/savings', () => {
  it('right after onboarding in the current month: the opening balance and nothing to settle', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-03', salary: 300000, openingSavings: 12345 });
    const res = await request(app).get('/api/savings').expect(200);
    expect(res.body).toEqual({
      balance: 12345,
      unassigned: 12345,
      goals: [],
      outstanding: [],
      outstandingTotal: 0,
    });
  });

  it('is all zeros when the opening balance is 0 and no row was created at all', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-03',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    expect((await request(app).get('/api/savings').expect(200)).body).toEqual({
      balance: 0,
      unassigned: 0,
      goals: [],
      outstanding: [],
      outstandingTotal: 0,
    });
  });

  it('lists every closed month with money due, ascending, with its direction and breakdown', async () => {
    const { app } = await setUpTwoClosedMonths();
    const res = await request(app).get('/api/savings').expect(200);

    // The fields of the response, and of one entry, are exactly the documented ones.
    expect(Object.keys(res.body).sort()).toEqual(
      ['balance', 'goals', 'outstanding', 'outstandingTotal', 'unassigned'].sort(),
    );
    expect(Object.keys(res.body.outstanding[0]).sort()).toEqual(
      [
        'adjustment',
        'breakdown',
        'direction',
        'month',
        'outstanding',
        'savingsDue',
        'settled',
      ].sort(),
    );

    // January: 2567.01 unallocated + 90.00 left in Groceries. February: 2587.01 - 50.00 overspent
    // in Groceries + 20.00 of the cancelled insurance's reserve given back.
    const expected: OutstandingMonthDto[] = [
      {
        month: '2026-01',
        savingsDue: 265701,
        settled: 0,
        outstanding: 265701,
        direction: 'move',
        breakdown: { unallocated: 256701, budgetsSettled: 9000, reservesReleased: 0 },
        adjustment: false,
      },
      {
        month: '2026-02',
        savingsDue: 255701,
        settled: 0,
        outstanding: 255701,
        direction: 'move',
        breakdown: { unallocated: 258701, budgetsSettled: -5000, reservesReleased: 2000 },
        adjustment: false,
      },
    ];
    expect(res.body).toEqual({
      balance: 50000,
      unassigned: 50000,
      goals: [],
      outstanding: expected,
      outstandingTotal: 521402,
    });
    await expectSavingsIdentities(app);
  });

  it('never lists the current month or a future one, however much they hold', async () => {
    const { app } = await setUpTwoClosedMonths();
    // March (the current month) already holds a full salary.
    const march = (await request(app).get('/api/months/2026-03').expect(200)).body;
    expect(march.status).toBe('current');
    expect(march.savingsDue.total).toBe(298701);
    expect((await getSavings(app)).outstanding.map((entry) => entry.month)).toEqual([
      '2026-01',
      '2026-02',
    ]);
  });

  it('does not list a closed month with nothing due, such as the months before the first salary', async () => {
    const { app } = await setUpTwoClosedMonths();
    // Moving the start month earlier adds empty months: no salary, nothing due.
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
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding.map((entry) => entry.month)).toEqual(['2026-01', '2026-02']);
    expect(savings.outstandingTotal).toBe(521402);
  });

  it('does not list a month settled exactly, and lists the others', async () => {
    const { app } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-01', { amount: 265701 });
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding.map((entry) => entry.month)).toEqual(['2026-02']);
    expect(savings.outstandingTotal).toBe(255701);
    expect(savings.balance).toBe(50000 + 265701);
  });

  it('counts the goals in the balance: balance = unassigned + the goals', async () => {
    const { app } = await setUpTwoClosedMonths();
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const car = await addGoal(app, { name: 'Car', targetAmount: 500000 });
    await addTransaction(app, { kind: 'deposit', amount: 12000, goalId: holiday.id });
    await addTransaction(app, { kind: 'deposit', amount: 3000, goalId: car.id });
    await request(app).patch(`/api/goals/${car.id}`).send({ archived: true }).expect(200);
    const savings = await expectSavingsIdentities(app);
    expect(savings).toMatchObject({ balance: 65000, unassigned: 50000 });
    // Archived goals are last, and their money counts in the balance but not in `unassigned`.
    expect(savings.goals.map((goal) => [goal.name, goal.balance, goal.archived])).toEqual([
      ['Holiday', 12000, false],
      ['Car', 3000, true],
    ]);
  });

  it('ignores a settlement of a month that is not closed, which still counts in the balance', async () => {
    const { app, clock } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-02', { amount: 255701 });
    // Only a clock that moves backwards can make a settled month not closed any more.
    clock.set('2026-02-10T10:00:00Z');
    const savings: SavingsDto = await getSavings(app);
    expect(savings.outstanding.map((entry) => entry.month)).toEqual(['2026-01']);
    expect(savings.outstandingTotal).toBe(265701);
    expect(savings.balance).toBe(50000 + 255701);
    await expectSavingsIdentities(app);
  });

  it('judges "closed" in the server time zone, like the rest of the app', async () => {
    const { app, clock } = await setUpTwoClosedMonths();
    clock.set('2026-03-31T23:30:00Z');
    // In UTC it is still March 31st, so March is the current month...
    expect((await getSavings(app)).outstanding.map((entry) => entry.month)).toEqual([
      '2026-01',
      '2026-02',
    ]);
    // ...but in Rome (UTC+2) it is already April 1st, so March is closed and has money due:
    // 3,000.00 - 12.99 (Netflix) - 400.00 (Groceries) unallocated, plus the 400.00 Groceries left.
    const inRome = await withTimeZone('Europe/Rome', () => getSavings(app));
    expect(inRome.outstanding.map((entry) => [entry.month, entry.savingsDue])).toEqual([
      ['2026-01', 265701],
      ['2026-02', 255701],
      ['2026-03', 298701],
    ]);
  });
});

describe('GET and PUT /api/savings/opening', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let db: Db;

  beforeEach(async () => {
    ({ app, db } = createTestApp(fixedClock('2026-03-15T10:00:00Z')));
  });

  const openingRows = () =>
    db.select().from(savingsTransactions).where(eq(savingsTransactions.kind, 'opening')).all();

  it('is 0 dated the first day of the start month while there is no opening row', async () => {
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    expect(openingRows()).toEqual([]);
    const res = await request(app).get('/api/savings/opening').expect(200);
    expect(res.body).toEqual({ amount: 0, date: '2026-01-01' });
  });

  it('returns what onboarding stored', async () => {
    await onboard(app, { startMonth: '2026-02', openingSavings: 123456 });
    const res = await request(app).get('/api/savings/opening').expect(200);
    expect(res.body).toEqual({ amount: 123456, date: '2026-02-01' });
  });

  it('PUT creates the opening row when there is none, and answers 200 with it', async () => {
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    const res = await request(app).put('/api/savings/opening').send({ amount: 50000 }).expect(200);
    expect(res.body).toEqual({ amount: 50000, date: '2026-01-01' });
    expect(openingRows()).toMatchObject([
      { kind: 'opening', amount: 50000, date: '2026-01-01', goalId: null, settlesMonth: null },
    ]);
    expect((await request(app).get('/api/savings/opening').expect(200)).body).toEqual(res.body);
    expect(await getSavings(app)).toMatchObject({ balance: 50000, unassigned: 50000 });
  });

  it('PUT updates the one opening row (never a second one), and 0 is allowed', async () => {
    await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
    const first = openingRows();
    expect(first).toHaveLength(1);

    await request(app).put('/api/savings/opening').send({ amount: 70000 }).expect(200);
    expect(openingRows()).toMatchObject([{ id: first[0]?.id, amount: 70000 }]);
    expect(await getSavings(app)).toMatchObject({ balance: 70000, unassigned: 70000 });

    const zero = await request(app).put('/api/savings/opening').send({ amount: 0 }).expect(200);
    expect(zero.body).toEqual({ amount: 0, date: '2026-01-01' });
    expect(openingRows()).toMatchObject([{ id: first[0]?.id, amount: 0 }]);
    expect(await getSavings(app)).toMatchObject({ balance: 0, unassigned: 0 });
  });

  it('accepts the largest amount', async () => {
    await onboard(app);
    const res = await request(app)
      .put('/api/savings/opening')
      .send({ amount: MAX_CENTS })
      .expect(200);
    expect(res.body.amount).toBe(MAX_CENTS);
  });

  it('is never part of a goal, and the goals are not touched', async () => {
    await onboard(app, { openingSavings: 10000 });
    const goal = await addGoal(app);
    await request(app).put('/api/savings/opening').send({ amount: 20000 }).expect(200);
    expect(await getSavings(app)).toMatchObject({
      balance: 20000,
      unassigned: 20000,
      goals: [{ id: goal.id, balance: 0 }],
    });
  });

  it('moving the start month moves the date and never the amount', async () => {
    await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
    const put = (startMonth: string) =>
      request(app).put('/api/settings').send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth,
        theme: 'system',
        alertWarnPercent: 80,
      });
    await put('2025-10').expect(200);
    expect((await request(app).get('/api/savings/opening').expect(200)).body).toEqual({
      amount: 50000,
      date: '2025-10-01',
    });
    // The UI then asks for the balance on the new first day and sends it.
    const res = await request(app).put('/api/savings/opening').send({ amount: 31000 }).expect(200);
    expect(res.body).toEqual({ amount: 31000, date: '2025-10-01' });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, 'amount'],
      ['a negative amount', { amount: -1 }, 'amount'],
      ['a fractional amount', { amount: 500.5 }, 'amount'],
      ['a text amount', { amount: '500' }, 'amount'],
      ['a null amount', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: MAX_CENTS + 1 }, 'amount'],
      [
        'a date (it is always the first day of the start month)',
        { amount: 1, date: '2026-01-01' },
        '',
      ],
    ])('rejects %s and changes nothing', async (_label, body, path) => {
      await onboard(app, { openingSavings: 50000 });
      expectValidationError(await request(app).put('/api/savings/opening').send(body), path);
      expect(openingRows()).toMatchObject([{ amount: 50000 }]);
    });

    it('rejects a request with no body at all', async () => {
      await onboard(app);
      expectValidationError(await request(app).put('/api/savings/opening'), '');
    });
  });
});
