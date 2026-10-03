import { type MonthSummary, type MonthView, addMonths } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  addSpending,
  addSubscription,
  expectApiError,
  expectNotFound,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { expectMonthIdentities, expectSummaryMatchesView } from '../../testing/month-identities';
import { createTestApp } from '../../testing/test-app';

/** An app that is onboarded from January 2026 with the clock on 15 March 2026. */
async function setUp(options: { startMonth?: string } = {}) {
  const clock = mutableClock('2026-03-15T10:00:00Z');
  const { app, db } = createTestApp(clock);
  await onboard(app, {
    startMonth: options.startMonth ?? '2026-01',
    salary: 300000,
    openingSavings: 0,
  });
  const get = (path: string) => request(app).get(path);
  return { app, db, clock, get };
}

describe('GET /api/months/:month', () => {
  it('returns the MonthView of the month, with exactly the documented fields', async () => {
    const { app, get } = await setUp();
    const groceries = await addBudget(app, {
      name: 'Groceries',
      amount: 40000,
      startMonth: '2026-01',
    });
    await addSubscription(app, { name: 'Netflix', amount: 1299, startMonth: '2026-01' });
    await addSpending(app, { budgetId: groceries.id, date: '2026-03-10', amount: 12000 });

    const res = await get('/api/months/2026-03').expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'budgets',
      'fixedCosts',
      'income',
      'month',
      'overAllocated',
      'savingsDue',
      'status',
      'subscriptions',
      'totals',
      'unallocated',
    ]);
    expect(res.body).toMatchObject({
      month: '2026-03',
      status: 'current',
      income: { salary: 300000, extra: 0, total: 300000 },
      fixedCosts: 1299,
      totals: { allocated: 40000, spent: 12000, remaining: 28000, transfersNet: 0 },
      unallocated: 300000 - 1299 - 40000,
      overAllocated: false,
    });
    expect(res.body.budgets).toHaveLength(1);
    expect(Object.keys(res.body.budgets[0]).sort()).toEqual([
      'alert',
      'allocated',
      'available',
      'carriedIn',
      'carriedOut',
      'color',
      'endsThisMonth',
      'icon',
      'id',
      'incremental',
      'name',
      'remaining',
      'spent',
      'toSavings',
      'transfersNet',
      'usagePercent',
      'warnPercent',
    ]);
    expect(Object.keys(res.body.subscriptions[0]).sort()).toEqual([
      'charge',
      'color',
      'endsThisMonth',
      'frequency',
      'id',
      'name',
      'nextRenewalMonth',
      'nextRenewalPrice',
      'price',
      'renewalThisMonth',
      'reserveBalance',
      'reserveReleased',
    ]);
    expectMonthIdentities(res.body as MonthView);
  });

  it('labels the months relative to the clock: closed, current, future', async () => {
    const { get } = await setUp();
    expect((await get('/api/months/2026-01').expect(200)).body.status).toBe('closed');
    expect((await get('/api/months/2026-02').expect(200)).body.status).toBe('closed');
    expect((await get('/api/months/2026-03').expect(200)).body.status).toBe('current');
    expect((await get('/api/months/2026-04').expect(200)).body.status).toBe('future');
    expect((await get('/api/months/2027-03').expect(200)).body.status).toBe('future');
  });

  it('an empty month has no lines and the salary left over, and a month before the salary has nothing', async () => {
    const { get } = await setUp();
    const march = (await get('/api/months/2026-03').expect(200)).body as MonthView;
    expect(march).toMatchObject({
      fixedCosts: 0,
      subscriptions: [],
      budgets: [],
      totals: { allocated: 0, spent: 0, remaining: 0, transfersNet: 0 },
      unallocated: 300000,
      savingsDue: { unallocated: 300000, budgetsSettled: 0, reservesReleased: 0, total: 300000 },
    });
  });

  it('is 404 before the start month and after the horizon (current month + 120)', async () => {
    const { clock, get } = await setUp();
    expectNotFound(await get('/api/months/2025-12'));
    await get('/api/months/2026-01').expect(200); // the start month itself
    await get('/api/months/2036-03').expect(200); // 120 months after March 2026
    const past = await get('/api/months/2036-04');
    expectNotFound(past);
    expect(past.body.error.message).toContain('2036-04');
    expect(past.body.error.message).toContain('2026-01'); // names the tracked range
    expect(past.body.error.message).toContain('2036-03');

    // The horizon moves with the clock.
    clock.set('2026-04-02T10:00:00Z');
    await get('/api/months/2036-04').expect(200);
    expectNotFound(await get('/api/months/2036-05'));
  });

  it('a start month moved earlier makes the earlier months exist', async () => {
    const { app, get } = await setUp();
    expectNotFound(await get('/api/months/2025-10'));
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2025-10',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    const october = (await get('/api/months/2025-10').expect(200)).body as MonthView;
    expect(october).toMatchObject({
      status: 'closed',
      income: { salary: 0, total: 0 },
      unallocated: 0,
    });
    // The salary started in January, so the months added before it have no income.
    expect((await get('/api/months/2026-01').expect(200)).body.income.salary).toBe(300000);
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-03', 'abc', '2026-03-01', '2026_03', '202603'])(
    'rejects the malformed month %s with 400',
    async (month) => {
      const { get } = await setUp();
      expectValidationError(await get(`/api/months/${month}`), 'month');
    },
  );

  it('is a plain 404 for a path that is not a month route', async () => {
    const { get } = await setUp();
    expectNotFound(await get('/api/months/2026-03/extra'));
  });

  it('answers 409 not_onboarded before the settings exist, ahead of validation', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    expectApiError(await request(app).get('/api/months/2026-03'), 'not_onboarded');
    expectApiError(await request(app).get('/api/months/garbage'), 'not_onboarded');
    expectApiError(await request(app).get('/api/months'), 'not_onboarded');
    expectApiError(await request(app).get('/api/months?from=nope'), 'not_onboarded');
  });

  it('is read-only and gives the same body every time', async () => {
    const { app, get } = await setUp();
    const budget = await addBudget(app, {
      amount: 10000,
      incremental: true,
      startMonth: '2026-01',
    });
    await addSpending(app, { budgetId: budget.id, date: '2026-02-03', amount: 2500 });
    const first = (await get('/api/months/2026-04').expect(200)).body;
    for (let i = 0; i < 3; i++)
      expect((await get('/api/months/2026-04').expect(200)).body).toEqual(first);
    // Reading the months stored nothing: the spendings are the only fact there is.
    expect((await get('/api/spendings').expect(200)).body.total).toBe(1);
  });
});

describe('GET /api/months', () => {
  const months = (body: MonthSummary[]) => body.map((row) => row.month);

  it('defaults to the start month through the current month + 11, ascending, with statuses', async () => {
    const { get } = await setUp();
    const rows = (await get('/api/months').expect(200)).body as MonthSummary[];
    expect(rows).toHaveLength(14); // 2026-01 to 2027-02
    expect(rows[0]?.month).toBe('2026-01');
    expect(rows.at(-1)?.month).toBe('2027-02');
    expect(months(rows)).toEqual([...months(rows)].sort());
    expect(rows.map((r) => r.status)).toEqual([
      'closed',
      'closed',
      'current',
      ...Array(11).fill('future'),
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'allocated',
      'fixedCosts',
      'income',
      'month',
      'savingsDue',
      'spent',
      'status',
      'unallocated',
    ]);
  });

  it("each row equals the same fields of that month's view", async () => {
    const { app, get } = await setUp();
    const budget = await addBudget(app, {
      amount: 20000,
      incremental: true,
      startMonth: '2026-01',
    });
    await addSubscription(app, {
      frequency: 'yearly',
      amount: 12000,
      anchorDate: '2025-09-01',
      startMonth: '2026-01',
    });
    await addSpending(app, { budgetId: budget.id, date: '2026-02-03', amount: 25000 });
    const rows = (await get('/api/months').expect(200)).body as MonthSummary[];
    for (const row of rows) {
      const view = (await get(`/api/months/${row.month}`).expect(200)).body as MonthView;
      expectSummaryMatchesView(row, view);
    }
  });

  it('starts at current + 11 - 119 when the start month is further back, so at most 120 months', async () => {
    const { get } = await setUp({ startMonth: '2010-01' });
    const rows = (await get('/api/months').expect(200)).body as MonthSummary[];
    expect(rows).toHaveLength(120);
    expect(rows[0]?.month).toBe('2017-03');
    expect(rows.at(-1)?.month).toBe('2027-02');
    // The carry from 2010 is still in the figures: the first row is a closed month of a long history.
    expect(rows[0]?.status).toBe('closed');
  });

  it('takes the figures of the whole history even when it lists only part of it', async () => {
    const { app, get } = await setUp();
    const budget = await addBudget(app, {
      amount: 10000,
      incremental: true,
      startMonth: '2026-01',
    });
    await addSpending(app, { budgetId: budget.id, date: '2026-01-05', amount: 4000 });
    const rows = (await get('/api/months?from=2026-02&to=2026-03').expect(200))
      .body as MonthSummary[];
    // January carries 60.00 and February 60.00 + 100.00 = 160.00 into March, though the list
    // starts in February: the carry comes from the whole history.
    expect(months(rows)).toEqual(['2026-02', '2026-03']);
    const march = (await get('/api/months/2026-03').expect(200)).body as MonthView;
    expect(march.budgets[0]?.carriedIn).toBe(16000);
  });

  it.each<[string, string, string[]]>([
    [
      'only from: up to the default end',
      '?from=2026-02',
      [...Array(13)].map((_u, i) => addMonths('2026-02', i)),
    ],
    [
      'only to: from the start month',
      '?to=2026-06',
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
    ],
    [
      'only from, before the start month: cut to the start month',
      '?from=2025-10',
      [...Array(14)].map((_u, i) => addMonths('2026-01', i)),
    ],
    ['both ends', '?from=2026-02&to=2026-04', ['2026-02', '2026-03', '2026-04']],
    ['a single month', '?from=2026-03&to=2026-03', ['2026-03']],
    [
      'from before the start month: cut to the start month',
      '?from=2025-10&to=2026-02',
      ['2026-01', '2026-02'],
    ],
    [
      'to after the horizon: cut to current + 120',
      '?from=2036-01&to=2036-12',
      ['2036-01', '2036-02', '2036-03'],
    ],
    ['entirely before the start month', '?from=2025-01&to=2025-06', []],
    ['just before the start month', '?from=2025-11&to=2025-12', []],
    ['entirely after the horizon', '?from=2037-01&to=2037-06', []],
    ['just after the horizon', '?from=2036-04&to=2036-12', []],
    ['to before the start month, from omitted', '?to=2025-12', []],
  ])('%s', async (_label, query, expected) => {
    const { get } = await setUp();
    const res = await get(`/api/months${query}`).expect(200);
    expect(months(res.body)).toEqual(expected);
  });

  it('allows exactly 120 months and no more', async () => {
    const { get } = await setUp();
    const widest = (await get('/api/months?from=2026-01&to=2035-12').expect(200))
      .body as MonthSummary[];
    expect(widest).toHaveLength(120);
    expectValidationError(await get('/api/months?from=2026-01&to=2036-01'), 'to'); // 121 months
    // The boundary also holds against the default end (2027-02): 2017-03 is 120 months, 2017-02 is 121.
    const { get: get2 } = await setUp({ startMonth: '2010-01' });
    expect(
      ((await get2('/api/months?from=2017-03').expect(200)).body as MonthSummary[]).length,
    ).toBe(120);
    expectValidationError(await get2('/api/months?from=2017-02'), 'from');
  });

  it.each<[string, string, string[]]>([
    ['from after to', '?from=2026-05&to=2026-04', ['to']],
    ['a malformed from', '?from=2026-13', ['from']],
    ['a malformed to', '?to=abc', ['to']],
    ['a date instead of a month', '?from=2026-03-01', ['from']],
    ['an unknown key', '?month=2026-03', ['']],
    ['a range wider than 120 months', '?from=2020-01&to=2030-01', ['to']],
    ['only from, after the default end (current + 11)', '?from=2030-01', ['from']],
    ['only from, more than 119 months before the default end', '?from=2010-01', ['from']],
    ['a repeated parameter', '?from=2026-01&from=2026-02', ['from']],
  ])('rejects %s with 400', async (_label, query, paths) => {
    const { get } = await setUp();
    expectValidationError(await get(`/api/months${query}`), ...paths);
  });

  it('shows the same ledger from any window: a month is the same alone and in a range', async () => {
    const { app, get } = await setUp();
    const budget = await addBudget(app, {
      amount: 10000,
      incremental: true,
      startMonth: '2026-01',
    });
    await addSpending(app, { budgetId: budget.id, date: '2026-01-05', amount: 14000 });
    const full = (await get('/api/months?from=2026-01&to=2026-12').expect(200))
      .body as MonthSummary[];
    const slice = (await get('/api/months?from=2026-04&to=2026-06').expect(200))
      .body as MonthSummary[];
    expect(slice).toEqual(full.slice(3, 6));
  });
});

describe('the current month comes from the clock, in the server time zone', () => {
  it('labels the months by the local calendar, not the UTC one', async () => {
    // 23:30 UTC on 31 March is already 1 April in Rome.
    const clock = mutableClock('2026-03-31T23:30:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-01' });
    const status = async (month: string) =>
      (await request(app).get(`/api/months/${month}`).expect(200)).body.status;

    expect(await status('2026-03')).toBe('current');
    expect(await status('2026-04')).toBe('future');
    await withTimeZone('Europe/Rome', async () => {
      expect(await status('2026-03')).toBe('closed');
      expect(await status('2026-04')).toBe('current');
      const rows = (await request(app).get('/api/months').expect(200)).body as MonthSummary[];
      expect(rows.at(-1)?.month).toBe('2027-03'); // current month (April) + 11
    });
  });
});

describe('catching up several months at once', () => {
  it('jumping the clock forward in one step gives the same figures as moving it month by month', async () => {
    const make = async () => {
      const clock = mutableClock('2026-01-10T10:00:00Z');
      const { app } = createTestApp(clock);
      await onboard(app, { startMonth: '2026-01', salary: 200000, openingSavings: 0 });
      const incremental = await addBudget(app, { name: 'Carry', amount: 10000, incremental: true });
      const settled = await addBudget(app, { name: 'Settle', amount: 20000, incremental: false });
      await addSubscription(app, {
        name: 'Yearly',
        frequency: 'yearly',
        amount: 12000,
        anchorDate: '2025-06-01',
      });
      await addSpending(app, { budgetId: incremental.id, date: '2026-01-20', amount: 4000 });
      await addSpending(app, { budgetId: settled.id, date: '2026-01-21', amount: 25000 });
      return { app, clock };
    };
    const noStatus = (rows: MonthSummary[]) => rows.map(({ status: _status, ...rest }) => rest);
    const read = async (app: ReturnType<typeof createTestApp>['app']) =>
      noStatus(
        (await request(app).get('/api/months?from=2026-01&to=2026-12').expect(200))
          .body as MonthSummary[],
      );

    const stepped = await make();
    for (const month of ['02', '03', '04', '05', '06']) {
      stepped.clock.set(`2026-${month}-15T10:00:00Z`);
      await request(stepped.app).get('/api/months').expect(200); // reading in between changes nothing
    }
    const jumped = await make();
    jumped.clock.set('2026-06-15T10:00:00Z');

    const untouched = await make(); // the clock never moved: still January
    expect(await read(jumped.app)).toEqual(await read(stepped.app));
    expect(await read(jumped.app)).toEqual(await read(untouched.app));
    // And running "it" twice gives the same result as running it once.
    expect(await read(jumped.app)).toEqual(await read(jumped.app));
    expect((await request(jumped.app).get('/api/months/2026-03').expect(200)).body).toEqual(
      (await request(stepped.app).get('/api/months/2026-03').expect(200)).body,
    );
  });
});
