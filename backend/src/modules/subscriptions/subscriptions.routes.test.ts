import type { MonthView, SubscriptionDto, SubscriptionPriceDto } from '@wallet/shared';
import { ceilDiv } from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { subscriptionPrices } from '../../db/schema';
import { fixedClock } from '../../lib/clock';
import {
  type MutableClock,
  addSubscription,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;
let clock: MutableClock;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
});

const list = async (): Promise<SubscriptionDto[]> =>
  (await request(app).get('/api/subscriptions').expect(200)).body;

const price = (effectiveMonth: string, amount: number): SubscriptionPriceDto => ({
  effectiveMonth,
  amount,
});

const putPrice = (id: number, month: string, amount: number) =>
  request(app).put(`/api/subscriptions/${id}/prices/${month}`).send({ amount });

describe('POST /api/subscriptions', () => {
  it('creates a monthly subscription with its first price and answers 201 with the full DTO', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ name: 'Netflix', frequency: 'monthly', anchorDate: '2026-01-15', amount: 1299 })
      .expect(201);
    expect(res.body).toEqual({
      id: 1,
      name: 'Netflix',
      frequency: 'monthly',
      anchorDate: '2026-01-15',
      startMonth: '2026-03',
      endMonth: null,
      color: null,
      notes: null,
      prices: [{ effectiveMonth: '2026-03', amount: 1299 }],
      currentPrice: 1299,
      monthlyEquivalent: 1299,
      status: 'active',
    });
    expect(await list()).toEqual([res.body]);
  });

  it('stores every optional field, normalizing them', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({
        name: ' Gym ',
        frequency: 'yearly',
        anchorDate: '2025-09-30',
        amount: 24000,
        startMonth: '2026-02',
        color: '#E50914',
        notes: '  Annual plan ',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Gym',
      frequency: 'yearly',
      anchorDate: '2025-09-30',
      startMonth: '2026-02',
      color: '#e50914',
      notes: 'Annual plan',
      prices: [{ effectiveMonth: '2026-02', amount: 24000 }],
    });
  });

  it('keeps a billing day of 31 as given (it is clamped when billed, not stored)', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ name: 'Rent-a-thing', frequency: 'monthly', anchorDate: '2026-01-31', amount: 500 })
      .expect(201);
    expect(res.body.anchorDate).toBe('2026-01-31');
  });

  it('accepts nulls and blank notes as "not set"', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({
        name: 'x',
        frequency: 'monthly',
        anchorDate: '2026-01-01',
        amount: 1,
        color: null,
        notes: '',
      })
      .expect(201);
    expect(res.body).toMatchObject({ color: null, notes: null });
  });

  describe('monthlyEquivalent: a yearly price / 12, rounded UP to the next cent', () => {
    it.each([
      [12000, 1000],
      [10000, 834],
      [12001, 1001],
      [11, 1],
      [1, 1],
      [13, 2],
      [100, 9],
      [99999, 8334],
      [1_000_000_000_000, 83_333_333_334],
    ])('a yearly price of %i shows as %i a month', async (amount, expected) => {
      const sub = await addSubscription(app, { frequency: 'yearly', amount });
      expect(sub.monthlyEquivalent).toBe(expected);
      expect(sub.monthlyEquivalent).toBe(ceilDiv(amount, 12));
      expect(sub.currentPrice).toBe(amount);
    });

    it('is the price itself for a monthly subscription', async () => {
      expect(
        (await addSubscription(app, { frequency: 'monthly', amount: 1299 })).monthlyEquivalent,
      ).toBe(1299);
    });
  });

  it('starts in a past month (from settings.startMonth on): active, priced from then', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    expect(sub).toMatchObject({
      status: 'active',
      prices: [price('2026-01', 1299)],
      currentPrice: 1299,
    });
  });

  it('starts in a future month: upcoming, with no current price or monthly equivalent yet', async () => {
    const sub = await addSubscription(app, { frequency: 'yearly', startMonth: '2026-05' });
    expect(sub).toMatchObject({
      status: 'upcoming',
      currentPrice: null,
      monthlyEquivalent: null,
      prices: [price('2026-05', 1299)],
    });
  });

  describe('before_start_month (422)', () => {
    it('refuses a start month before settings.startMonth and stores nothing', async () => {
      const res = await request(app).post('/api/subscriptions').send({
        name: 'Old',
        frequency: 'monthly',
        anchorDate: '2025-12-01',
        amount: 1,
        startMonth: '2025-12',
      });
      expectRuleViolation(res, 'before_start_month', 'startMonth');
      expect(await list()).toEqual([]);
      expect(db.select().from(subscriptionPrices).all()).toEqual([]);
    });

    it('accepts settings.startMonth itself (the boundary)', async () => {
      await addSubscription(app, { startMonth: '2026-01' });
    });
  });

  describe('validation (400)', () => {
    const ok = { name: 'x', frequency: 'monthly', anchorDate: '2026-01-01', amount: 1 };
    it.each([
      ['an empty body', {}, 'name'],
      ['a blank name', { ...ok, name: ' ' }, 'name'],
      ['a missing frequency', { ...ok, frequency: undefined }, 'frequency'],
      ['an unknown frequency', { ...ok, frequency: 'weekly' }, 'frequency'],
      ['a missing anchorDate', { ...ok, anchorDate: undefined }, 'anchorDate'],
      ['an impossible anchorDate', { ...ok, anchorDate: '2026-02-30' }, 'anchorDate'],
      ['a month as anchorDate', { ...ok, anchorDate: '2026-02' }, 'anchorDate'],
      ['a missing amount', { ...ok, amount: undefined }, 'amount'],
      ['a zero amount', { ...ok, amount: 0 }, 'amount'],
      ['a negative amount', { ...ok, amount: -5 }, 'amount'],
      ['a fractional amount', { ...ok, amount: 12.99 }, 'amount'],
      ['a bad startMonth', { ...ok, startMonth: '2026-9' }, 'startMonth'],
      ['a bad color', { ...ok, color: 'red' }, 'color'],
      ['an endMonth (use cancel)', { ...ok, endMonth: '2026-12' }, ''],
      ['a price field', { ...ok, price: 100 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      expectValidationError(await request(app).post('/api/subscriptions').send(body), path);
      expect(await list()).toEqual([]);
    });
  });
});

describe('GET /api/subscriptions', () => {
  it('is an empty list when there are none', async () => {
    expect(await list()).toEqual([]);
  });

  it('is ascending by name ignoring case, ties broken by id', async () => {
    const spotify = await addSubscription(app, { name: 'spotify' });
    const netflix = await addSubscription(app, { name: 'Netflix' });
    const amazonLower = await addSubscription(app, { name: 'amazon Prime' });
    const amazonUpper = await addSubscription(app, { name: 'Amazon prime' });
    expect((await list()).map((s) => s.id)).toEqual([
      amazonLower.id, // equal ignoring case: the lower id first
      amazonUpper.id,
      netflix.id,
      spotify.id,
    ]);
  });

  it('sorts an accented letter with its base letter, not after "z"', async () => {
    await addSubscription(app, { name: 'spotify' });
    await addSubscription(app, { name: 'Étoile' });
    await addSubscription(app, { name: 'Netflix' });
    expect((await list()).map((s) => s.name)).toEqual(['Étoile', 'Netflix', 'spotify']);
  });

  it('returns subscriptions of every status', async () => {
    const active = await addSubscription(app, { name: 'A active' });
    const upcoming = await addSubscription(app, { name: 'B upcoming', startMonth: '2026-06' });
    const cancelled = await addSubscription(app, { name: 'C cancelled', startMonth: '2026-01' });
    await request(app)
      .post(`/api/subscriptions/${cancelled.id}/cancel`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    expect((await list()).map((s) => [s.id, s.status])).toEqual([
      [active.id, 'active'],
      [upcoming.id, 'upcoming'],
      [cancelled.id, 'cancelled'],
    ]);
  });
});

describe('PATCH /api/subscriptions/:id', () => {
  it('edits the plain fields and leaves prices alone', async () => {
    const sub = await addSubscription(app);
    const res = await request(app)
      .patch(`/api/subscriptions/${sub.id}`)
      .send({ name: 'Netflix 4K', anchorDate: '2026-02-28', color: '#000000', notes: 'Upgraded' })
      .expect(200);
    expect(res.body).toEqual({
      ...sub,
      name: 'Netflix 4K',
      anchorDate: '2026-02-28',
      color: '#000000',
      notes: 'Upgraded',
    });
    expect(await list()).toEqual([res.body]);
  });

  it('clears color and notes with null', async () => {
    const sub = await addSubscription(app, { color: '#112233', notes: 'n' });
    const res = await request(app)
      .patch(`/api/subscriptions/${sub.id}`)
      .send({ color: null, notes: null })
      .expect(200);
    expect(res.body).toMatchObject({ color: null, notes: null });
  });

  it('keeps the frequency fixed: it cannot even be sent', async () => {
    const sub = await addSubscription(app, { frequency: 'monthly' });
    expectValidationError(
      await request(app).patch(`/api/subscriptions/${sub.id}`).send({ frequency: 'yearly' }),
      '',
    );
    expect((await list())[0]?.frequency).toBe('monthly');
  });

  it('is a 404 for an unknown id', async () => {
    expectNotFound(await request(app).patch('/api/subscriptions/99').send({ name: 'x' }));
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ''],
      ['a blank name', { name: '' }, 'name'],
      ['a bad anchorDate', { anchorDate: '15/10/2026' }, 'anchorDate'],
      ['a bad startMonth', { startMonth: '2026-00' }, 'startMonth'],
      ['a bad color', { color: 'red' }, 'color'],
      ['an endMonth (use cancel)', { endMonth: '2026-12' }, ''],
      ['an amount (use prices)', { amount: 100 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const sub = await addSubscription(app);
      expectValidationError(
        await request(app).patch(`/api/subscriptions/${sub.id}`).send(body),
        path,
      );
    });

    it.each(['abc', '0', '-1', '2.5', '99999999999999999999999'])(
      'rejects the id %j',
      async (id) => {
        expectValidationError(
          await request(app).patch(`/api/subscriptions/${id}`).send({ name: 'x' }),
          'id',
        );
      },
    );
  });

  describe('moving startMonth never deletes a price (docs/DOMAIN.md, "Versioned values")', () => {
    /** Prices 1000 (Jan), 2000 (Mar), 3000 (Jun). */
    async function threePrices(): Promise<SubscriptionDto> {
      const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-01' });
      await putPrice(sub.id, '2026-03', 2000).expect(200);
      await putPrice(sub.id, '2026-06', 3000).expect(200);
      return sub;
    }
    const move = (id: number, startMonth: string) =>
      request(app).patch(`/api/subscriptions/${id}`).send({ startMonth });

    it.each([
      ['the same month: nothing changes', '2026-01'],
      ['later but before the second price', '2026-02'],
      ['later, exactly to the second price', '2026-03'],
      ['later, between prices', '2026-04'],
      ['later than every price', '2026-09'],
    ])('%s: every price stays where it is', async (_label, newStart) => {
      const sub = await threePrices();
      const res = await move(sub.id, newStart).expect(200);
      expect(res.body.startMonth).toBe(newStart);
      expect(res.body.prices).toEqual([
        price('2026-01', 1000),
        price('2026-03', 2000),
        price('2026-06', 3000),
      ]);
    });

    it('earlier: re-dates only the first price and keeps its amount', async () => {
      const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-03' });
      await putPrice(sub.id, '2026-06', 3000).expect(200);
      const res = await move(sub.id, '2026-01').expect(200);
      expect(res.body.prices).toEqual([price('2026-01', 1000), price('2026-06', 3000)]);
    });

    it('moving later and back leaves both prices and every month charge unchanged', async () => {
      // 12.99 from January, 15.99 from May; the clock is in October, so January to September are closed.
      const { app } = createTestApp(fixedClock('2026-10-15T12:00:00Z'));
      await onboard(app, { startMonth: '2026-01' });
      const sub = await addSubscription(app, { startMonth: '2026-01', amount: 1299 });
      await request(app)
        .put(`/api/subscriptions/${sub.id}/prices/2026-05`)
        .send({ amount: 1599 })
        .expect(200);
      const prices = [price('2026-01', 1299), price('2026-05', 1599)];
      const charges = async () =>
        Promise.all(
          ['2026-01', '2026-02', '2026-04', '2026-05', '2026-06', '2026-10'].map(async (m) => {
            const view = (await request(app).get(`/api/months/${m}`).expect(200)).body as MonthView;
            return [m, view.subscriptions.find((s) => s.id === sub.id)?.charge ?? null];
          }),
        );
      const before = await charges();
      expect(before).toEqual([
        ['2026-01', 1299],
        ['2026-02', 1299],
        ['2026-04', 1299],
        ['2026-05', 1599],
        ['2026-06', 1599],
        ['2026-10', 1599],
      ]);

      const later = await request(app)
        .patch(`/api/subscriptions/${sub.id}`)
        .send({ startMonth: '2026-06' })
        .expect(200);
      expect(later.body.prices).toEqual(prices); // 15.99 is the price in effect in June
      expect(await charges()).toEqual([
        ['2026-01', null],
        ['2026-02', null],
        ['2026-04', null],
        ['2026-05', null],
        ['2026-06', 1599],
        ['2026-10', 1599],
      ]);

      const back = await request(app)
        .patch(`/api/subscriptions/${sub.id}`)
        .send({ startMonth: '2026-01' })
        .expect(200);
      expect(back.body.prices).toEqual(prices);
      expect(await charges()).toEqual(before);
    });

    it('moves the current price with it only through the months: the older price stays in effect at the new start', async () => {
      const sub = await threePrices();
      clock.set('2026-07-01T00:00:00Z');
      const res = await move(sub.id, '2026-04').expect(200);
      expect(res.body).toMatchObject({ currentPrice: 3000, status: 'active' });
      expect(res.body.prices).toHaveLength(3);
    });

    it('turns an active subscription into an upcoming one when moved past the current month', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-01' });
      const res = await move(sub.id, '2026-05').expect(200);
      expect(res.body).toMatchObject({
        status: 'upcoming',
        currentPrice: null,
        monthlyEquivalent: null,
      });
    });

    it('refuses a start month before settings.startMonth (before_start_month) and changes nothing', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-02' });
      expectRuleViolation(await move(sub.id, '2025-12'), 'before_start_month', 'startMonth');
      expect((await list())[0]).toEqual(sub);
    });

    it('accepts settings.startMonth itself (the boundary)', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-02' });
      await move(sub.id, '2026-01').expect(200);
    });

    it('refuses a start month after the end month (end_before_start), and accepts the end month itself', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-01' });
      await request(app)
        .post(`/api/subscriptions/${sub.id}/cancel`)
        .send({ endMonth: '2026-04' })
        .expect(200);
      expectRuleViolation(await move(sub.id, '2026-05'), 'end_before_start', 'startMonth');
      const res = await move(sub.id, '2026-04').expect(200);
      expect(res.body).toMatchObject({
        startMonth: '2026-04',
        endMonth: '2026-04',
        prices: [price('2026-01', 1299)],
      });
    });
  });

  describe('moving the renewal month of a yearly subscription (renewal_month_in_history)', () => {
    // The reviewer's scenario: it is October 2026, a 120.00 yearly subscription started in January
    // and renews in March, so January to September are closed.
    const octoberApp = async () => {
      const { app } = createTestApp(fixedClock('2026-10-15T12:00:00Z'));
      await onboard(app, { startMonth: '2026-01' });
      const sub = await addSubscription(app, {
        startMonth: '2026-01',
        frequency: 'yearly',
        anchorDate: '2026-03-10',
        amount: 12000,
      });
      const patch = (body: object) => request(app).patch(`/api/subscriptions/${sub.id}`).send(body);
      const marchLine = async () =>
        (
          (await request(app).get('/api/months/2026-03').expect(200)).body as MonthView
        ).subscriptions.find((s) => s.id === sub.id);
      return { app, sub, patch, marchLine };
    };

    it('refuses another renewal month once a month has closed, and March keeps its figures', async () => {
      const { app, sub, patch, marchLine } = await octoberApp();
      expect(await marchLine()).toMatchObject({ charge: 4000, renewalThisMonth: true });

      const res = await patch({ anchorDate: '2026-06-10' });
      expectRuleViolation(res, 'renewal_month_in_history', 'anchorDate');
      expect(res.body.error.message).toMatch(/cancel it and add a new subscription/i);

      // Nothing changed: the stored anchor, and the March line (4000 charged, the renewal month).
      expect(await marchLine()).toMatchObject({
        charge: 4000,
        renewalThisMonth: true,
        reserveBalance: 0,
      });
      expect((await request(app).get('/api/subscriptions').expect(200)).body[0].anchorDate).toBe(
        sub.anchorDate,
      );
    });

    it('accepts changing only the billing day', async () => {
      const { patch, marchLine } = await octoberApp();
      const res = await patch({ anchorDate: '2026-03-20' }).expect(200);
      expect(res.body.anchorDate).toBe('2026-03-20');
      expect(await marchLine()).toMatchObject({ charge: 4000, renewalThisMonth: true });
    });

    it('accepts a different year of the same month, and day 31 (clamped when billed)', async () => {
      const { patch } = await octoberApp();
      await patch({ anchorDate: '2025-03-31' }).expect(200);
      await patch({ anchorDate: '2027-03-01' }).expect(200);
    });

    it('refuses one month away in either direction, and across the year end', async () => {
      const { patch } = await octoberApp();
      expectRuleViolation(
        await patch({ anchorDate: '2026-04-10' }),
        'renewal_month_in_history',
        'anchorDate',
      );
      expectRuleViolation(
        await patch({ anchorDate: '2026-02-10' }),
        'renewal_month_in_history',
        'anchorDate',
      );
      expectRuleViolation(
        await patch({ anchorDate: '2025-12-31' }),
        'renewal_month_in_history',
        'anchorDate',
      );
    });

    it('is atomic: the other fields of a refused patch are not applied', async () => {
      const { app, sub, patch } = await octoberApp();
      expectRuleViolation(
        await patch({ name: 'Renamed', notes: 'x', anchorDate: '2026-06-10' }),
        'renewal_month_in_history',
        'anchorDate',
      );
      const [stored] = (await request(app).get('/api/subscriptions').expect(200))
        .body as SubscriptionDto[];
      expect(stored).toMatchObject({ name: sub.name, notes: null, anchorDate: '2026-03-10' });
    });

    it('also refuses a subscription that has been cancelled (its months are closed all the same)', async () => {
      const { app, sub } = await octoberApp();
      await request(app)
        .post(`/api/subscriptions/${sub.id}/cancel`)
        .send({ endMonth: '2026-06' })
        .expect(200);
      expectRuleViolation(
        await request(app).patch(`/api/subscriptions/${sub.id}`).send({ anchorDate: '2026-09-10' }),
        'renewal_month_in_history',
        'anchorDate',
      );
    });

    it('looks at the subscription as stored: a start month in the same request does not lift it', async () => {
      const { patch } = await octoberApp();
      expectRuleViolation(
        await patch({ startMonth: '2026-10', anchorDate: '2026-06-10' }),
        'renewal_month_in_history',
        'anchorDate',
      );
    });

    it('is checked after the start-month rules', async () => {
      const { app, sub } = await octoberApp();
      await request(app)
        .post(`/api/subscriptions/${sub.id}/cancel`)
        .send({ endMonth: '2026-04' })
        .expect(200);
      // Both break a rule: the start after the end month is reported first.
      expectRuleViolation(
        await request(app)
          .patch(`/api/subscriptions/${sub.id}`)
          .send({ startMonth: '2026-06', anchorDate: '2026-09-10' }),
        'end_before_start',
        'startMonth',
      );
    });

    it('accepts any anchorDate change while no month has closed: starting this month, or later', async () => {
      // March 2026 in the default clock: a subscription started in March has no closed month.
      const current = await addSubscription(app, {
        name: 'This month',
        frequency: 'yearly',
        anchorDate: '2026-03-10',
        startMonth: '2026-03',
        amount: 12000,
      });
      const upcoming = await addSubscription(app, {
        name: 'Next month',
        frequency: 'yearly',
        anchorDate: '2026-03-10',
        startMonth: '2026-04',
        amount: 12000,
      });
      for (const sub of [current, upcoming]) {
        const res = await request(app)
          .patch(`/api/subscriptions/${sub.id}`)
          .send({ anchorDate: '2026-09-15' })
          .expect(200);
        expect(res.body.anchorDate).toBe('2026-09-15');
      }
    });

    it('is refused from the first closed month: the month after the start, but not the start month itself', async () => {
      const sub = await addSubscription(app, {
        frequency: 'yearly',
        anchorDate: '2026-03-10',
        startMonth: '2026-03',
        amount: 12000,
      });
      const patch = () =>
        request(app).patch(`/api/subscriptions/${sub.id}`).send({ anchorDate: '2026-09-15' });
      clock.set('2026-03-31T23:59:59Z'); // still March: nothing has closed
      await patch().expect(200);
      clock.set('2026-04-01T00:00:00Z'); // March is closed now
      expectRuleViolation(
        await request(app).patch(`/api/subscriptions/${sub.id}`).send({ anchorDate: '2026-12-15' }),
        'renewal_month_in_history',
        'anchorDate',
      );
    });

    it('never applies to a monthly subscription: its anchor month means nothing', async () => {
      const sub = await addSubscription(app, {
        frequency: 'monthly',
        anchorDate: '2026-01-10',
        startMonth: '2026-01',
        amount: 1299,
      });
      clock.set('2026-10-15T12:00:00Z');
      const res = await request(app)
        .patch(`/api/subscriptions/${sub.id}`)
        .send({ anchorDate: '2026-06-10' })
        .expect(200);
      expect(res.body.anchorDate).toBe('2026-06-10');
    });
  });
});

describe('PUT /api/subscriptions/:id/prices/:month', () => {
  it('adds a price and answers 200 with the whole subscription, prices ascending', async () => {
    const sub = await addSubscription(app, { amount: 1299, startMonth: '2026-01' });
    await putPrice(sub.id, '2026-09', 1999).expect(200);
    const res = await putPrice(sub.id, '2026-05', 1499).expect(200);
    expect(res.body.prices).toEqual([
      price('2026-01', 1299),
      price('2026-05', 1499),
      price('2026-09', 1999),
    ]);
    expect(res.body.id).toBe(sub.id);
  });

  it('replaces the price of exactly that month instead of adding another', async () => {
    const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-01' });
    await putPrice(sub.id, '2026-04', 1100).expect(200);
    const res = await putPrice(sub.id, '2026-04', 1150).expect(200);
    expect(res.body.prices).toEqual([price('2026-01', 1000), price('2026-04', 1150)]);
  });

  it('replaces the first price when given the start month', async () => {
    const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-02' });
    const res = await putPrice(sub.id, '2026-02', 1234).expect(200);
    expect(res.body.prices).toEqual([price('2026-02', 1234)]);
  });

  it('has the current price and the monthly equivalent follow the clock', async () => {
    const sub = await addSubscription(app, {
      frequency: 'yearly',
      amount: 12000,
      startMonth: '2026-01',
    });
    await putPrice(sub.id, '2026-06', 12001).expect(200);
    expect((await list())[0]).toMatchObject({ currentPrice: 12000, monthlyEquivalent: 1000 });

    clock.set('2026-05-31T23:59:59Z');
    expect((await list())[0]?.currentPrice).toBe(12000);
    clock.set('2026-06-01T00:00:00Z');
    expect((await list())[0]).toMatchObject({ currentPrice: 12001, monthlyEquivalent: 1001 });
  });

  describe('outside_active_months (422)', () => {
    it('refuses a month before the subscription starts', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-03' });
      expectRuleViolation(await putPrice(sub.id, '2026-02', 5), 'outside_active_months', 'month');
    });

    it('refuses a month after the end month, and accepts the end month itself', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-01' });
      await request(app)
        .post(`/api/subscriptions/${sub.id}/cancel`)
        .send({ endMonth: '2026-05' })
        .expect(200);
      expectRuleViolation(await putPrice(sub.id, '2026-06', 5), 'outside_active_months', 'month');
      await putPrice(sub.id, '2026-05', 5).expect(200);
    });

    it('leaves the prices unchanged when refused', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-03' });
      await putPrice(sub.id, '2025-12', 5).expect(422);
      expect((await list())[0]?.prices).toEqual(sub.prices);
    });
  });

  it('is a 404 for an unknown subscription', async () => {
    expectNotFound(await putPrice(99, '2026-04', 5));
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad month', '2026-13', { amount: 5 }, 'month'],
      ['an empty body', '2026-04', {}, 'amount'],
      ['a zero price', '2026-04', { amount: 0 }, 'amount'],
      ['a negative price', '2026-04', { amount: -1 }, 'amount'],
      ['a fractional price', '2026-04', { amount: 14.99 }, 'amount'],
      ['a string price', '2026-04', { amount: '1499' }, 'amount'],
      ['an unknown key', '2026-04', { amount: 1, month: '2026-04' }, ''],
    ])('rejects %s', async (_label, month, body, path) => {
      const sub = await addSubscription(app, { startMonth: '2026-01' });
      expectValidationError(
        await request(app).put(`/api/subscriptions/${sub.id}/prices/${month}`).send(body),
        path,
      );
    });
  });
});

describe('POST /api/subscriptions/:id/cancel', () => {
  const cancel = (id: number, body?: object) => {
    const req = request(app).post(`/api/subscriptions/${id}/cancel`);
    return body === undefined ? req : req.send(body);
  };

  it('defaults to the current month, with no body at all', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    const res = await cancel(sub.id).expect(200);
    expect(res.body).toMatchObject({ id: sub.id, endMonth: '2026-03', status: 'active' });
  });

  it('also accepts an empty object', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    expect((await cancel(sub.id, {}).expect(200)).body.endMonth).toBe('2026-03');
  });

  it('takes an explicit end month, in the past or in the future', async () => {
    const past = await addSubscription(app, { name: 'Past', startMonth: '2026-01' });
    const future = await addSubscription(app, { name: 'Future', startMonth: '2026-01' });
    expect((await cancel(past.id, { endMonth: '2026-02' }).expect(200)).body).toMatchObject({
      endMonth: '2026-02',
      status: 'cancelled',
    });
    expect((await cancel(future.id, { endMonth: '2026-08' }).expect(200)).body).toMatchObject({
      endMonth: '2026-08',
      status: 'active',
    });
  });

  it('keeps charging in the end month: cancelled with this month as end month is still active', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    await cancel(sub.id).expect(200); // end month: March
    expect((await list())[0]).toMatchObject({ status: 'active', endMonth: '2026-03' });

    clock.set('2026-03-31T23:59:59Z');
    expect((await list())[0]?.status).toBe('active');
    clock.set('2026-04-01T00:00:00Z');
    expect((await list())[0]).toMatchObject({ status: 'cancelled', currentPrice: 1299 });
  });

  it('deletes no price: those after the end month are inert, and apply again when the end month moves later', async () => {
    const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-01' });
    for (const [month, amount] of [
      ['2026-03', 2000],
      ['2026-06', 3000],
      ['2026-09', 4000],
    ] as const) {
      await putPrice(sub.id, month, amount).expect(200);
    }
    const all = [
      price('2026-01', 1000),
      price('2026-03', 2000),
      price('2026-06', 3000),
      price('2026-09', 4000),
    ];
    let res = await cancel(sub.id, { endMonth: '2026-04' }).expect(200);
    expect(res.body.prices).toEqual(all);

    // Cancelling again further out brings the planned changes back into effect.
    res = await cancel(sub.id, { endMonth: '2026-12' }).expect(200);
    expect(res.body.endMonth).toBe('2026-12');
    expect(res.body.prices).toEqual(all);
    const october = (await request(app).get('/api/months/2026-10').expect(200)).body as MonthView;
    expect(october.subscriptions[0]).toMatchObject({ price: 4000, charge: 4000 });
  });

  it('shows the price in effect in the end month as current, never an inert later one', async () => {
    const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-01' });
    await putPrice(sub.id, '2026-03', 2000).expect(200);
    await putPrice(sub.id, '2026-06', 3000).expect(200);
    await cancel(sub.id, { endMonth: '2026-04' }).expect(200);
    clock.set('2026-12-01T00:00:00Z'); // well after the end: June's price is inert
    expect((await list())[0]).toMatchObject({
      status: 'cancelled',
      currentPrice: 2000,
      monthlyEquivalent: 2000,
    });
    expect((await list())[0]?.prices).toHaveLength(3);
  });

  it('keeps a price effective exactly in the end month', async () => {
    const sub = await addSubscription(app, { amount: 1000, startMonth: '2026-01' });
    await putPrice(sub.id, '2026-06', 3000).expect(200);
    const res = await cancel(sub.id, { endMonth: '2026-06' }).expect(200);
    expect(res.body.prices).toEqual([price('2026-01', 1000), price('2026-06', 3000)]);
  });

  it('moves the end month when cancelled again, earlier or later', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    await cancel(sub.id, { endMonth: '2026-06' }).expect(200);
    expect((await cancel(sub.id, { endMonth: '2026-04' }).expect(200)).body.endMonth).toBe(
      '2026-04',
    );
    expect((await cancel(sub.id, { endMonth: '2026-09' }).expect(200)).body.endMonth).toBe(
      '2026-09',
    );
  });

  it('is a 404 for an unknown subscription', async () => {
    expectNotFound(await cancel(99));
  });

  describe('end_before_start (422)', () => {
    it('refuses an end month before the start month and accepts the start month itself', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-02' });
      expectRuleViolation(
        await cancel(sub.id, { endMonth: '2026-01' }),
        'end_before_start',
        'endMonth',
      );
      await cancel(sub.id, { endMonth: '2026-02' }).expect(200);
    });

    it('applies to the default end month too: an upcoming subscription cannot be cancelled "now"', async () => {
      const sub = await addSubscription(app, { startMonth: '2026-05' });
      expectRuleViolation(await cancel(sub.id), 'end_before_start', 'endMonth');
      expect((await list())[0]?.endMonth).toBeNull();
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad end month', { endMonth: '2027-13' }, 'endMonth'],
      ['a null end month', { endMonth: null }, 'endMonth'],
      ['an unknown key', { reason: 'too expensive' }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const sub = await addSubscription(app, { startMonth: '2026-01' });
      expectValidationError(await cancel(sub.id, body), path);
    });
  });
});

describe('DELETE /api/subscriptions/:id', () => {
  it('deletes the subscription (204, no body) and its prices', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    await putPrice(sub.id, '2026-06', 5).expect(200);
    expect(db.select().from(subscriptionPrices).all()).toHaveLength(2);

    const res = await request(app).delete(`/api/subscriptions/${sub.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await list()).toEqual([]);
    expect(db.select().from(subscriptionPrices).all()).toEqual([]);
  });

  it('only removes that subscription', async () => {
    const a = await addSubscription(app, { name: 'A' });
    const b = await addSubscription(app, { name: 'B' });
    await request(app).delete(`/api/subscriptions/${a.id}`).expect(204);
    expect((await list()).map((s) => s.id)).toEqual([b.id]);
    expect(db.select().from(subscriptionPrices).all()).toHaveLength(1);
  });

  it('can delete a cancelled subscription too (it vanishes from past months)', async () => {
    const sub = await addSubscription(app, { startMonth: '2026-01' });
    await request(app)
      .post(`/api/subscriptions/${sub.id}/cancel`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    await request(app).delete(`/api/subscriptions/${sub.id}`).expect(204);
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const sub = await addSubscription(app);
    expectNotFound(await request(app).delete('/api/subscriptions/99'));
    await request(app).delete(`/api/subscriptions/${sub.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/subscriptions/${sub.id}`));
  });

  it('rejects a bad id (400)', async () => {
    expectValidationError(await request(app).delete('/api/subscriptions/abc'), 'id');
  });
});

describe('status and currentPrice around month boundaries', () => {
  it('turns upcoming into active in the first instant of the start month', async () => {
    clock.set('2026-03-31T23:59:59Z');
    const sub = await addSubscription(app, {
      startMonth: '2026-04',
      frequency: 'yearly',
      amount: 12000,
    });
    expect(sub).toMatchObject({ status: 'upcoming', currentPrice: null, monthlyEquivalent: null });

    clock.set('2026-04-01T00:00:00Z');
    expect((await list())[0]).toMatchObject({
      status: 'active',
      currentPrice: 12000,
      monthlyEquivalent: 1000,
    });
  });

  it('uses the server-local month, so Rome flips a few hours before UTC does', async () => {
    clock.set('2026-03-31T23:30:00Z');
    await addSubscription(app, { name: 'April', startMonth: '2026-04' });
    expect((await list())[0]?.status).toBe('upcoming');
    const inRome = await withTimeZone('Europe/Rome', list);
    expect(inRome[0]).toMatchObject({ status: 'active', currentPrice: 1299 });
  });
});
