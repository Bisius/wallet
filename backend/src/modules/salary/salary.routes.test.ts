import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../lib/clock';
import {
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
  await onboard(app, { startMonth: '2026-01', salary: 300000 });
});

describe('GET /api/salary', () => {
  it('returns the history, here just the onboarding salary', async () => {
    const res = await request(app).get('/api/salary').expect(200);
    expect(res.body).toEqual([{ effectiveMonth: '2026-01', amount: 300000 }]);
  });

  it('is ascending by effective month, whatever order the entries were made in', async () => {
    await request(app).put('/api/salary/2026-06').send({ amount: 330000 }).expect(200);
    await request(app).put('/api/salary/2026-04').send({ amount: 320000 }).expect(200);
    await request(app).put('/api/salary/2027-01').send({ amount: 350000 }).expect(200);
    const res = await request(app).get('/api/salary').expect(200);
    expect(res.body).toEqual([
      { effectiveMonth: '2026-01', amount: 300000 },
      { effectiveMonth: '2026-04', amount: 320000 },
      { effectiveMonth: '2026-06', amount: 330000 },
      { effectiveMonth: '2027-01', amount: 350000 },
    ]);
  });

  it('is empty when the app was onboarded through PUT /api/settings', async () => {
    const other = createTestApp(fixedClock('2026-03-15T10:00:00Z')).app;
    await request(other)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    expect((await request(other).get('/api/salary').expect(200)).body).toEqual([]);
  });
});

describe('PUT /api/salary/:month', () => {
  it('adds a salary change and answers 200 with the entry', async () => {
    const res = await request(app).put('/api/salary/2026-04').send({ amount: 320000 }).expect(200);
    expect(res.body).toEqual({ effectiveMonth: '2026-04', amount: 320000 });
    expect((await request(app).get('/api/salary')).body).toHaveLength(2);
  });

  it('replaces the entry of exactly that month instead of adding a second one', async () => {
    await request(app).put('/api/salary/2026-04').send({ amount: 320000 }).expect(200);
    await request(app).put('/api/salary/2026-04').send({ amount: 325000 }).expect(200);
    const res = await request(app).get('/api/salary');
    expect(res.body).toEqual([
      { effectiveMonth: '2026-01', amount: 300000 },
      { effectiveMonth: '2026-04', amount: 325000 },
    ]);
  });

  it('replaces the onboarding salary when given its month', async () => {
    await request(app).put('/api/salary/2026-01').send({ amount: 1 }).expect(200);
    expect((await request(app).get('/api/salary')).body).toEqual([
      { effectiveMonth: '2026-01', amount: 1 },
    ]);
  });

  it('accepts a zero salary (a month without pay)', async () => {
    const res = await request(app).put('/api/salary/2026-05').send({ amount: 0 }).expect(200);
    expect(res.body.amount).toBe(0);
  });

  it('accepts a month in the future', async () => {
    await request(app).put('/api/salary/2027-09').send({ amount: 400000 }).expect(200);
  });

  describe('before_start_month (422)', () => {
    it('refuses a month before settings.startMonth and stores nothing', async () => {
      const res = await request(app).put('/api/salary/2025-12').send({ amount: 100 });
      expectRuleViolation(res, 'before_start_month', 'month');
      expect((await request(app).get('/api/salary')).body).toHaveLength(1);
    });

    it('accepts startMonth itself (the boundary)', async () => {
      await request(app).put('/api/salary/2026-01').send({ amount: 100 }).expect(200);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['a month with 13', '2026-13'],
      ['a one-digit month', '2026-1'],
      ['a full date', '2026-03-01'],
      ['text', 'march'],
    ])('rejects %s in the path', async (_label, month) => {
      const res = await request(app).put(`/api/salary/${month}`).send({ amount: 100 });
      expectValidationError(res, 'month');
    });

    it.each([
      ['an empty body', {}, 'amount'],
      ['a negative amount', { amount: -1 }, 'amount'],
      ['a fractional amount', { amount: 1000.5 }, 'amount'],
      ['a string amount', { amount: '1000' }, 'amount'],
      ['a null amount', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: 1_000_000_000_001 }, 'amount'],
      ['an unknown key', { amount: 100, effectiveMonth: '2026-05' }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const res = await request(app).put('/api/salary/2026-05').send(body);
      expectValidationError(res, path);
      expect((await request(app).get('/api/salary')).body).toHaveLength(1);
    });

    it('rejects a missing body', async () => {
      expectValidationError(await request(app).put('/api/salary/2026-05'), '');
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .put('/api/salary/2026-05')
        .set('Content-Type', 'application/json')
        .send('{amount');
      expectApiError(res, 'invalid_json');
    });
  });
});

describe('DELETE /api/salary/:month', () => {
  it('removes exactly that entry (204, no body)', async () => {
    await request(app).put('/api/salary/2026-04').send({ amount: 320000 }).expect(200);
    const res = await request(app).delete('/api/salary/2026-04').expect(204);
    expect(res.text).toBe('');
    expect((await request(app).get('/api/salary')).body).toEqual([
      { effectiveMonth: '2026-01', amount: 300000 },
    ]);
  });

  it('can remove the first entry too: months without an entry have no salary', async () => {
    await request(app).delete('/api/salary/2026-01').expect(204);
    expect((await request(app).get('/api/salary')).body).toEqual([]);
  });

  it('is a 404 when no entry has exactly that month (an earlier entry does not count)', async () => {
    expectNotFound(await request(app).delete('/api/salary/2026-02'));
    expect((await request(app).get('/api/salary')).body).toHaveLength(1);
  });

  it('is a 404 the second time', async () => {
    await request(app).delete('/api/salary/2026-01').expect(204);
    expectNotFound(await request(app).delete('/api/salary/2026-01'));
  });

  it('rejects a bad month in the path (400)', async () => {
    expectValidationError(await request(app).delete('/api/salary/2026-13'), 'month');
  });
});
