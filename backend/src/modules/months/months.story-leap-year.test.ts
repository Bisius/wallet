/**
 * Story 4: a leap year and a year wrap, with the server clock on the wrong side of midnight.
 *
 * October 2027 to March 2028 is lived through the public API in the Auckland time zone (NZDT,
 * UTC+13), so that the clock is set to the very last and first second of months: 1 October 00:00:00
 * (still 30 September in UTC), 31 October 23:59:59 and 1 November 00:00:00, and the leap day, 29
 * February 2028, at 23:59:59. The New Year and the leap day are then replayed at their last and
 * first second in Auckland, Los Angeles and UTC. Three yearly subscriptions renew across the wrap: Magazine in December (anchored on
 * 31 December), Gym in January (31 January) and Domain in February (anchored on 29 February 2028, a
 * date that exists in a leap year only). A monthly one is anchored on the 31st. The expected figures
 * are worked out by hand in the comments. The independent model and the oracle are not used.
 *
 *   salary 2000.00; Food 300.00 (settled every month); fixed costs:
 *   Cloud 12.00 a month; Domain 100.00 a year, renewing in February; Magazine 90.00 a year, in
 *   December; Gym 60.00 a year, in January (from November)
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  addSpending,
  addSubscription,
  expectRuleViolation,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import {
  balances,
  budgetLine,
  getJson,
  monthSummaries,
  monthView,
  reserve,
  subscriptionLine,
  summaryRow,
} from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

const AUCKLAND = 'Pacific/Auckland'; // NZDT, UTC+13, from late September to early April
const LOS_ANGELES = 'America/Los_Angeles'; // PST, UTC-8, in winter

async function liveIt() {
  // 30 September 11:00:00 UTC is 1 October 00:00:00 in Auckland: the first second of October there.
  const clock = mutableClock('2027-09-30T11:00:00Z');
  const { app } = createTestApp(clock);
  await withTimeZone(AUCKLAND, async () => {
    await onboard(app, {
      startMonth: '2027-10',
      salary: 200000,
      openingSavings: 100000,
      budgets: [{ name: 'Food', amount: 30000, incremental: false }], // id 1
    });
    // No start month given: they start in the current month, which is October in Auckland.
    await addSubscription(app, { name: 'Cloud', amount: 1200, anchorDate: '2027-10-31' }); // id 1, monthly
    await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      amount: 10000,
      anchorDate: '2028-02-29', // the leap day: renews every February
    }); // id 2
    await addSubscription(app, {
      name: 'Magazine',
      frequency: 'yearly',
      amount: 9000,
      anchorDate: '2027-12-31', // renews every December
    }); // id 3
    clock.set('2027-10-12T05:00:00Z');
    await addSpending(app, { budgetId: 1, date: '2027-10-12', amount: 22000 });

    // The last second of October, then the first second of November, in Auckland.
    clock.set('2027-10-31T10:59:59Z');
    expect((await getJson<{ date: string }>(app, '/api/today')).date).toBe('2027-10-31');
    clock.set('2027-10-31T11:00:00Z');
    expect((await getJson<{ date: string }>(app, '/api/today')).date).toBe('2027-11-01');
    // Gym, again with no start month: it starts in November, because November has just begun.
    await addSubscription(app, {
      name: 'Gym',
      frequency: 'yearly',
      amount: 6000,
      anchorDate: '2028-01-31', // renews every January
    }); // id 4
    clock.set('2027-11-20T05:00:00Z');
    await addSpending(app, { budgetId: 1, date: '2027-11-20', amount: 28000 });
    clock.set('2027-12-10T05:00:00Z');
    await addSpending(app, { budgetId: 1, date: '2027-12-10', amount: 35000 });

    clock.set('2028-01-08T05:00:00Z'); // the New Year is checked at its last and first second below
    await addSpending(app, { budgetId: 1, date: '2028-01-08', amount: 24000 });

    // The leap day: a receipt dated 29 February, entered at 23:59:59 that evening, one second before March.
    clock.set('2028-02-29T10:59:59Z');
    await addSpending(app, { budgetId: 1, date: '2028-02-29', amount: 31000 });
    clock.set('2028-03-05T05:00:00Z');
    await addSpending(app, { budgetId: 1, date: '2028-03-05', amount: 20000 });
  });
  clock.set('2028-03-15T00:00:00Z'); // mid-March in UTC and in Auckland alike
  return { app, clock };
}

describe('story: a leap year and a year wrap, with the clock either side of midnight', () => {
  it('the server decides what month it is: at the first second of October in Auckland it is not yet October in UTC', async () => {
    const clock = mutableClock('2027-09-30T11:00:00Z');
    const { app } = createTestApp(clock);
    const body = {
      currency: 'EUR',
      locale: 'en-US',
      startMonth: '2027-10',
      salary: 200000,
      openingSavings: 0,
    };
    // In UTC the current month is September, so October is in the future.
    expectRuleViolation(
      await request(app).post('/api/onboarding').send(body),
      'start_month_in_future',
      'startMonth',
    );
    // In Auckland it is 1 October 00:00:00.
    await withTimeZone(AUCKLAND, async () => {
      expect(await getJson(app, '/api/today')).toEqual({ date: '2027-10-01', month: '2027-10' });
      await request(app).post('/api/onboarding').send(body).expect(201);
      // A budget with no start month starts in October, and its first (and only) month is the current one.
      const budget = await addBudget(app, { name: 'Food', amount: 30000, incremental: false });
      expect(budget).toMatchObject({ startMonth: '2027-10', status: 'active' });
      expect((await monthView(app, '2027-10')).status).toBe('current');
    });
  });

  it('month by month across the year wrap and the leap day, to the cent', async () => {
    const { app } = await liveIt();
    const rows = await monthSummaries(app, '2027-10', '2028-03');
    // [month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]
    expect(rows.map(summaryRow)).toEqual([
      // Fixed: Cloud 12.00 + Domain 20.00 (100.00 over October to February, 5 months) + Magazine 30.00
      // (90.00 over October to December, 3 months) = 62.00. Unallocated 2000.00 - 62.00 - 300.00 = 1638.00.
      // Food: 220.00 spent, 80.00 left to move. Due 1718.00.
      ['2027-10', 'closed', 200000, 6200, 30000, 22000, 163800, 171800],
      // Gym joins: 60.00 over November to January (3 months) = 20.00. Fixed 12.00 + 20.00 + 30.00 + 20.00 = 82.00.
      // Unallocated 2000.00 - 82.00 - 300.00 = 1618.00. Food 280.00 spent, 20.00 left. Due 1638.00.
      ['2027-11', 'closed', 200000, 8200, 30000, 28000, 161800, 163800],
      // The Magazine renews (60.00 held + 30.00 = 90.00 is paid out). Food 350.00 spent: 50.00 taken from
      // savings. Due 1618.00 - 50.00 = 1568.00.
      ['2027-12', 'closed', 200000, 8200, 30000, 35000, 161800, 156800],
      // The Magazine starts a 12-month cycle: 90.00 / 12 = 7.50. Gym renews (40.00 held + 20.00 = 60.00 paid).
      // Fixed 12.00 + 20.00 + 7.50 + 20.00 = 59.50. Unallocated 2000.00 - 59.50 - 300.00 = 1640.50. Food 240.00
      // spent, 60.00 left (December's 50.00 deficit is not carried). Due 1700.50.
      ['2028-01', 'closed', 200000, 5950, 30000, 24000, 164050, 170050],
      // The leap day month. Domain renews (80.00 held + 20.00 = 100.00 is paid). Gym starts a new cycle:
      // 60.00 / 12 = 5.00. Fixed 12.00 + 20.00 + 7.50 + 5.00 = 44.50. Unallocated 2000.00 - 44.50 - 300.00 =
      // 1655.50. Food 310.00 spent (the last 310.00 on the 29th): 10.00 taken from savings. Due 1645.50.
      ['2028-02', 'closed', 200000, 4450, 30000, 31000, 165550, 164550],
      // Domain starts a new cycle, 12 months: 100.00 / 12 = 8.33 rounded up to 8.34. Fixed 12.00 + 8.34 + 7.50 +
      // 5.00 = 32.84. Unallocated 2000.00 - 32.84 - 300.00 = 1667.16. Food 200.00 spent, 100.00 left. Due 1767.16.
      ['2028-03', 'current', 200000, 3284, 30000, 20000, 166716, 176716],
    ]);
    // Food never carries: the December deficit is gone in January, and the 29 February receipt is February's.
    expect((await monthView(app, '2027-12')).budgets[0]).toMatchObject({
      toSavings: -5000,
      carriedOut: 0,
    });
    expect(balances(budgetLine(await monthView(app, '2028-01'), 'Food'))).toEqual([
      0, 30000, 30000, 24000, 6000, 0, 6000,
    ]);
    expect(balances(budgetLine(await monthView(app, '2028-02'), 'Food'))).toEqual([
      0, 30000, 30000, 31000, -1000, 0, -1000,
    ]);
  });

  it('the reserves across the wrap: Magazine renews in December and Gym in January, then new cycles that look into the next year', async () => {
    const { app } = await liveIt();
    const months = ['2027-10', '2027-11', '2027-12', '2028-01', '2028-02', '2028-03'];
    const seen = async (name: string) => {
      const found: Record<string, unknown> = {};
      for (const month of months) {
        const line = (await monthView(app, month)).subscriptions.find((s) => s.name === name);
        found[month] = line && [
          ...reserve(line),
          line.renewalThisMonth ? 'renews' : '',
          line.nextRenewalMonth,
        ];
      }
      return found;
    };
    // [charge, reserveBalance, reserveReleased, 'renews' in a renewal month, the renewal it is saving towards]
    expect(await seen('Magazine')).toEqual({
      '2027-10': [3000, 3000, 0, '', '2027-12'], // 90.00 over October to December: 30.00 a month
      '2027-11': [3000, 6000, 0, '', '2027-12'],
      '2027-12': [3000, 0, 0, 'renews', '2027-12'], // 60.00 + 30.00 = 90.00 paid out: nothing is left
      '2028-01': [750, 750, 0, '', '2028-12'], // the next cycle looks to December of the NEW year: 90.00 / 12 = 7.50
      '2028-02': [750, 1500, 0, '', '2028-12'],
      '2028-03': [750, 2250, 0, '', '2028-12'],
    });
    // Gym starts in November: 60.00 over November to January: 20.00 a month.
    expect(await seen('Gym')).toEqual({
      '2027-10': undefined, // Gym does not exist yet
      '2027-11': [2000, 2000, 0, '', '2028-01'],
      '2027-12': [2000, 4000, 0, '', '2028-01'],
      '2028-01': [2000, 0, 0, 'renews', '2028-01'], // 40.00 + 20.00 = 60.00 paid out
      '2028-02': [500, 500, 0, '', '2029-01'], // the next cycle: 60.00 / 12 = 5.00, towards January 2029
      '2028-03': [500, 1000, 0, '', '2029-01'],
    });
  });

  it('Domain, anchored on 29 February 2028: it renews in the leap-day month, and its next cycle splits 100.00 as 8.34 four times and 8.33 eight times, through February 2029', async () => {
    const { app } = await liveIt();
    const domain = async (month: string) => subscriptionLine(await monthView(app, month), 'Domain');
    // October 2027 to February 2028: 5 months, 100.00 / 5 = 20.00 each, then the renewal on the leap day.
    const first: number[] = [];
    for (const month of ['2027-10', '2027-11', '2027-12', '2028-01', '2028-02'])
      first.push((await domain(month)).charge);
    expect(first).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(await domain('2028-02')).toMatchObject({
      renewalThisMonth: true,
      price: 10000,
      reserveBalance: 0,
      nextRenewalMonth: '2028-02',
    });
    expect((await domain('2028-01')).reserveBalance).toBe(8000); // 4 x 20.00 held when the leap month begins
    // From March 2028 to February 2029 (projections): ceil(100.00 / 12) = 8.34, then 8.34 again while
    // ceil((100.00 - 8.34) / 11) = 8.34, ceil((100.00 - 16.68) / 10) = 8.34 and ceil((100.00 - 25.02) / 9) = 8.34,
    // and 8.33 from July on: 4 x 8.34 + 8 x 8.33 = 33.36 + 66.64 = 100.00.
    const charges: number[] = [];
    const months = [
      '2028-03',
      '2028-04',
      '2028-05',
      '2028-06',
      '2028-07',
      '2028-08',
      '2028-09',
      '2028-10',
      '2028-11',
      '2028-12',
      '2029-01',
      '2029-02',
    ];
    for (const month of months) charges.push((await domain(month)).charge);
    expect(charges).toEqual([834, 834, 834, 834, 833, 833, 833, 833, 833, 833, 833, 833]);
    expect(charges.reduce((a, b) => a + b, 0)).toBe(10000);
    // The 2029 renewal (February has 28 days that year, the billing day is clamped) pays the same 100.00
    // out of a reserve of 91.67 + 8.33, and every month before it points at it.
    const feb2029 = await domain('2029-02');
    expect(feb2029).toMatchObject({
      renewalThisMonth: true,
      reserveBalance: 0,
      charge: 833,
      price: 10000,
    });
    expect((await domain('2029-01')).reserveBalance).toBe(9167);
    expect((await domain('2028-03')).nextRenewalMonth).toBe('2029-02');
    // The Magazine (December 2028) and Gym (January 2029) renewals fall in the same stretch.
    expect(subscriptionLine(await monthView(app, '2028-12'), 'Magazine')).toMatchObject({
      renewalThisMonth: true,
      reserveBalance: 0,
    });
    expect(subscriptionLine(await monthView(app, '2029-01'), 'Gym')).toMatchObject({
      renewalThisMonth: true,
      reserveBalance: 0,
    });
    // Fixed costs in the projections: 12.00 + 8.34 + 7.50 + 5.00 = 32.84 until June, then 32.83.
    const rows = await monthSummaries(app, '2028-03', '2028-08');
    expect(rows.map((r) => r.fixedCosts)).toEqual([3284, 3284, 3284, 3284, 3283, 3283]);
  });

  it('the first and last second of a month, in two time zones and UTC: the month changes at local midnight, the figures never do', async () => {
    const { app, clock } = await liveIt();
    const december = (await monthView(app, '2027-12')).status; // read once to see that the clock is in March
    expect(december).toBe('closed');
    const figures = (view: Awaited<ReturnType<typeof monthView>>) => ({
      ...view,
      status: undefined,
    });
    const atRest = {
      '2027-12': figures(await monthView(app, '2027-12')),
      '2028-01': figures(await monthView(app, '2028-01')),
      '2028-02': figures(await monthView(app, '2028-02')),
      '2028-03': figures(await monthView(app, '2028-03')),
    };
    // [time zone, instant (UTC), local date, current month, month before the boundary, month after it]
    const cases: [string, string, string, string, string, string][] = [
      // The New Year. Auckland is 13 hours ahead of UTC, Los Angeles 8 behind.
      [AUCKLAND, '2027-12-31T10:59:59Z', '2027-12-31', '2027-12', '2027-12', '2028-01'],
      [AUCKLAND, '2027-12-31T11:00:00Z', '2028-01-01', '2028-01', '2027-12', '2028-01'],
      [LOS_ANGELES, '2028-01-01T07:59:59Z', '2027-12-31', '2027-12', '2027-12', '2028-01'],
      [LOS_ANGELES, '2028-01-01T08:00:00Z', '2028-01-01', '2028-01', '2027-12', '2028-01'],
      ['UTC', '2027-12-31T23:59:59Z', '2027-12-31', '2027-12', '2027-12', '2028-01'],
      ['UTC', '2028-01-01T00:00:00Z', '2028-01-01', '2028-01', '2027-12', '2028-01'],
      // The same instant is still December in UTC while it is already January in Auckland.
      ['UTC', '2027-12-31T11:00:00Z', '2027-12-31', '2027-12', '2027-12', '2028-01'],
      // The leap day: 29 February 23:59:59, then 1 March 00:00:00.
      [AUCKLAND, '2028-02-29T10:59:59Z', '2028-02-29', '2028-02', '2028-02', '2028-03'],
      [AUCKLAND, '2028-02-29T11:00:00Z', '2028-03-01', '2028-03', '2028-02', '2028-03'],
      [LOS_ANGELES, '2028-03-01T07:59:59Z', '2028-02-29', '2028-02', '2028-02', '2028-03'],
      [LOS_ANGELES, '2028-03-01T08:00:00Z', '2028-03-01', '2028-03', '2028-02', '2028-03'],
      ['UTC', '2028-02-29T23:59:59Z', '2028-02-29', '2028-02', '2028-02', '2028-03'],
      ['UTC', '2028-03-01T00:00:00Z', '2028-03-01', '2028-03', '2028-02', '2028-03'],
      ['UTC', '2028-02-29T11:00:00Z', '2028-02-29', '2028-02', '2028-02', '2028-03'],
    ];
    for (const [timeZone, instant, date, month, before, after] of cases) {
      clock.set(instant);
      await withTimeZone(timeZone, async () => {
        const label = `${timeZone} at ${instant}`;
        expect(await getJson(app, '/api/today'), label).toEqual({ date, month });
        // Everything before the current month is closed, the current one is current, later ones are projections.
        const statuses = await Promise.all(
          [before, after].map(async (m) => (await monthView(app, m)).status),
        );
        const expected = [before, after].map((m) =>
          m < month ? 'closed' : m === month ? 'current' : 'future',
        );
        expect(statuses, label).toEqual(expected);
        // The figures are the same at every instant: only the labels move with the clock.
        for (const m of [before, after]) {
          expect(figures(await monthView(app, m)), `${label}: ${m}`).toEqual(
            atRest[m as keyof typeof atRest],
          );
        }
      });
    }
  });

  it('a new budget and a cancellation start in the local month at the last and the first second of a month', async () => {
    // [time zone, instant (UTC), the local month at that second]
    const cases: [string, string, string][] = [
      [AUCKLAND, '2027-12-31T10:59:59Z', '2027-12'],
      [AUCKLAND, '2027-12-31T11:00:00Z', '2028-01'],
      [LOS_ANGELES, '2028-01-01T07:59:59Z', '2027-12'],
      [LOS_ANGELES, '2028-01-01T08:00:00Z', '2028-01'],
      [AUCKLAND, '2028-02-29T10:59:59Z', '2028-02'],
      [AUCKLAND, '2028-02-29T11:00:00Z', '2028-03'],
      [LOS_ANGELES, '2028-03-01T07:59:59Z', '2028-02'],
      [LOS_ANGELES, '2028-03-01T08:00:00Z', '2028-03'],
    ];
    for (const [timeZone, instant, month] of cases) {
      const clock = mutableClock(instant);
      const { app } = createTestApp(clock);
      await withTimeZone(timeZone, async () => {
        await onboard(app, { startMonth: '2027-10', salary: 200000, openingSavings: 0 });
        const label = `${timeZone} at ${instant}`;
        const budget = await addBudget(app, { name: 'Gifts', amount: 5000, incremental: false });
        expect(budget.startMonth, label).toBe(month);
        const subscription = await addSubscription(app, {
          name: 'Cloud',
          amount: 1200,
          anchorDate: '2027-10-31',
          startMonth: '2027-10',
        });
        const cancelled = (
          await request(app)
            .post(`/api/subscriptions/${subscription.id}/cancel`)
            .send({})
            .expect(200)
        ).body;
        expect(cancelled.endMonth, label).toBe(month);
        const archived = (
          await request(app).post(`/api/budgets/${budget.id}/archive`).send({}).expect(200)
        ).body;
        expect(archived.endMonth, label).toBe(month);
      });
    }
  });

  it('the billing day of a yearly subscription may change, the renewal month may not once it has closed months', async () => {
    const { app } = await liveIt();
    const before = await monthSummaries(app, '2027-10', '2029-03');
    const patch = (id: number, anchorDate: string) =>
      request(app).patch(`/api/subscriptions/${id}`).send({ anchorDate });
    // Domain's 29 February anchor can be moved to 28 February (what the 2029 renewal will really use): same month.
    expect((await patch(2, '2029-02-28').expect(200)).body).toMatchObject({
      anchorDate: '2029-02-28',
    });
    // The Magazine's 31 December can become the 30th; Cloud (monthly) may change month freely.
    await patch(3, '2027-12-30').expect(200);
    await patch(1, '2027-11-05').expect(200);
    // Moving the renewal month of Domain to March is refused: it has closed months already.
    expectRuleViolation(await patch(2, '2028-03-29'), 'renewal_month_in_history', 'anchorDate');
    // None of it moved a figure, and the refused change changed nothing.
    expect(await monthSummaries(app, '2027-10', '2029-03')).toEqual(before);
    expect(subscriptionLine(await monthView(app, '2029-02'), 'Domain')).toMatchObject({
      renewalThisMonth: true,
    });
  });
});
