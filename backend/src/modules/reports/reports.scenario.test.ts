/**
 * A multi-month scenario for GET /api/reports/yearly/:year through the real API: a salary that
 * changes, extra income, a monthly and a yearly subscription with a price rise, three budgets (one
 * incremental, one archived mid-year), spendings, a transfer, and a clock that moves forward. Every
 * expected figure is worked out by hand in the comments, to the cent, and each report is checked
 * against the sums of the month views (`expectReportMatchesMonthViews`).
 *
 * The facts of the year 2026, start month 2026-01:
 *
 *   salary          300000 a month, 320000 from 2026-07; extra income 50000 on 2026-05-10
 *   Netflix         monthly, 1299, 1499 from 2026-09
 *   Domain          yearly, 12000, renews in March. January to March set aside 4000 each and March
 *                   pays 12000; from April it saves 12000 / 12 = 1000 a month towards March 2027.
 *   fixed costs     Jan-Mar 1299 + 4000 = 5299, Apr-Aug 1299 + 1000 = 2299, Sep-Dec 1499 + 1000 = 2499
 *   Groceries       incremental 40000; spent Jan 30000, Feb 45000, Mar 52000, Oct 20000
 *   Fun             non-incremental 10000; spent Jan 4000, Feb 12000, Oct 2500; Oct also gets a
 *                   transfer of 3000 from the unallocated pool
 *   Travel          non-incremental 20000, June to September (archived); spent Aug 25000
 */
import type { YearlyReportDto, YearlyReportMonth } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  addTransfer,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { expectReportMatchesMonthViews } from '../../testing/report-helpers';
import { createTestApp } from '../../testing/test-app';

const report = async (app: Parameters<typeof request>[0], year: number) =>
  (await request(app).get(`/api/reports/yearly/${year}`).expect(200)).body as YearlyReportDto;

describe('yearly report: a year of a household', () => {
  it('follows the facts month by month and always equals the sum of the month views', async () => {
    const clock = mutableClock('2026-03-15T10:00:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 0 });

    // Reorder on purpose: the report lists budgets by sortOrder, not by id or by first month.
    const groceries = await addBudget(app, {
      name: 'Groceries',
      amount: 40000,
      incremental: true,
      startMonth: '2026-01',
      sortOrder: 1,
    });
    const fun = await addBudget(app, {
      name: 'Fun',
      amount: 10000,
      incremental: false,
      startMonth: '2026-01',
      sortOrder: 2,
    });
    const netflix = await addSubscription(app, {
      name: 'Netflix',
      anchorDate: '2026-01-20',
      amount: 1299,
      startMonth: '2026-01',
    });
    await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2026-03-25',
      amount: 12000,
      startMonth: '2026-01',
    });
    for (const [budgetId, date, amount] of [
      [groceries.id, '2026-01-12', 30000],
      [groceries.id, '2026-02-12', 45000],
      [groceries.id, '2026-03-12', 52000],
      [fun.id, '2026-01-20', 4000],
      [fun.id, '2026-02-20', 12000],
    ] as const) {
      await addSpending(app, { budgetId, date, amount });
    }

    // ---- 15 March: three months of facts, nine months of projection -----------------------------
    const march = await report(app, 2026);
    expect(march).toMatchObject({ year: 2026, firstMonth: '2026-01', lastMonth: '2026-12' });
    expect(march.months.map((m) => m.status)).toEqual([
      'closed',
      'closed',
      'current',
      ...Array(9).fill('future'),
    ]);
    // unallocated = 300000 - 5299 - (40000 + 10000) = 244701
    //   Jan: Fun settles +6000 (10000 - 4000)                    -> saved 250701
    //   Feb: Fun settles -2000 (10000 - 12000), taken from savings -> saved 242701
    //   Mar: Fun settles +10000 (nothing spent)                  -> saved 254701
    // Groceries is incremental: its leftover or deficit is carried, never settled.
    expect(march.months.slice(0, 3).map((m) => m.saved)).toEqual([250701, 242701, 254701]);
    expect(march.months.slice(0, 3).map((m) => m.spent)).toEqual([34000, 57000, 52000]);
    await expectReportMatchesMonthViews(app, march);

    // ---- 15 October: the rest of the facts ------------------------------------------------------
    clock.set('2026-10-15T10:00:00Z');
    await request(app).put('/api/salary/2026-07').send({ amount: 320000 }).expect(200);
    await addIncome(app, { date: '2026-05-10', amount: 50000, description: 'Bonus' });
    await request(app)
      .put(`/api/subscriptions/${netflix.id}/prices/2026-09`)
      .send({ amount: 1499 })
      .expect(200);
    const travel = await addBudget(app, {
      name: 'Travel',
      amount: 20000,
      incremental: false,
      startMonth: '2026-06',
      sortOrder: 0,
    });
    await addSpending(app, { budgetId: travel.id, date: '2026-08-12', amount: 25000 });
    await request(app)
      .post(`/api/budgets/${travel.id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    await addSpending(app, { budgetId: groceries.id, date: '2026-10-08', amount: 20000 });
    await addSpending(app, { budgetId: fun.id, date: '2026-10-09', amount: 2500 });
    await addTransfer(app, {
      date: '2026-10-05',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 3000,
    });

    const october = await report(app, 2026);
    expect(october.months.map((m) => m.status)).toEqual([
      ...Array(9).fill('closed'),
      'current',
      'future',
      'future',
    ]);

    // Closed months did not move: a later fact never changes an earlier month (causality).
    // (March was the current month then and is closed now: only its status changed.)
    const figures = ({ status: _status, ...rest }: YearlyReportMonth) => rest;
    expect(october.months.slice(0, 3).map(figures)).toEqual(march.months.slice(0, 3).map(figures));

    // unallocated = income - fixed costs - allocated (- 3000 pool to Fun in October)
    expect(october.months.map((m) => m.unallocated)).toEqual([
      244701, //  Jan  300000 - 5299 - 50000
      244701, //  Feb
      244701, //  Mar
      247701, //  Apr  300000 - 2299 - 50000
      297701, //  May  + the 50000 bonus
      227701, //  Jun  Travel allocates 20000 more
      247701, //  Jul  320000 - 2299 - 70000
      247701, //  Aug
      247501, //  Sep  Netflix 1499: 320000 - 2499 - 70000
      264501, //  Oct  320000 - 2499 - 50000 - 3000
      267501, //  Nov  320000 - 2499 - 50000
      267501, //  Dec
    ]);
    // settled to savings: Fun and Travel (Groceries is incremental and carries on)
    expect(october.months.map((m) => m.savedBreakdown.budgetsSettled)).toEqual([
      6000, //   Jan  Fun
      -2000, //  Feb  Fun
      10000, //  Mar
      10000, //  Apr
      10000, //  May
      30000, //  Jun  Fun 10000 + Travel 20000
      30000, //  Jul
      5000, //   Aug  Fun 10000 + Travel (20000 - 25000)
      30000, //  Sep  Travel's last month: the whole 20000 balance is settled
      10500, //  Oct  Fun: 10000 + 3000 transfer - 2500 spent
      10000, //  Nov  a projection: nothing more is spent
      10000, //  Dec
    ]);
    expect(october.months.map((m) => m.saved)).toEqual([
      250701, 242701, 254701, 257701, 307701, 257701, 277701, 252701, 277501, 275001, 277501,
      277501,
    ]);
    expect(october.months.map((m) => m.spent)).toEqual([
      34000, 57000, 52000, 0, 0, 0, 0, 25000, 0, 22500, 0, 0,
    ]);

    expect(october.income).toEqual({ salary: 3720000, extra: 50000, total: 3770000 });
    expect(october.fixedCosts).toEqual({
      // 3 * 5299 + 5 * 2299 + 4 * 2499
      total: 37388,
      // Netflix 8 * 1299 + 4 * 1499 = 16388, and the 12000 March renewal of Domain
      paid: 28388,
      subscriptions: [
        // Domain: 3 * 4000 + 9 * 1000 set aside; 9000 is still held at the end of December
        { id: 2, name: 'Domain', color: null, frequency: 'yearly', cost: 21000, paid: 12000 },
        { id: 1, name: 'Netflix', color: null, frequency: 'monthly', cost: 16388, paid: 16388 },
      ],
    });
    expect(october.budgets).toEqual([
      { id: 3, name: 'Travel', color: null, icon: null, allocated: 80000, spent: 25000 },
      { id: 1, name: 'Groceries', color: null, icon: null, allocated: 480000, spent: 147000 },
      { id: 2, name: 'Fun', color: null, icon: null, allocated: 120000, spent: 18500 },
    ]);
    expect(october.allocated).toBe(680000);
    expect(october.spent).toBe(190500);
    expect(october.unallocated).toBe(3049612); // 3770000 - 37388 - 680000 - 3000
    expect(october.savedBreakdown).toEqual({
      unallocated: 3049612,
      budgetsSettled: 159500,
      reservesReleased: 0,
    });
    expect(october.saved).toBe(3209112);
    await expectReportMatchesMonthViews(app, october);

    // ---- The next year is a projection of this one ---------------------------------------------
    const next = await report(app, 2027);
    expect(next).toMatchObject({ year: 2027, firstMonth: '2027-01', lastMonth: '2027-12' });
    expect(next.months.every((m) => m.status === 'future')).toBe(true);
    // Salary 320000, Netflix 1499, and Domain: 1000 a month to January and February, then March
    // tops up what is missing (12000 - 11000 = 1000) and pays; April onwards saves 1000 a month.
    expect(next.income.total).toBe(12 * 320000);
    expect(next.fixedCosts.total).toBe(12 * 1499 + 12 * 1000);
    expect(next.fixedCosts.paid).toBe(12 * 1499 + 12000);
    // Groceries (incremental, 40000 a month) has 333000 carried in from 2026 and nothing is spent.
    expect(next.budgets.map((b) => b.name)).toEqual(['Groceries', 'Fun']);
    expect(next.budgets[0]).toMatchObject({ allocated: 480000, spent: 0 });
    await expectReportMatchesMonthViews(app, next);
  });

  it('is unchanged by settling a month, and moves with a late edit to a closed month', async () => {
    const clock = mutableClock('2026-10-15T10:00:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-08', salary: 300000, openingSavings: 0 });
    const fun = await addBudget(app, {
      name: 'Fun',
      amount: 10000,
      startMonth: '2026-08',
    });
    await addSpending(app, { budgetId: fun.id, date: '2026-08-10', amount: 4000 });
    const before = await report(app, 2026);
    // unallocated 290000 each month, Fun settles +6000 in August and +10000 afterwards
    expect(before.months.slice(0, 3).map((m) => m.saved)).toEqual([296000, 300000, 300000]);

    // The savings inbox lists the same amounts as the report's `saved` for the closed months.
    const savings = (await request(app).get('/api/savings').expect(200)).body;
    expect(
      savings.outstanding.map((o: { month: string; savingsDue: number }) => [
        o.month,
        o.savingsDue,
      ]),
    ).toEqual([
      ['2026-08', 296000],
      ['2026-09', 300000],
    ]);

    // Settling August moves money, not the amount that was due.
    await request(app).post('/api/savings/settle/2026-08').send({ amount: 296000 }).expect(201);
    expect(await report(app, 2026)).toEqual(before);

    // A forgotten spending in August lowers what was due then (and the budget's spending).
    await addSpending(app, { budgetId: fun.id, date: '2026-08-25', amount: 1000 });
    const after = await report(app, 2026);
    expect(after.months[0]).toMatchObject({ month: '2026-08', spent: 5000, saved: 295000 });
    expect(after.saved).toBe(before.saved - 1000);
    expect(after.spent).toBe(before.spent + 1000);
    expect(after.months.slice(1)).toEqual(before.months.slice(1));
    await expectReportMatchesMonthViews(app, after);
  });

  it('reports the reserve of a cancelled yearly subscription as released savings', async () => {
    const clock = mutableClock('2026-04-10T10:00:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 0 });
    const domain = await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2026-03-25',
      amount: 12000,
      startMonth: '2026-01',
    });
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2026-02' })
      .expect(200);

    const result = await report(app, 2026);
    // January sets aside 12000 / 3 = 4000. February is the end month and the next renewal is
    // after it: nothing more is set aside and the 4000 goes back to savings.
    expect(result.fixedCosts).toEqual({
      total: 4000,
      paid: 0,
      subscriptions: [
        { id: domain.id, name: 'Domain', color: null, frequency: 'yearly', cost: 4000, paid: 0 },
      ],
    });
    expect(result.months.slice(0, 3).map((m) => [m.fixedCosts, m.saved])).toEqual([
      [4000, 296000],
      [0, 304000], // 300000 unallocated + 4000 released
      [0, 300000],
    ]);
    expect(result.savedBreakdown.reservesReleased).toBe(4000);
    expect(result.saved).toBe(12 * 300000 - 4000 + 4000);
    await expectReportMatchesMonthViews(app, result);
  });
});
