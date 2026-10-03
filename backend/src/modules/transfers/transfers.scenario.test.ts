/**
 * Multi-month scenarios for transfers, through the real API with a clock that moves. Every number
 * is worked out by hand from docs/DOMAIN.md ("Transfers", "Unallocated", "Causality", "Savings" and
 * invariant 8), with the derivation next to it, and none is copied from a run. The ledger is
 * recomputed from the stored facts on every request, so nothing "closes" a month: the scenarios
 * check what a transfer does to the month it is dated in, to the months after it through the
 * carry-over of an incremental budget, to the savings due, and to nothing else.
 *
 * The world (`buildWorld`): tracking since 2026-01, salary 3,000.00, opening savings 1,000.00, no
 * subscriptions. Three budgets, all active from January:
 *
 *   Groceries  400.00  incremental      Holiday  200.00  incremental      Fun  100.00  not incremental
 *
 * Spendings (cents): Jan Groceries 150.00, Fun 30.00. Feb Groceries 250.00, Holiday 50.00, Fun 100.00.
 * Mar Groceries 600.00, Fun 80.00. Apr Groceries 120.00, Fun 20.00. It is 2026-04-15 at the end of
 * the set-up: January to March are closed, April is the current month, May on is projected.
 *
 * Every month: 3,000.00 comes in and 700.00 is allocated, so 2,300.00 is unallocated. Fun is settled
 * to savings each month, Groceries and Holiday carry their leftover (or deficit) into the next.
 */
import type { BudgetDto, MonthView, TransferCreateInput } from '@wallet/shared';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addSpending,
  addTransfer,
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { expectChainIdentities, expectMonthIdentities } from '../../testing/month-identities';
import {
  allTransactions,
  expectSavingsIdentities,
  getSavings,
  settleOk,
  undoSettlement,
} from '../../testing/savings-helpers';
import { expectApiMatchesOracle } from '../../testing/scenario';
import { budgetLine, getJson, monthView, sum, summaryRow } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';
import {
  type Row,
  expectNothingChangedBefore,
  expectNothingElseChanged,
  expectSameSnapshot,
  levelOf,
  listening,
  rowOf,
  rowsOf,
  snapshotOf,
  stopListening,
  viewOf,
} from '../../testing/transfer-story';

afterEach(stopListening);

// Each scenario makes a hundred requests or more: leave room for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
const RANGE = { from: '2026-01', to: '2026-07', months: MONTHS } as const;

async function buildWorld() {
  const clock = mutableClock('2026-01-20T10:00:00Z');
  const app = await listening(createTestApp(clock).app);
  const done = await onboard(app, {
    startMonth: '2026-01',
    salary: 300000,
    openingSavings: 100000,
    budgets: [
      { name: 'Groceries', amount: 40000, incremental: true },
      { name: 'Holiday', amount: 20000, incremental: true },
      { name: 'Fun', amount: 10000, incremental: false },
    ],
  });
  const [groceries, holiday, fun] = done.budgets as [BudgetDto, BudgetDto, BudgetDto];
  const spend = (budget: BudgetDto, date: string, amount: number) =>
    addSpending(app, { budgetId: budget.id, date, amount });

  await spend(groceries, '2026-01-12', 15000);
  await spend(fun, '2026-01-15', 3000);
  clock.set('2026-02-24T10:00:00Z');
  await spend(groceries, '2026-02-09', 25000);
  await spend(holiday, '2026-02-20', 5000);
  await spend(fun, '2026-02-14', 10000);
  clock.set('2026-03-25T10:00:00Z');
  await spend(groceries, '2026-03-10', 60000);
  await spend(fun, '2026-03-18', 8000);
  clock.set('2026-04-15T10:00:00Z');
  await spend(groceries, '2026-04-05', 12000);
  await spend(fun, '2026-04-08', 2000);
  return { app, clock, groceries, holiday, fun };
}

type Budgets = Awaited<ReturnType<typeof buildWorld>>;

/**
 * The world before any transfer, month by month, as `[Groceries, Holiday, Fun]` rows (see `Row`),
 * the unallocated pool and the savings due. Derivation, per budget:
 *
 *   Groceries  carried in = last month's remaining. Jan: 400 - 150 = 250. Feb: 250 + 400 - 250 = 400.
 *              Mar: 400 + 400 - 600 = 200. Apr: 200 + 400 - 120 = 480. May: 480 + 400 = 880.
 *              Jun: 880 + 400 = 1,280. Jul: 1,280 + 400 = 1,680.
 *   Holiday    Jan: 200. Feb: 200 + 200 - 50 = 350. Mar: 350 + 200 = 550. Apr: 750. May: 950.
 *              Jun: 1,150. Jul: 1,350.
 *   Fun        100.00 every month, nothing carried: Jan 100 - 30 = 70 to savings. Feb 100 - 100 = 0.
 *              Mar 100 - 80 = 20. Apr 100 - 20 = 80 (projected). May, Jun, Jul: 100.
 *   Savings due = unallocated 2,300.00 + what Fun sends: Jan 2,370.00. Feb 2,300.00. Mar 2,320.00.
 *              Apr 2,380.00. May, Jun, Jul 2,400.00.
 */
const BASELINE: Record<
  string,
  { groceries: Row; holiday: Row; fun: Row; unallocated: number; savingsDue: number }
> = {
  '2026-01': {
    groceries: [0, 40000, 0, 40000, 15000, 25000, 25000, 0],
    holiday: [0, 20000, 0, 20000, 0, 20000, 20000, 0],
    fun: [0, 10000, 0, 10000, 3000, 7000, 0, 7000],
    unallocated: 230000,
    savingsDue: 237000,
  },
  '2026-02': {
    groceries: [25000, 40000, 0, 65000, 25000, 40000, 40000, 0],
    holiday: [20000, 20000, 0, 40000, 5000, 35000, 35000, 0],
    fun: [0, 10000, 0, 10000, 10000, 0, 0, 0],
    unallocated: 230000,
    savingsDue: 230000,
  },
  '2026-03': {
    groceries: [40000, 40000, 0, 80000, 60000, 20000, 20000, 0],
    holiday: [35000, 20000, 0, 55000, 0, 55000, 55000, 0],
    fun: [0, 10000, 0, 10000, 8000, 2000, 0, 2000],
    unallocated: 230000,
    savingsDue: 232000,
  },
  '2026-04': {
    groceries: [20000, 40000, 0, 60000, 12000, 48000, 48000, 0],
    holiday: [55000, 20000, 0, 75000, 0, 75000, 75000, 0],
    fun: [0, 10000, 0, 10000, 2000, 8000, 0, 8000],
    unallocated: 230000,
    savingsDue: 238000,
  },
  '2026-05': {
    groceries: [48000, 40000, 0, 88000, 0, 88000, 88000, 0],
    holiday: [75000, 20000, 0, 95000, 0, 95000, 95000, 0],
    fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
    unallocated: 230000,
    savingsDue: 240000,
  },
  '2026-06': {
    groceries: [88000, 40000, 0, 128000, 0, 128000, 128000, 0],
    holiday: [95000, 20000, 0, 115000, 0, 115000, 115000, 0],
    fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
    unallocated: 230000,
    savingsDue: 240000,
  },
  '2026-07': {
    groceries: [128000, 40000, 0, 168000, 0, 168000, 168000, 0],
    holiday: [115000, 20000, 0, 135000, 0, 135000, 135000, 0],
    fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
    unallocated: 230000,
    savingsDue: 240000,
  },
};

describe('the world the scenarios start from', () => {
  it('is what the rules of docs/DOMAIN.md give, month by month, before any transfer', async () => {
    const { app } = await buildWorld();
    const snapshot = await snapshotOf(app, RANGE);
    for (const month of MONTHS) {
      const view = viewOf(snapshot, month);
      const want = BASELINE[month]!;
      expect(rowsOf(view), month).toEqual({
        Groceries: want.groceries,
        Holiday: want.holiday,
        Fun: want.fun,
      });
      expect(levelOf(view), month).toEqual({
        unallocated: want.unallocated,
        transfersNet: 0,
        savingsDue: want.savingsDue,
      });
      expectMonthIdentities(view);
    }
    // [month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]
    expect(snapshot.summaries.map(summaryRow)).toEqual([
      ['2026-01', 'closed', 300000, 0, 70000, 18000, 230000, 237000], // spent 150 + 30
      ['2026-02', 'closed', 300000, 0, 70000, 40000, 230000, 230000], // 250 + 50 + 100
      ['2026-03', 'closed', 300000, 0, 70000, 68000, 230000, 232000], // 600 + 80
      ['2026-04', 'current', 300000, 0, 70000, 14000, 230000, 238000], // 120 + 20
      ['2026-05', 'future', 300000, 0, 70000, 0, 230000, 240000],
      ['2026-06', 'future', 300000, 0, 70000, 0, 230000, 240000],
      ['2026-07', 'future', 300000, 0, 70000, 0, 230000, 240000],
    ]);
    // Three closed months, each to be moved to savings: 2,370.00 + 2,300.00 + 2,320.00 = 6,990.00.
    expect(snapshot.savings).toEqual({
      balance: 100000,
      unassigned: 100000,
      goals: [],
      outstanding: [
        {
          month: '2026-01',
          savingsDue: 237000,
          settled: 0,
          outstanding: 237000,
          direction: 'move',
          breakdown: { unallocated: 230000, budgetsSettled: 7000, reservesReleased: 0 },
          adjustment: false,
        },
        {
          month: '2026-02',
          savingsDue: 230000,
          settled: 0,
          outstanding: 230000,
          direction: 'move',
          breakdown: { unallocated: 230000, budgetsSettled: 0, reservesReleased: 0 },
          adjustment: false,
        },
        {
          month: '2026-03',
          savingsDue: 232000,
          settled: 0,
          outstanding: 232000,
          direction: 'move',
          breakdown: { unallocated: 230000, budgetsSettled: 2000, reservesReleased: 0 },
          adjustment: false,
        },
      ],
      outstandingTotal: 699000,
    });
    expectChainIdentities(snapshot.views, { startsAtLedgerStart: true });
    // Invariant 2 by hand, January to March: income 9,000.00 = spent 1,260.00 (180 + 400 + 680)
    // + savings due 6,990.00 + held in Groceries and Holiday at the end of March (200 + 550 = 750.00).
    const quarter = snapshot.summaries.slice(0, 3);
    const march = viewOf(snapshot, '2026-03');
    expect(sum(quarter.map((row) => row.income))).toBe(900000);
    expect(sum(quarter.map((row) => row.spent))).toBe(126000);
    expect(sum(quarter.map((row) => row.savingsDue))).toBe(699000);
    expect(sum(march.budgets.map((line) => line.carriedOut))).toBe(75000);
  });
});

// -------------------------------------------------------------------------------------------------
// The life of a few transfers
// -------------------------------------------------------------------------------------------------

describe('story: a transfer lands in a settled month, and the months catch up with the clock', () => {
  it('shows the settled month as an adjustment, settling clears it, and undo and delete put it all back to the cent', async () => {
    const { app, holiday } = await buildWorld();

    // January to March are settled with exactly what they owe (all to unassigned savings).
    await settleOk(app, '2026-01', { amount: 237000 });
    await settleOk(app, '2026-02', { amount: 230000 });
    await settleOk(app, '2026-03', { amount: 232000 });
    // Balance: 1,000.00 opening + 6,990.00 settled.
    expect(await expectSavingsIdentities(app)).toMatchObject({
      balance: 799000,
      unassigned: 799000,
      outstanding: [],
      outstandingTotal: 0,
    });
    const settled = await snapshotOf(app, RANGE);

    // 1. A transfer dated in the settled February: 100.00 from the unallocated pool to Holiday.
    const transfer = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: holiday.id,
      amount: 10000,
    });
    const withIt = await snapshotOf(app, RANGE);

    // January is before the transfer: untouched to the last field (causality).
    expectNothingChangedBefore(settled, withIt, '2026-02');
    // February: Holiday gets 100.00 more, 200 + 200 + 100 - 50 spent = 450.00 left, all carried.
    // The pool has 100.00 less: 3,000.00 - 700.00 - 100.00 = 2,200.00, and so has the savings due.
    const february = viewOf(withIt, '2026-02');
    expect(rowOf(budgetLine(february, 'Holiday'))).toEqual([
      20000, 20000, 10000, 50000, 5000, 45000, 45000, 0,
    ]);
    expect(levelOf(february)).toEqual({
      unallocated: 220000,
      transfersNet: 10000,
      savingsDue: 220000,
    });
    // Holiday carries 450.00 into March instead of 350.00 and every month after it carries 100.00
    // more: carried in / carried out of Mar, Apr, May, Jun, Jul.
    expect(
      ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map((month) => {
        const line = budgetLine(viewOf(withIt, month), 'Holiday');
        return [line.carriedIn, line.carriedOut];
      }),
    ).toEqual([
      [45000, 65000], // 450 in; 450 + 200 = 650 out
      [65000, 85000],
      [85000, 105000],
      [105000, 125000],
      [125000, 145000],
    ]);
    expectNothingElseChanged(settled, withIt, '2026-02', {
      involved: ['Holiday'],
      carrying: ['Holiday'],
    });
    // The only month that owes something is February, and as a correction of what was settled:
    // it was settled at 2,300.00 and is due 2,200.00 now, so 100.00 comes back from savings.
    expect(await expectSavingsIdentities(app)).toEqual({
      balance: 799000,
      unassigned: 799000,
      goals: [],
      outstanding: [
        {
          month: '2026-02',
          savingsDue: 220000,
          settled: 230000,
          outstanding: -10000,
          direction: 'take',
          breakdown: { unallocated: 220000, budgetsSettled: 0, reservesReleased: 0 },
          adjustment: true,
        },
      ],
      outstandingTotal: -10000,
    });
    // March does not owe more: Holiday carries the 100.00, it does not send it to savings.
    expect(viewOf(withIt, '2026-03').savingsDue.total).toBe(232000);
    expect(withIt.transfers).toEqual([
      {
        id: transfer.id,
        date: '2026-02-10',
        fromBudgetId: null,
        toBudgetId: holiday.id,
        amount: 10000,
        note: null,
      },
    ]);

    // 2. Settling the correction clears it. The row takes 100.00 out of unassigned savings.
    const [correction] = await settleOk(app, '2026-02', { amount: -10000 });
    expect(correction).toMatchObject({
      kind: 'settlement',
      amount: -10000,
      goalId: null,
      settlesMonth: '2026-02',
      date: '2026-04-15',
    });
    expect(await expectSavingsIdentities(app)).toMatchObject({
      balance: 789000, // 7,990.00 - 100.00
      outstanding: [],
      outstandingTotal: 0,
    });
    const februaryRows = (await allTransactions(app))
      .filter((row) => row.settlesMonth === '2026-02')
      .map((row) => row.amount)
      .sort((a, b) => a - b);
    // 2,300.00 and -100.00 settle 2,200.00, which is what February is due now.
    expect(februaryRows).toEqual([-10000, 230000]);

    // 3. Undoing the settlement removes both rows. February owes its whole savings due again,
    // 2,200.00, and it is no longer an adjustment.
    await undoSettlement(app, '2026-02');
    const undone = await expectSavingsIdentities(app);
    expect(undone.outstanding).toEqual([
      {
        month: '2026-02',
        savingsDue: 220000,
        settled: 0,
        outstanding: 220000,
        direction: 'move',
        breakdown: { unallocated: 220000, budgetsSettled: 0, reservesReleased: 0 },
        adjustment: false,
      },
    ]);
    expect(undone.balance).toBe(569000); // 1,000.00 + January 2,370.00 + March 2,320.00
    // The months did not move: settling and undoing are not facts of the ledger.
    expect((await snapshotOf(app, RANGE)).views).toEqual(withIt.views);

    // 4. Settled again at 2,200.00, then the transfer is deleted: February is due 2,300.00 again,
    // 100.00 more than was settled, so it is an adjustment of +100.00.
    await settleOk(app, '2026-02', { amount: 220000 });
    expect(await expectSavingsIdentities(app)).toMatchObject({ balance: 789000, outstanding: [] });
    await request(app).delete(`/api/transfers/${transfer.id}`).expect(204);
    const deleted = await snapshotOf(app, RANGE);
    // Every month, every summary row and the budgets (hasHistory included) are as they were.
    expect(deleted.views).toEqual(settled.views);
    expect(deleted.summaries).toEqual(settled.summaries);
    expect(deleted.budgets).toEqual(settled.budgets);
    expect(deleted.transfers).toEqual([]);
    expect(await expectSavingsIdentities(app)).toEqual({
      balance: 789000,
      unassigned: 789000,
      goals: [],
      outstanding: [
        {
          month: '2026-02',
          savingsDue: 230000,
          settled: 220000,
          outstanding: 10000,
          direction: 'move',
          breakdown: { unallocated: 230000, budgetsSettled: 0, reservesReleased: 0 },
          adjustment: true,
        },
      ],
      outstandingTotal: 10000,
    });

    // 5. Settling the last 100.00 gives the savings exactly what they were before the transfer.
    await settleOk(app, '2026-02', { amount: 10000 });
    expectSameSnapshot(await snapshotOf(app, RANGE), settled);
    expect(
      (await allTransactions(app)).filter((row) => row.settlesMonth === '2026-02').length,
    ).toBe(
      2, // 2,200.00 and 100.00: they settle 2,300.00 together
    );
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-07' });
  });

  it('a transfer in the current month and one in a future month, until the clock reaches them', async () => {
    const { app, clock, groceries, holiday } = await buildWorld();
    await settleOk(app, '2026-01', { amount: 237000 });
    await settleOk(app, '2026-02', { amount: 230000 });
    await settleOk(app, '2026-03', { amount: 232000 });
    const settled = await snapshotOf(app, RANGE);

    // B. The current month, dated after today (28 April; it is the 15th): 120.00 from Groceries to
    // Holiday. It counts in April, the month it is dated in. Both budgets carry, so the savings due
    // does not move, and neither does the pool.
    //   Groceries April: 200 carried in + 400 - 120 moved out = 480.00 available, 120.00 spent:
    //   360.00 left, carried (projected as if April ended today).
    //   Holiday April: 550 + 200 + 120 = 870.00 available, nothing spent, 870.00 carried.
    await addTransfer(app, {
      date: '2026-04-28',
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 12000,
    });
    const withB = await snapshotOf(app, RANGE);
    expectNothingChangedBefore(settled, withB, '2026-04');
    const april = viewOf(withB, '2026-04');
    expect(rowOf(budgetLine(april, 'Groceries'))).toEqual([
      20000, 40000, -12000, 48000, 12000, 36000, 36000, 0,
    ]);
    expect(rowOf(budgetLine(april, 'Holiday'))).toEqual([
      55000, 20000, 12000, 87000, 0, 87000, 87000, 0,
    ]);
    expect(levelOf(april)).toEqual({ unallocated: 230000, transfersNet: 0, savingsDue: 238000 });
    // May to July: Groceries carries 120.00 less each month and Holiday 120.00 more.
    //   Groceries carried out: May 360 + 400 = 760. Jun 1,160. Jul 1,560.
    //   Holiday carried out:   May 870 + 200 = 1,070. Jun 1,270. Jul 1,470.
    expect(
      ['2026-05', '2026-06', '2026-07'].map((month) => [
        budgetLine(viewOf(withB, month), 'Groceries').carriedOut,
        budgetLine(viewOf(withB, month), 'Holiday').carriedOut,
      ]),
    ).toEqual([
      [76000, 107000],
      [116000, 127000],
      [156000, 147000],
    ]);
    expectNothingElseChanged(settled, withB, '2026-04', {
      involved: ['Groceries', 'Holiday'],
      carrying: ['Groceries', 'Holiday'],
    });
    // April is not closed, so the list of months to settle does not know about it.
    expect(withB.savings).toEqual(settled.savings);

    // C. A future month: 60.00 from Holiday back to the pool on 5 June.
    //   Holiday June: 1,070 carried in + 200 - 60 = 1,210.00 available, all carried.
    //   The pool of June: 3,000.00 - 700.00 + 60.00 = 2,360.00, and so the savings due is
    //   2,360.00 + Fun's 100.00 = 2,460.00. May, before the transfer, is as it was.
    await addTransfer(app, {
      date: '2026-06-05',
      fromBudgetId: holiday.id,
      toBudgetId: null,
      amount: 6000,
    });
    const withC = await snapshotOf(app, RANGE);
    expectNothingChangedBefore(withB, withC, '2026-06');
    const june = viewOf(withC, '2026-06');
    expect(rowOf(budgetLine(june, 'Holiday'))).toEqual([
      107000, 20000, -6000, 121000, 0, 121000, 121000, 0,
    ]);
    expect(levelOf(june)).toEqual({ unallocated: 236000, transfersNet: -6000, savingsDue: 246000 });
    expect(rowOf(budgetLine(viewOf(withC, '2026-07'), 'Holiday'))).toEqual([
      121000, 20000, 0, 141000, 0, 141000, 141000, 0,
    ]);
    expect(withC.transfers.map((t) => [t.date, t.fromBudgetId, t.toBudgetId, t.amount])).toEqual([
      ['2026-06-05', holiday.id, null, 6000], // newest first
      ['2026-04-28', groceries.id, holiday.id, 12000],
    ]);
    expect(withC.savings).toEqual(settled.savings);
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-07' });

    // The clock reaches May: April is closed. Nothing about it changes but its status, and it
    // enters the list of months to settle with the savings due it showed as a projection:
    // 2,300.00 unallocated + 80.00 from Fun.
    clock.set('2026-05-03T09:00:00Z');
    const may3 = await snapshotOf(app, RANGE);
    const closedApril = viewOf(may3, '2026-04');
    expect(closedApril.status).toBe('closed');
    expect({ ...closedApril, status: 'current' }).toEqual(viewOf(withC, '2026-04'));
    expect(viewOf(may3, '2026-05').status).toBe('current');
    expect(await expectSavingsIdentities(app)).toEqual({
      balance: 799000,
      unassigned: 799000,
      goals: [],
      outstanding: [
        {
          month: '2026-04',
          savingsDue: 238000,
          settled: 0,
          outstanding: 238000,
          direction: 'move',
          breakdown: { unallocated: 230000, budgetsSettled: 8000, reservesReleased: 0 },
          adjustment: false,
        },
      ],
      outstandingTotal: 238000,
    });
    await settleOk(app, '2026-04', { amount: 238000 });

    // The clock reaches July: May and June are closed, with C inside June.
    //   May: 2,300.00 + Fun 100.00 = 2,400.00. June: 2,360.00 + 100.00 = 2,460.00.
    clock.set('2026-07-02T09:00:00Z');
    const savings = await expectSavingsIdentities(app);
    expect(
      savings.outstanding.map((m) => [m.month, m.savingsDue, m.outstanding, m.breakdown]),
    ).toEqual([
      [
        '2026-05',
        240000,
        240000,
        { unallocated: 230000, budgetsSettled: 10000, reservesReleased: 0 },
      ],
      [
        '2026-06',
        246000,
        246000,
        { unallocated: 236000, budgetsSettled: 10000, reservesReleased: 0 },
      ],
    ]);
    expect(savings.outstandingTotal).toBe(486000);
    await settleOk(app, '2026-05', { amount: 240000 });
    await settleOk(app, '2026-06', { amount: 246000 });
    // 1,000.00 + 2,370 + 2,300 + 2,320 + 2,380 + 2,400 + 2,460 = 15,230.00
    expect(await expectSavingsIdentities(app)).toMatchObject({
      balance: 1523000,
      outstanding: [],
      outstandingTotal: 0,
    });

    // Conservation (invariant 2), January to June, by hand:
    //   income 6 x 3,000.00 = 18,000.00
    //   = spent 1,400.00 (180 + 400 + 680 + 140) + savings due 14,230.00 (2,370 + 2,300 + 2,320 +
    //   2,380 + 2,400 + 2,460) + held in Groceries and Holiday at the end of June (1,160 + 1,210
    //   = 2,370.00).
    const { views, summaries } = await expectApiMatchesOracle(app, {
      from: '2026-01',
      to: '2026-09',
    });
    const half = summaries.slice(0, 6);
    expect(half.map((row) => row.month)).toEqual(MONTHS.slice(0, 6));
    expect(sum(half.map((row) => row.income))).toBe(1800000);
    expect(sum(half.map((row) => row.spent))).toBe(140000);
    expect(sum(half.map((row) => row.savingsDue))).toBe(1423000);
    const endOfJune = views[5] as MonthView;
    expect(budgetLine(endOfJune, 'Groceries').carriedOut).toBe(116000); // 1,160.00
    expect(budgetLine(endOfJune, 'Holiday').carriedOut).toBe(121000); // 1,210.00
  });

  it('the order the transfers were entered in changes nothing', async () => {
    const forward = await buildWorld();
    const backward = await buildWorld();
    const transfers = (
      w: Budgets,
    ): Pick<TransferCreateInput, 'date' | 'fromBudgetId' | 'toBudgetId' | 'amount'>[] => [
      { date: '2026-03-10', fromBudgetId: w.groceries.id, toBudgetId: w.holiday.id, amount: 7000 },
      { date: '2026-03-12', fromBudgetId: null, toBudgetId: w.groceries.id, amount: 1500 },
      { date: '2026-03-20', fromBudgetId: w.fun.id, toBudgetId: null, amount: 900 },
    ];
    for (const body of transfers(forward)) await addTransfer(forward.app, body);
    for (const body of transfers(backward).reverse()) await addTransfer(backward.app, body);

    const a = await snapshotOf(forward.app, RANGE);
    const b = await snapshotOf(backward.app, RANGE);
    expect(b.views).toEqual(a.views);
    expect(b.summaries).toEqual(a.summaries);
    expect(b.savings).toEqual(a.savings);
    expect(b.budgets).toEqual(a.budgets);

    // March (closed) by hand. Groceries: -70.00 to Holiday + 15.00 from the pool = -55.00, so
    // 400 + 400 - 55 = 745.00 available, 600.00 spent, 145.00 left and carried. Holiday: +70.00,
    // 350 + 200 + 70 = 620.00 left. Fun: -9.00 to the pool, 91.00 available, 80.00 spent, 11.00 left.
    // The pool: 3,000.00 - 700.00 - 15.00 + 9.00 = 2,294.00. Savings due 2,294.00 + 11.00 = 2,305.00:
    // 15.00 less than without the transfers (the pool gave 15.00 to Groceries, which carries it).
    const march = viewOf(a, '2026-03');
    expect(rowsOf(march)).toEqual({
      Groceries: [40000, 40000, -5500, 74500, 60000, 14500, 14500, 0],
      Holiday: [35000, 20000, 7000, 62000, 0, 62000, 62000, 0],
      Fun: [0, 10000, -900, 9100, 8000, 1100, 0, 1100],
    });
    expect(levelOf(march)).toEqual({ unallocated: 229400, transfersNet: 600, savingsDue: 230500 });
  });
});

describe('transfers that look alike', () => {
  it('two identical transfers are two transfers: deleting one leaves the other', async () => {
    const { app, groceries, holiday } = await buildWorld();
    const before = await snapshotOf(app, RANGE);
    const body = {
      date: '2026-03-10',
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 7000,
    };
    const first = await addTransfer(app, body);
    const second = await addTransfer(app, body);
    expect(second.id).not.toBe(first.id);

    // The list is newest first, and on the same date the later one comes first (date, then id,
    // both descending).
    const both = await snapshotOf(app, RANGE);
    expect(both.transfers.map((t) => t.id)).toEqual([second.id, first.id]);
    // March, both counted: Groceries 400 + 400 - 140 = 660.00 available, 600.00 spent, 60.00 left.
    // Holiday 350 + 200 + 140 = 690.00. The pool and the savings due are what they were.
    const march = viewOf(both, '2026-03');
    expect(rowsOf(march)).toMatchObject({
      Groceries: [40000, 40000, -14000, 66000, 60000, 6000, 6000, 0],
      Holiday: [35000, 20000, 14000, 69000, 0, 69000, 69000, 0],
    });
    expect(levelOf(march)).toEqual({ unallocated: 230000, transfersNet: 0, savingsDue: 232000 });

    // The first one is deleted: exactly one is left, and it moves 70.00. (A delete that took every
    // transfer with the same date, the same amount or the same sides would have taken both.)
    await request(app).delete(`/api/transfers/${first.id}`).expect(204);
    const one = await snapshotOf(app, RANGE);
    expect(one.transfers.map((t) => t.id)).toEqual([second.id]);
    expect(rowsOf(viewOf(one, '2026-03'))).toMatchObject({
      Groceries: [40000, 40000, -7000, 73000, 60000, 13000, 13000, 0],
      Holiday: [35000, 20000, 7000, 62000, 0, 62000, 62000, 0],
    });
    // April carries 130.00 from Groceries (200 - 70) and 620.00 from Holiday (550 + 70).
    expect(budgetLine(viewOf(one, '2026-04'), 'Groceries').carriedIn).toBe(13000);
    expect(budgetLine(viewOf(one, '2026-04'), 'Holiday').carriedIn).toBe(62000);

    await request(app).delete(`/api/transfers/${second.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, RANGE), before);
  });

  it('three on one date keep the order of the list, and deleting the middle one removes only it', async () => {
    const { app, groceries, holiday, fun } = await buildWorld();
    const date = '2026-03-10';
    const a = await addTransfer(app, {
      date,
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 100,
    });
    const b = await addTransfer(app, { date, fromBudgetId: null, toBudgetId: fun.id, amount: 200 });
    const c = await addTransfer(app, {
      date,
      fromBudgetId: holiday.id,
      toBudgetId: null,
      amount: 400,
    });
    expect((await snapshotOf(app, RANGE)).transfers.map((t) => t.amount)).toEqual([400, 200, 100]);

    await request(app).delete(`/api/transfers/${b.id}`).expect(204);
    const left = await snapshotOf(app, RANGE);
    expect(left.transfers.map((t) => t.id)).toEqual([c.id, a.id]);
    // March by hand: Groceries -1.00, Holiday +1.00 - 4.00 = -3.00, Fun untouched. The pool gets 4.00.
    const march = viewOf(left, '2026-03');
    expect(rowsOf(march)).toMatchObject({
      Groceries: [40000, 40000, -100, 79900, 60000, 19900, 19900, 0],
      Holiday: [35000, 20000, -300, 54700, 0, 54700, 54700, 0],
      Fun: [0, 10000, 0, 10000, 8000, 2000, 0, 2000],
    });
    expect(levelOf(march)).toEqual({ unallocated: 230400, transfersNet: -400, savingsDue: 232400 });
  });
});

describe('a transfer dated beyond the projection horizon', () => {
  it('is stored but shows nowhere until the clock comes within 120 months of its month', async () => {
    const clock = mutableClock('2026-03-15T10:00:00Z');
    const app = await listening(createTestApp(clock).app);
    // One incremental budget of 400.00 and nothing else: every month it carries 400.00 more, so the
    // carried-out of the n-th month from 2026-01 (n = 0 for January 2026) is 400.00 x (n + 1).
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 300000,
      openingSavings: 0,
      budgets: [{ name: 'Groceries', amount: 40000, incremental: true }],
    });
    const budget = done.budgets[0]!;

    // 50.00 from the pool to Groceries in January 2040: 168 months after the start, far beyond
    // the horizon (the current month, March 2026, plus 120 months is March 2036).
    const made = await addTransfer(app, {
      date: '2040-01-10',
      fromBudgetId: null,
      toBudgetId: budget.id,
      amount: 5000,
    });
    // It is listed with no filter, by its own month and by its budget, and not by another month.
    for (const query of [
      '',
      `?month=2040-01`,
      `?budgetId=${budget.id}`,
      '?from=2040-01-01&to=2040-01-31',
    ]) {
      expect(
        (await getJson<{ id: number }[]>(app, `/api/transfers${query}`)).map((t) => t.id),
        `GET /api/transfers${query}`,
      ).toEqual([made.id]);
    }
    expect(await getJson(app, '/api/transfers?month=2036-03')).toEqual([]);
    // It is still activity of its budget (docs/DOMAIN.md, "Transfers"): the budget cannot be deleted,
    // nor ended before the month of the transfer, though no month view shows the transfer yet.
    expectApiError(await request(app).delete(`/api/budgets/${budget.id}`), 'has_history');
    expectRuleViolation(
      await request(app).post(`/api/budgets/${budget.id}/archive`).send({ endMonth: '2039-12' }),
      'end_before_activity',
      'endMonth',
    );
    expectNotFound(await request(app).get('/api/months/2040-01'));
    expectNotFound(await request(app).get('/api/months/2036-04')); // the first month past the horizon
    // March 2036, the last month that exists, is n = 122: 400.00 x 123 = 49,200.00 carried, nothing
    // of the transfer in it (it is dated four years later).
    const last = await monthView(app, '2036-03');
    expect(rowOf(budgetLine(last, 'Groceries'))).toEqual([
      4_880_000, 40000, 0, 4_920_000, 0, 4_920_000, 4_920_000, 0,
    ]);
    expect(levelOf(last)).toEqual({ unallocated: 260000, transfersNet: 0, savingsDue: 260000 });

    // Five years later the horizon reaches January 2041, and the transfer shows in its month.
    //   January 2040 (n = 168): carried in 400.00 x 168 = 67,200.00, + 400.00 + 50.00 = 67,650.00 carried.
    //   The pool of that month: 3,000.00 - 400.00 - 50.00 = 2,550.00, which is the savings due too.
    //   February 2040 starts from 67,650.00: 67,650.00 + 400.00 = 68,050.00.
    //   December 2039 is before it: 400.00 x 168 = 67,200.00, as it always was.
    clock.set('2031-01-15T10:00:00Z');
    const january = await monthView(app, '2040-01');
    expect(january.status).toBe('future');
    expect(rowOf(budgetLine(january, 'Groceries'))).toEqual([
      6_720_000, 40000, 5000, 6_765_000, 0, 6_765_000, 6_765_000, 0,
    ]);
    expect(levelOf(january)).toEqual({
      unallocated: 255000,
      transfersNet: 5000,
      savingsDue: 255000,
    });
    expect(rowOf(budgetLine(await monthView(app, '2040-02'), 'Groceries'))).toEqual([
      6_765_000, 40000, 0, 6_805_000, 0, 6_805_000, 6_805_000, 0,
    ]);
    expect(rowOf(budgetLine(await monthView(app, '2039-12'), 'Groceries'))).toEqual([
      6_680_000, 40000, 0, 6_720_000, 0, 6_720_000, 6_720_000, 0,
    ]);
    // Deleting it puts January 2040 back.
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    const without = await monthView(app, '2040-01');
    expect(rowOf(budgetLine(without, 'Groceries'))).toEqual([
      6_720_000, 40000, 0, 6_760_000, 0, 6_760_000, 6_760_000, 0,
    ]);
    expect(levelOf(without)).toEqual({ unallocated: 260000, transfersNet: 0, savingsDue: 260000 });
  });
});

// -------------------------------------------------------------------------------------------------
// Every kind of transfer in a closed, the current and a future month
// -------------------------------------------------------------------------------------------------

interface Cell {
  label: string;
  body: (
    w: Budgets,
  ) => Pick<TransferCreateInput, 'date' | 'fromBudgetId' | 'toBudgetId' | 'amount'>;
  /** The month the transfer is dated in. */
  month: string;
  /** The budgets it names, and the incremental ones among them (they carry it into later months). */
  involved: string[];
  carrying: string[];
  /** The lines of the budgets it names in its own month. */
  rows: Record<string, Row>;
  /** Unallocated, `totals.transfersNet` and the savings due of its own month. */
  level: { unallocated: number; transfersNet: number; savingsDue: number };
  /** The lines of the carrying budgets in July, three months or more later. */
  july: Record<string, Row>;
  /** For a closed month: its entry in the list of months to settle. */
  entry?: { savingsDue: number; breakdown: [number, number, number] };
}

/**
 * The nine cells: budget to budget, pool to budget and budget to pool, each in a closed month, the
 * current month and a future month. The baseline is `BASELINE` above; each transfer changes the
 * lines of the budgets it names by its amount, in its own month and (for an incremental budget)
 * in every month after it, and the pool and the savings due only in its own month.
 */
const CELLS: Cell[] = [
  {
    // Groceries and Holiday both carry, so the 70.00 moves a leftover from one to the other and
    // the month, the pool and the savings due stay exactly as they were.
    label: 'budget to budget in a closed month: 70.00 from Groceries to Holiday on 2026-02-10',
    body: (w) => ({
      date: '2026-02-10',
      fromBudgetId: w.groceries.id,
      toBudgetId: w.holiday.id,
      amount: 7000,
    }),
    month: '2026-02',
    involved: ['Groceries', 'Holiday'],
    carrying: ['Groceries', 'Holiday'],
    // Groceries: 250 + 400 - 70 = 580 available, 250 spent, 330 left. Holiday: 200 + 200 + 70 = 470, 50 spent, 420 left.
    rows: {
      Groceries: [25000, 40000, -7000, 58000, 25000, 33000, 33000, 0],
      Holiday: [20000, 20000, 7000, 47000, 5000, 42000, 42000, 0],
    },
    level: { unallocated: 230000, transfersNet: 0, savingsDue: 230000 },
    // July: Groceries 1,680 - 70 = 1,610 available (carried in 1,210 = 1,280 - 70); Holiday 1,350 + 70 = 1,420 (carried in 1,220).
    july: {
      Groceries: [121000, 40000, 0, 161000, 0, 161000, 161000, 0],
      Holiday: [122000, 20000, 0, 142000, 0, 142000, 142000, 0],
    },
    entry: { savingsDue: 230000, breakdown: [230000, 0, 0] },
  },
  {
    label:
      'budget to budget in the current month: 120.00 from Holiday to Groceries on 2026-04-28 (after today)',
    body: (w) => ({
      date: '2026-04-28',
      fromBudgetId: w.holiday.id,
      toBudgetId: w.groceries.id,
      amount: 12000,
    }),
    month: '2026-04',
    involved: ['Groceries', 'Holiday'],
    carrying: ['Groceries', 'Holiday'],
    // Groceries: 200 + 400 + 120 = 720 available, 120 spent, 600 left. Holiday: 550 + 200 - 120 = 630 left.
    rows: {
      Groceries: [20000, 40000, 12000, 72000, 12000, 60000, 60000, 0],
      Holiday: [55000, 20000, -12000, 63000, 0, 63000, 63000, 0],
    },
    level: { unallocated: 230000, transfersNet: 0, savingsDue: 238000 },
    // July: Groceries carried in 1,280 + 120 = 1,400; Holiday 1,150 - 120 = 1,030.
    july: {
      Groceries: [140000, 40000, 0, 180000, 0, 180000, 180000, 0],
      Holiday: [103000, 20000, 0, 123000, 0, 123000, 123000, 0],
    },
  },
  {
    label: 'budget to budget in a future month: 30.00 from Groceries to Holiday on 2026-06-05',
    body: (w) => ({
      date: '2026-06-05',
      fromBudgetId: w.groceries.id,
      toBudgetId: w.holiday.id,
      amount: 3000,
    }),
    month: '2026-06',
    involved: ['Groceries', 'Holiday'],
    carrying: ['Groceries', 'Holiday'],
    // Groceries: 880 + 400 - 30 = 1,250 available. Holiday: 950 + 200 + 30 = 1,180.
    rows: {
      Groceries: [88000, 40000, -3000, 125000, 0, 125000, 125000, 0],
      Holiday: [95000, 20000, 3000, 118000, 0, 118000, 118000, 0],
    },
    level: { unallocated: 230000, transfersNet: 0, savingsDue: 240000 },
    // July: Groceries carried in 1,250 (so 1,650 available), Holiday carried in 1,180 (1,380 available).
    july: {
      Groceries: [125000, 40000, 0, 165000, 0, 165000, 165000, 0],
      Holiday: [118000, 20000, 0, 138000, 0, 138000, 138000, 0],
    },
  },
  {
    // Fun is settled to savings every month: the 90.00 from the pool stays in March and goes to
    // savings with the rest of Fun, so the savings due is what it was (232000) with another split.
    label: 'pool to budget in a closed month: 90.00 from the pool to Fun on 2026-03-05',
    body: (w) => ({ date: '2026-03-05', fromBudgetId: null, toBudgetId: w.fun.id, amount: 9000 }),
    month: '2026-03',
    involved: ['Fun'],
    carrying: [],
    // Fun: 100 + 90 = 190 available, 80 spent, 110 left and sent to savings. Pool: 2,300 - 90 = 2,210.
    rows: { Fun: [0, 10000, 9000, 19000, 8000, 11000, 0, 11000] },
    level: { unallocated: 221000, transfersNet: 9000, savingsDue: 232000 },
    july: {},
    entry: { savingsDue: 232000, breakdown: [221000, 11000, 0] },
  },
  {
    label: 'pool to budget in the current month: 40.00 from the pool to Groceries on 2026-04-02',
    body: (w) => ({
      date: '2026-04-02',
      fromBudgetId: null,
      toBudgetId: w.groceries.id,
      amount: 4000,
    }),
    month: '2026-04',
    involved: ['Groceries'],
    carrying: ['Groceries'],
    // Groceries: 200 + 400 + 40 = 640 available, 120 spent, 520 left, carried. Pool 2,300 - 40 = 2,260;
    // the 40.00 is held in Groceries, so April owes 40.00 less: 2,260 + 80 (Fun) = 2,340.
    rows: { Groceries: [20000, 40000, 4000, 64000, 12000, 52000, 52000, 0] },
    level: { unallocated: 226000, transfersNet: 4000, savingsDue: 234000 },
    // July: Groceries carried in 1,280 + 40 = 1,320.
    july: { Groceries: [132000, 40000, 0, 172000, 0, 172000, 172000, 0] },
  },
  {
    label: 'pool to budget in a future month: 250.00 from the pool to Holiday on 2026-05-20',
    body: (w) => ({
      date: '2026-05-20',
      fromBudgetId: null,
      toBudgetId: w.holiday.id,
      amount: 25000,
    }),
    month: '2026-05',
    involved: ['Holiday'],
    carrying: ['Holiday'],
    // Holiday: 750 + 200 + 250 = 1,200 available, carried. Pool 2,300 - 250 = 2,050; owes 2,050 + 100 = 2,150.
    rows: { Holiday: [75000, 20000, 25000, 120000, 0, 120000, 120000, 0] },
    level: { unallocated: 205000, transfersNet: 25000, savingsDue: 215000 },
    // July: Holiday carried in 1,150 + 250 = 1,400.
    july: { Holiday: [140000, 20000, 0, 160000, 0, 160000, 160000, 0] },
  },
  {
    // The last day of the first month: it belongs to January, not February.
    label: 'budget to pool in a closed month: 50.00 from Fun to the pool on 2026-01-31',
    body: (w) => ({ date: '2026-01-31', fromBudgetId: w.fun.id, toBudgetId: null, amount: 5000 }),
    month: '2026-01',
    involved: ['Fun'],
    carrying: [],
    // Fun: 100 - 50 = 50 available, 30 spent, 20 left and sent to savings. Pool 2,300 + 50 = 2,350.
    // Savings due 2,350 + 20 = 2,370: the same as without the transfer, with another split.
    rows: { Fun: [0, 10000, -5000, 5000, 3000, 2000, 0, 2000] },
    level: { unallocated: 235000, transfersNet: -5000, savingsDue: 237000 },
    july: {},
    entry: { savingsDue: 237000, breakdown: [235000, 2000, 0] },
  },
  {
    label: 'budget to pool in the current month: 110.00 from Holiday to the pool on 2026-04-30',
    body: (w) => ({
      date: '2026-04-30',
      fromBudgetId: w.holiday.id,
      toBudgetId: null,
      amount: 11000,
    }),
    month: '2026-04',
    involved: ['Holiday'],
    carrying: ['Holiday'],
    // Holiday: 550 + 200 - 110 = 640 available, carried. Pool 2,300 + 110 = 2,410; owes 2,410 + 80 = 2,490.
    rows: { Holiday: [55000, 20000, -11000, 64000, 0, 64000, 64000, 0] },
    level: { unallocated: 241000, transfersNet: -11000, savingsDue: 249000 },
    // July: Holiday carried in 1,150 - 110 = 1,040.
    july: { Holiday: [104000, 20000, 0, 124000, 0, 124000, 124000, 0] },
  },
  {
    label: 'budget to pool in a future month: 20.00 from Groceries to the pool on 2026-06-30',
    body: (w) => ({
      date: '2026-06-30',
      fromBudgetId: w.groceries.id,
      toBudgetId: null,
      amount: 2000,
    }),
    month: '2026-06',
    involved: ['Groceries'],
    carrying: ['Groceries'],
    // Groceries: 880 + 400 - 20 = 1,260 available, carried. Pool 2,300 + 20 = 2,320; owes 2,320 + 100 = 2,420.
    rows: { Groceries: [88000, 40000, -2000, 126000, 0, 126000, 126000, 0] },
    level: { unallocated: 232000, transfersNet: -2000, savingsDue: 242000 },
    // July: Groceries carried in 1,280 - 20 = 1,260.
    july: { Groceries: [126000, 40000, 0, 166000, 0, 166000, 166000, 0] },
  },
];

describe('every kind of transfer in a closed, the current and a future month', () => {
  it.each(CELLS)('$label', async (cell) => {
    const world = await buildWorld();
    const { app } = world;
    const before = await snapshotOf(app, RANGE);
    const body = cell.body(world);

    const made = await addTransfer(app, body);
    const after = await snapshotOf(app, RANGE);

    // The numbers of its own month, and where the carry-over has got to by July.
    const own = viewOf(after, cell.month);
    for (const [name, row] of Object.entries(cell.rows)) {
      expect(rowOf(budgetLine(own, name)), `${name} in ${cell.month}`).toEqual(row);
    }
    expect(levelOf(own)).toEqual(cell.level);
    const july = viewOf(after, '2026-07');
    for (const [name, row] of Object.entries(cell.july)) {
      expect(rowOf(budgetLine(july, name)), `${name} in 2026-07`).toEqual(row);
    }

    // Nothing before it changed, and nothing after it but what it carries.
    expectNothingChangedBefore(before, after, cell.month);
    expectNothingElseChanged(before, after, cell.month, cell);
    // The month list: only the unallocated pool and the savings due of its month moved.
    expect(after.summaries.filter((row) => row.month !== cell.month)).toEqual(
      before.summaries.filter((row) => row.month !== cell.month),
    );
    expect(after.summaries.find((row) => row.month === cell.month)).toEqual({
      ...before.summaries.find((row) => row.month === cell.month),
      unallocated: cell.level.unallocated,
      savingsDue: cell.level.savingsDue,
    });
    // The list of months to settle: only a closed month has an entry, and it has the new split.
    if (cell.entry) {
      const [unallocated, budgetsSettled, reservesReleased] = cell.entry.breakdown;
      const entry = after.savings.outstanding.find((candidate) => candidate.month === cell.month);
      expect(entry).toEqual({
        month: cell.month,
        savingsDue: cell.entry.savingsDue,
        settled: 0,
        outstanding: cell.entry.savingsDue,
        direction: 'move',
        breakdown: { unallocated, budgetsSettled, reservesReleased },
        adjustment: false,
      });
      // The other months are as they were, and so is the total: these transfers only change the
      // split of the month's savings due (6,990.00 for the three closed months).
      expect(after.savings.outstanding.filter((other) => other.month !== cell.month)).toEqual(
        before.savings.outstanding.filter((other) => other.month !== cell.month),
      );
      expect(after.savings.outstandingTotal).toBe(699000);
    } else {
      expect(after.savings).toEqual(before.savings);
    }

    // The identities of the contract hold on every month, and an oracle written apart from the
    // ledger agrees on the savings due and on what is held.
    for (const view of after.views) expectMonthIdentities(view);
    expectChainIdentities(after.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-07' });
    expect(after.transfers).toEqual([{ id: made.id, note: null, ...body }]);

    // Deleting it undoes exactly that, in every month, the summaries and the savings.
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, RANGE), before);
  });
});
