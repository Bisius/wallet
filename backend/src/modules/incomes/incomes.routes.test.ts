import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../lib/clock';
import {
  addIncome,
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];

beforeEach(async () => {
  ({ app } = createTestApp(fixedClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01' });
});

describe('POST /api/incomes', () => {
  it('creates an income and answers 201 with the DTO', async () => {
    const res = await request(app)
      .post('/api/incomes')
      .send({ date: '2026-03-05', amount: 50000, description: 'Bonus' })
      .expect(201);
    expect(res.body).toEqual({ id: 1, date: '2026-03-05', amount: 50000, description: 'Bonus' });
  });

  it('trims the description', async () => {
    const res = await request(app)
      .post('/api/incomes')
      .send({ date: '2026-03-05', amount: 100, description: '  Tax refund ' })
      .expect(201);
    expect(res.body.description).toBe('Tax refund');
  });

  it('accepts a date in the future', async () => {
    await addIncome(app, { date: '2027-01-01' });
  });

  describe('before_start_month (422)', () => {
    it('refuses a date before settings.startMonth', async () => {
      const res = await request(app)
        .post('/api/incomes')
        .send({ date: '2025-12-31', amount: 100, description: 'Old' });
      expectRuleViolation(res, 'before_start_month', 'date');
      expect((await request(app).get('/api/incomes')).body).toEqual([]);
    });

    it('accepts the first day of the start month (the boundary)', async () => {
      await addIncome(app, { date: '2026-01-01' });
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, 'date'],
      ['a missing date', { amount: 100, description: 'x' }, 'date'],
      ['a bad date', { date: '2026-02-30', amount: 100, description: 'x' }, 'date'],
      ['a month instead of a date', { date: '2026-03', amount: 100, description: 'x' }, 'date'],
      ['a zero amount', { date: '2026-03-05', amount: 0, description: 'x' }, 'amount'],
      ['a negative amount', { date: '2026-03-05', amount: -5, description: 'x' }, 'amount'],
      ['a fractional amount', { date: '2026-03-05', amount: 1.5, description: 'x' }, 'amount'],
      ['a missing description', { date: '2026-03-05', amount: 100 }, 'description'],
      [
        'a blank description',
        { date: '2026-03-05', amount: 100, description: '  ' },
        'description',
      ],
      ['an unknown key', { date: '2026-03-05', amount: 100, description: 'x', id: 4 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const res = await request(app).post('/api/incomes').send(body);
      expectValidationError(res, path);
      expect((await request(app).get('/api/incomes')).body).toEqual([]);
    });
  });
});

describe('GET /api/incomes', () => {
  it('is an empty list when there are none', async () => {
    expect((await request(app).get('/api/incomes').expect(200)).body).toEqual([]);
  });

  it('is newest first: date descending, then id descending', async () => {
    const a = await addIncome(app, { date: '2026-02-10', description: 'a' });
    const b = await addIncome(app, { date: '2026-03-01', description: 'b' });
    const c = await addIncome(app, { date: '2026-02-10', description: 'c' });
    const d = await addIncome(app, { date: '2026-01-31', description: 'd' });
    const res = await request(app).get('/api/incomes').expect(200);
    expect(res.body.map((i: { id: number }) => i.id)).toEqual([b.id, c.id, a.id, d.id]);
  });

  it('filters by month, first and last day included', async () => {
    await addIncome(app, { date: '2026-01-31', description: 'jan' });
    await addIncome(app, { date: '2026-02-01', description: 'feb first' });
    await addIncome(app, { date: '2026-02-28', description: 'feb last' });
    await addIncome(app, { date: '2026-03-01', description: 'mar' });
    const res = await request(app).get('/api/incomes?month=2026-02').expect(200);
    expect(res.body.map((i: { description: string }) => i.description)).toEqual([
      'feb last',
      'feb first',
    ]);
  });

  it('filters by a month that ends on the 30th or the 31st', async () => {
    await addIncome(app, { date: '2026-03-31', description: 'mar last', amount: 1 });
    await addIncome(app, { date: '2026-04-01', description: 'apr first', amount: 2 });
    await addIncome(app, { date: '2026-04-30', description: 'apr last', amount: 4 });
    await addIncome(app, { date: '2026-05-01', description: 'may first', amount: 8 });
    const names = async (month: string) =>
      (
        (await request(app).get(`/api/incomes?month=${month}`).expect(200)).body as {
          description: string;
        }[]
      ).map((i) => i.description);
    expect(await names('2026-03')).toEqual(['mar last']);
    expect(await names('2026-04')).toEqual(['apr last', 'apr first']);
  });

  it('filters by a leap February', async () => {
    const other = createTestApp(fixedClock('2028-03-15T10:00:00Z')).app;
    await onboard(other, { startMonth: '2028-01' });
    await addIncome(other, { date: '2028-02-29', description: 'leap day' });
    await addIncome(other, { date: '2028-03-01', description: 'march' });
    const res = await request(other).get('/api/incomes?month=2028-02').expect(200);
    expect(res.body.map((i: { description: string }) => i.description)).toEqual(['leap day']);
  });

  it('returns an empty list for a month without income', async () => {
    await addIncome(app, { date: '2026-02-01' });
    expect((await request(app).get('/api/incomes?month=2026-05').expect(200)).body).toEqual([]);
  });

  it.each([
    ['a bad month', '?month=2026-13', 'month'],
    ['a date as month', '?month=2026-02-01', 'month'],
    ['an empty month', '?month=', 'month'],
    ['an unknown filter', '?year=2026', ''],
    ['a repeated month', '?month=2026-02&month=2026-03', 'month'],
  ])('rejects %s (400)', async (_label, query, path) => {
    expectValidationError(await request(app).get(`/api/incomes${query}`), path);
  });
});

describe('PATCH /api/incomes/:id', () => {
  it('changes one field and leaves the rest', async () => {
    const income = await addIncome(app, {
      date: '2026-03-05',
      amount: 50000,
      description: 'Bonus',
    });
    const res = await request(app)
      .patch(`/api/incomes/${income.id}`)
      .send({ amount: 60000 })
      .expect(200);
    expect(res.body).toEqual({ ...income, amount: 60000 });
    expect((await request(app).get('/api/incomes')).body).toEqual([res.body]);
  });

  it('changes every field at once', async () => {
    const income = await addIncome(app);
    const body = { date: '2026-02-20', amount: 1, description: 'Gift' };
    const res = await request(app).patch(`/api/incomes/${income.id}`).send(body).expect(200);
    expect(res.body).toEqual({ id: income.id, ...body });
  });

  it('can move the income into another month', async () => {
    const income = await addIncome(app, { date: '2026-03-05' });
    await request(app).patch(`/api/incomes/${income.id}`).send({ date: '2026-02-05' }).expect(200);
    expect((await request(app).get('/api/incomes?month=2026-03')).body).toEqual([]);
    expect((await request(app).get('/api/incomes?month=2026-02')).body).toHaveLength(1);
  });

  it('is a 404 for an unknown id', async () => {
    expectNotFound(await request(app).patch('/api/incomes/99').send({ amount: 5 }));
  });

  it('refuses a date before settings.startMonth (422) and changes nothing', async () => {
    const income = await addIncome(app, { date: '2026-03-05' });
    const res = await request(app).patch(`/api/incomes/${income.id}`).send({ date: '2025-12-31' });
    expectRuleViolation(res, 'before_start_month', 'date');
    expect((await request(app).get('/api/incomes')).body).toEqual([income]);
  });

  it('accepts the first day of the start month (the boundary)', async () => {
    const income = await addIncome(app, { date: '2026-03-05' });
    await request(app).patch(`/api/incomes/${income.id}`).send({ date: '2026-01-01' }).expect(200);
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ''],
      ['a bad date', { date: 'tomorrow' }, 'date'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['an empty description', { description: '' }, 'description'],
      ['a null description', { description: null }, 'description'],
      ['an unknown key', { id: 9 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const income = await addIncome(app);
      expectValidationError(await request(app).patch(`/api/incomes/${income.id}`).send(body), path);
    });

    it.each(['abc', '0', '-1', '1.5', '99999999999999999999999'])(
      'rejects the id %j',
      async (id) => {
        expectValidationError(
          await request(app).patch(`/api/incomes/${id}`).send({ amount: 5 }),
          'id',
        );
      },
    );

    it('checks the body before looking the income up', async () => {
      expectValidationError(await request(app).patch('/api/incomes/99').send({}), '');
    });
  });
});

describe('DELETE /api/incomes/:id', () => {
  it('removes the income (204, no body)', async () => {
    const income = await addIncome(app);
    const res = await request(app).delete(`/api/incomes/${income.id}`).expect(204);
    expect(res.text).toBe('');
    expect((await request(app).get('/api/incomes')).body).toEqual([]);
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const income = await addIncome(app);
    expectNotFound(await request(app).delete('/api/incomes/99'));
    await request(app).delete(`/api/incomes/${income.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/incomes/${income.id}`));
  });

  it('rejects a bad id (400)', async () => {
    expectValidationError(await request(app).delete('/api/incomes/abc'), 'id');
  });
});

it('answers every other error with the ApiError shape', async () => {
  expectApiError(await request(app).get('/api/incomes/1'), 'not_found');
});
