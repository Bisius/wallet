import type { BudgetDto, SpendingDto, SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { spendings } from '../../db/schema';
import {
  type MutableClock,
  addBudget,
  addSpending,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;
let clock: MutableClock;
let groceries: BudgetDto;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
  groceries = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
});

const page = async (query = ''): Promise<SpendingsPage> =>
  (await request(app).get(`/api/spendings${query}`).expect(200)).body;

/** Inserts spendings straight into the database (bulk setup, bypassing the rules on purpose). */
function rows(items: { date: string; amount: number; budgetId: number; description?: string }[]) {
  for (let i = 0; i < items.length; i += 100) {
    db.insert(spendings)
      .values(items.slice(i, i + 100).map((item) => ({ description: '', ...item })))
      .run();
  }
}

describe('POST /api/spendings', () => {
  it('creates a spending and answers 201 with the DTO', async () => {
    const res = await request(app)
      .post('/api/spendings')
      .send({
        date: '2026-03-10',
        amount: 1250,
        budgetId: groceries.id,
        description: 'Lunch',
        notes: 'with Sam',
      })
      .expect(201);
    expect(res.body).toEqual({
      id: 1,
      date: '2026-03-10',
      amount: 1250,
      budgetId: groceries.id,
      description: 'Lunch',
      notes: 'with Sam',
      tagIds: [],
    });
    expect((await page()).items).toEqual([res.body]);
  });

  it('defaults the description to "" and the notes to null', async () => {
    const res = await request(app)
      .post('/api/spendings')
      .send({ date: '2026-03-10', amount: 500, budgetId: groceries.id })
      .expect(201);
    expect(res.body).toMatchObject({ description: '', notes: null });
  });

  it('trims text and turns blank notes into null', async () => {
    const res = await request(app)
      .post('/api/spendings')
      .send({
        date: '2026-03-10',
        amount: 500,
        budgetId: groceries.id,
        description: '  coffee ',
        notes: '   ',
      })
      .expect(201);
    expect(res.body).toMatchObject({ description: 'coffee', notes: null });
  });

  it('accepts a refund (a negative amount)', async () => {
    const res = await request(app)
      .post('/api/spendings')
      .send({ date: '2026-03-10', amount: -2500, budgetId: groceries.id, description: 'Returned' })
      .expect(201);
    expect(res.body.amount).toBe(-2500);
  });

  it('accepts a date in the future', async () => {
    await addSpending(app, { budgetId: groceries.id, date: '2030-12-31' });
  });

  it('stamps createdAt and updatedAt from the injected clock', async () => {
    const created = await addSpending(app, { budgetId: groceries.id });
    const row = db.select().from(spendings).get();
    expect(row).toMatchObject({
      id: created.id,
      createdAt: '2026-03-15T10:00:00.000Z',
      updatedAt: '2026-03-15T10:00:00.000Z',
      importHash: null,
    });
  });

  describe('rule violations (422), checked in the documented order', () => {
    const body = (over: object) => ({
      date: '2026-03-10',
      amount: 100,
      budgetId: groceries.id,
      ...over,
    });

    it('unknown_budget: the budget does not exist', async () => {
      const res = await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: 999 }));
      expectRuleViolation(res, 'unknown_budget', 'budgetId');
      expect((await page()).total).toBe(0);
    });

    it('before_start_month: the date is before settings.startMonth (and the first day of it is fine)', async () => {
      expectRuleViolation(
        await request(app)
          .post('/api/spendings')
          .send(body({ date: '2025-12-31' })),
        'before_start_month',
        'date',
      );
      await request(app)
        .post('/api/spendings')
        .send(body({ date: '2026-01-01' }))
        .expect(201);
    });

    it('outside_active_months: before the budget starts, on the last day before and the first day of its start month', async () => {
      const march = await addBudget(app, { name: 'From March', startMonth: '2026-03' });
      expectRuleViolation(
        await request(app)
          .post('/api/spendings')
          .send(body({ budgetId: march.id, date: '2026-02-28' })),
        'outside_active_months',
        'date',
      );
      await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: march.id, date: '2026-03-01' }))
        .expect(201);
    });

    it('outside_active_months: after the budget ended, on the last day of its end month and the first day after', async () => {
      const temp = await addBudget(app, { name: 'Temp', startMonth: '2026-01' });
      await request(app)
        .post(`/api/budgets/${temp.id}/archive`)
        .send({ endMonth: '2026-02' })
        .expect(200);
      await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: temp.id, date: '2026-02-28' }))
        .expect(201);
      expectRuleViolation(
        await request(app)
          .post('/api/spendings')
          .send(body({ budgetId: temp.id, date: '2026-03-01' })),
        'outside_active_months',
        'date',
      );
    });

    it('outside_active_months: the boundary on a leap day', async () => {
      const leap = await addBudget(app, { name: 'Leap', startMonth: '2028-03' });
      expectRuleViolation(
        await request(app)
          .post('/api/spendings')
          .send(body({ budgetId: leap.id, date: '2028-02-29' })),
        'outside_active_months',
        'date',
      );
      await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: leap.id, date: '2028-03-01' }))
        .expect(201);
      await request(app)
        .post(`/api/budgets/${leap.id}/archive`)
        .send({ endMonth: '2028-03' })
        .expect(200);
      await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: leap.id, date: '2028-03-31' }))
        .expect(201);
      expectRuleViolation(
        await request(app)
          .post('/api/spendings')
          .send(body({ budgetId: leap.id, date: '2028-04-01' })),
        'outside_active_months',
        'date',
      );
    });

    it('a single-month budget accepts exactly its month', async () => {
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
        const res = await request(app)
          .post('/api/spendings')
          .send(body({ budgetId: once.id, date }));
        expect(res.status, date).toBe(status);
      }
    });

    it('unknown_budget comes before before_start_month', async () => {
      const res = await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: 999, date: '2025-01-01' }));
      expectRuleViolation(res, 'unknown_budget', 'budgetId');
    });

    it('before_start_month comes before outside_active_months', async () => {
      // 2025-12-31 is before the start month and, for a budget starting in March, outside its range too.
      const march = await addBudget(app, { name: 'From March', startMonth: '2026-03' });
      const res = await request(app)
        .post('/api/spendings')
        .send(body({ budgetId: march.id, date: '2025-12-31' }));
      expectRuleViolation(res, 'before_start_month', 'date');
    });
  });

  describe('validation (400)', () => {
    const ok = { date: '2026-03-10', amount: 100, budgetId: 1 };
    it.each([
      ['an empty body', {}, 'date'],
      ['a missing date', { ...ok, date: undefined }, 'date'],
      ['an impossible date', { ...ok, date: '2026-04-31' }, 'date'],
      ['a month instead of a date', { ...ok, date: '2026-04' }, 'date'],
      ['a missing amount', { ...ok, amount: undefined }, 'amount'],
      ['a zero amount', { ...ok, amount: 0 }, 'amount'],
      ['a fractional amount', { ...ok, amount: 12.5 }, 'amount'],
      ['a string amount', { ...ok, amount: '12.50' }, 'amount'],
      ['an amount above the cap', { ...ok, amount: 1_000_000_000_001 }, 'amount'],
      ['a missing budgetId', { ...ok, budgetId: undefined }, 'budgetId'],
      ['a zero budgetId', { ...ok, budgetId: 0 }, 'budgetId'],
      ['a string budgetId', { ...ok, budgetId: '1' }, 'budgetId'],
      ['a boolean budgetId', { ...ok, budgetId: true }, 'budgetId'],
      ['a too long description', { ...ok, description: 'x'.repeat(201) }, 'description'],
      ['too long notes', { ...ok, notes: 'x'.repeat(1001) }, 'notes'],
      ['an unknown key', { ...ok, tags: [1] }, ''],
    ])('rejects %s', async (_label, payload, path) => {
      expectValidationError(await request(app).post('/api/spendings').send(payload), path);
      expect((await page()).total).toBe(0);
    });

    it('validates before it looks at the budget', async () => {
      expectValidationError(
        await request(app)
          .post('/api/spendings')
          .send({ ...ok, budgetId: 999, amount: 0 }),
        'amount',
      );
    });
  });
});

describe('GET /api/spendings', () => {
  it('is an empty page with zero totals when there are none', async () => {
    expect(await page()).toEqual({ items: [], total: 0, limit: 50, offset: 0, totalAmount: 0 });
  });

  it('is newest first: date descending, then id descending', async () => {
    const a = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-02-10',
      description: 'a',
    });
    const b = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-03-01',
      description: 'b',
    });
    const c = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-02-10',
      description: 'c',
    });
    const d = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-01-31',
      description: 'd',
    });
    const res = await page();
    expect(res.items.map((i) => i.id)).toEqual([b.id, c.id, a.id, d.id]);
    expect(res.items[0]).toEqual(b);
  });

  describe('filters', () => {
    let other: BudgetDto;
    beforeEach(async () => {
      other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      rows([
        { date: '2026-01-31', amount: 100, budgetId: groceries.id, description: 'jan last' },
        { date: '2026-02-01', amount: 200, budgetId: groceries.id, description: 'feb first' },
        { date: '2026-02-15', amount: 300, budgetId: other.id, description: 'feb mid other' },
        { date: '2026-02-28', amount: -50, budgetId: groceries.id, description: 'feb last refund' },
        { date: '2026-03-01', amount: 400, budgetId: groceries.id, description: 'mar first' },
        { date: '2026-03-10', amount: 500, budgetId: other.id, description: 'mar other' },
      ]);
    });
    const descriptions = (p: SpendingsPage) => p.items.map((i) => i.description);

    it('month: every day of the month, nothing from the neighbours', async () => {
      const res = await page('?month=2026-02');
      expect(descriptions(res)).toEqual(['feb last refund', 'feb mid other', 'feb first']);
      expect(res).toMatchObject({ total: 3, totalAmount: 450 });
    });

    it('month: includes the last day of a 30- and a 31-day month, but not the first day of the next', async () => {
      rows([
        { date: '2026-04-30', amount: 1, budgetId: groceries.id, description: 'apr last' },
        { date: '2026-05-01', amount: 2, budgetId: groceries.id, description: 'may first' },
        { date: '2026-05-31', amount: 4, budgetId: groceries.id, description: 'may last' },
        { date: '2026-06-01', amount: 8, budgetId: groceries.id, description: 'jun first' },
      ]);
      expect(descriptions(await page('?month=2026-04'))).toEqual(['apr last']);
      const may = await page('?month=2026-05');
      expect(descriptions(may)).toEqual(['may last', 'may first']);
      expect(may).toMatchObject({ total: 2, totalAmount: 6 });
      // January also ends on the 31st ('jan last' from the shared setup).
      expect(descriptions(await page('?month=2026-01'))).toEqual(['jan last']);
    });

    it('from/to: inclusive on both ends', async () => {
      const res = await page('?from=2026-02-01&to=2026-03-01');
      expect(descriptions(res)).toEqual([
        'mar first',
        'feb last refund',
        'feb mid other',
        'feb first',
      ]);
      expect(res).toMatchObject({ total: 4, totalAmount: 850 });
    });

    it('from alone and to alone', async () => {
      expect(descriptions(await page('?from=2026-03-01'))).toEqual(['mar other', 'mar first']);
      expect(descriptions(await page('?to=2026-01-31'))).toEqual(['jan last']);
    });

    it('a one-day range', async () => {
      expect(descriptions(await page('?from=2026-02-28&to=2026-02-28'))).toEqual([
        'feb last refund',
      ]);
    });

    it('budgetId', async () => {
      const res = await page(`?budgetId=${other.id}`);
      expect(descriptions(res)).toEqual(['mar other', 'feb mid other']);
      expect(res).toMatchObject({ total: 2, totalAmount: 800 });
    });

    it('combines with AND: month and budgetId, range and budgetId', async () => {
      expect(descriptions(await page(`?month=2026-02&budgetId=${groceries.id}`))).toEqual([
        'feb last refund',
        'feb first',
      ]);
      expect(
        descriptions(await page(`?from=2026-02-15&to=2026-03-10&budgetId=${other.id}`)),
      ).toEqual(['mar other', 'feb mid other']);
    });

    it('an unknown budgetId just matches nothing', async () => {
      expect(await page('?budgetId=999')).toEqual({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        totalAmount: 0,
      });
    });

    it('a month without spendings is an empty page', async () => {
      expect(await page('?month=2026-09')).toMatchObject({ items: [], total: 0, totalAmount: 0 });
    });

    it('nets refunds into totalAmount', async () => {
      expect((await page(`?month=2026-02&budgetId=${groceries.id}`)).totalAmount).toBe(150);
    });
  });

  describe('Page and totalAmount over a filtered set larger than the page', () => {
    let other: BudgetDto;
    /** 130 matching spendings in March of `groceries`, amounts 1..130 and every 10th a refund. */
    let expectedTotal = 0;
    beforeEach(async () => {
      expectedTotal = 0;
      other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      const matching = Array.from({ length: 130 }, (_unused, i) => {
        const n = i + 1;
        const amount = n % 10 === 0 ? -n : n;
        expectedTotal += amount;
        return {
          date: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
          amount,
          budgetId: groceries.id,
        };
      });
      // Noise that the filter must exclude: other budget, other month.
      const noise = [
        ...Array.from({ length: 20 }, () => ({
          date: '2026-03-05',
          amount: 99999,
          budgetId: other.id,
        })),
        ...Array.from({ length: 20 }, () => ({
          date: '2026-02-05',
          amount: 88888,
          budgetId: groceries.id,
        })),
      ];
      rows([...matching, ...noise]);
    });
    const filter = () => `month=2026-03&budgetId=${groceries.id}`;

    it('the default page is 50 items, but total and totalAmount cover all 130', async () => {
      const res = await page(`?${filter()}`);
      expect(res.items).toHaveLength(50);
      expect(res).toMatchObject({ total: 130, limit: 50, offset: 0, totalAmount: expectedTotal });
      expect(expectedTotal).not.toBe(res.items.reduce((sum, i) => sum + i.amount, 0)); // not just the page
    });

    it('a middle page and the last, partial page', async () => {
      const middle = await page(`?${filter()}&limit=50&offset=50`);
      expect(middle).toMatchObject({
        total: 130,
        limit: 50,
        offset: 50,
        totalAmount: expectedTotal,
      });
      expect(middle.items).toHaveLength(50);
      const last = await page(`?${filter()}&limit=50&offset=100`);
      expect(last).toMatchObject({ total: 130, offset: 100, totalAmount: expectedTotal });
      expect(last.items).toHaveLength(30);
    });

    it('pages concatenate to the whole ordered set: no gaps, no repeats, ids break date ties', async () => {
      const seen: SpendingDto[] = [];
      for (let offset = 0; offset < 130; offset += 25) {
        seen.push(...(await page(`?${filter()}&limit=25&offset=${offset}`)).items);
      }
      expect(seen).toHaveLength(130);
      expect(new Set(seen.map((s) => s.id)).size).toBe(130);
      const sorted = [...seen].sort((a, b) =>
        a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
      );
      expect(seen).toEqual(sorted);
      expect(seen.reduce((sum, s) => sum + s.amount, 0)).toBe(expectedTotal);
    });

    it('the largest page (200) returns everything that matches', async () => {
      const res = await page(`?${filter()}&limit=200`);
      expect(res.items).toHaveLength(130);
      expect(res).toMatchObject({ total: 130, limit: 200, totalAmount: expectedTotal });
    });

    it('an offset past the end is an empty page that still reports the totals', async () => {
      const res = await page(`?${filter()}&offset=500`);
      expect(res).toMatchObject({ items: [], total: 130, offset: 500, totalAmount: expectedTotal });
    });

    it('a page of one', async () => {
      const res = await page(`?${filter()}&limit=1`);
      expect(res.items).toHaveLength(1);
      expect(res).toMatchObject({ total: 130, limit: 1, totalAmount: expectedTotal });
    });

    it('without any filter it covers every spending', async () => {
      const res = await page('?limit=1');
      expect(res.total).toBe(130 + 40);
      expect(res.totalAmount).toBe(expectedTotal + 20 * 99999 + 20 * 88888);
    });
  });

  it('sums large amounts exactly', async () => {
    const big = 1_000_000_000_000; // MAX_CENTS
    rows([
      { date: '2026-03-01', amount: big, budgetId: groceries.id },
      { date: '2026-03-02', amount: big, budgetId: groceries.id },
      { date: '2026-03-03', amount: -1, budgetId: groceries.id },
    ]);
    expect((await page()).totalAmount).toBe(2 * big - 1);
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad month', '?month=2026-13', 'month'],
      ['month together with from', '?month=2026-03&from=2026-03-01', 'month'],
      ['month together with to', '?month=2026-03&to=2026-03-31', 'month'],
      ['from after to', '?from=2026-03-31&to=2026-03-01', 'to'],
      ['a bad from', '?from=2026-03', 'from'],
      ['a bad to', '?to=today', 'to'],
      ['a zero budgetId', '?budgetId=0', 'budgetId'],
      ['a text budgetId', '?budgetId=food', 'budgetId'],
      ['a repeated budgetId', '?budgetId=1&budgetId=2', 'budgetId'],
      ['a zero limit', '?limit=0', 'limit'],
      ['a limit above 200', '?limit=201', 'limit'],
      ['a text limit', '?limit=many', 'limit'],
      ['a fractional limit', '?limit=1.5', 'limit'],
      ['a negative offset', '?offset=-1', 'offset'],
      ['a text offset', '?offset=x', 'offset'],
      ['an unknown filter', '?search=coffee', ''],
    ])('rejects %s', async (_label, query, path) => {
      expectValidationError(await request(app).get(`/api/spendings${query}`), path);
    });
  });
});

describe('PATCH /api/spendings/:id', () => {
  let spending: SpendingDto;
  beforeEach(async () => {
    spending = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-03-10',
      amount: 1250,
      description: 'Lunch',
      notes: 'with Sam',
    });
  });
  const patch = (body: object, id = spending.id) =>
    request(app).patch(`/api/spendings/${id}`).send(body);

  it.each([
    ['the amount', { amount: 1500 }],
    ['the amount to a refund', { amount: -300 }],
    ['the date', { date: '2026-03-11' }],
    ['the description', { description: 'Dinner' }],
    ['the description to empty', { description: '' }],
    ['the notes', { notes: 'new' }],
    ['the notes to null', { notes: null }],
    ['blank notes to null', { notes: '  ' }],
  ])('changes only %s', async (_label, change) => {
    const res = await patch(change).expect(200);
    const expected = {
      ...spending,
      ...change,
      ...('notes' in change && change.notes?.trim() === '' ? { notes: null } : {}),
    };
    expect(res.body).toEqual(expected);
    expect((await page()).items).toEqual([res.body]);
  });

  it('changes every field at once, including the budget', async () => {
    const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
    const body = {
      date: '2026-02-01',
      amount: 99,
      budgetId: other.id,
      description: 'x',
      notes: null,
    };
    const res = await patch(body).expect(200);
    expect(res.body).toEqual({ id: spending.id, ...body, tagIds: [] });
  });

  it('can move a spending into another month', async () => {
    await patch({ date: '2026-02-20' }).expect(200);
    expect((await page('?month=2026-03')).items).toEqual([]);
    expect((await page('?month=2026-02')).items).toHaveLength(1);
  });

  it('stamps updatedAt from the clock and leaves createdAt', async () => {
    clock.set('2026-03-20T08:00:00Z');
    await patch({ amount: 1 }).expect(200);
    expect(db.select().from(spendings).get()).toMatchObject({
      createdAt: '2026-03-15T10:00:00.000Z',
      updatedAt: '2026-03-20T08:00:00.000Z',
    });
  });

  it('is a 404 for an unknown id, even when the body would also break a rule', async () => {
    expectNotFound(await patch({ budgetId: 999 }, 4242));
  });

  describe('the same 422 rules as the create, against the resulting date and budget', () => {
    it('unknown_budget: moving it to a budget that does not exist', async () => {
      expectRuleViolation(await patch({ budgetId: 999 }), 'unknown_budget', 'budgetId');
      expect((await page()).items).toEqual([spending]);
    });

    it('before_start_month: a date before settings.startMonth (the first day of it is fine)', async () => {
      expectRuleViolation(await patch({ date: '2025-12-31' }), 'before_start_month', 'date');
      await patch({ date: '2026-01-01' }).expect(200);
    });

    it('outside_active_months: a date after the budget ended, on its last day and the day after', async () => {
      const temp = await addBudget(app, { name: 'Temp', startMonth: '2026-01' });
      await request(app)
        .post(`/api/budgets/${temp.id}/archive`)
        .send({ endMonth: '2026-03' })
        .expect(200);
      await patch({ budgetId: temp.id }).expect(200);
      await patch({ date: '2026-03-31' }).expect(200);
      expectRuleViolation(await patch({ date: '2026-04-01' }), 'outside_active_months', 'date');
      expect((await page()).items[0]).toMatchObject({ date: '2026-03-31', budgetId: temp.id });
    });

    it('outside_active_months: moving to a budget whose range excludes the unchanged date', async () => {
      const later = await addBudget(app, { name: 'From April', startMonth: '2026-04' });
      expectRuleViolation(await patch({ budgetId: later.id }), 'outside_active_months', 'date');
      // ...unless the date moves along with it.
      const res = await patch({ budgetId: later.id, date: '2026-04-01' }).expect(200);
      expect(res.body).toMatchObject({ budgetId: later.id, date: '2026-04-01' });
    });

    it('does not re-check what the patch does not touch: the amount of a spending in an archived budget', async () => {
      await request(app)
        .post(`/api/budgets/${groceries.id}/archive`)
        .send({ endMonth: '2026-03' })
        .expect(200);
      await patch({ amount: 7 }).expect(200);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ''],
      ['a bad date', { date: '2026-10' }, 'date'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['a bad budgetId', { budgetId: -1 }, 'budgetId'],
      ['a null description', { description: null }, 'description'],
      ['an unknown key', { id: 5 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      expectValidationError(await patch(body), path);
    });

    it.each(['abc', '0', '-1', '2.5', '99999999999999999999999'])(
      'rejects the id %j',
      async (id) => {
        expectValidationError(
          await request(app).patch(`/api/spendings/${id}`).send({ amount: 5 }),
          'id',
        );
      },
    );
  });
});

describe('DELETE /api/spendings/:id', () => {
  it('removes the spending (204, no body) and its share of the totals', async () => {
    const keep = await addSpending(app, { budgetId: groceries.id, amount: 100 });
    const gone = await addSpending(app, { budgetId: groceries.id, amount: 900 });
    expect((await page()).totalAmount).toBe(1000);

    const res = await request(app).delete(`/api/spendings/${gone.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await page()).toMatchObject({ items: [keep], total: 1, totalAmount: 100 });
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const spending = await addSpending(app, { budgetId: groceries.id });
    expectNotFound(await request(app).delete('/api/spendings/99'));
    await request(app).delete(`/api/spendings/${spending.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/spendings/${spending.id}`));
  });

  it('rejects a bad id (400)', async () => {
    expectValidationError(await request(app).delete('/api/spendings/abc'), 'id');
  });
});
