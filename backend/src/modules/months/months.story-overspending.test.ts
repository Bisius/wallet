/**
 * Story 2: six months of overspending, January to June 2027.
 *
 * Three budgets that never last the month: Eating out (200.00) and Clothes (100.00) roll over, so
 * their deficits compound; Hobby (80.00) does not, so its deficit is taken from savings and the next
 * month starts clean. The pay is cut from April. In June the owner stops Eating out from rolling
 * over, and the whole accumulated deficit is taken from savings at once. Everything is entered
 * through the public API as it happens, with the clock moving, and every figure is worked out by
 * hand in the comments (the tests do not use the independent model or the oracle).
 *
 *   salary 2000.00 (1800.00 from April)   Phone 19.99 a month   opening savings 500.00
 *   allocations 200.00 + 100.00 + 80.00 = 380.00
 *   unallocated: January to March 2000.00 - 19.99 - 380.00 = 1600.01; April to June 1800.00 - 19.99 - 380.00 = 1400.01
 */
import type { MonthView } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import { addSpending, addSubscription, mutableClock, onboard } from '../../testing/helpers';
import {
  balances,
  budgetLine,
  monthSummaries,
  monthView,
  putJson,
  sum,
  summaryRow,
} from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

/** What was spent each month: `[month, eatingOut, clothes, hobby]`, one number per receipt (a refund is negative). */
const PLAN: [month: string, eatingOut: number[], clothes: number[], hobby: number[]][] = [
  ['2027-01', [16000, 10000], [15000], [12000]],
  ['2027-02', [25000], [], [8000]],
  ['2027-03', [27000], [23000], [7000, 5000]],
  ['2027-04', [26000], [], [12000]],
  ['2027-05', [24000], [14000], [12000, -3000]], // 30.00 of the Hobby purchase was returned
  ['2027-06', [26000], [], [5000]],
];

async function liveIt() {
  const clock = mutableClock('2027-01-04T09:00:00Z');
  const { app } = createTestApp(clock);
  await onboard(app, {
    startMonth: '2027-01',
    salary: 200000,
    openingSavings: 50000,
    budgets: [
      { name: 'Eating out', amount: 20000, incremental: true }, // id 1
      { name: 'Clothes', amount: 10000, incremental: true }, // id 2
      { name: 'Hobby', amount: 8000, incremental: false }, // id 3
    ],
  });
  await addSubscription(app, { name: 'Phone', amount: 1999, anchorDate: '2027-01-09' });

  const ids = { eatingOut: 1, clothes: 2, hobby: 3 };
  let beforeTheCut: MonthView[] = [];
  for (const [month, eatingOut, clothes, hobby] of PLAN) {
    clock.set(`${month}-15T10:00:00Z`);
    if (month === '2027-04') {
      // The pay cut, entered in April: it takes effect from April. First look at how the months so
      // far stand, to be able to check that the cut did not touch them.
      beforeTheCut = [
        await monthView(app, '2027-01'),
        await monthView(app, '2027-02'),
        await monthView(app, '2027-03'),
      ];
      await putJson(app, '/api/salary/2027-04', { amount: 180000 });
    }
    if (month === '2027-06') {
      // Enough: Eating out stops rolling over from June.
      await putJson(app, '/api/budgets/1/versions/2027-06', { amount: 20000, incremental: false });
    }
    const receipts = [
      ...eatingOut.map((amount) => ({ budgetId: ids.eatingOut, amount })),
      ...clothes.map((amount) => ({ budgetId: ids.clothes, amount })),
      ...hobby.map((amount) => ({ budgetId: ids.hobby, amount })),
    ];
    let day = 2;
    for (const { budgetId, amount } of receipts) {
      await addSpending(app, {
        budgetId,
        amount,
        date: `${month}-${String(day).padStart(2, '0')}`,
      });
      day += 5;
    }
  }
  return { app, clock, beforeTheCut };
}

describe('story: six months of overspending, January to June 2027', () => {
  it('the deficits compound in the budgets that roll over, and the one that does not starts clean every month', async () => {
    const { app } = await liveIt();
    const book = async (name: string) => {
      const lines: Record<string, ReturnType<typeof balances>> = {};
      for (const [month] of PLAN)
        lines[month] = balances(budgetLine(await monthView(app, month), name));
      return lines;
    };
    // [carriedIn, allocated, available, spent, remaining, carriedOut, toSavings]
    expect(await book('Eating out')).toEqual({
      '2027-01': [0, 20000, 20000, 26000, -6000, -6000, 0], // 200.00 - 260.00: 60.00 behind, carried
      '2027-02': [-6000, 20000, 14000, 25000, -11000, -11000, 0], // -60.00 + 200.00 = 140.00; 250.00 spent: 110.00 behind
      '2027-03': [-11000, 20000, 9000, 27000, -18000, -18000, 0], // -110.00 + 200.00 = 90.00; 270.00 spent: 180.00 behind
      '2027-04': [-18000, 20000, 2000, 26000, -24000, -24000, 0], // -180.00 + 200.00 = 20.00; 260.00 spent: 240.00 behind
      '2027-05': [-24000, 20000, -4000, 24000, -28000, -28000, 0], // -240.00 + 200.00 = -40.00 to spend; 240.00 spent
      // Switched to non-incremental in June: the 340.00 hole is not carried on, it is taken from savings.
      // -280.00 + 200.00 = -80.00 available, 260.00 spent: -340.00.
      '2027-06': [-28000, 20000, -8000, 26000, -34000, 0, -34000],
    });
    expect(await book('Clothes')).toEqual({
      '2027-01': [0, 10000, 10000, 15000, -5000, -5000, 0], // 100.00 - 150.00
      '2027-02': [-5000, 10000, 5000, 0, 5000, 5000, 0], // -50.00 + 100.00 = 50.00, nothing bought: 50.00 carried
      '2027-03': [5000, 10000, 15000, 23000, -8000, -8000, 0], // 50.00 + 100.00 = 150.00; 230.00 spent
      '2027-04': [-8000, 10000, 2000, 0, 2000, 2000, 0], // -80.00 + 100.00 = 20.00
      '2027-05': [2000, 10000, 12000, 14000, -2000, -2000, 0], // 20.00 + 100.00 = 120.00; 140.00 spent
      '2027-06': [-2000, 10000, 8000, 0, 8000, 8000, 0], // -20.00 + 100.00 = 80.00 carried: it still rolls over
    });
    expect(await book('Hobby')).toEqual({
      // Never carried: each month is settled with savings and the next one starts at 80.00.
      '2027-01': [0, 8000, 8000, 12000, -4000, 0, -4000], // 120.00 of 80.00: 40.00 taken from savings
      '2027-02': [0, 8000, 8000, 8000, 0, 0, 0], // the 40.00 deficit of January is not carried: exactly on budget
      '2027-03': [0, 8000, 8000, 12000, -4000, 0, -4000],
      '2027-04': [0, 8000, 8000, 12000, -4000, 0, -4000],
      '2027-05': [0, 8000, 8000, 9000, -1000, 0, -1000], // 120.00 spent, 30.00 refunded: 90.00 net, -10.00
      '2027-06': [0, 8000, 8000, 5000, 3000, 0, 3000], // 50.00 spent: 30.00 moves to savings
    });
  });

  it('the alerts: over budget in most months, a warning at exactly 100%, and no usage figure once the available amount is negative', async () => {
    const { app } = await liveIt();
    const alerts = async (name: string) => {
      const found: Record<string, [number | null, string]> = {};
      for (const [month] of PLAN) {
        const line = budgetLine(await monthView(app, month), name);
        found[month] = [line.usagePercent, line.alert];
      }
      return found;
    };
    // usagePercent = floor(100 x spent / available): rounded down and not capped.
    expect(await alerts('Eating out')).toEqual({
      '2027-01': [130, 'over'], // 260.00 of 200.00
      '2027-02': [178, 'over'], // 250.00 of 140.00 = 178.57
      '2027-03': [300, 'over'], // 270.00 of 90.00
      '2027-04': [1300, 'over'], // 260.00 of 20.00
      '2027-05': [null, 'over'], // 240.00 spent of -40.00 available: no percentage, but over
      '2027-06': [null, 'over'], // -80.00 available
    });
    expect(await alerts('Clothes')).toEqual({
      '2027-01': [150, 'over'],
      '2027-02': [0, 'ok'], // nothing bought
      '2027-03': [153, 'over'], // 230.00 of 150.00 = 153.33
      '2027-04': [0, 'ok'],
      '2027-05': [116, 'over'], // 140.00 of 120.00 = 116.67
      '2027-06': [0, 'ok'],
    });
    expect(await alerts('Hobby')).toEqual({
      '2027-01': [150, 'over'],
      '2027-02': [100, 'warning'], // 80.00 of 80.00: used up, not over
      '2027-03': [150, 'over'],
      '2027-04': [150, 'over'],
      '2027-05': [112, 'over'], // 90.00 of 80.00 = 112.5
      '2027-06': [62, 'ok'], // 50.00 of 80.00 = 62.5: under the 80% warning
    });
  });

  it('what each month sends to savings or takes from them, with the pay cut from April, and July and August as projections', async () => {
    const { app } = await liveIt();
    const rows = await monthSummaries(app, '2027-01', '2027-08');
    // [month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]
    expect(rows.map(summaryRow)).toEqual([
      // Income 2000.00; Phone 19.99; allocated 380.00; spent 260.00 + 150.00 + 120.00 = 530.00.
      // Unallocated 2000.00 - 19.99 - 380.00 = 1600.01. Only Hobby settles: -40.00. Due 1560.01.
      ['2027-01', 'closed', 200000, 1999, 38000, 53000, 160001, 156001],
      // Spent 250.00 + 0 + 80.00 = 330.00. Nothing settles (Hobby is exactly on budget): due 1600.01.
      ['2027-02', 'closed', 200000, 1999, 38000, 33000, 160001, 160001],
      // Spent 270.00 + 230.00 + 120.00 = 620.00, far more than the 380.00 allocated, yet the month still
      // owes 1600.01 - 40.00 = 1560.01: the other two deficits are carried, not taken from savings.
      ['2027-03', 'closed', 200000, 1999, 38000, 62000, 160001, 156001],
      // The pay cut: income 1800.00, unallocated 1800.00 - 19.99 - 380.00 = 1400.01. Spent 260.00 + 0 +
      // 120.00 = 380.00. Hobby -40.00: due 1360.01.
      ['2027-04', 'closed', 180000, 1999, 38000, 38000, 140001, 136001],
      // Spent 240.00 + 140.00 + 90.00 = 470.00. Hobby -10.00: due 1390.01.
      ['2027-05', 'closed', 180000, 1999, 38000, 47000, 140001, 139001],
      // June, projected as if it ended today: spent 260.00 + 0 + 50.00 = 310.00. Eating out settles its
      // whole deficit, -340.00, and Hobby +30.00: due 1400.01 - 340.00 + 30.00 = 1090.01.
      ['2027-06', 'current', 180000, 1999, 38000, 31000, 140001, 109001],
      // July assumes June ends like this: Eating out starts clean (200.00 moves), Clothes carries 80.00 + 100.00
      // = 180.00, Hobby 80.00 moves: due 1400.01 + 200.00 + 80.00 = 1680.01.
      ['2027-07', 'future', 180000, 1999, 38000, 0, 140001, 168001],
      ['2027-08', 'future', 180000, 1999, 38000, 0, 140001, 168001],
    ]);
    // No month is over-allocated: the deficits are in the budgets, not in the plan.
    for (const [month] of PLAN) expect((await monthView(app, month)).overAllocated).toBe(false);
  });

  it('switching Eating out to non-incremental settles the whole deficit in June, and the projection of July starts clean', async () => {
    const { app } = await liveIt();
    const june = await monthView(app, '2027-06');
    expect(june.status).toBe('current');
    expect(budgetLine(june, 'Eating out')).toMatchObject({
      incremental: false,
      toSavings: -34000,
      carriedOut: 0,
    });
    expect(june.savingsDue.budgetsSettled).toBe(-31000); // -340.00 (Eating out) + 30.00 (Hobby) + 0 (Clothes carries)
    // July: Eating out's balance is 0 (not -340.00), so its full 200.00 allocation is available again.
    const july = await monthView(app, '2027-07');
    expect(balances(budgetLine(july, 'Eating out'))).toEqual([0, 20000, 20000, 0, 20000, 0, 20000]);
    // Clothes still rolls over: June's 80.00 is carried into July, and July's projection into August.
    expect(balances(budgetLine(july, 'Clothes'))).toEqual([8000, 10000, 18000, 0, 18000, 18000, 0]);
    expect(balances(budgetLine(await monthView(app, '2027-08'), 'Clothes'))).toEqual([
      18000, 10000, 28000, 0, 28000, 28000, 0,
    ]);
  });

  it('the pay cut dated April leaves January to March exactly as they were; dating it March would rewrite March', async () => {
    const { app, beforeTheCut } = await liveIt();
    // The three months, as they stood before the cut was entered, are unchanged (March has closed since).
    for (const before of beforeTheCut) {
      const now = await monthView(app, before.month);
      expect(now).toEqual({ ...before, status: 'closed' });
    }
    expect(beforeTheCut.map((m) => m.income.total)).toEqual([200000, 200000, 200000]);
    // An explicit edit dated March (backdating the cut by a month, to 1900.00) does rewrite March, and
    // only March: January and February come before it, April has its own salary entry.
    const april = await monthView(app, '2027-04');
    await putJson(app, '/api/salary/2027-03', { amount: 190000 });
    const march = await monthView(app, '2027-03');
    // Unallocated 1900.00 - 19.99 - 380.00 = 1500.01; Hobby -40.00: due 1460.01 (was 1560.01).
    expect([march.income.total, march.unallocated, march.savingsDue.total]).toEqual([
      190000, 150001, 146001,
    ]);
    expect(await monthView(app, '2027-02')).toEqual(beforeTheCut[1]);
    expect(await monthView(app, '2027-01')).toEqual(beforeTheCut[0]);
    expect(await monthView(app, '2027-04')).toEqual(april);
  });

  it('accounts for every cent: income = spent + paid to providers + due to savings + still held (the 80.00 Clothes carries)', async () => {
    const { app } = await liveIt();
    const rows = await monthSummaries(app, '2027-01', '2027-06');
    // Income: 3 x 2000.00 + 3 x 1800.00 = 11400.00.
    const income = 3 * 200000 + 3 * 180000;
    expect(sum(rows.map((r) => r.income))).toBe(income);
    // Spent: Eating out 1540.00 + Clothes 520.00 + Hobby 580.00 = 2640.00 (the 30.00 refund is already off).
    expect(sum(rows.map((r) => r.spent))).toBe(154000 + 52000 + 58000);
    // Paid to the provider: Phone 6 x 19.99 = 119.94. Held at the end of June: Clothes' 80.00.
    const paid = 6 * 1999;
    const held = 8000;
    // Due to savings: 11400.00 - 2640.00 - 119.94 - 80.00 = 8560.06, which is what the months say.
    expect(sum(rows.map((r) => r.savingsDue))).toBe(
      income - (154000 + 52000 + 58000) - paid - held,
    );
    expect(sum(rows.map((r) => r.savingsDue))).toBe(856006);
    expect(sum((await monthView(app, '2027-06')).budgets.map((b) => b.carriedOut))).toBe(held);
  });
});
