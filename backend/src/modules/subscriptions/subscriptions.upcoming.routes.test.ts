/**
 * GET /api/subscriptions/upcoming (docs/DOMAIN.md, "Upcoming renewals"): the next billing date of
 * every subscription within the window, the price from the price rows, and for a yearly one what is
 * reserved towards it. Every rule of the documented order has a test, and the reserve is checked
 * against the month views of the same ledger.
 */
import type { MonthView, SubscriptionDto, UpcomingRenewalDto } from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import {
  type MutableClock,
  addSubscription,
  expectApiError,
  expectNotFound,
  expectValidationError,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let clock: MutableClock;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 0 });
});

const upcoming = async (query = ''): Promise<UpcomingRenewalDto[]> =>
  (await request(app).get(`/api/subscriptions/upcoming${query}`).expect(200)).body;

/** The upcoming list as [name, date] pairs, for the many tests that only check what is listed. */
const dates = async (query = ''): Promise<[string, string][]> =>
  (await upcoming(query)).map((item) => [item.name, item.date]);

const month = async (key: string): Promise<MonthView> =>
  (await request(app).get(`/api/months/${key}`).expect(200)).body;

const cancel = (id: number, endMonth: string) =>
  request(app).post(`/api/subscriptions/${id}/cancel`).send({ endMonth }).expect(200);

const putPrice = (id: number, at: string, amount: number) =>
  request(app).put(`/api/subscriptions/${id}/prices/${at}`).send({ amount }).expect(200);

/** 1200.00 a year, renewing on 25 March, saved up from January: 400.00 a month. */
const domain = (overrides: Partial<Parameters<typeof addSubscription>[1]> = {}) =>
  addSubscription(app, {
    name: 'Domain',
    frequency: 'yearly',
    anchorDate: '2026-03-25',
    amount: 120000,
    startMonth: '2026-01',
    ...overrides,
  });

describe('GET /api/subscriptions/upcoming', () => {
  it('lists the next billing date of a monthly subscription with exactly the documented fields', async () => {
    const netflix = await addSubscription(app, {
      name: 'Netflix',
      anchorDate: '2026-01-20',
      amount: 1299,
      startMonth: '2026-01',
      color: '#e50914',
    });
    const res = await request(app).get('/api/subscriptions/upcoming').expect(200);
    expect(res.body).toEqual([
      {
        id: netflix.id,
        name: 'Netflix',
        color: '#e50914',
        frequency: 'monthly',
        yearly: false,
        date: '2026-03-20',
        daysUntil: 5,
        amount: 1299,
        reserved: null,
        unreserved: null,
      },
    ]);
  });

  it('is an empty list when there are no subscriptions', async () => {
    expect(await upcoming()).toEqual([]);
    expect(await upcoming('?days=366')).toEqual([]);
  });

  describe('the window', () => {
    it('includes today and the last day, and excludes a date beyond it', async () => {
      await addSubscription(app, {
        name: 'Today',
        anchorDate: '2026-01-15',
        startMonth: '2026-01',
      });
      await addSubscription(app, { name: 'Edge', anchorDate: '2026-01-20', startMonth: '2026-01' });
      await addSubscription(app, {
        name: 'Beyond',
        anchorDate: '2026-01-21',
        startMonth: '2026-01',
      });

      expect(await dates('?days=5')).toEqual([
        ['Today', '2026-03-15'],
        ['Edge', '2026-03-20'],
      ]);
      expect(await dates('?days=4')).toEqual([['Today', '2026-03-15']]);
      expect(await dates('?days=6')).toHaveLength(3);
      const [today] = await upcoming('?days=1');
      expect(today).toMatchObject({ name: 'Today', daysUntil: 0 });
    });

    it('defaults to 30 days', async () => {
      // Today is the 15th. Billing on the 14th: the next date is 2026-04-14, 30 days away. Billing
      // on the 15th from April on: 2026-04-15, 31 days away.
      await addSubscription(app, { name: 'In30', anchorDate: '2026-01-14', startMonth: '2026-01' });
      await addSubscription(app, { name: 'In31', anchorDate: '2026-01-15', startMonth: '2026-04' });
      expect(await dates()).toEqual([['In30', '2026-04-14']]);
      expect((await upcoming('?days=30'))[0]?.daysUntil).toBe(30);
      expect(await dates('?days=31')).toHaveLength(2);
    });

    it('takes the next date after one that has passed this month', async () => {
      await addSubscription(app, {
        name: 'Early',
        anchorDate: '2026-01-10',
        startMonth: '2026-01',
      });
      const [item] = await upcoming('?days=30');
      expect(item).toMatchObject({ date: '2026-04-10', daysUntil: 26 });
    });

    it('lists a subscription once, even when a wide window holds several of its dates', async () => {
      await addSubscription(app, {
        name: 'Often',
        anchorDate: '2026-01-20',
        startMonth: '2026-01',
      });
      expect(await dates('?days=366')).toEqual([['Often', '2026-03-20']]);
    });

    it('finds the next yearly renewal even when it is almost a year away', async () => {
      await domain(); // renewal 25 March: this year's is 10 days away
      clock.set('2026-03-26T10:00:00Z');
      // The next one is 2027-03-25, 364 days away: only the widest windows reach it.
      expect(await upcoming('?days=363')).toEqual([]);
      expect(await dates('?days=364')).toEqual([['Domain', '2027-03-25']]);
      expect(await dates('?days=366')).toEqual([['Domain', '2027-03-25']]);
    });

    it('uses the server time zone for today', async () => {
      await addSubscription(app, {
        name: 'April',
        anchorDate: '2026-01-01',
        startMonth: '2026-01',
      });
      clock.set('2026-03-31T23:30:00Z');
      // In UTC it is still 31 March, so the 1st is tomorrow; in Rome it is already 1 April, so it is today.
      expect((await upcoming('?days=1'))[0]).toMatchObject({ date: '2026-04-01', daysUntil: 1 });
      const inRome = await withTimeZone('Europe/Rome', () => upcoming('?days=1'));
      expect(inRome[0]).toMatchObject({ date: '2026-04-01', daysUntil: 0 });
    });
  });

  describe('the billing day', () => {
    it('clamps day 31 to the length of the month', async () => {
      await addSubscription(app, { name: 'Rent', anchorDate: '2026-01-31', startMonth: '2026-01' });
      clock.set('2026-02-10T10:00:00Z');
      expect(await dates()).toEqual([['Rent', '2026-02-28']]);
      clock.set('2026-04-01T10:00:00Z');
      expect(await dates()).toEqual([['Rent', '2026-04-30']]);
      clock.set('2026-05-01T10:00:00Z');
      expect(await dates()).toEqual([['Rent', '2026-05-31']]);
    });

    it('clamps in February of a leap year to the 29th and of another year to the 28th', async () => {
      await addSubscription(app, { name: 'Rent', anchorDate: '2026-01-30', startMonth: '2026-01' });
      clock.set('2028-02-10T10:00:00Z');
      expect(await dates()).toEqual([['Rent', '2028-02-29']]);
      clock.set('2027-02-10T10:00:00Z');
      expect(await dates()).toEqual([['Rent', '2027-02-28']]);
    });

    it('goes to the next month when the clamped day has passed', async () => {
      await addSubscription(app, { name: 'Rent', anchorDate: '2026-01-31', startMonth: '2026-01' });
      clock.set('2026-04-30T10:00:00Z'); // the clamped day itself is today
      expect((await upcoming('?days=1'))[0]).toMatchObject({ date: '2026-04-30', daysUntil: 0 });
      clock.set('2026-05-01T10:00:00Z');
      expect(await dates('?days=1')).toEqual([]);
    });

    it('clamps a 29 February billing day of a yearly subscription in a non-leap year', async () => {
      await addSubscription(app, {
        name: 'Leap',
        frequency: 'yearly',
        anchorDate: '2024-02-29',
        amount: 24000,
        startMonth: '2026-01',
      });
      clock.set('2026-02-01T10:00:00Z');
      expect(await dates()).toEqual([['Leap', '2026-02-28']]);
      clock.set('2027-02-28T10:00:00Z');
      expect(await dates('?days=1')).toEqual([['Leap', '2027-02-28']]);
      // The next day the real 29 February of 2028 is the next date, 365 days ahead.
      clock.set('2027-03-01T10:00:00Z');
      expect(await dates('?days=366')).toEqual([['Leap', '2028-02-29']]);
    });
  });

  describe('which subscriptions appear', () => {
    it('leaves out a subscription cancelled before the current month', async () => {
      const old = await addSubscription(app, {
        name: 'Old',
        anchorDate: '2026-01-20',
        startMonth: '2026-01',
      });
      await cancel(old.id, '2026-02');
      expect(await upcoming()).toEqual([]);
    });

    it('lists a monthly subscription cancelled with this month as its end month while its date is ahead', async () => {
      const ahead = await addSubscription(app, {
        name: 'Ahead',
        anchorDate: '2026-01-20',
        startMonth: '2026-01',
      });
      const passed = await addSubscription(app, {
        name: 'Passed',
        anchorDate: '2026-01-10',
        startMonth: '2026-01',
      });
      await cancel(ahead.id, '2026-03');
      await cancel(passed.id, '2026-03');
      // The next billing date of "Passed" is in April, after its last month: it is not charged again.
      expect(await dates()).toEqual([['Ahead', '2026-03-20']]);
    });

    it('moves a subscription back in when its end month moves later, and out when it moves earlier', async () => {
      const sub = await addSubscription(app, {
        name: 'Gym',
        anchorDate: '2026-01-20',
        startMonth: '2026-01',
      });
      await cancel(sub.id, '2026-03');
      expect(await dates('?days=60')).toEqual([['Gym', '2026-03-20']]);
      await cancel(sub.id, '2026-06');
      expect(await dates('?days=60')).toEqual([['Gym', '2026-03-20']]);
      clock.set('2026-03-25T10:00:00Z');
      expect(await dates('?days=60')).toEqual([['Gym', '2026-04-20']]);
      await cancel(sub.id, '2026-03');
      expect(await dates('?days=60')).toEqual([]);
    });

    it('lists a subscription that starts next month once its first billing date is in the window', async () => {
      await addSubscription(app, {
        name: 'April',
        anchorDate: '2026-01-05',
        startMonth: '2026-04',
      });
      await addSubscription(app, { name: 'May', anchorDate: '2026-01-05', startMonth: '2026-05' });
      expect(await dates()).toEqual([['April', '2026-04-05']]);
      expect(await dates('?days=60')).toEqual([
        ['April', '2026-04-05'],
        ['May', '2026-05-05'],
      ]);
    });

    it('does not list a subscription whose start month is after its next billing in the window', async () => {
      // Billing on the 10th: this month's has passed, next month's is before the start month.
      await addSubscription(app, { name: 'May', anchorDate: '2026-01-10', startMonth: '2026-05' });
      expect(await dates('?days=40')).toEqual([]);
    });

    it('lists a yearly subscription only in its renewal month', async () => {
      await domain({ anchorDate: '2026-06-10' });
      expect(await upcoming('?days=60')).toEqual([]);
      expect(await dates('?days=100')).toEqual([['Domain', '2026-06-10']]);
    });

    it('does not list a yearly subscription that ends before its renewal, and does when it ends in it', async () => {
      const sub = await domain();
      await cancel(sub.id, '2026-02');
      expect(await upcoming('?days=60')).toEqual([]);
      await cancel(sub.id, '2026-03');
      expect(await dates('?days=60')).toEqual([['Domain', '2026-03-25']]);
    });

    it('does not list a yearly subscription that ends in the renewal month after the renewal date', async () => {
      const sub = await domain();
      await cancel(sub.id, '2026-03');
      clock.set('2026-03-28T10:00:00Z');
      expect(await upcoming('?days=366')).toEqual([]);
    });

    it('sorts by date, then by id', async () => {
      const b = await addSubscription(app, {
        name: 'B',
        anchorDate: '2026-01-22',
        startMonth: '2026-01',
      });
      const a = await addSubscription(app, {
        name: 'A',
        anchorDate: '2026-01-22',
        startMonth: '2026-01',
      });
      const early = await addSubscription(app, {
        name: 'Z',
        anchorDate: '2026-01-16',
        startMonth: '2026-01',
      });
      const late = await addSubscription(app, {
        name: 'C',
        anchorDate: '2026-01-29',
        startMonth: '2026-01',
      });
      expect((await upcoming()).map((item) => item.id)).toEqual([early.id, b.id, a.id, late.id]);
    });
  });

  describe('the price', () => {
    it('is the price row in effect in the renewal month, not the current one', async () => {
      const sub = await addSubscription(app, {
        name: 'Netflix',
        anchorDate: '2026-01-10',
        amount: 1299,
        startMonth: '2026-01',
      });
      await putPrice(sub.id, '2026-04', 1599); // from April on; March still costs 12.99
      // Today is the 15th, so the next billing is 10 April: it is charged at the April price.
      expect((await upcoming())[0]).toMatchObject({ date: '2026-04-10', amount: 1599 });
      // A price dated after the renewal month does not apply to it.
      await putPrice(sub.id, '2026-05', 1999);
      expect((await upcoming())[0]).toMatchObject({ date: '2026-04-10', amount: 1599 });
    });

    it('uses the price in the current month for a date still ahead this month', async () => {
      const sub = await addSubscription(app, {
        name: 'Netflix',
        anchorDate: '2026-01-20',
        amount: 1299,
        startMonth: '2026-01',
      });
      await putPrice(sub.id, '2026-04', 1599);
      expect((await upcoming())[0]).toMatchObject({ date: '2026-03-20', amount: 1299 });
    });

    it('reads a price row dated before the start month when it is the one in effect', async () => {
      const sub = await addSubscription(app, {
        name: 'Gym',
        anchorDate: '2026-01-20',
        amount: 3000,
        startMonth: '2026-02',
      });
      await request(app)
        .patch(`/api/subscriptions/${sub.id}`)
        .send({ startMonth: '2026-03' })
        .expect(200);
      expect((await upcoming())[0]).toMatchObject({ date: '2026-03-20', amount: 3000 });
    });

    it('ignores a price row dated after the end month', async () => {
      const sub = await addSubscription(app, {
        name: 'Gym',
        anchorDate: '2026-01-20',
        amount: 3000,
        startMonth: '2026-01',
      });
      await putPrice(sub.id, '2026-06', 9900);
      await cancel(sub.id, '2026-04');
      expect((await upcoming())[0]).toMatchObject({ date: '2026-03-20', amount: 3000 });
      clock.set('2026-04-25T10:00:00Z');
      expect(await upcoming()).toEqual([]);
    });

    it('differs from nextRenewalPrice of the month view when the price changes in the renewal month', async () => {
      const sub = await domain();
      clock.set('2026-02-15T10:00:00Z');
      await putPrice(sub.id, '2026-03', 180000);
      const february = await month('2026-02');
      expect(february.subscriptions[0]).toMatchObject({
        nextRenewalMonth: '2026-03',
        nextRenewalPrice: 120000, // what February saves towards
      });
      expect((await upcoming('?days=60'))[0]).toMatchObject({ date: '2026-03-25', amount: 180000 });
    });
  });

  describe('what a yearly subscription has reserved', () => {
    it('has a reserve of 0 and the whole price still to find when the renewal is next year', async () => {
      await domain({ startMonth: '2026-04' });
      clock.set('2026-04-01T10:00:00Z'); // the next renewal is 25 March 2027
      const [item] = await upcoming('?days=366');
      expect(item).toMatchObject({ date: '2027-03-25', amount: 120000 });
      // April saves 120000 / 12 = 10000, and that counts: it is this month's fixed cost.
      expect(item).toMatchObject({ reserved: 10000, unreserved: 110000, yearly: true });
      expect((await month('2026-04')).subscriptions[0]?.reserveBalance).toBe(10000);
    });

    it('equals the end-of-month reserve of the current month for a renewal next month', async () => {
      await domain();
      clock.set('2026-02-15T10:00:00Z');
      // January and February each set aside 40000 towards the 25 March renewal.
      const february = await month('2026-02');
      expect(february.subscriptions[0]?.reserveBalance).toBe(80000);
      expect((await upcoming('?days=60'))[0]).toMatchObject({
        date: '2026-03-25',
        amount: 120000,
        reserved: 80000,
        unreserved: 40000,
      });
    });

    it('counts the whole price as reserved for a renewal in the current month', async () => {
      await domain();
      // March: 80000 held, this month's top-up of 40000 brings it to the price, the renewal pays it.
      const march = await month('2026-03');
      expect(march.subscriptions[0]).toMatchObject({
        charge: 40000,
        renewalThisMonth: true,
        reserveBalance: 0,
      });
      expect((await upcoming())[0]).toMatchObject({
        date: '2026-03-25',
        yearly: true,
        amount: 120000,
        reserved: 120000,
        unreserved: 0,
      });
    });

    it("is 0 after this year's renewal date has passed, with the next one a year away", async () => {
      await domain();
      clock.set('2026-03-28T10:00:00Z');
      const [item] = await upcoming('?days=366');
      expect(item).toMatchObject({ date: '2027-03-25', amount: 120000 });
      // March paid the renewal and its reserve is 0; the top-ups for 2027 start in April.
      expect((await month('2026-03')).subscriptions[0]?.reserveBalance).toBe(0);
      expect(item).toMatchObject({ reserved: 0, unreserved: 120000 });
    });

    it('is 0 for a subscription that has not started, whose first charge is its start month', async () => {
      await domain({ startMonth: '2026-04', anchorDate: '2026-04-20' });
      expect((await upcoming('?days=40'))[0]).toMatchObject({
        date: '2026-04-20',
        amount: 120000,
        reserved: 0,
        unreserved: 120000,
      });
      // The ledger charges the full price in the start month when it renews in it.
      expect((await month('2026-04')).subscriptions[0]).toMatchObject({
        charge: 120000,
        renewalThisMonth: true,
      });
    });

    it('caps the reserve at the price when the price drops in the renewal month', async () => {
      const sub = await domain();
      clock.set('2026-02-15T10:00:00Z');
      await putPrice(sub.id, '2026-03', 50000);
      // 80000 is held after February, but only 50000 will be paid (the rest is released in March).
      expect((await upcoming('?days=60'))[0]).toMatchObject({
        amount: 50000,
        reserved: 50000,
        unreserved: 0,
      });
    });

    it('caps the reserve at the price in the current month too, even though more is released', async () => {
      const sub = await domain();
      await putPrice(sub.id, '2026-03', 50000);
      const march = await month('2026-03');
      expect(march.subscriptions[0]).toMatchObject({ reserveReleased: 30000, reserveBalance: 0 });
      expect((await upcoming())[0]).toMatchObject({
        amount: 50000,
        reserved: 50000,
        unreserved: 0,
      });
    });

    it('shows a price rise in the renewal month as still to find when it is next month', async () => {
      const sub = await domain();
      clock.set('2026-02-15T10:00:00Z');
      await putPrice(sub.id, '2026-03', 180000);
      expect((await upcoming('?days=60'))[0]).toMatchObject({
        amount: 180000,
        reserved: 80000,
        unreserved: 100000,
      });
    });

    it('counts a price rise in the renewal month as reserved once it is the current month', async () => {
      const sub = await domain();
      await putPrice(sub.id, '2026-03', 180000);
      // March tops the reserve up by 100000 to pay 180000: all of it is set aside this month.
      expect((await month('2026-03')).subscriptions[0]).toMatchObject({ charge: 100000 });
      expect((await upcoming())[0]).toMatchObject({
        amount: 180000,
        reserved: 180000,
        unreserved: 0,
      });
    });

    it('is null for a monthly subscription', async () => {
      await addSubscription(app, {
        name: 'Netflix',
        anchorDate: '2026-01-20',
        startMonth: '2026-01',
      });
      expect((await upcoming())[0]).toMatchObject({
        yearly: false,
        reserved: null,
        unreserved: null,
      });
    });

    it('always satisfies reserved + unreserved = amount and 0 <= reserved <= amount', async () => {
      const sub = await domain();
      for (const [now, change] of [
        ['2026-01-10T10:00:00Z', null],
        ['2026-02-20T10:00:00Z', ['2026-03', 90000]],
        ['2026-03-01T10:00:00Z', ['2026-03', 300000]],
        ['2026-03-31T10:00:00Z', null],
        ['2026-04-10T10:00:00Z', ['2026-04', 1000]],
        ['2026-12-01T10:00:00Z', null],
      ] as const) {
        clock.set(now);
        if (change) await putPrice(sub.id, change[0], change[1]);
        for (const item of await upcoming('?days=366')) {
          expect(item.reserved).not.toBeNull();
          expect(item.reserved).toBeGreaterThanOrEqual(0);
          expect(item.reserved).toBeLessThanOrEqual(item.amount);
          expect((item.reserved ?? 0) + (item.unreserved ?? 0)).toBe(item.amount);
        }
      }
    });
  });

  describe('validation', () => {
    it.each([
      ['0', 'zero days'],
      ['367', 'a window over the maximum'],
      ['-1', 'a negative window'],
      ['1.5', 'a fraction'],
      ['1e1', 'an exponent'],
      ['', 'a blank value'],
      ['abc', 'text'],
      [' 30', 'a leading space'],
    ])('rejects days=%s (%s) with a 400 at days', async (value) => {
      expectValidationError(
        await request(app).get(`/api/subscriptions/upcoming?days=${value}`),
        'days',
      );
    });

    it('rejects a repeated days and an unknown parameter', async () => {
      expectValidationError(
        await request(app).get('/api/subscriptions/upcoming?days=10&days=20'),
        'days',
      );
      expectValidationError(await request(app).get('/api/subscriptions/upcoming?weeks=2'), '');
    });

    it('accepts the smallest and the largest window', async () => {
      await request(app).get('/api/subscriptions/upcoming?days=1').expect(200);
      await request(app).get('/api/subscriptions/upcoming?days=366').expect(200);
    });
  });

  describe('routing', () => {
    it('is not read as a subscription id', async () => {
      // A route registered after `/:id` would treat "upcoming" as an id and fail validation or 404.
      const res = await request(app).get('/api/subscriptions/upcoming');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('does not shadow the subscription list', async () => {
      const sub: SubscriptionDto = await addSubscription(app, { startMonth: '2026-01' });
      const res = await request(app).get('/api/subscriptions').expect(200);
      expect(res.body.map((item: SubscriptionDto) => item.id)).toEqual([sub.id]);
    });

    it('answers 404 for other paths below it and for other methods', async () => {
      expectNotFound(await request(app).get('/api/subscriptions/upcoming/extra'));
      expectNotFound(await request(app).post('/api/subscriptions/upcoming'));
      expectNotFound(await request(app).get('/api/subscriptions/upcomin'));
    });

    it('answers 409 not_onboarded before the settings exist, ahead of validation', async () => {
      const bare = createDb(':memory:');
      runMigrations(bare);
      const fresh = createApp({ db: bare, clock, config: { env: 'test', staticDir: undefined } });
      expectApiError(await request(fresh).get('/api/subscriptions/upcoming'), 'not_onboarded');
      expectApiError(
        await request(fresh).get('/api/subscriptions/upcoming?days=0'),
        'not_onboarded',
      );
    });
  });
});
