import type { YearlyReportDto } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  expectApiError,
  expectNotFound,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { expectReportMatchesMonthViews } from '../../testing/report-helpers';
import { createTestApp } from '../../testing/test-app';

async function setUp(options: { startMonth?: string; now?: string } = {}) {
  const clock = mutableClock(options.now ?? '2026-03-15T10:00:00Z');
  const { app, db } = createTestApp(clock);
  await onboard(app, {
    startMonth: options.startMonth ?? '2026-01',
    salary: 300000,
    openingSavings: 0,
  });
  const report = async (year: number | string) =>
    (await request(app).get(`/api/reports/yearly/${year}`).expect(200)).body as YearlyReportDto;
  return { app, db, clock, report };
}

describe('GET /api/reports/yearly/:year', () => {
  it('returns a YearlyReportDto with exactly the documented fields', async () => {
    const { app, report } = await setUp();
    const groceries = await addBudget(app, {
      name: 'Groceries',
      amount: 40000,
      startMonth: '2026-01',
    });
    await addSubscription(app, { name: 'Netflix', amount: 1299, startMonth: '2026-01' });
    await addSpending(app, { budgetId: groceries.id, date: '2026-03-10', amount: 12000 });

    const res = await request(app).get('/api/reports/yearly/2026').expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'allocated',
      'budgets',
      'firstMonth',
      'fixedCosts',
      'income',
      'lastMonth',
      'months',
      'saved',
      'savedBreakdown',
      'spent',
      'unallocated',
      'year',
    ]);
    expect(Object.keys(res.body.months[0]).sort()).toEqual([
      'allocated',
      'fixedCosts',
      'income',
      'month',
      'saved',
      'savedBreakdown',
      'spent',
      'status',
      'unallocated',
    ]);
    expect(Object.keys(res.body.fixedCosts).sort()).toEqual(['paid', 'subscriptions', 'total']);
    expect(Object.keys(res.body.fixedCosts.subscriptions[0]).sort()).toEqual([
      'color',
      'cost',
      'frequency',
      'id',
      'name',
      'paid',
    ]);
    expect(Object.keys(res.body.budgets[0]).sort()).toEqual([
      'allocated',
      'color',
      'icon',
      'id',
      'name',
      'spent',
    ]);
    const body = res.body as YearlyReportDto;
    expect(body.months).toHaveLength(12);
    expect(body.spent).toBe(12000);
    expect(body.budgets).toEqual([
      {
        id: groceries.id,
        name: 'Groceries',
        color: null,
        icon: null,
        allocated: 480000,
        spent: 12000,
      },
    ]);
    // March: 300000 - 1299 - 40000 = 258701 unallocated, and 28000 of Groceries is left to settle.
    expect(body.months[2]).toMatchObject({
      month: '2026-03',
      status: 'current',
      fixedCosts: 1299,
      spent: 12000,
      unallocated: 258701,
      saved: 286701,
    });
    await expectReportMatchesMonthViews(app, body);
  });

  it('is an empty report of zeros for a year of an empty ledger apart from the salary', async () => {
    const { report } = await setUp();
    const result = await report(2026);
    expect(result.budgets).toEqual([]);
    expect(result.fixedCosts).toEqual({ total: 0, paid: 0, subscriptions: [] });
    expect(result).toMatchObject({
      income: { salary: 3600000, extra: 0, total: 3600000 },
      allocated: 0,
      spent: 0,
      unallocated: 3600000,
      saved: 3600000,
      savedBreakdown: { unallocated: 3600000, budgetsSettled: 0, reservesReleased: 0 },
    });
  });

  it('counts the extra income of the year', async () => {
    const { app, report } = await setUp();
    await addIncome(app, { date: '2026-02-10', amount: 25000 });
    await addIncome(app, { date: '2027-02-10', amount: 7000 });
    expect((await report(2026)).income).toEqual({ salary: 3600000, extra: 25000, total: 3625000 });
    expect((await report(2027)).income).toEqual({ salary: 3600000, extra: 7000, total: 3607000 });
  });

  it('includes budgets and subscriptions that are active in the year only, and not others', async () => {
    const { app, report } = await setUp();
    await addBudget(app, { name: 'Always', amount: 1000, startMonth: '2026-01' });
    const old = await addBudget(app, { name: 'Ended', amount: 2000, startMonth: '2026-01' });
    await request(app)
      .post(`/api/budgets/${old.id}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    await addBudget(app, { name: 'Later', amount: 3000, startMonth: '2027-02' });
    const gone = await addSubscription(app, { name: 'Gone', startMonth: '2026-01' });
    await request(app)
      .post(`/api/subscriptions/${gone.id}/cancel`)
      .send({ endMonth: '2026-06' })
      .expect(200);

    const y2026 = await report(2026);
    expect(y2026.budgets.map((b) => [b.name, b.allocated])).toEqual([
      ['Always', 12000],
      ['Ended', 4000], // January and February
    ]);
    expect(y2026.fixedCosts.subscriptions.map((s) => [s.name, s.cost])).toEqual([
      ['Gone', 6 * 1299],
    ]);
    const y2027 = await report(2027);
    expect(y2027.budgets.map((b) => [b.name, b.allocated])).toEqual([
      ['Always', 12000],
      ['Later', 33000], // February to December
    ]);
    expect(y2027.fixedCosts).toEqual({ total: 0, paid: 0, subscriptions: [] });
  });

  it('keeps a budget that is active but has no spending, with a spent of 0', async () => {
    const { app, report } = await setUp();
    await addBudget(app, { name: 'Quiet', amount: 5000, startMonth: '2026-01' });
    expect((await report(2026)).budgets).toEqual([
      { id: 1, name: 'Quiet', color: null, icon: null, allocated: 60000, spent: 0 },
    ]);
  });

  it('lists budgets by sortOrder, then id, and subscriptions by name ignoring case, then id', async () => {
    const { app, report } = await setUp();
    await addBudget(app, { name: 'B1', sortOrder: 2, startMonth: '2026-01' });
    await addBudget(app, { name: 'B2', sortOrder: 1, startMonth: '2026-06' });
    await addBudget(app, { name: 'B3', sortOrder: 1, startMonth: '2026-01' });
    await addSubscription(app, { name: 'zeta', startMonth: '2026-01' });
    await addSubscription(app, { name: 'Alpha', startMonth: '2026-01' });
    await addSubscription(app, { name: 'alpha', startMonth: '2026-01' });
    const result = await report(2026);
    expect(result.budgets.map((b) => b.name)).toEqual(['B2', 'B3', 'B1']);
    expect(result.fixedCosts.subscriptions.map((s) => [s.name, s.id])).toEqual([
      ['Alpha', 2],
      ['alpha', 3],
      ['zeta', 1],
    ]);
  });

  describe('which months are included', () => {
    it('starts at the start month when it is in the year, and not before', async () => {
      const { report } = await setUp({ startMonth: '2026-07', now: '2026-09-15T10:00:00Z' });
      const result = await report(2026);
      expect(result).toMatchObject({ firstMonth: '2026-07', lastMonth: '2026-12' });
      expect(result.months.map((m) => m.month)).toEqual([
        '2026-07',
        '2026-08',
        '2026-09',
        '2026-10',
        '2026-11',
        '2026-12',
      ]);
      // The salary of the six months that exist; the first six months are not counted as zeros.
      expect(result.income.total).toBe(6 * 300000);
    });

    it('includes the start month alone when it is December', async () => {
      const { report } = await setUp({ startMonth: '2025-12', now: '2025-12-20T10:00:00Z' });
      const result = await report(2025);
      expect(result.months.map((m) => [m.month, m.status])).toEqual([['2025-12', 'current']]);
      expect(result.firstMonth).toBe('2025-12');
      expect(result.lastMonth).toBe('2025-12');
    });

    it('labels closed, current and future months', async () => {
      const { report } = await setUp();
      const statuses = (await report(2026)).months.map((m) => m.status);
      expect(statuses).toEqual(['closed', 'closed', 'current', ...Array(9).fill('future')]);
    });

    it('answers 404 for a year before the start month or one with no tracked month', async () => {
      const { app } = await setUp({ startMonth: '2026-07', now: '2026-09-15T10:00:00Z' });
      expectNotFound(await request(app).get('/api/reports/yearly/2025'));
      expectNotFound(await request(app).get('/api/reports/yearly/1999'));
      expectNotFound(await request(app).get('/api/reports/yearly/0001'));
    });

    it('stops at the horizon: the current month + 120', async () => {
      const { app, report } = await setUp(); // now 2026-03, horizon 2036-03
      const last = await report(2036);
      expect(last).toMatchObject({ firstMonth: '2036-01', lastMonth: '2036-03' });
      expect(last.months).toHaveLength(3);
      expect(last.months.every((m) => m.status === 'future')).toBe(true);
      expectNotFound(await request(app).get('/api/reports/yearly/2037'));
      expectNotFound(await request(app).get('/api/reports/yearly/9999'));
      // The year before it is complete.
      expect((await report(2035)).months).toHaveLength(12);
    });

    it('follows the server clock: a later date includes later months', async () => {
      const { app, clock, report } = await setUp();
      expectNotFound(await request(app).get('/api/reports/yearly/2037'));
      clock.set('2026-04-01T10:00:00Z'); // horizon 2036-04, still not 2037
      expectNotFound(await request(app).get('/api/reports/yearly/2037'));
      clock.set('2027-01-01T10:00:00Z'); // horizon 2037-01
      const result = await report(2037);
      expect(result.months.map((m) => m.month)).toEqual(['2037-01']);
    });

    it('uses the server time zone for the current month', async () => {
      const { report, clock } = await setUp({ startMonth: '2026-01' });
      clock.set('2026-03-31T23:30:00Z');
      const utc = (await report(2026)).months.map((m) => m.status);
      expect(utc[2]).toBe('current');
      const rome = await withTimeZone('Europe/Rome', () => report(2026));
      expect(rome.months.map((m) => m.status).slice(2, 4)).toEqual(['closed', 'current']);
    });
  });

  it('equals the sum of the month views, for a closed year, a mixed one and a projected one', async () => {
    const { app, clock, report } = await setUp({
      startMonth: '2025-06',
      now: '2026-03-15T10:00:00Z',
    });
    const food = await addBudget(app, {
      name: 'Food',
      amount: 30000,
      incremental: true,
      startMonth: '2025-06',
    });
    const fun = await addBudget(app, { name: 'Fun', amount: 9000, startMonth: '2025-09' });
    await addSubscription(app, { name: 'Netflix', amount: 1299, startMonth: '2025-06' });
    await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2025-11-02',
      amount: 9999, // does not divide by the months: the ceiling makes the first months higher
      startMonth: '2025-06',
    });
    await addIncome(app, { date: '2025-12-24', amount: 100000, description: 'Gift' });
    await addSpending(app, { budgetId: food.id, date: '2025-07-03', amount: 41234 });
    await addSpending(app, { budgetId: fun.id, date: '2025-10-03', amount: 9500 });
    await addSpending(app, { budgetId: fun.id, date: '2026-02-03', amount: -700 }); // a refund

    for (const now of ['2026-03-15T10:00:00Z', '2026-12-31T22:00:00Z', '2025-09-01T08:00:00Z']) {
      clock.set(now);
      for (const year of [2025, 2026, 2027]) {
        const result = await report(year);
        await expectReportMatchesMonthViews(app, result);
      }
    }
    // The first year starts in June: seven months.
    expect((await report(2025)).months).toHaveLength(7);
  });

  describe('validation', () => {
    it.each([
      ['26', 'two digits'],
      ['02026', 'five digits'],
      ['0000', 'year zero'],
      ['2026.5', 'a fraction'],
      ['+2026', 'a sign'],
      ['-2026', 'a negative year'],
      ['2026-10', 'a month'],
      ['abc', 'text'],
      ['1e3', 'an exponent'],
    ])('rejects %s (%s) with a 400 at year', async (value) => {
      const { app } = await setUp();
      expectValidationError(await request(app).get(`/api/reports/yearly/${value}`), 'year');
    });

    it('answers 400 before 404: a malformed year is not "not found"', async () => {
      const { app } = await setUp();
      expectValidationError(await request(app).get('/api/reports/yearly/0000'), 'year');
      expectNotFound(await request(app).get('/api/reports/yearly/0001'));
    });
  });

  describe('routing', () => {
    it('answers 404 for the paths and methods around it', async () => {
      const { app } = await setUp();
      expectNotFound(await request(app).get('/api/reports'));
      expectNotFound(await request(app).get('/api/reports/yearly'));
      expectNotFound(await request(app).get('/api/reports/monthly/2026'));
      expectNotFound(await request(app).get('/api/reports/yearly/2026/extra'));
      expectNotFound(await request(app).post('/api/reports/yearly/2026'));
      expectNotFound(await request(app).delete('/api/reports/yearly/2026'));
    });

    it('answers 409 not_onboarded before the settings exist, ahead of validation', async () => {
      const bare = createDb(':memory:');
      runMigrations(bare);
      const fresh = createApp({
        db: bare,
        clock: mutableClock('2026-03-15T10:00:00Z'),
        config: { env: 'test', staticDir: undefined },
      });
      expectApiError(await request(fresh).get('/api/reports/yearly/2026'), 'not_onboarded');
      expectApiError(await request(fresh).get('/api/reports/yearly/abc'), 'not_onboarded');
    });
  });
});
