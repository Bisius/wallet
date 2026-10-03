import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import {
  budgetTransfers,
  budgetVersions,
  budgets,
  incomes,
  salaryChanges,
  savingsTransactions,
  settings,
  spendings,
  subscriptionPrices,
  subscriptions,
} from '../../db/schema';
import { fixedClock } from '../../lib/clock';
import {
  expectApiError,
  expectRuleViolation,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

const VALID = {
  currency: 'EUR',
  locale: 'it-IT',
  startMonth: '2026-01',
  theme: 'system',
  alertWarnPercent: 80,
};

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;

beforeEach(() => {
  ({ app, db } = createTestApp(fixedClock('2026-03-15T10:00:00Z')));
});

describe('GET /api/settings', () => {
  it('is a 404 until the settings exist', async () => {
    expectApiError(await request(app).get('/api/settings'), 'not_found');
  });

  it('returns exactly the five settings once they exist', async () => {
    await request(app).put('/api/settings').send(VALID).expect(200);
    const res = await request(app).get('/api/settings').expect(200);
    expect(res.body).toEqual(VALID);
  });
});

describe('PUT /api/settings', () => {
  it('creates the settings on the first call and answers 200 with them', async () => {
    const res = await request(app).put('/api/settings').send(VALID).expect(200);
    expect(res.body).toEqual(VALID);
    expect(db.select().from(settings).all()).toHaveLength(1);
  });

  it('completes onboarding without storing a salary, an opening balance or budgets', async () => {
    await request(app).put('/api/settings').send(VALID).expect(200);
    expect((await request(app).get('/api/salary').expect(200)).body).toEqual([]);
    expect(db.select().from(savingsTransactions).all()).toEqual([]);
    expect(db.select().from(budgets).all()).toEqual([]);
    // ...and POST /api/onboarding is then refused.
    const res = await request(app).post('/api/onboarding').send({
      currency: 'EUR',
      locale: 'en-US',
      startMonth: '2026-01',
      salary: 1,
      openingSavings: 0,
    });
    expectApiError(res, 'already_onboarded');
  });

  it('replaces all five fields on later calls', async () => {
    await request(app).put('/api/settings').send(VALID).expect(200);
    const changed = {
      currency: 'USD',
      locale: 'en-US',
      startMonth: '2025-11',
      theme: 'dark',
      alertWarnPercent: 95,
    };
    const res = await request(app).put('/api/settings').send(changed).expect(200);
    expect(res.body).toEqual(changed);
    expect((await request(app).get('/api/settings')).body).toEqual(changed);
    expect(db.select().from(settings).all()).toHaveLength(1);
  });

  it('stamps updatedAt from the injected clock', async () => {
    await request(app).put('/api/settings').send(VALID).expect(200);
    expect(db.select().from(settings).get()?.updatedAt).toBe('2026-03-15T10:00:00.000Z');
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, 'currency'],
      ['a missing currency', { ...VALID, currency: undefined }, 'currency'],
      ['a lower-case currency', { ...VALID, currency: 'eur' }, 'currency'],
      ['a bad locale', { ...VALID, locale: 'it_IT' }, 'locale'],
      ['a bad start month', { ...VALID, startMonth: '2026-13' }, 'startMonth'],
      ['a date as start month', { ...VALID, startMonth: '2026-01-01' }, 'startMonth'],
      ['an unknown theme', { ...VALID, theme: 'neon' }, 'theme'],
      ['a missing theme (PUT replaces all five)', { ...VALID, theme: undefined }, 'theme'],
      ['a zero alert percent', { ...VALID, alertWarnPercent: 0 }, 'alertWarnPercent'],
      ['an alert percent above 100', { ...VALID, alertWarnPercent: 101 }, 'alertWarnPercent'],
      ['an unknown key', { ...VALID, id: 1 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const res = await request(app).put('/api/settings').send(body);
      expectValidationError(res, path);
      expectApiError(await request(app).get('/api/settings'), 'not_found'); // nothing stored
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set('Content-Type', 'application/json')
        .send('{"currency":');
      expectApiError(res, 'invalid_json');
    });
  });

  describe('start_month_in_future (422)', () => {
    it('refuses a start month after the current month, on the first call', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2026-04' });
      expectRuleViolation(res, 'start_month_in_future', 'startMonth');
      expectApiError(await request(app).get('/api/settings'), 'not_found');
    });

    it('refuses it on later calls too, leaving the settings unchanged', async () => {
      await request(app).put('/api/settings').send(VALID).expect(200);
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, theme: 'dark', startMonth: '2027-01' });
      expectRuleViolation(res, 'start_month_in_future', 'startMonth');
      expect((await request(app).get('/api/settings')).body).toEqual(VALID);
    });

    it('accepts the current month itself', async () => {
      await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2026-03' })
        .expect(200);
    });

    it('judges the month in the server time zone, not in UTC', async () => {
      const late = createTestApp(fixedClock('2026-03-31T23:30:00Z')).app;
      const body = { ...VALID, startMonth: '2026-04' };
      // In UTC it is still March, so April is the future...
      expectRuleViolation(
        await request(late).put('/api/settings').send(body),
        'start_month_in_future',
        'startMonth',
      );
      // ...but in Rome (UTC+2) it is already 1 April.
      await withTimeZone('Europe/Rome', () =>
        request(late).put('/api/settings').send(body).expect(200),
      );
    });
  });

  describe('start_month_too_old (422)', () => {
    // Today is 2026-03-15, so 240 months back (MAX_START_MONTH_AGE_MONTHS, 20 years) is 2006-03.
    it('refuses a start month more than 240 months before the current month, on the first call', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2006-02' });
      expectRuleViolation(res, 'start_month_too_old', 'startMonth');
      expectApiError(await request(app).get('/api/settings'), 'not_found');
    });

    it.each(['1999-12', '1900-01', '0001-01'])(
      'refuses %s, however far back',
      async (startMonth) => {
        const res = await request(app)
          .put('/api/settings')
          .send({ ...VALID, startMonth });
        expectRuleViolation(res, 'start_month_too_old', 'startMonth');
        expect(db.select().from(settings).all()).toEqual([]);
      },
    );

    it('accepts exactly 240 months before the current month, and no more', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2006-03' })
        .expect(200);
      expect(res.body.startMonth).toBe('2006-03');
      expectRuleViolation(
        await request(app)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2006-02' }),
        'start_month_too_old',
        'startMonth',
      );
      expect((await request(app).get('/api/settings')).body.startMonth).toBe('2006-03');
    });

    it('refuses it on later calls too, when the start month is changed, leaving everything as it was', async () => {
      await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, theme: 'dark', startMonth: '2000-01' });
      expectRuleViolation(res, 'start_month_too_old', 'startMonth');
      expect((await request(app).get('/api/settings')).body).toMatchObject({
        startMonth: '2026-01',
        theme: 'system',
      });
      expect(db.select().from(savingsTransactions).get()?.date).toBe('2026-01-01');
    });

    it('is judged in the server time zone, like the current month', async () => {
      // At 23:30 UTC on 2026-03-31 it is still March in UTC, and already April in Rome (UTC+2).
      const late = createTestApp(fixedClock('2026-03-31T23:30:00Z')).app;
      const body = { ...VALID, startMonth: '2006-03' };
      expectRuleViolation(
        await withTimeZone('Europe/Rome', () => request(late).put('/api/settings').send(body)),
        'start_month_too_old',
        'startMonth',
      );
      await request(late).put('/api/settings').send(body).expect(200);
    });

    describe('an old start month that stays as it is is never refused', () => {
      it('keeps the settings editable as time passes: the age is only checked when the start month changes', async () => {
        const clock = mutableClock('2026-03-15T10:00:00Z');
        const old = createTestApp(clock).app;
        await request(old)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2006-03' })
          .expect(200);

        // A month later 2006-03 is 241 months back: too old for a new start month, but it is the
        // stored one, so every other setting stays editable.
        clock.set('2026-04-02T10:00:00Z');
        const edited = await request(old)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2006-03', theme: 'dark', currency: 'USD' })
          .expect(200);
        expect(edited.body).toMatchObject({
          startMonth: '2006-03',
          theme: 'dark',
          currency: 'USD',
        });

        // Changing it to another month that is too old is refused, earlier or later than the stored one.
        for (const startMonth of ['2006-02', '2005-12']) {
          expectRuleViolation(
            await request(old)
              .put('/api/settings')
              .send({ ...VALID, startMonth }),
            'start_month_too_old',
            'startMonth',
          );
        }
        expect((await request(old).get('/api/settings')).body.startMonth).toBe('2006-03');

        // A start month within the limit is fine, later than the stored one or not.
        await request(old)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2006-04' })
          .expect(200);
        await request(old)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2026-01' })
          .expect(200);
      });

      it('keeps a database working whose start month is decades old, and checks the age before the facts', async () => {
        // Onboarded in January 2020, with the start month exactly 240 months back (2000-01)...
        const clock = mutableClock('2020-01-15T10:00:00Z');
        const legacy = createTestApp(clock).app;
        await onboard(legacy, { startMonth: '2000-01', salary: 100000, openingSavings: 0 });

        // ...and six years on it is 314 months old. Nothing about it is refused: the settings stay
        // editable and the rest of the API still answers.
        clock.set('2026-03-15T10:00:00Z');
        const same = await request(legacy)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2000-01', alertWarnPercent: 90 })
          .expect(200);
        expect(same.body).toMatchObject({ startMonth: '2000-01', alertWarnPercent: 90 });
        await request(legacy).get('/api/savings').expect(200);
        await request(legacy).get('/api/months/2026-02').expect(200);

        // Moving it later is a change. The salary of 2000-01 blocks any later start month, but the
        // age is checked first: a month that is too old is reported as too old, one that is not is
        // reported as after the facts.
        expectRuleViolation(
          await request(legacy)
            .put('/api/settings')
            .send({ ...VALID, startMonth: '2001-01' }),
          'start_month_too_old',
          'startMonth',
        );
        expectRuleViolation(
          await request(legacy)
            .put('/api/settings')
            .send({ ...VALID, startMonth: '2010-01' }),
          'start_month_after_facts',
          'startMonth',
        );
        expect((await request(legacy).get('/api/settings')).body.startMonth).toBe('2000-01');
      });
    });
  });

  describe('moving startMonth earlier', () => {
    it('is always allowed, whatever facts exist, and moves the opening balance with it', async () => {
      await onboard(app, {
        startMonth: '2026-02',
        salary: 250000,
        openingSavings: 123400,
        budgets: [{ name: 'Groceries', amount: 40000, incremental: false }],
      });
      await request(app)
        .post('/api/spendings')
        .send({ date: '2026-02-10', amount: 500, budgetId: 1 })
        .expect(201);

      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2025-10' })
        .expect(200);
      expect(res.body.startMonth).toBe('2025-10');

      const [opening] = db.select().from(savingsTransactions).all();
      expect(opening).toMatchObject({ kind: 'opening', amount: 123400, date: '2025-10-01' });
      // The added months are simply empty: the salary still starts where it did.
      expect((await request(app).get('/api/salary')).body).toEqual([
        { effectiveMonth: '2026-02', amount: 250000 },
      ]);
    });
  });

  describe('moving startMonth later', () => {
    it('is allowed once every fact is dated in or after the new month, and the opening balance follows', async () => {
      await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
      // Re-date the first salary from January to February, the way the UI would suggest.
      await request(app).put('/api/salary/2026-02').send({ amount: 300000 }).expect(200);
      await request(app).delete('/api/salary/2026-01').expect(204);

      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2026-02' })
        .expect(200);
      expect(res.body.startMonth).toBe('2026-02');
      expect(db.select().from(savingsTransactions).all()).toMatchObject([
        { kind: 'opening', amount: 50000, date: '2026-02-01' },
      ]);
    });

    it('is blocked by the first salary onboarding stored, and nothing changes', async () => {
      await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2026-02', theme: 'dark' });
      expectRuleViolation(res, 'start_month_after_facts', 'startMonth');
      expect((await request(app).get('/api/settings')).body).toMatchObject({
        startMonth: '2026-01',
        theme: 'system',
      });
      expect(db.select().from(savingsTransactions).get()?.date).toBe('2026-01-01');
    });

    it('leaves the opening balance (not a fact) out of the check', async () => {
      await onboard(app, { startMonth: '2026-01', openingSavings: 50000 });
      await request(app).delete('/api/salary/2026-01').expect(204);
      await request(app)
        .put('/api/settings')
        .send({ ...VALID, startMonth: '2026-03' })
        .expect(200);
    });

    /**
     * One fact of each kind, alone, dated February 2026 (rows are inserted directly so that no
     * other fact, such as the budget a spending belongs to, dates earlier and hides the case). The
     * price and version rows of a subscription or a budget are not facts of their own: they only
     * matter from the item's start month on (see the next block).
     */
    const FACTS: [string, (db: Db) => void][] = [
      [
        'a salary change',
        (d) => void d.insert(salaryChanges).values({ effectiveMonth: '2026-02', amount: 1 }).run(),
      ],
      [
        'an income',
        (d) =>
          void d.insert(incomes).values({ date: '2026-02-10', amount: 1, description: 'x' }).run(),
      ],
      [
        'a subscription start month',
        (d) =>
          void d
            .insert(subscriptions)
            .values({
              name: 's',
              frequency: 'monthly',
              anchorDate: '2026-02-01',
              startMonth: '2026-02',
            })
            .run(),
      ],
      [
        'a budget start month',
        (d) => void d.insert(budgets).values({ name: 'b', startMonth: '2026-02' }).run(),
      ],
      [
        'a spending',
        (d) => {
          d.insert(budgets).values({ name: 'b', startMonth: '2026-04' }).run();
          d.insert(spendings)
            .values({ date: '2026-02-10', amount: 1, budgetId: 1, description: '' })
            .run();
        },
      ],
      [
        'a transfer',
        (d) => {
          d.insert(budgets).values({ name: 'b', startMonth: '2026-04' }).run();
          d.insert(budgetTransfers).values({ date: '2026-02-10', toBudgetId: 1, amount: 1 }).run();
        },
      ],
      [
        'a savings deposit',
        (d) =>
          void d
            .insert(savingsTransactions)
            .values({ date: '2026-02-15', amount: 1, kind: 'deposit' })
            .run(),
      ],
      [
        'a savings settlement (by the month it settles)',
        (d) =>
          void d
            .insert(savingsTransactions)
            .values({ date: '2026-04-02', amount: 1, kind: 'settlement', settlesMonth: '2026-02' })
            .run(),
      ],
    ];

    describe.each(FACTS)('with %s dated February', (_label, seed) => {
      beforeEach(async () => {
        await request(app).put('/api/settings').send(VALID).expect(200);
        seed(db);
      });

      it('refuses to start in March (start_month_after_facts) and changes nothing', async () => {
        const res = await request(app)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2026-03' });
        expectRuleViolation(res, 'start_month_after_facts', 'startMonth');
        expect((await request(app).get('/api/settings')).body.startMonth).toBe('2026-01');
      });

      it('allows starting in February itself: the fact is dated in the new month', async () => {
        await request(app)
          .put('/api/settings')
          .send({ ...VALID, startMonth: '2026-02' })
          .expect(200);
      });
    });

    describe('rows dated before their item starts are not facts (they are inert)', () => {
      // A price or version row can sit before the item's start month once the item's start moved
      // later: it is then the row in effect at the start month, and nothing else. The item's own
      // start month is the fact. (The clock is in March 2026, so the start can reach March at most.)
      const SETTINGS = (startMonth: string) => ({ ...VALID, startMonth });

      it('a price dated before its subscription starts does not block moving the start past it', async () => {
        await request(app).put('/api/settings').send(SETTINGS('2025-12')).expect(200);
        db.insert(subscriptions)
          .values({
            name: 's',
            frequency: 'monthly',
            anchorDate: '2026-02-01',
            startMonth: '2026-02',
          })
          .run();
        db.insert(subscriptionPrices)
          .values({ subscriptionId: 1, effectiveMonth: '2025-12', amount: 1 })
          .run();
        await request(app).put('/api/settings').send(SETTINGS('2026-01')).expect(200);
        await request(app).put('/api/settings').send(SETTINGS('2026-02')).expect(200);
        // The subscription itself starts in February: March would leave it before the start.
        expectRuleViolation(
          await request(app).put('/api/settings').send(SETTINGS('2026-03')),
          'start_month_after_facts',
          'startMonth',
        );
        expect((await request(app).get('/api/settings')).body.startMonth).toBe('2026-02');
      });

      it('a version dated before its budget starts does not block moving the start past it', async () => {
        await request(app).put('/api/settings').send(SETTINGS('2025-12')).expect(200);
        db.insert(budgets).values({ name: 'b', startMonth: '2026-02' }).run();
        db.insert(budgetVersions)
          .values({ budgetId: 1, effectiveMonth: '2025-12', amount: 1, incremental: false })
          .run();
        await request(app).put('/api/settings').send(SETTINGS('2026-01')).expect(200);
        await request(app).put('/api/settings').send(SETTINGS('2026-02')).expect(200);
        expectRuleViolation(
          await request(app).put('/api/settings').send(SETTINGS('2026-03')),
          'start_month_after_facts',
          'startMonth',
        );
      });

      it('through the API: a start moved later leaves the older prices behind, and the tracking can start after them', async () => {
        await onboard(app, { startMonth: '2026-01' });
        await request(app).delete('/api/salary/2026-01').expect(204);
        const sub = (
          await request(app)
            .post('/api/subscriptions')
            .send({
              name: 'Netflix',
              frequency: 'monthly',
              anchorDate: '2026-01-15',
              amount: 1299,
              startMonth: '2026-01',
            })
            .expect(201)
        ).body;
        await request(app)
          .put(`/api/subscriptions/${sub.id}/prices/2026-02`)
          .send({ amount: 1599 })
          .expect(200);
        // While the subscription starts in January, the tracking cannot start later than that.
        expectRuleViolation(
          await request(app).put('/api/settings').send(SETTINGS('2026-03')),
          'start_month_after_facts',
          'startMonth',
        );

        // Re-date the subscription to start in March: both prices stay, dated January and February.
        const moved = await request(app)
          .patch(`/api/subscriptions/${sub.id}`)
          .send({ startMonth: '2026-03' })
          .expect(200);
        expect(moved.body.prices).toHaveLength(2);

        // Nothing in January or February is a fact any more, so the tracking can start in March.
        const res = await request(app).put('/api/settings').send(SETTINGS('2026-03')).expect(200);
        expect(res.body.startMonth).toBe('2026-03');
      });

      it('a price or version dated at or after its start month never makes the facts earlier than the item', async () => {
        await request(app).put('/api/settings').send(VALID).expect(200);
        db.insert(subscriptions)
          .values({
            name: 's',
            frequency: 'monthly',
            anchorDate: '2026-02-01',
            startMonth: '2026-02',
          })
          .run();
        db.insert(subscriptionPrices)
          .values({ subscriptionId: 1, effectiveMonth: '2026-02', amount: 1 })
          .run();
        db.insert(subscriptionPrices)
          .values({ subscriptionId: 1, effectiveMonth: '2026-03', amount: 2 })
          .run();
        await request(app).put('/api/settings').send(SETTINGS('2026-02')).expect(200);
      });
    });

    it('does not block a change that keeps the start month, however old the facts are', async () => {
      await onboard(app, { startMonth: '2026-01' });
      const res = await request(app)
        .put('/api/settings')
        .send({ ...VALID, theme: 'dark' })
        .expect(200);
      expect(res.body.theme).toBe('dark');
    });

    it('does not touch the opening balance date when the start month stays', async () => {
      await onboard(app, { startMonth: '2026-01' });
      db.update(savingsTransactions)
        .set({ date: '2026-01-05' })
        .where(eq(savingsTransactions.kind, 'opening'))
        .run();
      await request(app)
        .put('/api/settings')
        .send({ ...VALID, theme: 'dark' })
        .expect(200);
      expect(db.select().from(savingsTransactions).get()?.date).toBe('2026-01-05');
    });
  });
});
