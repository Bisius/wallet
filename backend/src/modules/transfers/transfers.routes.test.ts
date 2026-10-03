import {
  MAX_CENTS,
  NOTES_MAX_LENGTH,
  type BudgetDto,
  type MonthView,
  type TransferDto,
} from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { budgetTransfers } from '../../db/schema';
import {
  type MutableClock,
  addBudget,
  addTransfer,
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

/**
 * Today is 2026-03-15 and tracking started in 2026-01. Groceries (400.00) and Fun (100.00) are
 * active since January. What a transfer does to the month figures is in
 * transfers.months.routes.test.ts.
 */
let app: ReturnType<typeof createTestApp>['app'];
let db: Db;
let clock: MutableClock;
let groceries: BudgetDto;
let fun: BudgetDto;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
  groceries = await addBudget(app, { name: 'Groceries', amount: 40000, startMonth: '2026-01' });
  fun = await addBudget(app, { name: 'Fun', amount: 10000, startMonth: '2026-01' });
});

const list = async (query = ''): Promise<TransferDto[]> =>
  (await request(app).get(`/api/transfers${query}`).expect(200)).body;
const post = (payload: object) => request(app).post('/api/transfers').send(payload);

/** A valid body (Groceries to Fun, 25.00, in March) with `over` applied on top. */
const body = (over: object = {}) => ({
  date: '2026-03-10',
  fromBudgetId: groceries.id,
  toBudgetId: fun.id,
  amount: 2500,
  ...over,
});

describe('POST /api/transfers', () => {
  it('moves money between two budgets and answers 201 with the DTO', async () => {
    const res = await post(body({ note: 'Birthday dinner' })).expect(201);
    expect(res.body).toEqual({
      id: 1,
      date: '2026-03-10',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 2500,
      note: 'Birthday dinner',
    });
    expect(await list()).toEqual([res.body]);
  });

  it('takes money from the unallocated pool: fromBudgetId null', async () => {
    const res = await post(body({ fromBudgetId: null })).expect(201);
    expect(res.body).toEqual({
      id: 1,
      date: '2026-03-10',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 2500,
      note: null,
    });
  });

  it('gives money back to the unallocated pool: toBudgetId null', async () => {
    const res = await post(body({ toBudgetId: null })).expect(201);
    expect(res.body).toMatchObject({ fromBudgetId: groceries.id, toBudgetId: null, amount: 2500 });
  });

  it('turns an omitted, null or blank note into null and trims the rest', async () => {
    expect((await post(body()).expect(201)).body.note).toBeNull();
    expect((await post(body({ note: null })).expect(201)).body.note).toBeNull();
    expect((await post(body({ note: '   ' })).expect(201)).body.note).toBeNull();
    expect((await post(body({ note: '  rent top-up ' })).expect(201)).body.note).toBe(
      'rent top-up',
    );
    expect(
      (await post(body({ note: 'x'.repeat(NOTES_MAX_LENGTH) })).expect(201)).body.note,
    ).toHaveLength(NOTES_MAX_LENGTH);
  });

  it('stamps createdAt from the injected clock', async () => {
    await post(body()).expect(201);
    expect(db.select().from(budgetTransfers).get()).toMatchObject({
      createdAt: '2026-03-15T10:00:00.000Z',
    });
  });

  it('numbers the transfers one after another', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await post(body()).expect(201)).body.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it.each([
    ['the first day of the start month', '2026-01-01'],
    ['a day of a closed month', '2026-01-31'],
    ['the last day of a closed month', '2026-02-28'],
    ['today', '2026-03-15'],
    ['a day of the current month after today', '2026-03-31'],
    ['the first day of next month', '2026-04-01'],
    ['a future month', '2026-12-31'],
    ['a date years ahead', '2030-06-15'],
  ])('accepts a date in any month: %s', async (_label, date) => {
    const res = await post(body({ date })).expect(201);
    expect(res.body.date).toBe(date);
  });

  it('accepts one cent and the largest amount', async () => {
    await post(body({ amount: 1 })).expect(201);
    await post(body({ amount: MAX_CENTS })).expect(201);
  });

  it('is never refused for lack of money: it may move more than the source holds', async () => {
    // Groceries holds 400.00 in March and the pool 2,500.00 (3,000.00 less the 500.00 allocated).
    await post(body({ amount: 100_000 })).expect(201);
    await post(body({ fromBudgetId: null, amount: 100_000_000 })).expect(201);
    await post(body({ toBudgetId: null, amount: 100_000_000 })).expect(201);
    expect(await list()).toHaveLength(3);
  });

  describe('rule violations (422), checked in the documented order', () => {
    // Groceries and Fun run since January. Late starts in March. Early runs January to February
    // and Gone is active in January only, so February is outside both Late and Gone.
    let late: BudgetDto;
    let early: BudgetDto;
    let gone: BudgetDto;
    beforeEach(async () => {
      late = await addBudget(app, { name: 'Late', startMonth: '2026-03' });
      early = await addBudget(app, { name: 'Early', startMonth: '2026-01' });
      gone = await addBudget(app, { name: 'Gone', startMonth: '2026-01' });
      for (const [budget, endMonth] of [
        [early, '2026-02'],
        [gone, '2026-01'],
      ] as const) {
        await request(app).post(`/api/budgets/${budget.id}/archive`).send({ endMonth }).expect(200);
      }
    });
    const nothingStored = async () => expect(await list()).toEqual([]);

    it('unknown_budget: the source does not exist (field fromBudgetId)', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: 999 })),
        'unknown_budget',
        'fromBudgetId',
      );
      await nothingStored();
    });

    it('unknown_budget: the destination does not exist (field toBudgetId)', async () => {
      expectRuleViolation(await post(body({ toBudgetId: 999 })), 'unknown_budget', 'toBudgetId');
      await nothingStored();
    });

    it('unknown_budget: the budget side is the one named, whichever side is the pool', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: 999, toBudgetId: null })),
        'unknown_budget',
        'fromBudgetId',
      );
      expectRuleViolation(
        await post(body({ fromBudgetId: null, toBudgetId: 999 })),
        'unknown_budget',
        'toBudgetId',
      );
      await nothingStored();
    });

    it('unknown_budget: when both sides are unknown the source is reported', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: 998, toBudgetId: 999 })),
        'unknown_budget',
        'fromBudgetId',
      );
    });

    it('unknown_budget comes before before_start_month', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: 999, date: '2025-12-31' })),
        'unknown_budget',
        'fromBudgetId',
      );
    });

    it('unknown_budget on the destination comes before outside_active_months on the source', async () => {
      // Late has not started in February, but the unknown destination is checked first.
      expectRuleViolation(
        await post(body({ fromBudgetId: late.id, toBudgetId: 999, date: '2026-02-10' })),
        'unknown_budget',
        'toBudgetId',
      );
    });

    it('before_start_month: the date is before settings.startMonth (the first day of it is fine)', async () => {
      expectRuleViolation(await post(body({ date: '2025-12-31' })), 'before_start_month', 'date');
      await nothingStored();
      await post(body({ date: '2026-01-01' })).expect(201);
    });

    it('before_start_month: a pool transfer too', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: null, date: '2025-06-15' })),
        'before_start_month',
        'date',
      );
      expectRuleViolation(
        await post(body({ toBudgetId: null, date: '1999-01-01' })),
        'before_start_month',
        'date',
      );
    });

    it('before_start_month comes before outside_active_months', async () => {
      // 2025-12-31 is before the start month and, for Late (from March), outside its months too.
      expectRuleViolation(
        await post(body({ fromBudgetId: late.id, date: '2025-12-31' })),
        'before_start_month',
        'date',
      );
    });

    it('outside_active_months: the source is not active yet (field fromBudgetId)', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: late.id, date: '2026-02-28' })),
        'outside_active_months',
        'fromBudgetId',
      );
      await nothingStored();
    });

    it('outside_active_months: the destination is not active yet (field toBudgetId)', async () => {
      expectRuleViolation(
        await post(body({ toBudgetId: late.id, date: '2026-02-28' })),
        'outside_active_months',
        'toBudgetId',
      );
    });

    it('outside_active_months: a budget that ended, as source and as destination', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: early.id, date: '2026-03-01' })),
        'outside_active_months',
        'fromBudgetId',
      );
      expectRuleViolation(
        await post(body({ toBudgetId: early.id, date: '2026-03-01' })),
        'outside_active_months',
        'toBudgetId',
      );
    });

    it('outside_active_months: a pool transfer is not excused, its budget side has to be active', async () => {
      expectRuleViolation(
        await post(body({ fromBudgetId: null, toBudgetId: early.id, date: '2026-04-15' })),
        'outside_active_months',
        'toBudgetId',
      );
      expectRuleViolation(
        await post(body({ fromBudgetId: early.id, toBudgetId: null, date: '2026-04-15' })),
        'outside_active_months',
        'fromBudgetId',
      );
      await nothingStored();
    });

    it('outside_active_months: only the side that is out is named', async () => {
      // February: Early is active, Late has not started.
      expectRuleViolation(
        await post(body({ fromBudgetId: early.id, toBudgetId: late.id, date: '2026-02-10' })),
        'outside_active_months',
        'toBudgetId',
      );
      expectRuleViolation(
        await post(body({ fromBudgetId: late.id, toBudgetId: early.id, date: '2026-02-10' })),
        'outside_active_months',
        'fromBudgetId',
      );
    });

    it('outside_active_months: when both sides are out the source is reported', async () => {
      // February: Late has not started and Gone has ended.
      expectRuleViolation(
        await post(body({ fromBudgetId: late.id, toBudgetId: gone.id, date: '2026-02-10' })),
        'outside_active_months',
        'fromBudgetId',
      );
      expectRuleViolation(
        await post(body({ fromBudgetId: gone.id, toBudgetId: late.id, date: '2026-02-10' })),
        'outside_active_months',
        'fromBudgetId',
      );
      await nothingStored();
    });
  });

  describe('the active months of a budget, both ends included', () => {
    // Active from 2026-02 to 2026-04. Fun, the other side, runs since January.
    let window: BudgetDto;
    beforeEach(async () => {
      window = await addBudget(app, { name: 'Window', startMonth: '2026-02' });
      await request(app)
        .post(`/api/budgets/${window.id}/archive`)
        .send({ endMonth: '2026-04' })
        .expect(200);
    });

    it.each([
      ['the day before the first month', '2026-01-31', 422],
      ['the first day of the first month', '2026-02-01', 201],
      ['the last day of the first month', '2026-02-28', 201],
      ['the last day of the last month', '2026-04-30', 201],
      ['the first day after the last month', '2026-05-01', 422],
    ])('%s: %i', async (_label, date, status) => {
      const asSource = await post(body({ fromBudgetId: window.id, toBudgetId: fun.id, date }));
      const asDestination = await post(body({ fromBudgetId: fun.id, toBudgetId: window.id, date }));
      const fromPool = await post(body({ fromBudgetId: null, toBudgetId: window.id, date }));
      const toPool = await post(body({ fromBudgetId: window.id, toBudgetId: null, date }));
      expect([asSource, asDestination, fromPool, toPool].map((res) => res.status)).toEqual([
        status,
        status,
        status,
        status,
      ]);
      if (status === 422) {
        expectRuleViolation(asSource, 'outside_active_months', 'fromBudgetId');
        expectRuleViolation(asDestination, 'outside_active_months', 'toBudgetId');
        expectRuleViolation(fromPool, 'outside_active_months', 'toBudgetId');
        expectRuleViolation(toPool, 'outside_active_months', 'fromBudgetId');
      }
    });

    it('a budget active for a single month accepts exactly that month', async () => {
      const once = await addBudget(app, { name: 'Once', startMonth: '2026-02' });
      await request(app)
        .post(`/api/budgets/${once.id}/archive`)
        .send({ endMonth: '2026-02' })
        .expect(200);
      for (const [date, status] of [
        ['2026-01-31', 422],
        ['2026-02-01', 201],
        ['2026-02-28', 201],
        ['2026-03-01', 422],
      ] as const) {
        const res = await post(body({ fromBudgetId: once.id, toBudgetId: fun.id, date }));
        expect(res.status, date).toBe(status);
      }
    });

    it('the boundary on a leap day', async () => {
      const leap = await addBudget(app, { name: 'Leap', startMonth: '2028-03' });
      await request(app)
        .post(`/api/budgets/${leap.id}/archive`)
        .send({ endMonth: '2028-03' })
        .expect(200);
      for (const [date, status] of [
        ['2028-02-29', 422],
        ['2028-03-01', 201],
        ['2028-03-31', 201],
        ['2028-04-01', 422],
      ] as const) {
        const res = await post(body({ fromBudgetId: null, toBudgetId: leap.id, date }));
        expect(res.status, date).toBe(status);
      }
    });
  });

  describe('validation (400)', () => {
    // Groceries and Fun are budgets 1 and 2: the table is built before the budgets exist.
    const OK = { date: '2026-03-10', fromBudgetId: 1, toBudgetId: 2, amount: 2500 };
    it.each([
      ['an empty body', {}, ['date', 'fromBudgetId', 'toBudgetId', 'amount']],
      ['a body that is a list', [], ['']],
      ['a missing date (it is not defaulted)', { ...OK, date: undefined }, ['date']],
      ['a null date', { ...OK, date: null }, ['date']],
      ['an impossible date', { ...OK, date: '2026-02-30' }, ['date']],
      ['a month instead of a date', { ...OK, date: '2026-03' }, ['date']],
      ['a text date', { ...OK, date: 'today' }, ['date']],
      [
        'a missing source (an omitted side is not the pool)',
        { ...OK, fromBudgetId: undefined },
        ['fromBudgetId'],
      ],
      [
        'a missing destination (an omitted side is not the pool)',
        { ...OK, toBudgetId: undefined },
        ['toBudgetId'],
      ],
      ['a source that is 0', { ...OK, fromBudgetId: 0 }, ['fromBudgetId']],
      ['a negative source', { ...OK, fromBudgetId: -1 }, ['fromBudgetId']],
      ['a fractional source', { ...OK, fromBudgetId: 1.5 }, ['fromBudgetId']],
      ['a string source', { ...OK, fromBudgetId: '1' }, ['fromBudgetId']],
      ['a boolean source', { ...OK, fromBudgetId: false }, ['fromBudgetId']],
      ['a destination that is 0', { ...OK, toBudgetId: 0 }, ['toBudgetId']],
      ['a string destination', { ...OK, toBudgetId: '2' }, ['toBudgetId']],
      ['a boolean destination', { ...OK, toBudgetId: true }, ['toBudgetId']],
      [
        'the pool on both sides (no budget at all)',
        { ...OK, fromBudgetId: null, toBudgetId: null },
        ['toBudgetId'],
      ],
      ['the same budget on both sides', { ...OK, fromBudgetId: 2, toBudgetId: 2 }, ['toBudgetId']],
      ['a missing amount', { ...OK, amount: undefined }, ['amount']],
      ['a zero amount', { ...OK, amount: 0 }, ['amount']],
      ['a negative amount (the direction is the sides)', { ...OK, amount: -2500 }, ['amount']],
      ['a fractional amount', { ...OK, amount: 12.5 }, ['amount']],
      ['a string amount', { ...OK, amount: '25.00' }, ['amount']],
      ['a null amount', { ...OK, amount: null }, ['amount']],
      ['an amount above the cap', { ...OK, amount: MAX_CENTS + 1 }, ['amount']],
      ['too long a note', { ...OK, note: 'x'.repeat(NOTES_MAX_LENGTH + 1) }, ['note']],
      ['a numeric note', { ...OK, note: 5 }, ['note']],
      ['an unknown key', { ...OK, kind: 'transfer' }, ['']],
      ['a month in the body', { ...OK, month: '2026-03' }, ['']],
      ['an id in the body', { ...OK, id: 7 }, ['']],
      [
        'a budget id under another name',
        { date: '2026-03-10', amount: 5, budgetId: 1 },
        ['', 'fromBudgetId', 'toBudgetId'],
      ],
    ])('rejects %s', async (_label, payload, paths) => {
      expectValidationPaths(await post(payload), ...paths);
      expect(await list()).toEqual([]);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .post('/api/transfers')
        .set('Content-Type', 'application/json')
        .send('{"date": ');
      expectApiError(res, 'invalid_json');
    });

    it('validates before it looks at the budgets or the dates', async () => {
      // Unknown budgets and a date before the start month, but a zero amount: only the 400 shows.
      expectValidationPaths(
        await post(body({ fromBudgetId: 998, toBudgetId: 999, date: '2025-01-01', amount: 0 })),
        'amount',
      );
    });
  });
});

describe('GET /api/transfers', () => {
  it('is an empty list when there are none', async () => {
    expect(await list()).toEqual([]);
  });

  it('is newest first: date descending, then id descending', async () => {
    const a = await addTransfer(app, { ...ids(), date: '2026-02-10' });
    const b = await addTransfer(app, { ...ids(), date: '2026-03-01' });
    const c = await addTransfer(app, { ...ids(), date: '2026-02-10' });
    const d = await addTransfer(app, { ...ids(), date: '2026-01-31' });
    const e = await addTransfer(app, { ...ids(), date: '2026-02-10' });
    const result = await list();
    expect(result.map((t) => t.id)).toEqual([b.id, e.id, c.id, a.id, d.id]);
    expect(result[0]).toEqual(b);
  });

  /** Groceries to Fun, the default of the transfers these tests make. */
  function ids() {
    return { fromBudgetId: groceries.id, toBudgetId: fun.id };
  }

  describe('filters', () => {
    let other: BudgetDto;
    let t: Record<string, TransferDto>;
    beforeEach(async () => {
      other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      const g = groceries.id;
      const f = fun.id;
      const o = other.id;
      t = {
        janLast: await addTransfer(app, {
          date: '2026-01-31',
          fromBudgetId: g,
          toBudgetId: f,
          amount: 100,
        }),
        febFirst: await addTransfer(app, {
          date: '2026-02-01',
          fromBudgetId: null,
          toBudgetId: g,
          amount: 200,
        }),
        febMid: await addTransfer(app, {
          date: '2026-02-15',
          fromBudgetId: f,
          toBudgetId: null,
          amount: 300,
        }),
        febLast: await addTransfer(app, {
          date: '2026-02-28',
          fromBudgetId: o,
          toBudgetId: f,
          amount: 400,
        }),
        marFirst: await addTransfer(app, {
          date: '2026-03-01',
          fromBudgetId: g,
          toBudgetId: null,
          amount: 500,
        }),
        marTenA: await addTransfer(app, {
          date: '2026-03-10',
          fromBudgetId: o,
          toBudgetId: g,
          amount: 600,
        }),
        marTenB: await addTransfer(app, {
          date: '2026-03-10',
          fromBudgetId: null,
          toBudgetId: o,
          amount: 700,
        }),
      } as Record<string, TransferDto>;
    });
    const amounts = (items: TransferDto[]) => items.map((item) => item.amount);

    it('without a filter every transfer, newest first, equal dates by descending id', async () => {
      expect(amounts(await list())).toEqual([700, 600, 500, 400, 300, 200, 100]);
    });

    it('month: every day of the month, nothing from the neighbours', async () => {
      expect(amounts(await list('?month=2026-02'))).toEqual([400, 300, 200]);
      expect(amounts(await list('?month=2026-01'))).toEqual([100]);
      expect(amounts(await list('?month=2026-03'))).toEqual([700, 600, 500]);
    });

    it('month: the last day of a 30- and a 31-day month, but not the first day of the next', async () => {
      await addTransfer(app, {
        date: '2026-04-30',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
        amount: 1,
      });
      await addTransfer(app, {
        date: '2026-05-01',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
        amount: 2,
      });
      await addTransfer(app, {
        date: '2026-05-31',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
        amount: 4,
      });
      await addTransfer(app, {
        date: '2026-06-01',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
        amount: 8,
      });
      expect(amounts(await list('?month=2026-04'))).toEqual([1]);
      expect(amounts(await list('?month=2026-05'))).toEqual([4, 2]);
      expect(amounts(await list('?month=2026-01'))).toEqual([100]);
    });

    it('month: a month outside the tracked range matches nothing (it is no error)', async () => {
      expect(await list('?month=2099-01')).toEqual([]);
      expect(await list('?month=1999-12')).toEqual([]);
    });

    it('from/to: inclusive on both ends', async () => {
      expect(amounts(await list('?from=2026-02-01&to=2026-03-01'))).toEqual([500, 400, 300, 200]);
    });

    it('from alone, to alone and a one-day range', async () => {
      expect(amounts(await list('?from=2026-03-01'))).toEqual([700, 600, 500]);
      expect(amounts(await list('?to=2026-01-31'))).toEqual([100]);
      expect(amounts(await list('?from=2026-02-28&to=2026-02-28'))).toEqual([400]);
    });

    it('budgetId: a transfer out of OR into the budget, pool transfers included', async () => {
      // Groceries is the source of 100 and 500 and the destination of 200 and 600.
      expect(amounts(await list(`?budgetId=${groceries.id}`))).toEqual([600, 500, 200, 100]);
      // Fun: destination of 100 and 400, source of 300.
      expect(amounts(await list(`?budgetId=${fun.id}`))).toEqual([400, 300, 100]);
      // Other: source of 400 and 600, destination of 700.
      expect(amounts(await list(`?budgetId=${other.id}`))).toEqual([700, 600, 400]);
    });

    it('budgetId: an unknown budget matches nothing', async () => {
      expect(await list('?budgetId=999')).toEqual([]);
    });

    it('combines with AND: month and budgetId, range and budgetId', async () => {
      expect(amounts(await list(`?month=2026-02&budgetId=${fun.id}`))).toEqual([400, 300]);
      expect(
        amounts(await list(`?from=2026-02-15&to=2026-03-10&budgetId=${groceries.id}`)),
      ).toEqual([600, 500]);
      expect(await list(`?month=2026-01&budgetId=${other.id}`)).toEqual([]);
    });

    it('returns the same DTOs as the create did', async () => {
      expect((await list('?month=2026-02')).at(-1)).toEqual(t['febFirst']);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad month', '?month=2026-13', ['month']],
      ['month together with from', '?month=2026-03&from=2026-03-01', ['month']],
      ['month together with to', '?month=2026-03&to=2026-03-31', ['month']],
      ['from after to', '?from=2026-03-31&to=2026-03-01', ['to']],
      ['a bad from', '?from=2026-03', ['from']],
      ['a bad to', '?to=today', ['to']],
      ['a zero budgetId', '?budgetId=0', ['budgetId']],
      ['a negative budgetId', '?budgetId=-1', ['budgetId']],
      ['a text budgetId', '?budgetId=food', ['budgetId']],
      ['a fractional budgetId', '?budgetId=1.5', ['budgetId']],
      ['an empty budgetId', '?budgetId=', ['budgetId']],
      ['a repeated budgetId', '?budgetId=1&budgetId=2', ['budgetId']],
      ['paging (the list is not paged)', '?limit=10', ['']],
      ['an offset', '?offset=0', ['']],
      ['a search (it is a spendings filter)', '?q=rent', ['']],
      ['an unknown filter', '?fromBudgetId=1', ['']],
    ])('rejects %s', async (_label, query, paths) => {
      expectValidationPaths(await request(app).get(`/api/transfers${query}`), ...paths);
    });
  });
});

describe('DELETE /api/transfers/:id', () => {
  it('removes the transfer (204, no body) and only that one', async () => {
    const keep = await addTransfer(app, { fromBudgetId: groceries.id, toBudgetId: fun.id });
    const gone = await addTransfer(app, { fromBudgetId: null, toBudgetId: fun.id });
    const res = await request(app).delete(`/api/transfers/${gone.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await list()).toEqual([keep]);
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const transfer = await addTransfer(app, { fromBudgetId: groceries.id, toBudgetId: fun.id });
    expectNotFound(await request(app).delete('/api/transfers/99'));
    await request(app).delete(`/api/transfers/${transfer.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/transfers/${transfer.id}`));
  });

  it('does not reuse the id of a deleted transfer', async () => {
    const first = await addTransfer(app, { fromBudgetId: groceries.id, toBudgetId: fun.id });
    await request(app).delete(`/api/transfers/${first.id}`).expect(204);
    const second = await addTransfer(app, { fromBudgetId: groceries.id, toBudgetId: fun.id });
    expect(second.id).toBeGreaterThan(first.id);
  });

  it.each(['abc', '0', '-1', '2.5', '99999999999999999999999'])(
    'rejects the id %j (400)',
    async (id) => {
      expectValidationPaths(await request(app).delete(`/api/transfers/${id}`), 'id');
    },
  );

  it('has no PATCH or PUT: a transfer is deleted and entered again', async () => {
    const transfer = await addTransfer(app, { fromBudgetId: groceries.id, toBudgetId: fun.id });
    expectNotFound(await request(app).patch(`/api/transfers/${transfer.id}`).send({ amount: 1 }));
    expectNotFound(await request(app).put(`/api/transfers/${transfer.id}`).send(body()));
    expect(await list()).toEqual([transfer]);
  });
});

describe('a transfer dated beyond the 120-month projection horizon', () => {
  // Today is 2026-03-15, so the last month that has a view is 2036-03.
  const FAR = '2062-10-15';
  const far = () =>
    addTransfer(app, { date: FAR, fromBudgetId: groceries.id, toBudgetId: fun.id, amount: 777 });

  it('is stored (201), and the list finds it unfiltered, by budget, by its month and by its dates', async () => {
    const res = await post(body({ date: FAR, amount: 777 })).expect(201);
    const stored: TransferDto = res.body;
    expect(stored).toMatchObject({ date: FAR, amount: 777 });

    expect(await list()).toEqual([stored]);
    expect(await list(`?budgetId=${groceries.id}`)).toEqual([stored]);
    expect(await list(`?budgetId=${fun.id}`)).toEqual([stored]);
    expect(await list('?month=2062-10')).toEqual([stored]);
    expect(await list('?from=2062-10-01&to=2062-10-31')).toEqual([stored]);
    expect(await list(`?month=2062-10&budgetId=${fun.id}`)).toEqual([stored]);
    // A month without transfers is an empty list, inside the tracked range or not.
    expect(await list('?month=2062-09')).toEqual([]);
    expect(await list('?month=2062-11')).toEqual([]);
    expect(await list('?month=2026-04')).toEqual([]);
  });

  it('is in no month view, as the month does not exist', async () => {
    await far();
    expectNotFound(await request(app).get('/api/months/2062-10'));
  });

  it('the last month that has a view shows its transfers, the next one is stored without a view', async () => {
    const inside = await addTransfer(app, {
      date: '2036-03-31',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 1234,
    });
    const beyond = await addTransfer(app, {
      date: '2036-04-01',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 4321,
    });
    const view: MonthView = (await request(app).get('/api/months/2036-03').expect(200)).body;
    expect(view.totals.transfersNet).toBe(1234);
    expectNotFound(await request(app).get('/api/months/2036-04'));

    expect(await list('?month=2036-04')).toEqual([beyond]);
    expect(await list()).toEqual([beyond, inside]);
  });

  it('counts for the budget guards (end_before_activity, has_history) until it is deleted', async () => {
    const stored = await far();
    const archive = (budget: BudgetDto) =>
      request(app).post(`/api/budgets/${budget.id}/archive`).send({ endMonth: '2026-12' });

    expectRuleViolation(await archive(groceries), 'end_before_activity', 'endMonth');
    expectRuleViolation(await archive(fun), 'end_before_activity', 'endMonth');
    expectApiError(await request(app).delete(`/api/budgets/${fun.id}`), 'has_history');
    const budgets: BudgetDto[] = (await request(app).get('/api/budgets').expect(200)).body;
    expect(budgets.map((budget) => budget.hasHistory)).toEqual([true, true]);

    await request(app).delete(`/api/transfers/${stored.id}`).expect(204);
    expect(await list()).toEqual([]);
    expect(await list('?month=2062-10')).toEqual([]);
    expectNotFound(await request(app).delete(`/api/transfers/${stored.id}`));

    // With the transfer gone the budgets are free again.
    await archive(groceries).expect(200);
    await request(app).delete(`/api/budgets/${fun.id}`).expect(204);
  });
});
