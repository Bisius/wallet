/**
 * Story 1: two years of a household, January 2025 to December 2026 (24 months), lived through the
 * public API with the clock moving month by month, and asserted to the cent.
 *
 *   Jan 2025  onboarding: salary 2500.00; Groceries 400.00 (rolls over), Fun 150.00 and Transport
 *             80.00 (rolls over); Streaming 12.99 a month; Insurance 240.00 a year, renewing in June
 *   Mar 2025  a 600.00 bonus
 *   Jul 2025  a raise to 2700.00
 *   Sep 2025  Groceries stops rolling over (incremental -> non-incremental)
 *   Nov 2025  Transport is archived
 *   Jan 2026  Insurance goes up to 300.00 a year
 *   Apr 2026  Streaming goes up to 14.99
 *   Sep 2026  Insurance is cancelled
 *
 * The expected numbers are worked out by hand in the comments. Nothing here computes money, and
 * the independent model and the ledger oracle are not used: the figures are the story's own.
 */
import { describe, expect, it } from 'vitest';
import {
  addIncome,
  addSpending,
  mutableClock,
  onboard,
  addSubscription,
} from '../../testing/helpers';
import {
  balances,
  budgetLine,
  getJson,
  monthSummaries,
  monthView,
  postJson,
  putJson,
  reserve,
  subscriptionLine,
  sum,
  summaryRow,
} from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

/**
 * What was spent each month: `[month, groceries, fun, transport]`, one number per receipt. Spendings
 * are entered in the month they happen, so the clock sits in that month while they are added.
 */
const PLAN: [month: string, groceries: number[], fun: number[], transport: number[]][] = [
  ['2025-01', [21000, 15000], [9000], [6500]],
  ['2025-02', [27000, 20000], [15000], [8000]],
  ['2025-03', [30000], [12000, 8000], [4000]],
  ['2025-04', [40000], [15000], [2000]],
  ['2025-05', [25000, 20000], [12000], [8000]],
  ['2025-06', [42000], [15000], [5000]],
  ['2025-07', [38000], [10000], [6000]],
  ['2025-08', [24500, 20000], [15000], [8000]],
  ['2025-09', [35000], [14000], [8000]],
  ['2025-10', [41000], [15000], [3000]],
  ['2025-11', [39000], [13000], [600, 400]],
  ['2025-12', [30000, 22000], [22000], []],
  ['2026-01', [38000], [15000], []],
  ['2026-02', [40000], [9000], []],
  ['2026-03', [37000], [16000], []],
  ['2026-04', [41000], [15000], []],
  ['2026-05', [36000], [12000], []],
  ['2026-06', [40000], [15000], []],
  ['2026-07', [39000], [11000], []],
  ['2026-08', [33000], [15000], []],
  ['2026-09', [42000], [17000], []],
  ['2026-10', [38000], [15000], []],
  ['2026-11', [40000], [14000], []],
  ['2026-12', [20000], [5000], []], // so far: the month is still running when the story ends
];

/** Lives the story up to and including `lastMonth`, and returns the app with the clock in that month. */
async function liveUntil(lastMonth: string) {
  const clock = mutableClock('2025-01-05T09:00:00Z');
  const { app } = createTestApp(clock);

  // January 2025: onboarding, with the first three budgets (ids 1, 2, 3), and two subscriptions.
  await onboard(app, {
    startMonth: '2025-01',
    salary: 250000,
    openingSavings: 100000,
    budgets: [
      { name: 'Groceries', amount: 40000, incremental: true },
      { name: 'Fun', amount: 15000, incremental: false },
      { name: 'Transport', amount: 8000, incremental: true },
    ],
  });
  await addSubscription(app, { name: 'Streaming', amount: 1299, anchorDate: '2025-01-12' }); // id 1
  await addSubscription(app, {
    name: 'Insurance',
    frequency: 'yearly',
    amount: 24000,
    anchorDate: '2024-06-15', // renews every June
  }); // id 2

  /** What happens in a month besides the receipts. The clock is in that month, as in real life. */
  const events: Record<string, () => Promise<unknown>> = {
    '2025-03': () => addIncome(app, { date: '2025-03-14', amount: 60000, description: 'Bonus' }),
    '2025-07': () => putJson(app, '/api/salary/2025-07', { amount: 270000 }),
    '2025-09': () =>
      putJson(app, '/api/budgets/1/versions/2025-09', { amount: 40000, incremental: false }),
    '2025-11': () => postJson(app, '/api/budgets/3/archive'), // defaults to this month
    '2026-01': () => putJson(app, '/api/subscriptions/2/prices/2026-01', { amount: 30000 }),
    '2026-04': () => putJson(app, '/api/subscriptions/1/prices/2026-04', { amount: 1499 }),
    '2026-09': () => postJson(app, '/api/subscriptions/2/cancel'), // defaults to this month
  };

  const budgetIds = { groceries: 1, fun: 2, transport: 3 };
  for (const [month, groceries, fun, transport] of PLAN) {
    clock.set(`${month}-20T10:00:00Z`);
    await events[month]?.();
    const receipts = [
      ...groceries.map((amount) => ({ budgetId: budgetIds.groceries, amount })),
      ...fun.map((amount) => ({ budgetId: budgetIds.fun, amount })),
      ...transport.map((amount) => ({ budgetId: budgetIds.transport, amount })),
    ];
    let day = 0;
    for (const { budgetId, amount } of receipts) {
      await addSpending(app, {
        budgetId,
        amount,
        date: `${month}-${String([3, 11, 19, 26][day++ % 4]).padStart(2, '0')}`,
      });
    }
    if (month === lastMonth) break;
  }
  return { app, clock };
}

describe('story: two years of a household, January 2025 to December 2026', () => {
  it('month by month: income, fixed costs, what was allocated and spent, what is unallocated and what is due to savings', async () => {
    const { app } = await liveUntil('2026-12');
    const rows = await monthSummaries(app, '2025-01', '2026-12');
    // [month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]
    // Fixed costs: Streaming + Insurance's monthly contribution. Savings due = unallocated + what
    // the non-incremental budgets (and an archived or switched one) settle with savings.
    expect(rows.map(summaryRow)).toEqual([
      // Income 2500.00. Fixed: 12.99 + 40.00 (240.00 over January to June, 6 months) = 52.99.
      // Allocated 400.00 + 150.00 + 80.00 = 630.00. Spent 360.00 + 90.00 + 65.00 = 515.00.
      // Unallocated 2500.00 - 52.99 - 630.00 = 1817.01. Fun's 60.00 left over moves: due 1877.01.
      // (Groceries and Transport roll over: 40.00 and 15.00 are carried, not settled.)
      ['2025-01', 'closed', 250000, 5299, 63000, 51500, 181701, 187701],
      // Spent 470.00 + 150.00 + 80.00 = 700.00. Groceries ran out (40.00 + 400.00 = 440.00 against
      // 470.00): -30.00 is carried. Nothing settles: due = the unallocated 1817.01.
      ['2025-02', 'closed', 250000, 5299, 63000, 70000, 181701, 181701],
      // Income 2500.00 + 600.00 bonus = 3100.00, so unallocated 3100.00 - 52.99 - 630.00 = 2417.01.
      // Spent 300.00 + 200.00 + 40.00 = 540.00. Fun overspent by 50.00, taken from savings:
      // due 2417.01 - 50.00 = 2367.01.
      ['2025-03', 'closed', 310000, 5299, 63000, 54000, 241701, 236701],
      // Spent 400.00 + 150.00 + 20.00 = 570.00. Fun spent exactly 150.00: due 1817.01.
      ['2025-04', 'closed', 250000, 5299, 63000, 57000, 181701, 181701],
      // Spent 450.00 + 120.00 + 80.00 = 650.00. Fun has 30.00 left: due 1817.01 + 30.00 = 1847.01.
      ['2025-05', 'closed', 250000, 5299, 63000, 65000, 181701, 184701],
      // Spent 420.00 + 150.00 + 50.00 = 620.00. Insurance renews: 200.00 held + 40.00 = 240.00 is paid.
      ['2025-06', 'closed', 250000, 5299, 63000, 62000, 181701, 181701],
      // The raise: income 2700.00. Insurance starts a 12-month cycle: 240.00 / 12 = 20.00, so fixed
      // 12.99 + 20.00 = 32.99. Unallocated 2700.00 - 32.99 - 630.00 = 2037.01. Spent 380.00 + 100.00
      // + 60.00 = 540.00. Fun has 50.00 left: due 2087.01.
      ['2025-07', 'closed', 270000, 3299, 63000, 54000, 203701, 208701],
      // Spent 445.00 + 150.00 + 80.00 = 675.00. Nothing settles: due 2037.01.
      ['2025-08', 'closed', 270000, 3299, 63000, 67500, 203701, 203701],
      // Spent 350.00 + 140.00 + 80.00 = 570.00. Groceries is now settled every month and releases its
      // balance: -25.00 carried + 400.00 - 350.00 = 25.00. Fun has 10.00 left. Due 2037.01 + 35.00 = 2072.01.
      ['2025-09', 'closed', 270000, 3299, 63000, 57000, 203701, 207201],
      // Spent 410.00 + 150.00 + 30.00 = 590.00. Groceries overspent by 10.00, taken from savings:
      // due 2037.01 - 10.00 = 2027.01. (Transport still rolls over.)
      ['2025-10', 'closed', 270000, 3299, 63000, 59000, 203701, 202701],
      // Spent 390.00 + 130.00 + 10.00 = 530.00. Transport ends this month, so its whole balance
      // (215.00 carried + 80.00 - 10.00 = 285.00) moves to savings, with Groceries' 10.00 and Fun's 20.00:
      // due 2037.01 + 315.00 = 2352.01.
      ['2025-11', 'closed', 270000, 3299, 63000, 53000, 203701, 235201],
      // Transport is gone: allocated 400.00 + 150.00 = 550.00, unallocated 2700.00 - 32.99 - 550.00 =
      // 2117.01. Spent 520.00 + 220.00 = 740.00: Groceries -120.00 and Fun -70.00 are taken from
      // savings. Due 2117.01 - 190.00 = 1927.01.
      ['2025-12', 'closed', 270000, 3299, 55000, 74000, 211701, 192701],
      // Insurance is 300.00 from now on: 120.00 is held, so 180.00 is spread over January to June
      // (6 months): 30.00. Fixed 12.99 + 30.00 = 42.99, unallocated 2700.00 - 42.99 - 550.00 = 2107.01.
      // Spent 380.00 + 150.00 = 530.00. Groceries has 20.00 left: due 2127.01.
      ['2026-01', 'closed', 270000, 4299, 55000, 53000, 210701, 212701],
      // Spent 400.00 + 90.00 = 490.00. Fun has 60.00 left: due 2107.01 + 60.00 = 2167.01.
      ['2026-02', 'closed', 270000, 4299, 55000, 49000, 210701, 216701],
      // Spent 370.00 + 160.00 = 530.00. Groceries +30.00, Fun -10.00: due 2107.01 + 20.00 = 2127.01.
      ['2026-03', 'closed', 270000, 4299, 55000, 53000, 210701, 212701],
      // Streaming is 14.99: fixed 14.99 + 30.00 = 44.99, unallocated 2700.00 - 44.99 - 550.00 = 2105.01.
      // Spent 410.00 + 150.00 = 560.00. Groceries -10.00: due 2105.01 - 10.00 = 2095.01.
      ['2026-04', 'closed', 270000, 4499, 55000, 56000, 210501, 209501],
      // Spent 360.00 + 120.00 = 480.00. Groceries 40.00 and Fun 30.00 left: due 2105.01 + 70.00 = 2175.01.
      ['2026-05', 'closed', 270000, 4499, 55000, 48000, 210501, 217501],
      // Spent 400.00 + 150.00 = 550.00, nothing left. Insurance renews: 270.00 held + 30.00 = 300.00 is paid.
      ['2026-06', 'closed', 270000, 4499, 55000, 55000, 210501, 210501],
      // A new cycle: 300.00 / 12 = 25.00, fixed 14.99 + 25.00 = 39.99, unallocated 2700.00 - 39.99 - 550.00 =
      // 2110.01. Spent 390.00 + 110.00 = 500.00. Groceries 10.00 and Fun 40.00 left: due 2160.01.
      ['2026-07', 'closed', 270000, 3999, 55000, 50000, 211001, 216001],
      // Spent 330.00 + 150.00 = 480.00. Groceries has 70.00 left: due 2110.01 + 70.00 = 2180.01.
      ['2026-08', 'closed', 270000, 3999, 55000, 48000, 211001, 218001],
      // Insurance is cancelled this month: no renewal is left, so it sets nothing aside and gives back
      // the 50.00 it held (2 x 25.00). Fixed 14.99, unallocated 2700.00 - 14.99 - 550.00 = 2135.01.
      // Spent 420.00 + 170.00 = 590.00: Groceries -20.00, Fun -20.00. Due 2135.01 - 40.00 + 50.00 = 2145.01.
      ['2026-09', 'closed', 270000, 1499, 55000, 59000, 213501, 214501],
      // Spent 380.00 + 150.00 = 530.00. Groceries has 20.00 left: due 2135.01 + 20.00 = 2155.01.
      ['2026-10', 'closed', 270000, 1499, 55000, 53000, 213501, 215501],
      // Spent 400.00 + 140.00 = 540.00. Fun has 10.00 left: due 2135.01 + 10.00 = 2145.01.
      ['2026-11', 'closed', 270000, 1499, 55000, 54000, 213501, 214501],
      // The current month, projected as if it ended today: 250.00 spent so far, so 200.00 + 100.00 =
      // 300.00 of the allocations would move to savings: due 2135.01 + 300.00 = 2435.01.
      ['2026-12', 'current', 270000, 1499, 55000, 25000, 213501, 243501],
    ]);
  });

  it('Groceries rolls over (a deficit too) until September 2025, when it is switched to non-incremental and releases its balance', async () => {
    const { app } = await liveUntil('2026-12');
    const lines: Record<string, ReturnType<typeof balances>> = {};
    for (const [month] of PLAN)
      lines[month] = balances(budgetLine(await monthView(app, month), 'Groceries'));
    // [carriedIn, allocated, available, spent, remaining, carriedOut, toSavings]
    expect(lines).toEqual({
      '2025-01': [0, 40000, 40000, 36000, 4000, 4000, 0], // 400.00 - 360.00: 40.00 carried
      '2025-02': [4000, 40000, 44000, 47000, -3000, -3000, 0], // 40.00 + 400.00 - 470.00: -30.00 carried
      '2025-03': [-3000, 40000, 37000, 30000, 7000, 7000, 0], // -30.00 + 400.00 - 300.00: 70.00 carried
      '2025-04': [7000, 40000, 47000, 40000, 7000, 7000, 0], // 70.00 + 400.00 - 400.00
      '2025-05': [7000, 40000, 47000, 45000, 2000, 2000, 0], // 70.00 + 400.00 - 450.00
      '2025-06': [2000, 40000, 42000, 42000, 0, 0, 0], // 20.00 + 400.00 - 420.00
      '2025-07': [0, 40000, 40000, 38000, 2000, 2000, 0], // 400.00 - 380.00
      '2025-08': [2000, 40000, 42000, 44500, -2500, -2500, 0], // 20.00 + 400.00 - 445.00: -25.00 carried
      // Switched to non-incremental: the -25.00 is not carried on, it is settled this month:
      // -25.00 + 400.00 - 350.00 = 25.00 moves to savings.
      '2025-09': [-2500, 40000, 37500, 35000, 2500, 0, 2500],
      '2025-10': [0, 40000, 40000, 41000, -1000, 0, -1000], // starts clean; 410.00 spent: -10.00 from savings
      '2025-11': [0, 40000, 40000, 39000, 1000, 0, 1000],
      '2025-12': [0, 40000, 40000, 52000, -12000, 0, -12000], // Christmas: -120.00 taken from savings
      '2026-01': [0, 40000, 40000, 38000, 2000, 0, 2000],
      '2026-02': [0, 40000, 40000, 40000, 0, 0, 0],
      '2026-03': [0, 40000, 40000, 37000, 3000, 0, 3000],
      '2026-04': [0, 40000, 40000, 41000, -1000, 0, -1000],
      '2026-05': [0, 40000, 40000, 36000, 4000, 0, 4000],
      '2026-06': [0, 40000, 40000, 40000, 0, 0, 0],
      '2026-07': [0, 40000, 40000, 39000, 1000, 0, 1000],
      '2026-08': [0, 40000, 40000, 33000, 7000, 0, 7000],
      '2026-09': [0, 40000, 40000, 42000, -2000, 0, -2000],
      '2026-10': [0, 40000, 40000, 38000, 2000, 0, 2000],
      '2026-11': [0, 40000, 40000, 40000, 0, 0, 0],
      '2026-12': [0, 40000, 40000, 20000, 20000, 0, 20000], // projected: 200.00 would move
    });

    // The alerts the owner would have seen (warning from 80%, over past 100%, rounded down).
    const alert = async (month: string, name: string) => {
      const line = budgetLine(await monthView(app, month), name);
      return [line.usagePercent, line.alert];
    };
    expect(await alert('2025-01', 'Groceries')).toEqual([90, 'warning']); // 360.00 of 400.00
    expect(await alert('2025-02', 'Groceries')).toEqual([106, 'over']); // 470.00 of 440.00: 106.8 rounds down
    expect(await alert('2025-04', 'Groceries')).toEqual([85, 'warning']); // 400.00 of 470.00 available
    expect(await alert('2025-06', 'Groceries')).toEqual([100, 'warning']); // 420.00 of 420.00: used up, not over
    expect(await alert('2025-12', 'Groceries')).toEqual([130, 'over']); // 520.00 of 400.00
    expect(await alert('2026-02', 'Fun')).toEqual([60, 'ok']); // 90.00 of 150.00
  });

  it('Transport rolls over a growing balance until it is archived in November 2025, when all of it moves to savings', async () => {
    const { app } = await liveUntil('2026-12');
    const lines: Record<string, ReturnType<typeof balances>> = {};
    for (const [month] of PLAN.slice(0, 11))
      lines[month] = balances(budgetLine(await monthView(app, month), 'Transport'));
    expect(lines).toEqual({
      '2025-01': [0, 8000, 8000, 6500, 1500, 1500, 0], // 80.00 - 65.00: 15.00 carried
      '2025-02': [1500, 8000, 9500, 8000, 1500, 1500, 0], // 15.00 + 80.00 - 80.00
      '2025-03': [1500, 8000, 9500, 4000, 5500, 5500, 0], // 15.00 + 80.00 - 40.00: 55.00
      '2025-04': [5500, 8000, 13500, 2000, 11500, 11500, 0], // 55.00 + 80.00 - 20.00: 115.00
      '2025-05': [11500, 8000, 19500, 8000, 11500, 11500, 0],
      '2025-06': [11500, 8000, 19500, 5000, 14500, 14500, 0], // 115.00 + 80.00 - 50.00: 145.00
      '2025-07': [14500, 8000, 22500, 6000, 16500, 16500, 0], // 145.00 + 80.00 - 60.00: 165.00
      '2025-08': [16500, 8000, 24500, 8000, 16500, 16500, 0],
      '2025-09': [16500, 8000, 24500, 8000, 16500, 16500, 0],
      '2025-10': [16500, 8000, 24500, 3000, 21500, 21500, 0], // 165.00 + 80.00 - 30.00: 215.00
      // The end month: 215.00 + 80.00 - 10.00 = 285.00 is not carried on, it moves to savings.
      '2025-11': [21500, 8000, 29500, 1000, 28500, 0, 28500],
    });
    expect(budgetLine(await monthView(app, '2025-11'), 'Transport').endsThisMonth).toBe(true);
    // From December on the budget has no line, and nothing of it is left anywhere.
    for (const month of ['2025-12', '2026-06', '2026-12']) {
      expect((await monthView(app, month)).budgets.map((b) => b.name)).toEqual([
        'Groceries',
        'Fun',
      ]);
    }
  });

  it("Insurance's yearly reserve over the year wrap: a rise in January, the renewal in June, and the reserve given back on cancelling in September", async () => {
    const { app } = await liveUntil('2026-12');
    const series: Record<string, ReturnType<typeof reserve>> = {};
    const renewalMonths: Record<string, string | null> = {};
    for (const [month] of PLAN.slice(0, 21)) {
      const line = subscriptionLine(await monthView(app, month), 'Insurance');
      series[month] = reserve(line);
      renewalMonths[month] = line.nextRenewalMonth;
    }
    // [charge, reserveBalance, reserveReleased]
    expect(series).toEqual({
      // 240.00 over January to June (6 months): 40.00 a month, held 40.00, 80.00, ... 200.00.
      '2025-01': [4000, 4000, 0],
      '2025-02': [4000, 8000, 0],
      '2025-03': [4000, 12000, 0],
      '2025-04': [4000, 16000, 0],
      '2025-05': [4000, 20000, 0],
      '2025-06': [4000, 0, 0], // 200.00 + 40.00 = 240.00 is paid out: nothing is left
      // A new cycle, July to June (12 months): 240.00 / 12 = 20.00 a month.
      '2025-07': [2000, 2000, 0],
      '2025-08': [2000, 4000, 0],
      '2025-09': [2000, 6000, 0],
      '2025-10': [2000, 8000, 0],
      '2025-11': [2000, 10000, 0],
      '2025-12': [2000, 12000, 0],
      // The rise to 300.00 in January: (300.00 - 120.00 held) / 6 months left = 30.00 a month.
      '2026-01': [3000, 15000, 0],
      '2026-02': [3000, 18000, 0],
      '2026-03': [3000, 21000, 0],
      '2026-04': [3000, 24000, 0],
      '2026-05': [3000, 27000, 0],
      '2026-06': [3000, 0, 0], // 270.00 + 30.00 = 300.00 is paid out
      // The next cycle: 300.00 / 12 = 25.00 a month.
      '2026-07': [2500, 2500, 0],
      '2026-08': [2500, 5000, 0],
      // Cancelled in September: no renewal is left, nothing more is set aside and the 50.00 held is given back.
      '2026-09': [0, 0, 5000],
    });
    // Until the cancellation every month still looks towards the next renewal, even after the end month's year.
    expect(renewalMonths['2025-01']).toBe('2025-06');
    expect(renewalMonths['2025-07']).toBe('2026-06');
    expect(renewalMonths['2026-01']).toBe('2026-06');
    expect(renewalMonths['2026-08']).toBe('2027-06');
    expect(renewalMonths['2026-09']).toBeNull();
    const september = await monthView(app, '2026-09');
    expect(subscriptionLine(september, 'Insurance')).toMatchObject({
      price: 30000,
      endsThisMonth: true,
      renewalThisMonth: false,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
    });
    expect(september.savingsDue.reservesReleased).toBe(5000);
    // After September there is no Insurance line at all.
    expect((await monthView(app, '2026-10')).subscriptions.map((s) => s.name)).toEqual([
      'Streaming',
    ]);
    // The renewals are the months the provider is actually paid: 240.00 in June 2025, 300.00 in June 2026.
    for (const [month, price] of [
      ['2025-06', 24000],
      ['2026-06', 30000],
    ] as const) {
      expect(subscriptionLine(await monthView(app, month), 'Insurance')).toMatchObject({
        renewalThisMonth: true,
        price,
        reserveBalance: 0,
      });
    }
  });

  it('accounts for every cent of the two years: income = spent + paid to providers + due to savings (nothing is still held)', async () => {
    const { app } = await liveUntil('2026-12');
    const rows = await monthSummaries(app, '2025-01', '2026-12');
    // Income: 6 x 2500.00 + 600.00 bonus + 18 x 2700.00 = 15000.00 + 600.00 + 48600.00 = 64200.00.
    const income = 6 * 250000 + 60000 + 18 * 270000;
    expect(income).toBe(6420000);
    expect(sum(rows.map((r) => r.income))).toBe(income);
    // Paid to providers: Streaming 15 x 12.99 (January 2025 to March 2026) + 9 x 14.99 (April to December 2026)
    // = 194.85 + 134.91 = 329.76, and the two renewals of Insurance, 240.00 + 300.00 = 540.00: 869.76.
    const paid = 15 * 1299 + 9 * 1499 + 24000 + 30000;
    expect(paid).toBe(86976);
    // Spent: 13270.00 in 24 months (the table of the first test, added up).
    expect(sum(rows.map((r) => r.spent))).toBe(1327000);
    // Everything else is due to savings: 64200.00 - 13270.00 - 869.76 = 50060.24. Nothing is held: Groceries no
    // longer rolls over, Transport is archived and the Insurance reserve was paid out or given back.
    expect(sum(rows.map((r) => r.savingsDue))).toBe(income - 1327000 - paid);
    expect(sum(rows.map((r) => r.savingsDue))).toBe(5006024);
    const december = await monthView(app, '2026-12');
    expect(sum(december.budgets.map((b) => b.carriedOut))).toBe(0);
    expect(december.subscriptions.map((s) => s.reserveBalance)).toEqual([0]);
  });

  it('in June 2025 the renewal month is a projection, July is only an assumption, and the later months change what July was', async () => {
    const { app, clock } = await liveUntil('2025-06');
    // The clock is in June (20 June). June is the current month: everything is as it stands today.
    const june = await monthView(app, '2025-06');
    expect(june.status).toBe('current');
    expect(subscriptionLine(june, 'Insurance')).toMatchObject({
      renewalThisMonth: true,
      price: 24000,
      charge: 4000, // 200.00 held + 40.00 reaches 240.00
      reserveBalance: 0, // ... which is paid out in June
    });
    expect(june.savingsDue.total).toBe(181701);
    // July is a projection that assumes June ends as it stands: no raise yet, Insurance on its new
    // 12-month cycle (20.00), Groceries starting clean after a June that ended on 0.00, Transport's
    // 145.00 carried. Unallocated: 2500.00 - (12.99 + 20.00) - 630.00 = 1837.01.
    const july = await monthView(app, '2025-07');
    expect(july.status).toBe('future');
    expect([july.income.total, july.fixedCosts, july.unallocated]).toEqual([250000, 3299, 183701]);
    expect(balances(budgetLine(july, 'Transport'))).toEqual([
      14500, 8000, 22500, 0, 22500, 22500, 0,
    ]);
    expect(balances(budgetLine(july, 'Groceries'))).toEqual([0, 40000, 40000, 0, 40000, 40000, 0]);
    // Once the clock has moved on, June is closed and says the same, and July is what actually happened.
    clock.set('2025-07-02T09:00:00Z');
    expect(await monthView(app, '2025-06')).toEqual({ ...june, status: 'closed' });
    await putJson(app, '/api/salary/2025-07', { amount: 270000 });
    const raised = await monthView(app, '2025-07');
    expect(raised.status).toBe('current');
    expect([raised.income.total, raised.unallocated]).toEqual([270000, 203701]);
    // Nothing before July moved because of the raise.
    expect(await monthView(app, '2025-06')).toEqual({ ...june, status: 'closed' });
    expect((await getJson<{ date: string; month: string }>(app, '/api/today')).month).toBe(
      '2025-07',
    );
  });
});
