/**
 * Story 3: the receipt in the drawer. Months are not "closed" by any stored step, so a spending (or
 * a refund, or an income) entered late for a closed month changes the figures of that month, and of
 * no other month, except where the money genuinely goes on (a budget that rolls over).
 *
 * Six months are lived through the public API, March to August 2027, and on 9 August the owner
 * finds a dentist receipt of 87.30 from 14 May. Every figure after each edit is worked out by hand
 * from the figures before it. The month list and every month view are compared in full, so "and
 * nothing else changed" is checked on every field of the ten months from March to December (the
 * last four are projections). The independent model and the oracle are not used.
 *
 *   salary 2400.00; Health 60.00, Fun 100.00 (settled every month), Groceries 350.00 (rolls over)
 *   Internet 29.00 a month; Car insurance 480.00 a year, renewing in October, 60.00 a month from March
 *   allocated 60.00 + 350.00 + 100.00 = 510.00; fixed 29.00 + 60.00 = 89.00 until October
 *   unallocated 2400.00 - 89.00 - 510.00 = 1801.00
 */
import type { MonthSummary, MonthView } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addIncome,
  addSpending,
  addSubscription,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { budgetLine, getJson, monthSummaries, monthView, summaryRow } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

/** `[month, health, groceries, fun]`: what was spent, one number per receipt. */
const PLAN: [month: string, health: number[], groceries: number[], fun: number[]][] = [
  ['2027-03', [1500], [33000], [7000]],
  ['2027-04', [], [36500], [12000]],
  ['2027-05', [2500], [34000], [9500]],
  ['2027-06', [], [35000], [10000]],
  ['2027-07', [4000], [31000], [6000]],
  ['2027-08', [], [12000], [3000]], // so far: it is 9 August
];

const MONTHS = [
  '2027-03',
  '2027-04',
  '2027-05',
  '2027-06',
  '2027-07',
  '2027-08',
  '2027-09',
  '2027-10',
  '2027-11',
  '2027-12',
];

interface Snapshot {
  list: MonthSummary[];
  views: MonthView[];
}

/** The month list and every month view from March to December, as the API shows them right now. */
async function snapshot(app: Express): Promise<Snapshot> {
  return {
    list: await monthSummaries(app, '2027-03', '2027-12'),
    views: await Promise.all(MONTHS.map((month) => monthView(app, month))),
  };
}

/** The summary row a month view stands for (the contract of `MonthSummary`, field by field). */
const summaryOf = (view: MonthView): MonthSummary => ({
  month: view.month,
  status: view.status,
  income: view.income.total,
  fixedCosts: view.fixedCosts,
  allocated: view.totals.allocated,
  spent: view.totals.spent,
  unallocated: view.unallocated,
  savingsDue: view.savingsDue.total,
});

async function liveIt() {
  const clock = mutableClock('2027-03-02T09:00:00Z');
  const { app } = createTestApp(clock);
  await onboard(app, {
    startMonth: '2027-03',
    salary: 240000,
    openingSavings: 200000,
    budgets: [
      { name: 'Health', amount: 6000, incremental: false }, // id 1
      { name: 'Groceries', amount: 35000, incremental: true }, // id 2
      { name: 'Fun', amount: 10000, incremental: false }, // id 3
    ],
  });
  await addSubscription(app, { name: 'Internet', amount: 2900, anchorDate: '2027-03-05' });
  await addSubscription(app, {
    name: 'Car insurance',
    frequency: 'yearly',
    amount: 48000,
    anchorDate: '2026-10-20',
  });

  for (const [month, health, groceries, fun] of PLAN) {
    clock.set(`${month}-08T10:00:00Z`);
    const receipts = [
      ...health.map((amount) => ({ budgetId: 1, amount })),
      ...groceries.map((amount) => ({ budgetId: 2, amount })),
      ...fun.map((amount) => ({ budgetId: 3, amount })),
    ];
    let day = 3;
    for (const { budgetId, amount } of receipts) {
      await addSpending(app, {
        budgetId,
        amount,
        date: `${month}-${String(day).padStart(2, '0')}`,
      });
      day += 6;
    }
  }
  clock.set('2027-08-09T10:00:00Z'); // the day the receipt is found
  return { app, clock, baseline: await snapshot(app) };
}

/**
 * The months after a late edit must be the baseline with only `changed` months different: each entry
 * says how a month's view becomes (every number written by hand), and the list follows from it.
 */
async function expectOnly(app: Express, baseline: Snapshot, changed: Record<string, MonthView>) {
  const now = await snapshot(app);
  baseline.views.forEach((before, index) => {
    expect(now.views[index], `the view of ${before.month}`).toEqual(
      changed[before.month] ?? before,
    );
  });
  expect(now.list).toEqual(
    baseline.views.map((before) => summaryOf(changed[before.month] ?? before)),
  );
}

const inMonth = (baseline: Snapshot, month: string): MonthView => {
  const view = baseline.views.find((v) => v.month === month);
  if (!view) throw new Error(`no baseline for ${month}`);
  return view;
};

describe('story: the receipt in the drawer (a late edit to a closed month)', () => {
  it('the months as they stand on 9 August, before anything is found', async () => {
    const { baseline } = await liveIt();
    // [month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]
    expect(baseline.list.map(summaryRow)).toEqual([
      // March: Health 15.00 spent, 45.00 moves to savings; Groceries 330.00 spent, 20.00 carried;
      // Fun 70.00 spent, 30.00 moves. Settled 75.00: due 1801.00 + 75.00 = 1876.00.
      ['2027-03', 'closed', 240000, 8900, 51000, 41500, 180100, 187600],
      // April: Health nothing spent, 60.00 moves; Groceries 20.00 + 350.00 - 365.00 = 5.00 carried;
      // Fun 120.00 spent, -20.00 taken from savings. Settled 40.00: due 1841.00.
      ['2027-04', 'closed', 240000, 8900, 51000, 48500, 180100, 184100],
      // May: Health 25.00 spent, 35.00 moves; Groceries 5.00 + 350.00 - 340.00 = 15.00 carried; Fun 95.00
      // spent, 5.00 moves. Settled 40.00: due 1841.00.
      ['2027-05', 'closed', 240000, 8900, 51000, 46000, 180100, 184100],
      // June: Health 60.00 moves; Groceries 15.00 + 350.00 - 350.00 = 15.00 carried; Fun 100.00 spent, 0.
      // Settled 60.00: due 1861.00.
      ['2027-06', 'closed', 240000, 8900, 51000, 45000, 180100, 186100],
      // July: Health 40.00 spent, 20.00 moves; Groceries 15.00 + 350.00 - 310.00 = 55.00 carried; Fun 60.00
      // spent, 40.00 moves. Settled 60.00: due 1861.00.
      ['2027-07', 'closed', 240000, 8900, 51000, 41000, 180100, 186100],
      // August, so far: Health 60.00 would move; Groceries 55.00 + 350.00 - 120.00 = 285.00 carried; Fun 30.00
      // spent, 70.00 would move. Settled 130.00: due 1931.00.
      ['2027-08', 'current', 240000, 8900, 51000, 15000, 180100, 193100],
      // September and October (projections, nothing spent): Health 60.00 + Fun 100.00 move, Groceries carries.
      ['2027-09', 'future', 240000, 8900, 51000, 0, 180100, 196100],
      // October: Car insurance renews; 480.00 is paid out of the reserve built up since March.
      ['2027-10', 'future', 240000, 8900, 51000, 0, 180100, 196100],
      // November: a new 12-month cycle for Car insurance, 480.00 / 12 = 40.00, so fixed 29.00 + 40.00 = 69.00 and
      // unallocated 2400.00 - 69.00 - 510.00 = 1821.00: due 1821.00 + 160.00 = 1981.00.
      ['2027-11', 'future', 240000, 6900, 51000, 0, 182100, 198100],
      ['2027-12', 'future', 240000, 6900, 51000, 0, 182100, 198100],
    ]);
  });

  it("a forgotten spending (87.30 for the dentist, 14 May) changes May's savings due by exactly 87.30, and nothing else in ten months", async () => {
    const { app, baseline } = await liveIt();
    const may = inMonth(baseline, '2027-05');
    expect(budgetLine(may, 'Health')).toMatchObject({
      spent: 2500,
      remaining: 3500,
      toSavings: 3500,
    });

    const created = await addSpending(app, {
      budgetId: 1,
      date: '2027-05-14',
      amount: 8730,
      description: 'Dentist',
    });
    expect(created.date).toBe('2027-05-14'); // a closed month accepts it

    await expectOnly(app, baseline, {
      '2027-05': {
        ...may,
        budgets: may.budgets.map((b) =>
          b.name !== 'Health'
            ? b
            : {
                ...b,
                // Health: 25.00 + 87.30 = 112.30 spent of 60.00: 52.30 over, taken from savings (112.30 / 60.00 = 187.2%).
                spent: 11230,
                remaining: -5230,
                usagePercent: 187,
                alert: 'over',
                toSavings: -5230,
              },
        ),
        // Spent 460.00 + 87.30 = 547.30. Remaining: -52.30 (Health) + 15.00 (Groceries) + 5.00 (Fun) = -32.30.
        totals: { allocated: 51000, spent: 54730, remaining: -3230, transfersNet: 0 },
        // Settled: -52.30 (Health) + 5.00 (Fun) = -47.30 (Groceries carries). Due: 1801.00 - 47.30 = 1753.70,
        // which is the 1841.00 of before, less exactly 87.30.
        savingsDue: {
          unallocated: 180100,
          budgetsSettled: -4730,
          reservesReleased: 0,
          total: 175370,
        },
      },
    });
    // The spendings list agrees: Health in May is 25.00 + 87.30.
    const page = await getJson<{ totalAmount: number }>(
      app,
      '/api/spendings?month=2027-05&budgetId=1',
    );
    expect(page.totalAmount).toBe(11230);
  });

  it('a late refund and a forgotten income each land in their own month only', async () => {
    const { app, baseline } = await liveIt();
    const april = inMonth(baseline, '2027-04');
    const june = inMonth(baseline, '2027-06');

    // 25.00 of the April shoes went back to the shop (found in the same drawer).
    await addSpending(app, {
      budgetId: 3,
      date: '2027-04-20',
      amount: -2500,
      description: 'Returned shoes',
    });
    // A 120.00 freelance payment from 25 June was never entered.
    await addIncome(app, { date: '2027-06-25', amount: 12000, description: 'Freelance' });

    await expectOnly(app, baseline, {
      '2027-04': {
        ...april,
        budgets: april.budgets.map((b) =>
          b.name !== 'Fun'
            ? b
            : {
                ...b,
                // Fun: 120.00 - 25.00 = 95.00 spent of 100.00: 5.00 left (it was 20.00 over), 95%: a warning, not over.
                spent: 9500,
                remaining: 500,
                usagePercent: 95,
                alert: 'warning',
                toSavings: 500,
              },
        ),
        // Spent 485.00 - 25.00 = 460.00. Remaining: 60.00 + 5.00 + 5.00 = 70.00.
        totals: { allocated: 51000, spent: 46000, remaining: 7000, transfersNet: 0 },
        // Settled 60.00 + 5.00 = 65.00 (was 40.00): due 1801.00 + 65.00 = 1866.00, 25.00 more than before.
        savingsDue: {
          unallocated: 180100,
          budgetsSettled: 6500,
          reservesReleased: 0,
          total: 186600,
        },
      },
      '2027-06': {
        ...june,
        // Income 2400.00 + 120.00 = 2520.00, so unallocated 2520.00 - 89.00 - 510.00 = 1921.00 and
        // due 1921.00 + 60.00 = 1981.00: 120.00 more than the 1861.00 of before.
        income: { salary: 240000, extra: 12000, total: 252000 },
        unallocated: 192100,
        savingsDue: {
          unallocated: 192100,
          budgetsSettled: 6000,
          reservesReleased: 0,
          total: 198100,
        },
      },
    });
  });

  it('moving a spending to another month moves its effect from one month to the other', async () => {
    const { app, baseline } = await liveIt();
    const july = inMonth(baseline, '2027-07');
    const refund = await addSpending(app, { budgetId: 3, date: '2027-04-20', amount: -2500 });
    // It turns out the shoes went back in July, not April.
    await request(app)
      .patch(`/api/spendings/${refund.id}`)
      .send({ date: '2027-07-03' })
      .expect(200);

    // April is exactly as it was, and July has the refund: Fun 60.00 - 25.00 = 35.00 spent, 65.00 left to move
    // (it was 40.00), 35%: fine. Spent 410.00 - 25.00 = 385.00. Remaining 20.00 + 55.00 + 65.00 = 140.00.
    // Settled 20.00 + 65.00 = 85.00: due 1801.00 + 85.00 = 1886.00, 25.00 more than the 1861.00 of before.
    await expectOnly(app, baseline, {
      '2027-07': {
        ...july,
        budgets: july.budgets.map((b) =>
          b.name !== 'Fun'
            ? b
            : {
                ...b,
                spent: 3500,
                remaining: 6500,
                usagePercent: 35,
                alert: 'ok',
                toSavings: 6500,
              },
        ),
        totals: { allocated: 51000, spent: 38500, remaining: 14000, transfersNet: 0 },
        savingsDue: {
          unallocated: 180100,
          budgetsSettled: 8500,
          reservesReleased: 0,
          total: 188600,
        },
      },
    });
  });

  it('deleting the late entries gives back exactly the figures before: there is no stored close step to reopen', async () => {
    const { app, baseline } = await liveIt();
    const dentist = await addSpending(app, { budgetId: 1, date: '2027-05-14', amount: 8730 });
    const refund = await addSpending(app, { budgetId: 3, date: '2027-04-20', amount: -2500 });
    const freelance = await addIncome(app, {
      date: '2027-06-25',
      amount: 12000,
      description: 'Freelance',
    });
    // Three late edits, in three different months: every one of them is visible somewhere.
    const edited = await snapshot(app);
    expect(edited.list.map((row) => row.savingsDue)).toEqual([
      187600, // March
      186600, // April: +25.00
      175370, // May: -87.30
      198100, // June: +120.00
      186100,
      193100,
      196100,
      196100,
      198100,
      198100,
    ]);

    await request(app).delete(`/api/spendings/${dentist.id}`).expect(204);
    await request(app).delete(`/api/spendings/${refund.id}`).expect(204);
    await request(app).delete(`/api/incomes/${freelance.id}`).expect(204);
    // Byte for byte: the same list and the same ten views, including every projection.
    const after = await snapshot(app);
    expect(JSON.stringify(after)).toBe(JSON.stringify(baseline));
  });

  it("a late spending on the budget that rolls over reaches every later month, but moves no month's savings due", async () => {
    const { app, baseline } = await liveIt();
    // 40.00 of Groceries from 12 April, forgotten. Groceries rolls over and is never settled in these months, so
    // the 40.00 is not "due" anywhere: it is carried, month after month, as 40.00 less in the balance.
    await addSpending(app, { budgetId: 2, date: '2027-04-12', amount: 4000 });
    const after = await snapshot(app);

    // Not one month's savings due changes, nor any income, fixed cost, other budget or the Car insurance reserve.
    expect(after.list.map((row) => row.savingsDue)).toEqual(
      baseline.list.map((row) => row.savingsDue),
    );
    baseline.views.forEach((before, index) => {
      const now = after.views[index]!;
      expect(now.savingsDue, before.month).toEqual(before.savingsDue);
      expect(now.subscriptions, before.month).toEqual(before.subscriptions);
      expect(now.income, before.month).toEqual(before.income);
      expect(now.unallocated, before.month).toEqual(before.unallocated);
      for (const name of ['Health', 'Fun'])
        expect(budgetLine(now, name), `${before.month} ${name}`).toEqual(budgetLine(before, name));
    });
    // March is before the receipt: nothing at all moved there.
    expect(after.views[0]).toEqual(baseline.views[0]);

    // Groceries from April on, each balance 40.00 lower (written out: before -> after).
    const groceries = (index: number) => {
      const b = budgetLine(after.views[index]!, 'Groceries');
      return [
        b.carriedIn,
        b.available,
        b.spent,
        b.remaining,
        b.carriedOut,
        b.toSavings,
        b.usagePercent,
        b.alert,
      ];
    };
    // April: 20.00 + 350.00 = 370.00 available; 365.00 + 40.00 = 405.00 spent: -35.00, carried (109%: over).
    expect(groceries(1)).toEqual([2000, 37000, 40500, -3500, -3500, 0, 109, 'over']);
    // May: -35.00 + 350.00 = 315.00 available (was 355.00); 340.00 spent: -25.00 (was 15.00); 107%: over.
    expect(groceries(2)).toEqual([-3500, 31500, 34000, -2500, -2500, 0, 107, 'over']);
    // June: -25.00 + 350.00 = 325.00; 350.00 spent: -25.00 (was 15.00); 107%: over.
    expect(groceries(3)).toEqual([-2500, 32500, 35000, -2500, -2500, 0, 107, 'over']);
    // July: -25.00 + 350.00 = 325.00; 310.00 spent: 15.00 (was 55.00); 95%: a warning.
    expect(groceries(4)).toEqual([-2500, 32500, 31000, 1500, 1500, 0, 95, 'warning']);
    // August (projected): 15.00 + 350.00 = 365.00; 120.00 spent: 245.00 (was 285.00); 32%.
    expect(groceries(5)).toEqual([1500, 36500, 12000, 24500, 24500, 0, 32, 'ok']);
    // The projection goes on carrying the 40.00 gap: 245.00 + 350.00 = 595.00 in September (was 635.00).
    expect(groceries(6)).toEqual([24500, 59500, 0, 59500, 59500, 0, 0, 'ok']);
  });
});
