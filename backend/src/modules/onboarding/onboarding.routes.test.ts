import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import {
  budgetVersions,
  budgets,
  salaryChanges,
  savingsTransactions,
  settings,
} from '../../db/schema';
import { fixedClock } from '../../lib/clock';
import {
  ONBOARDING,
  expectApiError,
  expectRuleViolation,
  expectValidationError,
  withTimeZone,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;

beforeEach(() => {
  ({ app, db } = createTestApp(fixedClock('2026-03-15T10:00:00Z')));
});

/** Row counts of every table onboarding writes to. */
function stored() {
  return {
    settings: db.select().from(settings).all().length,
    salary: db.select().from(salaryChanges).all().length,
    savings: db.select().from(savingsTransactions).all().length,
    budgets: db.select().from(budgets).all().length,
    versions: db.select().from(budgetVersions).all().length,
  };
}
const NOTHING = { settings: 0, salary: 0, savings: 0, budgets: 0, versions: 0 };

describe('POST /api/onboarding', () => {
  it('stores everything and returns what it stored (201)', async () => {
    const res = await request(app)
      .post('/api/onboarding')
      .send({
        currency: 'EUR',
        locale: 'it-IT',
        startMonth: '2026-01',
        theme: 'dark',
        alertWarnPercent: 90,
        salary: 250000,
        openingSavings: 123456,
        budgets: [
          { name: 'Groceries', amount: 40000, incremental: false },
          { name: 'Holidays', amount: 15000, incremental: true },
        ],
      })
      .expect(201);

    expect(res.body).toEqual({
      settings: {
        currency: 'EUR',
        locale: 'it-IT',
        startMonth: '2026-01',
        theme: 'dark',
        alertWarnPercent: 90,
      },
      salary: { effectiveMonth: '2026-01', amount: 250000 },
      openingSavings: 123456,
      budgets: [
        {
          id: 1,
          name: 'Groceries',
          color: null,
          icon: null,
          sortOrder: 0,
          startMonth: '2026-01',
          endMonth: null,
          alertWarnPercent: null,
          notes: null,
          versions: [{ effectiveMonth: '2026-01', amount: 40000, incremental: false }],
          current: { effectiveMonth: '2026-01', amount: 40000, incremental: false },
          hasHistory: false,
          status: 'active',
        },
        {
          id: 2,
          name: 'Holidays',
          color: null,
          icon: null,
          sortOrder: 10,
          startMonth: '2026-01',
          endMonth: null,
          alertWarnPercent: null,
          notes: null,
          versions: [{ effectiveMonth: '2026-01', amount: 15000, incremental: true }],
          current: { effectiveMonth: '2026-01', amount: 15000, incremental: true },
          hasHistory: false,
          status: 'active',
        },
      ],
    });
  });

  it('is exactly what the other endpoints then read back', async () => {
    const created = (
      await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          budgets: [{ name: 'Groceries', amount: 40000, incremental: false }],
        })
    ).body;

    expect((await request(app).get('/api/settings')).body).toEqual(created.settings);
    expect((await request(app).get('/api/salary')).body).toEqual([created.salary]);
    expect((await request(app).get('/api/budgets')).body).toEqual(created.budgets);
  });

  it('stores the first salary, the opening savings and the budget versions in the database', async () => {
    await request(app)
      .post('/api/onboarding')
      .send({
        ...ONBOARDING,
        startMonth: '2026-02',
        salary: 250000,
        openingSavings: 123456,
        budgets: [{ name: 'Groceries', amount: 40000, incremental: true }],
      })
      .expect(201);

    expect(db.select().from(salaryChanges).all()).toMatchObject([
      { effectiveMonth: '2026-02', amount: 250000 },
    ]);
    expect(db.select().from(savingsTransactions).all()).toMatchObject([
      {
        kind: 'opening',
        amount: 123456,
        date: '2026-02-01',
        goalId: null,
        settlesMonth: null,
      },
    ]);
    expect(db.select().from(budgets).all()).toMatchObject([
      { name: 'Groceries', startMonth: '2026-02', endMonth: null, sortOrder: 0 },
    ]);
    expect(db.select().from(budgetVersions).all()).toMatchObject([
      { budgetId: 1, effectiveMonth: '2026-02', amount: 40000, incremental: true },
    ]);
  });

  it('applies the documented defaults: theme "system", 80% and no budgets', async () => {
    const res = await request(app).post('/api/onboarding').send(ONBOARDING).expect(201);
    expect(res.body.settings).toEqual({
      currency: 'EUR',
      locale: 'en-US',
      startMonth: '2026-01',
      theme: 'system',
      alertWarnPercent: 80,
    });
    expect(res.body.budgets).toEqual([]);
    expect(res.body.openingSavings).toBe(50000);
  });

  it('accepts a zero salary and a zero opening balance, and still stores both rows', async () => {
    const res = await request(app)
      .post('/api/onboarding')
      .send({ ...ONBOARDING, salary: 0, openingSavings: 0 })
      .expect(201);
    expect(res.body.salary).toEqual({ effectiveMonth: '2026-01', amount: 0 });
    expect(stored()).toMatchObject({ salary: 1, savings: 1 });
  });

  it('accepts the current month and a month in the past as the start month', async () => {
    await request(app)
      .post('/api/onboarding')
      .send({ ...ONBOARDING, startMonth: '2026-03' })
      .expect(201);
    const other = createTestApp(fixedClock('2026-03-15T10:00:00Z')).app;
    await request(other)
      .post('/api/onboarding')
      .send({ ...ONBOARDING, startMonth: '2019-12' })
      .expect(201);
  });

  it('keeps budget order in sortOrder, in steps of 10', async () => {
    const budgetsIn = ['A', 'B', 'C'].map((name) => ({ name, amount: 100, incremental: false }));
    const res = await request(app)
      .post('/api/onboarding')
      .send({ ...ONBOARDING, budgets: budgetsIn })
      .expect(201);
    expect(
      res.body.budgets.map((b: { name: string; sortOrder: number }) => [b.name, b.sortOrder]),
    ).toEqual([
      ['A', 0],
      ['B', 10],
      ['C', 20],
    ]);
  });

  it('uses the largest request it accepts (50 budgets)', async () => {
    const many = Array.from({ length: 50 }, (_unused, i) => ({
      name: `Budget ${i}`,
      amount: i,
      incremental: i % 2 === 0,
    }));
    const res = await request(app)
      .post('/api/onboarding')
      .send({ ...ONBOARDING, budgets: many })
      .expect(201);
    expect(res.body.budgets).toHaveLength(50);
    expect(stored()).toMatchObject({ budgets: 50, versions: 50 });
  });

  describe('validation (400): nothing is stored', () => {
    it.each([
      ['an empty body', {}, 'currency'],
      ['a bad currency', { ...ONBOARDING, currency: 'euro' }, 'currency'],
      ['a bad locale', { ...ONBOARDING, locale: 'en_US' }, 'locale'],
      ['a missing start month', { ...ONBOARDING, startMonth: undefined }, 'startMonth'],
      ['a bad start month', { ...ONBOARDING, startMonth: '2026-1' }, 'startMonth'],
      ['a missing salary', { ...ONBOARDING, salary: undefined }, 'salary'],
      ['a negative salary', { ...ONBOARDING, salary: -1 }, 'salary'],
      ['a fractional salary', { ...ONBOARDING, salary: 2500.5 }, 'salary'],
      ['a missing opening balance', { ...ONBOARDING, openingSavings: undefined }, 'openingSavings'],
      ['a negative opening balance', { ...ONBOARDING, openingSavings: -5 }, 'openingSavings'],
      ['a bad theme', { ...ONBOARDING, theme: 'neon' }, 'theme'],
      ['a bad alert percent', { ...ONBOARDING, alertWarnPercent: 0 }, 'alertWarnPercent'],
      ['budgets that is not a list', { ...ONBOARDING, budgets: {} }, 'budgets'],
      [
        'a budget with a negative amount',
        {
          ...ONBOARDING,
          budgets: [
            { name: 'Ok', amount: 1, incremental: false },
            { name: 'Bad', amount: -1, incremental: false },
          ],
        },
        'budgets.1.amount',
      ],
      [
        'a budget without a name',
        { ...ONBOARDING, budgets: [{ name: ' ', amount: 1, incremental: false }] },
        'budgets.0.name',
      ],
      [
        'a budget without incremental',
        { ...ONBOARDING, budgets: [{ name: 'x', amount: 1 }] },
        'budgets.0.incremental',
      ],
      ['an unknown key', { ...ONBOARDING, extra: true }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const res = await request(app).post('/api/onboarding').send(body);
      expectValidationError(res, path);
      expect(stored()).toEqual(NOTHING);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .post('/api/onboarding')
        .set('Content-Type', 'application/json')
        .send('not json');
      expectApiError(res, 'invalid_json');
      expect(stored()).toEqual(NOTHING);
    });

    it('rejects a request without a body', async () => {
      expectValidationError(await request(app).post('/api/onboarding'), '');
    });
  });

  describe('already_onboarded (409)', () => {
    it('refuses a second onboarding and changes nothing', async () => {
      await request(app)
        .post('/api/onboarding')
        .send({ ...ONBOARDING, budgets: [{ name: 'Groceries', amount: 100, incremental: false }] })
        .expect(201);
      const before = stored();

      const res = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          currency: 'USD',
          salary: 1,
          budgets: [{ name: 'Other', amount: 1, incremental: true }],
        });
      expectApiError(res, 'already_onboarded');
      expect(stored()).toEqual(before);
      expect((await request(app).get('/api/settings')).body.currency).toBe('EUR');
    });

    it('is raised before the start-month rule', async () => {
      await request(app).post('/api/onboarding').send(ONBOARDING).expect(201);
      const res = await request(app)
        .post('/api/onboarding')
        .send({ ...ONBOARDING, startMonth: '2030-01' });
      expectApiError(res, 'already_onboarded');
    });
  });

  describe('start_month_in_future (422)', () => {
    it('refuses a start month after the current month and stores nothing', async () => {
      const res = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          startMonth: '2026-04',
          budgets: [{ name: 'Groceries', amount: 100, incremental: false }],
        });
      expectRuleViolation(res, 'start_month_in_future', 'startMonth');
      expect(stored()).toEqual(NOTHING);
      expectApiError(await request(app).get('/api/settings'), 'not_found');
    });

    it('judges the month in the server time zone', async () => {
      const late = createTestApp(fixedClock('2026-03-31T23:30:00Z'));
      const body = { ...ONBOARDING, startMonth: '2026-04' };
      expectRuleViolation(
        await request(late.app).post('/api/onboarding').send(body),
        'start_month_in_future',
        'startMonth',
      );
      await withTimeZone('Europe/Rome', () =>
        request(late.app).post('/api/onboarding').send(body).expect(201),
      );
    });
  });

  describe('start_month_too_old (422)', () => {
    // Today is 2026-03-15, so 240 months back (MAX_START_MONTH_AGE_MONTHS, 20 years) is 2006-03.
    it('refuses a start month more than 240 months before the current month and stores nothing', async () => {
      const res = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          startMonth: '2006-02',
          budgets: [{ name: 'Groceries', amount: 100, incremental: false }],
        });
      expectRuleViolation(res, 'start_month_too_old', 'startMonth');
      expect(stored()).toEqual(NOTHING);
      expectApiError(await request(app).get('/api/settings'), 'not_found');
    });

    it.each(['1999-12', '1900-01', '0001-01'])(
      'refuses the start month %s, however far back',
      async (startMonth) => {
        const res = await request(app)
          .post('/api/onboarding')
          .send({ ...ONBOARDING, startMonth });
        expectRuleViolation(res, 'start_month_too_old', 'startMonth');
        expect(stored()).toEqual(NOTHING);
      },
    );

    it('accepts a start month exactly 240 months before the current month', async () => {
      const res = await request(app)
        .post('/api/onboarding')
        .send({ ...ONBOARDING, startMonth: '2006-03' })
        .expect(201);
      expect(res.body.settings.startMonth).toBe('2006-03');
      expect(stored()).toMatchObject({ settings: 1, salary: 1, savings: 1 });
    });

    it('judges the age in the server time zone, like the current month', async () => {
      // On 2026-03-31 at 23:30 UTC it is still March in UTC (2006-03 is 240 months back), but already
      // April in Rome (UTC+2), where 2006-03 is 241 months back.
      const late = createTestApp(fixedClock('2026-03-31T23:30:00Z'));
      const body = { ...ONBOARDING, startMonth: '2006-03' };
      expectRuleViolation(
        await withTimeZone('Europe/Rome', () =>
          request(late.app).post('/api/onboarding').send(body),
        ),
        'start_month_too_old',
        'startMonth',
      );
      await request(late.app).post('/api/onboarding').send(body).expect(201);
    });

    it('has a rule for each side of the range: in the future, and too old', async () => {
      expectRuleViolation(
        await request(app)
          .post('/api/onboarding')
          .send({ ...ONBOARDING, startMonth: '2026-04' }),
        'start_month_in_future',
        'startMonth',
      );
      expectRuleViolation(
        await request(app)
          .post('/api/onboarding')
          .send({ ...ONBOARDING, startMonth: '2006-02' }),
        'start_month_too_old',
        'startMonth',
      );
      expect(stored()).toEqual(NOTHING);
    });
  });

  describe('atomicity', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a budget that fails validation stores nothing at all', async () => {
      const res = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          budgets: [
            { name: 'Fine', amount: 100, incremental: false },
            { name: 'Broken', amount: -100, incremental: false },
          ],
        });
      expectValidationError(res, 'budgets.1.amount');
      expect(stored()).toEqual(NOTHING);
    });

    it('a database failure half way through rolls back the settings, salary, opening balance and earlier budgets', async () => {
      // The third write of the request (the second budget's first version) fails inside SQLite,
      // after the settings, salary, opening balance and the first budget were already written.
      db.run(sql`
        CREATE TRIGGER fail_second_budget BEFORE INSERT ON budget_versions
        WHEN NEW.amount = 666
        BEGIN SELECT RAISE(ABORT, 'simulated failure'); END
      `);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          budgets: [
            { name: 'First', amount: 100, incremental: false },
            { name: 'Fails', amount: 666, incremental: false },
            { name: 'Never reached', amount: 300, incremental: false },
          ],
        });

      expectApiError(res, 'internal_error');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(stored()).toEqual(NOTHING);
      expectApiError(await request(app).get('/api/settings'), 'not_found');
      // Still not onboarded, so the guard still applies...
      expectApiError(await request(app).get('/api/budgets'), 'not_onboarded');

      // ...and once the cause is gone the very same request succeeds from a clean slate.
      db.run(sql`DROP TRIGGER fail_second_budget`);
      const retry = await request(app)
        .post('/api/onboarding')
        .send({
          ...ONBOARDING,
          budgets: [
            { name: 'First', amount: 100, incremental: false },
            { name: 'Second', amount: 666, incremental: false },
          ],
        })
        .expect(201);
      expect(retry.body.budgets).toHaveLength(2);
      expect(stored()).toMatchObject({
        settings: 1,
        salary: 1,
        savings: 1,
        budgets: 2,
        versions: 2,
      });
    });
  });
});
