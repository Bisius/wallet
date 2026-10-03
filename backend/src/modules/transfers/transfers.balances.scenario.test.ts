/**
 * Transfers and the balances they meet, through the real API with a clock that moves. Every number
 * is worked out by hand from docs/DOMAIN.md ("Transfers", "Unallocated", "Budgets", "Savings" and
 * invariants 2 and 8), with the derivation next to it, and none is copied from a run.
 *
 *  1. A transfer is never limited by the balances. A budget that gives more than it holds goes
 *     negative: an incremental budget carries the deficit into the next month, any other budget has
 *     it taken from savings and starts clean. The pool that gives more than it holds is
 *     over-allocated, and the shortfall is taken from savings.
 *  2. A budget's last month (`endMonth`). Its leftover goes to savings whatever its mode, so a
 *     transfer dated in it counts in that month and ends there; a transfer in a later month is
 *     refused; and moving the end month brings the carry-over back, with the transfers in it.
 *  3. A transfer between budgets of different modes moves the amount between what is carried and
 *     what goes to savings, and the two together (invariant 8) do not change. The mode that counts
 *     is the one in effect in the month the transfer is dated in.
 */
import type { BudgetDto } from '@wallet/shared';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addSpending,
  addTransfer,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { expectChainIdentities, expectMonthIdentities } from '../../testing/month-identities';
import { expectSavingsIdentities, settleOk } from '../../testing/savings-helpers';
import { expectApiMatchesOracle } from '../../testing/scenario';
import { budgetLine, postJson, putJson, sum } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';
import {
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

// -------------------------------------------------------------------------------------------------
// 1. A transfer is never limited by the balances
// -------------------------------------------------------------------------------------------------

/**
 * Tracking since 2026-01, today is 2026-03-15, salary 3,000.00, opening savings 0, nothing spent.
 * Groceries 400.00 carries its leftover; Fun 100.00 sends it to savings. January and February are
 * closed, March is the current month. Every month before a transfer:
 *
 *   Groceries: Jan 400.00 left and carried. Feb 400 + 400 = 800.00. Mar 800 + 400 = 1,200.00.
 *              Apr 1,200 + 400 = 1,600.00 (projected).
 *   Fun: 100.00 every month, all of it sent to savings.
 *   The pool: 3,000.00 - (400 + 100) = 2,500.00. Savings due: 2,500.00 + 100.00 = 2,600.00.
 */
async function buildLimits() {
  const clock = mutableClock('2026-03-15T10:00:00Z');
  const app = await listening(createTestApp(clock).app);
  const done = await onboard(app, {
    startMonth: '2026-01',
    salary: 300000,
    openingSavings: 0,
    budgets: [
      { name: 'Groceries', amount: 40000, incremental: true },
      { name: 'Fun', amount: 10000, incremental: false },
    ],
  });
  const [groceries, fun] = done.budgets as [BudgetDto, BudgetDto];
  return { app, clock, groceries, fun };
}

const LIMITS = {
  from: '2026-01',
  to: '2026-04',
  months: ['2026-01', '2026-02', '2026-03', '2026-04'],
} as const;

describe('a transfer is never limited by the balances', () => {
  it('the world before any transfer', async () => {
    const { app } = await buildLimits();
    const snapshot = await snapshotOf(app, LIMITS);
    expect(snapshot.views.map((view) => rowsOf(view))).toEqual([
      {
        Groceries: [0, 40000, 0, 40000, 0, 40000, 40000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
      {
        Groceries: [40000, 40000, 0, 80000, 0, 80000, 80000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
      {
        Groceries: [80000, 40000, 0, 120000, 0, 120000, 120000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
      {
        Groceries: [120000, 40000, 0, 160000, 0, 160000, 160000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
    ]);
    expect(snapshot.views.map((view) => levelOf(view))).toEqual(
      Array(4).fill({ unallocated: 250000, transfersNet: 0, savingsDue: 260000 }),
    );
  });

  it('a budget that gives exactly what it holds is empty, not over', async () => {
    const { app, groceries } = await buildLimits();
    const before = await snapshotOf(app, LIMITS);
    // February: Groceries holds 800.00 and gives all of it to the pool.
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: groceries.id,
      toBudgetId: null,
      amount: 80000,
    });
    const after = await snapshotOf(app, LIMITS);
    expectNothingChangedBefore(before, after, '2026-02');
    const february = viewOf(after, '2026-02');
    // 400 carried in + 400 - 800 = 0.00 available: no usage figure (available is not above 0), and
    // it is not over budget (nothing is spent).
    const line = budgetLine(february, 'Groceries');
    expect(rowOf(line)).toEqual([40000, 40000, -80000, 0, 0, 0, 0, 0]);
    expect(line).toMatchObject({ alert: 'ok', usagePercent: null });
    // The pool: 2,500.00 + 800.00 = 3,300.00. Due: 3,300.00 + 100.00.
    expect(levelOf(february)).toEqual({
      unallocated: 330000,
      transfersNet: -80000,
      savingsDue: 340000,
    });
    // March starts from nothing: 0 carried in + 400 = 400.00.
    expect(rowOf(budgetLine(viewOf(after, '2026-03'), 'Groceries'))).toEqual([
      0, 40000, 0, 40000, 0, 40000, 40000, 0,
    ]);
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, LIMITS), before);
  });

  it('a pool that gives exactly what it holds is empty, not over-allocated', async () => {
    const { app, groceries } = await buildLimits();
    const before = await snapshotOf(app, LIMITS);
    // February: the pool holds 2,500.00 (3,000.00 - 400.00 - 100.00) and gives all of it to Groceries.
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 250000,
    });
    const after = await snapshotOf(app, LIMITS);
    expectNothingChangedBefore(before, after, '2026-02');
    const february = viewOf(after, '2026-02');
    // Nothing is left: 2,500.00 - 2,500.00 = 0, which is not below 0, so not over-allocated.
    // Groceries: 400 + 400 + 2,500 = 3,300.00 available, all carried. Due: 0 + Fun's 100.00.
    expect(february.unallocated).toBe(0);
    expect(february.overAllocated).toBe(false);
    expect(rowOf(budgetLine(february, 'Groceries'))).toEqual([
      40000, 40000, 250000, 330000, 0, 330000, 330000, 0,
    ]);
    expect(levelOf(february)).toEqual({ unallocated: 0, transfersNet: 250000, savingsDue: 10000 });
    expect(february.savingsDue).toEqual({
      unallocated: 0,
      budgetsSettled: 10000,
      reservesReleased: 0,
      total: 10000,
    });
    // One cent more and it would be over-allocated by one cent.
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 250001,
    });
    const over = viewOf(await snapshotOf(app, LIMITS), '2026-02');
    expect(over.unallocated).toBe(-1);
    expect(over.overAllocated).toBe(true);
  });

  it('an incremental budget that gives more than it holds goes negative and carries the deficit', async () => {
    const { app, groceries } = await buildLimits();
    const before = await snapshotOf(app, LIMITS);
    // February: Groceries holds 800.00 and gives 1,000.00 to the pool.
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: groceries.id,
      toBudgetId: null,
      amount: 100000,
    });
    const after = await snapshotOf(app, LIMITS);
    expectNothingChangedBefore(before, after, '2026-02');

    // 400 + 400 - 1,000 = -200.00 available and left: over budget, no usage figure, and, being
    // incremental, the -200.00 is carried (it is not taken from savings).
    const february = viewOf(after, '2026-02');
    const line = budgetLine(february, 'Groceries');
    expect(rowOf(line)).toEqual([40000, 40000, -100000, -20000, 0, -20000, -20000, 0]);
    expect(line).toMatchObject({ alert: 'over', usagePercent: null });
    // The pool: 2,500.00 + 1,000.00 = 3,500.00. Due: 3,500.00 + Fun's 100.00; Groceries adds 0.
    expect(levelOf(february)).toEqual({
      unallocated: 350000,
      transfersNet: -100000,
      savingsDue: 360000,
    });
    expect(february.savingsDue).toEqual({
      unallocated: 350000,
      budgetsSettled: 10000,
      reservesReleased: 0,
      total: 360000,
    });
    expect(february.totals.remaining).toBe(-10000); // -200.00 + 100.00
    // March starts with the deficit: -200 + 400 = 200.00 available instead of 1,200.00.
    expect(rowOf(budgetLine(viewOf(after, '2026-03'), 'Groceries'))).toEqual([
      -20000, 40000, 0, 20000, 0, 20000, 20000, 0,
    ]);
    expect(rowOf(budgetLine(viewOf(after, '2026-04'), 'Groceries'))).toEqual([
      20000, 40000, 0, 60000, 0, 60000, 60000, 0,
    ]);
    expectNothingElseChanged(before, after, '2026-02', {
      involved: ['Groceries'],
      carrying: ['Groceries'],
    });

    // The months to settle: January 2,600.00 and February 3,600.00.
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding.map((m) => [m.month, m.outstanding, m.breakdown])).toEqual([
      ['2026-01', 260000, { unallocated: 250000, budgetsSettled: 10000, reservesReleased: 0 }],
      ['2026-02', 360000, { unallocated: 350000, budgetsSettled: 10000, reservesReleased: 0 }],
    ]);
    expect(savings.outstandingTotal).toBe(620000);
    // Conservation, January and February: income 6,000.00 = spent 0 + savings due 6,200.00 + held
    // at the end of February, -200.00 (the deficit Groceries carries).
    expect(sum(after.summaries.slice(0, 2).map((row) => row.income))).toBe(600000);
    expect(sum(after.summaries.slice(0, 2).map((row) => row.savingsDue))).toBe(620000);
    expect(sum(february.budgets.map((b) => b.carriedOut))).toBe(-20000);
    expectChainIdentities(after.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-04' });

    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, LIMITS), before);
  });

  it('a budget that is not incremental has the deficit taken from savings and starts clean', async () => {
    const { app, fun } = await buildLimits();
    const before = await snapshotOf(app, LIMITS);
    // February: Fun holds 100.00 and gives 150.00 to the pool.
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: fun.id,
      toBudgetId: null,
      amount: 15000,
    });
    const after = await snapshotOf(app, LIMITS);
    expectNothingChangedBefore(before, after, '2026-02');

    // 100 - 150 = -50.00 available and left; nothing is carried, so the whole -50.00 goes to savings.
    const february = viewOf(after, '2026-02');
    const line = budgetLine(february, 'Fun');
    expect(rowOf(line)).toEqual([0, 10000, -15000, -5000, 0, -5000, 0, -5000]);
    expect(line).toMatchObject({ alert: 'over', usagePercent: null });
    // The pool: 2,500.00 + 150.00 = 2,650.00. Due: 2,650.00 - 50.00 = 2,600.00, as without the
    // transfer: the pool gained what Fun gave up, and Fun's deficit takes 50.00 back.
    expect(february.savingsDue).toEqual({
      unallocated: 265000,
      budgetsSettled: -5000,
      reservesReleased: 0,
      total: 260000,
    });
    expect(levelOf(february)).toEqual({
      unallocated: 265000,
      transfersNet: -15000,
      savingsDue: 260000,
    });
    // March starts clean: the deficit did not follow. Every month after February is as it was.
    expect(viewOf(after, '2026-03')).toEqual(viewOf(before, '2026-03'));
    expect(viewOf(after, '2026-04')).toEqual(viewOf(before, '2026-04'));
    // The savings due of February is what it was, with another split.
    expect((await expectSavingsIdentities(app)).outstanding[1]).toEqual({
      month: '2026-02',
      savingsDue: 260000,
      settled: 0,
      outstanding: 260000,
      direction: 'move',
      breakdown: { unallocated: 265000, budgetsSettled: -5000, reservesReleased: 0 },
      adjustment: false,
    });
    // Income 6,000.00 = savings due 5,200.00 + held 800.00 in Groceries.
    expect(sum(after.summaries.slice(0, 2).map((row) => row.savingsDue))).toBe(520000);
    expect(sum(february.budgets.map((b) => b.carriedOut))).toBe(80000);
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-04' });

    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, LIMITS), before);
  });

  it('a pool that gives more than it holds is over-allocated, and savings pay the shortfall', async () => {
    const { app, groceries } = await buildLimits();
    const before = await snapshotOf(app, LIMITS);
    // February: the pool holds 2,500.00 and gives 2,700.00 to Groceries.
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 270000,
    });
    const after = await snapshotOf(app, LIMITS);
    expectNothingChangedBefore(before, after, '2026-02');

    // The pool: 2,500.00 - 2,700.00 = -200.00, over-allocated. Groceries: 400 + 400 + 2,700 =
    // 3,500.00 available, all carried. Due: -200.00 + Fun's 100.00 = -100.00, to be taken from savings.
    const february = viewOf(after, '2026-02');
    expect(february.overAllocated).toBe(true);
    expect(rowOf(budgetLine(february, 'Groceries'))).toEqual([
      40000, 40000, 270000, 350000, 0, 350000, 350000, 0,
    ]);
    expect(levelOf(february)).toEqual({
      unallocated: -20000,
      transfersNet: 270000,
      savingsDue: -10000,
    });
    expect(february.savingsDue).toEqual({
      unallocated: -20000,
      budgetsSettled: 10000,
      reservesReleased: 0,
      total: -10000,
    });
    // March: the pool is whole again (2,500.00) and Groceries carries 3,500 + 400 = 3,900.00.
    const march = viewOf(after, '2026-03');
    expect(march.overAllocated).toBe(false);
    expect(rowOf(budgetLine(march, 'Groceries'))).toEqual([
      350000, 40000, 0, 390000, 0, 390000, 390000, 0,
    ]);
    expect(levelOf(march)).toEqual({ unallocated: 250000, transfersNet: 0, savingsDue: 260000 });

    // January is to be moved (2,600.00), February is to be taken back (100.00).
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding.map((m) => [m.month, m.outstanding, m.direction])).toEqual([
      ['2026-01', 260000, 'move'],
      ['2026-02', -10000, 'take'],
    ]);
    expect(savings.outstandingTotal).toBe(250000);
    // Income 6,000.00 = savings due 2,600.00 - 100.00 + held 3,500.00.
    expect(sum(after.summaries.slice(0, 2).map((row) => row.savingsDue))).toBe(250000);
    expect(sum(february.budgets.map((b) => b.carriedOut))).toBe(350000);
    expectChainIdentities(after.views, { startsAtLedgerStart: true });

    // Settling both: the balance goes to 2,600.00 - 100.00 = 2,500.00. Taking money from savings is
    // recorded as it happened.
    await settleOk(app, '2026-01', { amount: 260000 });
    await settleOk(app, '2026-02', { amount: -10000 });
    expect(await expectSavingsIdentities(app)).toMatchObject({
      balance: 250000,
      outstanding: [],
      outstandingTotal: 0,
    });

    // Deleting the transfer makes February due 2,600.00 again: 2,700.00 more than the -100.00
    // settled, as a correction.
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    const restored = await expectSavingsIdentities(app);
    expect(restored.outstanding).toEqual([
      {
        month: '2026-02',
        savingsDue: 260000,
        settled: -10000,
        outstanding: 270000,
        direction: 'move',
        breakdown: { unallocated: 250000, budgetsSettled: 10000, reservesReleased: 0 },
        adjustment: true,
      },
    ]);
    const afterDelete = await snapshotOf(app, LIMITS);
    expect(afterDelete.views).toEqual(before.views);
    expect(afterDelete.summaries).toEqual(before.summaries);
  });
});

// -------------------------------------------------------------------------------------------------
// 2. A budget's last month
// -------------------------------------------------------------------------------------------------

/**
 * Tracking since 2026-01, today is 2026-03-05, salary 3,000.00, nothing spent. Groceries 400.00 and
 * Holiday 200.00 carry their leftover, Fun 100.00 does not. The pool is 3,000.00 - 700.00 = 2,300.00
 * every month, and without transfers the savings due is 2,300.00 + Fun's 100.00 = 2,400.00.
 *
 *   Groceries: Jan 400.00 left. Feb 400 + 400 = 800.00. Mar 800 + 400 = 1,200.00.
 *   Holiday:   Jan 200.00. Feb 200 + 200 = 400.00. Mar 400 + 200 = 600.00.
 */
async function buildFinalMonth() {
  const clock = mutableClock('2026-03-05T10:00:00Z');
  const app = await listening(createTestApp(clock).app);
  const done = await onboard(app, {
    startMonth: '2026-01',
    salary: 300000,
    openingSavings: 0,
    budgets: [
      { name: 'Groceries', amount: 40000, incremental: true },
      { name: 'Holiday', amount: 20000, incremental: true },
      { name: 'Fun', amount: 10000, incremental: false },
    ],
  });
  const [groceries, holiday, fun] = done.budgets as [BudgetDto, BudgetDto, BudgetDto];
  return { app, clock, groceries, holiday, fun };
}

const FINAL = {
  from: '2026-01',
  to: '2026-06',
  months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
} as const;

describe("a transfer in a budget's last month", () => {
  it('counts in that month, ends there, and the end month can be moved with the transfers in it', async () => {
    const { app, groceries, holiday } = await buildFinalMonth();

    // Two transfers in March, while Groceries is still open: 50.00 from the pool to Groceries,
    // and 30.00 from Groceries to Holiday. Groceries nets +20.00, Holiday +30.00, the pool -50.00.
    await addTransfer(app, {
      date: '2026-03-08',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 5000,
    });
    await addTransfer(app, {
      date: '2026-03-09',
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 3000,
    });
    const open = await snapshotOf(app, FINAL);
    // March with Groceries open: Groceries 800 + 400 + 20 = 1,220.00, carried. Holiday 400 + 200 + 30
    // = 630.00, carried. The pool 2,300.00 - 50.00 = 2,250.00. Due 2,250.00 + Fun's 100.00.
    const marchOpen = viewOf(open, '2026-03');
    expect(rowsOf(marchOpen)).toEqual({
      Groceries: [80000, 40000, 2000, 122000, 0, 122000, 122000, 0],
      Holiday: [40000, 20000, 3000, 63000, 0, 63000, 63000, 0],
      Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
    });
    expect(levelOf(marchOpen)).toEqual({
      unallocated: 225000,
      transfersNet: 5000,
      savingsDue: 235000,
    });

    // 1. Groceries is archived in March, its last month (the default end month is the current one).
    await postJson(app, `/api/budgets/${groceries.id}/archive`, {});
    const ended = await snapshotOf(app, FINAL);
    expectNothingChangedBefore(open, ended, '2026-03');
    // Its last month: whatever it holds goes to savings, the carried-in money, the allocation and
    // both transfers included: 1,220.00. Nothing is carried out of it.
    const march = viewOf(ended, '2026-03');
    expect(rowOf(budgetLine(march, 'Groceries'))).toEqual([
      80000, 40000, 2000, 122000, 0, 122000, 0, 122000,
    ]);
    expect(budgetLine(march, 'Groceries').endsThisMonth).toBe(true);
    // Holiday keeps its 630.00. Savings due: the pool 2,250.00 + Groceries 1,220.00 + Fun 100.00 = 3,570.00.
    expect(rowOf(budgetLine(march, 'Holiday'))).toEqual([
      40000, 20000, 3000, 63000, 0, 63000, 63000, 0,
    ]);
    expect(march.savingsDue).toEqual({
      unallocated: 225000,
      budgetsSettled: 132000,
      reservesReleased: 0,
      total: 357000,
    });
    // Conservation in March: income 3,000.00 = savings due 3,570.00 + the change in what is held
    // (Groceries 800 + Holiday 400 = 1,200.00 held in February, Holiday's 630.00 in March: -570.00).
    expect(march.income.total).toBe(300000);
    expect(
      sum(march.budgets.map((b) => b.carriedOut)) -
        sum(viewOf(ended, '2026-02').budgets.map((b) => b.carriedOut)),
    ).toBe(-57000);

    // April, May, June: Groceries is gone. The pool is 3,000.00 - (200 + 100) = 2,700.00 and the
    // savings due 2,700.00 + 100.00 = 2,800.00. Holiday carries on from 630.00: 630 + 200 = 830.00.
    const april = viewOf(ended, '2026-04');
    expect(april.budgets.map((b) => b.name)).toEqual(['Holiday', 'Fun']);
    expect(rowOf(budgetLine(april, 'Holiday'))).toEqual([
      63000, 20000, 0, 83000, 0, 83000, 83000, 0,
    ]);
    expect(levelOf(april)).toEqual({ unallocated: 270000, transfersNet: 0, savingsDue: 280000 });
    expect(rowOf(budgetLine(viewOf(ended, '2026-06'), 'Holiday'))).toEqual([
      103000, 20000, 0, 123000, 0, 123000, 123000, 0,
    ]);
    // Holiday and Fun do not notice that Groceries ended: their lines are what they were.
    for (const month of ['2026-03', '2026-04', '2026-05', '2026-06']) {
      for (const name of ['Holiday', 'Fun']) {
        expect(rowOf(budgetLine(viewOf(ended, month), name)), `${name} in ${month}`).toEqual(
          rowOf(budgetLine(viewOf(open, month), name)),
        );
      }
    }

    // 2. The transfers stay stored, and a new one cannot be dated after the last month: the money
    // would leave Groceries, or arrive in it, and be counted nowhere.
    const stored = ended.transfers;
    expect(stored.map((t) => [t.date, t.amount])).toEqual([
      ['2026-03-09', 3000],
      ['2026-03-08', 5000],
    ]);
    expectRuleViolation(
      await request(app).post('/api/transfers').send({
        date: '2026-04-02',
        fromBudgetId: groceries.id,
        toBudgetId: holiday.id,
        amount: 100,
      }),
      'outside_active_months',
      'fromBudgetId',
    );
    expectRuleViolation(
      await request(app).post('/api/transfers').send({
        date: '2026-04-02',
        fromBudgetId: null,
        toBudgetId: groceries.id,
        amount: 100,
      }),
      'outside_active_months',
      'toBudgetId',
    );
    // ... and the end month cannot be moved before the last transfer: 422 end_before_activity.
    expectRuleViolation(
      await request(app).post(`/api/budgets/${groceries.id}/archive`).send({ endMonth: '2026-02' }),
      'end_before_activity',
      'endMonth',
    );
    expectSameSnapshot(await snapshotOf(app, FINAL), ended);

    // 3. Moving the end month to May gives the months back: only March and later change, and the
    // transfers still count in March.
    await postJson(app, `/api/budgets/${groceries.id}/archive`, { endMonth: '2026-05' });
    const later = await snapshotOf(app, FINAL);
    expectNothingChangedBefore(ended, later, '2026-03');
    // March: Groceries is no longer ending, so its 1,220.00 is carried instead of sent to savings,
    // and the savings due is the 2,350.00 it was while the budget was open.
    const marchLater = viewOf(later, '2026-03');
    expect(rowOf(budgetLine(marchLater, 'Groceries'))).toEqual([
      80000, 40000, 2000, 122000, 0, 122000, 122000, 0,
    ]);
    expect(budgetLine(marchLater, 'Groceries').endsThisMonth).toBe(false);
    expect(levelOf(marchLater)).toEqual({
      unallocated: 225000,
      transfersNet: 5000,
      savingsDue: 235000,
    });
    // April: Groceries is back: 1,220 + 400 = 1,620.00. The pool is 2,300.00 again.
    const aprilLater = viewOf(later, '2026-04');
    expect(rowOf(budgetLine(aprilLater, 'Groceries'))).toEqual([
      122000, 40000, 0, 162000, 0, 162000, 162000, 0,
    ]);
    expect(levelOf(aprilLater)).toEqual({
      unallocated: 230000,
      transfersNet: 0,
      savingsDue: 240000,
    });
    // May is its last month now: 1,620 + 400 = 2,020.00 goes to savings. Due 2,300 + 2,020 + 100.
    const mayLater = viewOf(later, '2026-05');
    expect(rowOf(budgetLine(mayLater, 'Groceries'))).toEqual([
      162000, 40000, 0, 202000, 0, 202000, 0, 202000,
    ]);
    expect(mayLater.savingsDue).toEqual({
      unallocated: 230000,
      budgetsSettled: 212000,
      reservesReleased: 0,
      total: 442000,
    });
    // June: gone again.
    expect(viewOf(later, '2026-06').budgets.map((b) => b.name)).toEqual(['Holiday', 'Fun']);
    expect(later.transfers).toEqual(ended.transfers);
    expectChainIdentities(later.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-06' });

    // 4. Back to March: the months are exactly what they were at step 1, to the cent.
    await postJson(app, `/api/budgets/${groceries.id}/archive`, { endMonth: '2026-03' });
    expectSameSnapshot(await snapshotOf(app, FINAL), ended);
  });

  it('a transfer into a budget that is not incremental and ends this month goes to savings with the rest', async () => {
    const { app, fun, holiday } = await buildFinalMonth();
    // Fun ends in March too. 20.00 moves from Holiday to Fun in March, its last month:
    // Fun 100 + 20 = 120.00 available, all of it to savings; Holiday 400 + 200 - 20 = 580.00 carried.
    await postJson(app, `/api/budgets/${fun.id}/archive`, {});
    const before = await snapshotOf(app, FINAL);
    const made = await addTransfer(app, {
      date: '2026-03-31',
      fromBudgetId: holiday.id,
      toBudgetId: fun.id,
      amount: 2000,
    });
    const after = await snapshotOf(app, FINAL);
    expectNothingChangedBefore(before, after, '2026-03');
    const march = viewOf(after, '2026-03');
    expect(rowOf(budgetLine(march, 'Fun'))).toEqual([0, 10000, 2000, 12000, 0, 12000, 0, 12000]);
    expect(rowOf(budgetLine(march, 'Holiday'))).toEqual([
      40000, 20000, -2000, 58000, 0, 58000, 58000, 0,
    ]);
    // Savings due: the pool 2,300.00 + Fun 120.00 = 2,420.00 (20.00 more than before: it left Holiday,
    // which carries, and went to Fun, which ends).
    expect(march.savingsDue).toEqual({
      unallocated: 230000,
      budgetsSettled: 12000,
      reservesReleased: 0,
      total: 242000,
    });
    // April has no Fun line: the pool is 3,000.00 - (400 + 200) = 2,400.00, and nothing else is
    // sent to savings (Groceries and Holiday carry).
    expect(levelOf(viewOf(after, '2026-04'))).toEqual({
      unallocated: 240000,
      transfersNet: 0,
      savingsDue: 240000,
    });
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, FINAL), before);
  });
});

describe("a budget's start month and its transfers", () => {
  it('can move up to the month of its first transfer and no further, and back', async () => {
    const { app, holiday, groceries } = await buildFinalMonth();
    // Two transfers in March; Holiday takes part in one of them: its first activity is March.
    await addTransfer(app, {
      date: '2026-03-08',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 5000,
    });
    await addTransfer(app, {
      date: '2026-03-09',
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 3000,
    });
    const original = await snapshotOf(app, FINAL);

    // After March the transfer would be left behind: refused, and nothing changes.
    expectRuleViolation(
      await request(app).patch(`/api/budgets/${holiday.id}`).send({ startMonth: '2026-04' }),
      'start_after_activity',
      'startMonth',
    );
    expectSameSnapshot(await snapshotOf(app, FINAL), original);

    // In March, the month of the transfer, it is allowed. Holiday has no January and February now:
    //   the pool gets its 200.00 back in each (3,000.00 - 400 - 100 = 2,500.00) and so does the savings
    //   due (2,500.00 + Fun's 100.00 = 2,600.00); nothing is carried from before into March.
    //   March: Holiday 0 + 200 + 30 (the transfer) = 230.00 available, carried. Groceries and Fun
    //   are what they were, so March owes what it did: pool 3,000.00 - 700.00 - 50.00 = 2,250.00 + 100.00.
    await request(app)
      .patch(`/api/budgets/${holiday.id}`)
      .send({ startMonth: '2026-03' })
      .expect(200);
    const moved = await snapshotOf(app, FINAL);
    for (const month of ['2026-01', '2026-02']) {
      const view = viewOf(moved, month);
      expect(view.budgets.map((b) => b.name)).toEqual(['Groceries', 'Fun']);
      expect(levelOf(view)).toEqual({ unallocated: 250000, transfersNet: 0, savingsDue: 260000 });
    }
    const march = viewOf(moved, '2026-03');
    expect(rowOf(budgetLine(march, 'Holiday'))).toEqual([
      0, 20000, 3000, 23000, 0, 23000, 23000, 0,
    ]);
    expect(rowOf(budgetLine(march, 'Groceries'))).toEqual([
      80000, 40000, 2000, 122000, 0, 122000, 122000, 0,
    ]);
    expect(levelOf(march)).toEqual({ unallocated: 225000, transfersNet: 5000, savingsDue: 235000 });
    expect(rowOf(budgetLine(viewOf(moved, '2026-04'), 'Holiday'))).toEqual([
      23000, 20000, 0, 43000, 0, 43000, 43000, 0,
    ]);
    // No version is lost: the January row stays, and is the one in effect in March.
    const [stored] = moved.budgets.filter((b) => b.id === holiday.id);
    expect(stored?.startMonth).toBe('2026-03');
    expect(stored?.versions).toEqual([
      { effectiveMonth: '2026-01', amount: 20000, incremental: true },
    ]);
    // Conservation, January to March: income 9,000.00 = savings due 2,600.00 + 2,600.00 + 2,350.00
    // + held at the end of March (Groceries 1,220.00 + Holiday 230.00 = 1,450.00).
    expect(sum(moved.summaries.slice(0, 3).map((row) => row.savingsDue))).toBe(755000);
    expect(sum(march.budgets.map((b) => b.carriedOut))).toBe(145000);
    expectChainIdentities(moved.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-06' });

    // Moving it back gives the budget back exactly as it was.
    await request(app)
      .patch(`/api/budgets/${holiday.id}`)
      .send({ startMonth: '2026-01' })
      .expect(200);
    expectSameSnapshot(await snapshotOf(app, FINAL), original);
  });
});

describe('the largest amounts stay exact', () => {
  it('three transfers of the largest amount, carried month after month, to the last cent', async () => {
    const clock = mutableClock('2026-03-15T10:00:00Z');
    const app = await listening(createTestApp(clock).app);
    // MAX_CENTS is 1,000,000,000,000: ten billion units in cents. A salary of exactly that.
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 1_000_000_000_000,
      openingSavings: 0,
      budgets: [{ name: 'Big', amount: 500_000_000_000, incremental: true }],
    });
    const big = done.budgets[0]!;
    await addSpending(app, { budgetId: big.id, date: '2026-02-10', amount: 1 });
    for (const date of ['2026-01-05', '2026-02-05', '2026-03-05']) {
      await addTransfer(app, {
        date,
        fromBudgetId: null,
        toBudgetId: big.id,
        amount: 1_000_000_000_000,
      });
    }
    const range = { from: '2026-01', to: '2026-03', months: ['2026-01', '2026-02', '2026-03'] };
    const snapshot = await snapshotOf(app, range);

    // Each month the pool gives away 10,000,000,000.00 of a salary of 10,000,000,000.00 and
    // allocates 5,000,000,000.00: 1e12 - 5e11 - 1e12 = -5e11, over-allocated by half the salary.
    //   January: Big 0 + 5e11 + 1e12 = 1.5e12 available, all carried.
    //   February: 1.5e12 + 5e11 + 1e12 = 3e12 available, 1 spent: 2,999,999,999,999 left, carried.
    //   March: 2,999,999,999,999 + 5e11 + 1e12 = 4,499,999,999,999 available, all carried.
    expect(snapshot.views.map((view) => rowsOf(view))).toEqual([
      {
        Big: [
          0, 500_000_000_000, 1_000_000_000_000, 1_500_000_000_000, 0, 1_500_000_000_000,
          1_500_000_000_000, 0,
        ],
      },
      {
        Big: [
          1_500_000_000_000, 500_000_000_000, 1_000_000_000_000, 3_000_000_000_000, 1,
          2_999_999_999_999, 2_999_999_999_999, 0,
        ],
      },
      {
        Big: [
          2_999_999_999_999, 500_000_000_000, 1_000_000_000_000, 4_499_999_999_999, 0,
          4_499_999_999_999, 4_499_999_999_999, 0,
        ],
      },
    ]);
    expect(snapshot.views.map((view) => levelOf(view))).toEqual(
      Array(3).fill({
        unallocated: -500_000_000_000,
        transfersNet: 1_000_000_000_000,
        savingsDue: -500_000_000_000,
      }),
    );
    expect(snapshot.views.map((view) => view.overAllocated)).toEqual([true, true, true]);
    // 1 spent of 3e12 is 0 percent, rounded down, and no alert.
    expect(budgetLine(viewOf(snapshot, '2026-02'), 'Big')).toMatchObject({
      usagePercent: 0,
      alert: 'ok',
    });
    // Conservation: income 3e12 = spent 1 + savings due -1.5e12 + held 4,499,999,999,999.
    expect(sum(snapshot.summaries.map((row) => row.income))).toBe(3_000_000_000_000);
    expect(sum(snapshot.summaries.map((row) => row.spent))).toBe(1);
    expect(sum(snapshot.summaries.map((row) => row.savingsDue))).toBe(-1_500_000_000_000);
    expectChainIdentities(snapshot.views, { startsAtLedgerStart: true });

    // January and February are closed, each to be taken from savings by 5e11; and that can be
    // settled, to a balance of -1e12 (a settlement records what happened).
    expect(snapshot.savings.outstanding.map((m) => [m.month, m.outstanding, m.direction])).toEqual([
      ['2026-01', -500_000_000_000, 'take'],
      ['2026-02', -500_000_000_000, 'take'],
    ]);
    await settleOk(app, '2026-01', { amount: -500_000_000_000 });
    await settleOk(app, '2026-02', { amount: -500_000_000_000 });
    expect(await expectSavingsIdentities(app)).toMatchObject({
      balance: -1_000_000_000_000,
      outstanding: [],
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 3. A transfer between budgets of different modes
// -------------------------------------------------------------------------------------------------

/**
 * Tracking since 2026-01, today is 2026-03-15, salary 3,000.00. Groceries 400.00 carries its
 * leftover, Fun 100.00 does not; 150.00 is spent from Groceries in January and nothing else is spent.
 *
 *   Groceries: Jan 400 - 150 = 250.00 carried. Feb 250 + 400 = 650.00. Mar 650 + 400 = 1,050.00.
 *   Fun: 100.00 to savings every month. The pool: 3,000.00 - 500.00 = 2,500.00.
 *   Savings due: 2,500.00 + 100.00 = 2,600.00 every month.
 *
 * Held (carried out of the month) plus savings due: Jan 250 + 2,600 = 2,850.00. Feb 650 + 2,600 =
 * 3,250.00. Mar 1,050 + 2,600 = 3,650.00.
 */
async function buildModes() {
  const clock = mutableClock('2026-03-15T10:00:00Z');
  const app = await listening(createTestApp(clock).app);
  const done = await onboard(app, {
    startMonth: '2026-01',
    salary: 300000,
    openingSavings: 0,
    budgets: [
      { name: 'Groceries', amount: 40000, incremental: true },
      { name: 'Fun', amount: 10000, incremental: false },
    ],
  });
  const [groceries, fun] = done.budgets as [BudgetDto, BudgetDto];
  await addSpending(app, { budgetId: groceries.id, date: '2026-01-12', amount: 15000 });
  return { app, clock, groceries, fun };
}

const MODES = {
  from: '2026-01',
  to: '2026-04',
  months: ['2026-01', '2026-02', '2026-03', '2026-04'],
} as const;

/** Held in incremental budgets at the end of a month, plus the month's savings due. */
const heldAndDue = (view: ReturnType<typeof viewOf>) =>
  sum(view.budgets.map((line) => line.carriedOut)) + view.savingsDue.total;

describe('a transfer between budgets of different modes', () => {
  it('the world before any transfer', async () => {
    const { app } = await buildModes();
    const snapshot = await snapshotOf(app, MODES);
    expect(snapshot.views.slice(0, 3).map((view) => rowsOf(view))).toEqual([
      {
        Groceries: [0, 40000, 0, 40000, 15000, 25000, 25000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
      {
        Groceries: [25000, 40000, 0, 65000, 0, 65000, 65000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
      {
        Groceries: [65000, 40000, 0, 105000, 0, 105000, 105000, 0],
        Fun: [0, 10000, 0, 10000, 0, 10000, 0, 10000],
      },
    ]);
    expect(snapshot.views.slice(0, 3).map(heldAndDue)).toEqual([285000, 325000, 365000]);
  });

  it('moves the amount from what goes to savings to what is carried (to the incremental budget)', async () => {
    const { app, groceries, fun } = await buildModes();
    const before = await snapshotOf(app, MODES);
    // February: 20.00 from Fun (not incremental) to Groceries (incremental).
    const made = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: fun.id,
      toBudgetId: groceries.id,
      amount: 2000,
    });
    const after = await snapshotOf(app, MODES);
    expectNothingChangedBefore(before, after, '2026-02');
    // Groceries: 250 + 400 + 20 = 670.00 available and carried. Fun: 100 - 20 = 80.00 to savings.
    const february = viewOf(after, '2026-02');
    expect(rowsOf(february)).toEqual({
      Groceries: [25000, 40000, 2000, 67000, 0, 67000, 67000, 0],
      Fun: [0, 10000, -2000, 8000, 0, 8000, 0, 8000],
    });
    // No field of the month's totals and not the pool changes (invariant 8): the savings due
    // goes down by the 20.00 that is now carried: 2,500.00 + 80.00 = 2,580.00.
    expect(levelOf(february)).toEqual({ unallocated: 250000, transfersNet: 0, savingsDue: 258000 });
    expect(february.totals).toEqual({
      allocated: 50000,
      spent: 0,
      remaining: 75000,
      transfersNet: 0,
    });
    // The two together do not change: carried 670 + due 2,580 = 3,250.00.
    expect(heldAndDue(february)).toBe(325000);
    expect(heldAndDue(february)).toBe(heldAndDue(viewOf(before, '2026-02')));
    // March carries the 20.00 on (and sends nothing more to savings): the due is as it was, held
    // goes up by 20.00: 1,070 + 2,600 = 3,670.00.
    const march = viewOf(after, '2026-03');
    expect(rowOf(budgetLine(march, 'Groceries'))).toEqual([
      67000, 40000, 0, 107000, 0, 107000, 107000, 0,
    ]);
    expect(march.savingsDue.total).toBe(260000);
    expect(heldAndDue(march)).toBe(367000);
    // Over the three months what is due and what is held add up to the same 8,850.00 as without
    // the transfer: Jan 2,600 + Feb 2,580 + Mar 2,600 + held at the end of March 1,070.
    const total = (snapshot: typeof after) =>
      sum(snapshot.summaries.slice(0, 3).map((row) => row.savingsDue)) +
      sum(viewOf(snapshot, '2026-03').budgets.map((line) => line.carriedOut));
    expect(total(after)).toBe(885000);
    expect(total(before)).toBe(885000);
    // January's savings due in the list is unchanged (causality); February's has the new split.
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding[1]).toEqual({
      month: '2026-02',
      savingsDue: 258000,
      settled: 0,
      outstanding: 258000,
      direction: 'move',
      breakdown: { unallocated: 250000, budgetsSettled: 8000, reservesReleased: 0 },
      adjustment: false,
    });
    for (const view of after.views) expectMonthIdentities(view);
    expectChainIdentities(after.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-04' });
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, MODES), before);
  });

  it('moves the amount from what is carried to what goes to savings (to the budget that is not incremental)', async () => {
    const { app, groceries, fun } = await buildModes();
    const before = await snapshotOf(app, MODES);
    // February: 40.00 from Groceries (incremental) to Fun (not incremental).
    const made = await addTransfer(app, {
      date: '2026-02-12',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 4000,
    });
    const after = await snapshotOf(app, MODES);
    expectNothingChangedBefore(before, after, '2026-02');
    // Groceries: 250 + 400 - 40 = 610.00 carried. Fun: 100 + 40 = 140.00 to savings.
    const february = viewOf(after, '2026-02');
    expect(rowsOf(february)).toEqual({
      Groceries: [25000, 40000, -4000, 61000, 0, 61000, 61000, 0],
      Fun: [0, 10000, 4000, 14000, 0, 14000, 0, 14000],
    });
    expect(levelOf(february)).toEqual({ unallocated: 250000, transfersNet: 0, savingsDue: 264000 });
    // Carried 610 + due 2,640 = 3,250.00, as before.
    expect(heldAndDue(february)).toBe(325000);
    // March carries 40.00 less: 610 + 400 = 1,010.00; its due is 2,600.00 as before.
    const march = viewOf(after, '2026-03');
    expect(rowOf(budgetLine(march, 'Groceries'))).toEqual([
      61000, 40000, 0, 101000, 0, 101000, 101000, 0,
    ]);
    expect(march.savingsDue.total).toBe(260000);
    const total =
      sum(after.summaries.slice(0, 3).map((row) => row.savingsDue)) +
      sum(march.budgets.map((line) => line.carriedOut));
    expect(total).toBe(885000); // 2,600 + 2,640 + 2,600 + 1,010
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-04' });
    await request(app).delete(`/api/transfers/${made.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, MODES), before);
  });

  it('counts the mode in effect in the month of the transfer: the same 20.00 is cross-mode in February and not in March', async () => {
    const { app, groceries, fun } = await buildModes();
    // From March on Groceries is not incremental: what it holds at the end of March goes to savings
    // ("switching from incremental to non-incremental releases its accumulated balance at the end of
    // that month"). Without transfers: Mar 650 carried in + 400 = 1,050.00 goes to savings, with
    // Fun's 100.00 and the pool's 2,500.00: 3,650.00.
    await putJson(app, `/api/budgets/${groceries.id}/versions/2026-03`, {
      amount: 40000,
      incremental: false,
    });
    const before = await snapshotOf(app, MODES);
    expect(rowOf(budgetLine(viewOf(before, '2026-03'), 'Groceries'))).toEqual([
      65000, 40000, 0, 105000, 0, 105000, 0, 105000,
    ]);
    expect(viewOf(before, '2026-03').savingsDue.total).toBe(365000);

    // Dated in March, both budgets send what they have to savings: the 20.00 only changes which of
    // the two sends it, and nothing is carried. Savings due 2,500.00 + 1,070.00 + 80.00 = 3,650.00.
    const inMarch = await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: fun.id,
      toBudgetId: groceries.id,
      amount: 2000,
    });
    const march = await snapshotOf(app, MODES);
    expectNothingChangedBefore(before, march, '2026-03');
    expect(rowsOf(viewOf(march, '2026-03'))).toEqual({
      Groceries: [65000, 40000, 2000, 107000, 0, 107000, 0, 107000],
      Fun: [0, 10000, -2000, 8000, 0, 8000, 0, 8000],
    });
    expect(viewOf(march, '2026-03').savingsDue).toEqual({
      unallocated: 250000,
      budgetsSettled: 115000,
      reservesReleased: 0,
      total: 365000,
    });
    expect(viewOf(march, '2026-02')).toEqual(viewOf(before, '2026-02'));
    await request(app).delete(`/api/transfers/${inMarch.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, MODES), before);

    // Dated in February, Groceries is incremental: the 20.00 is carried (February's savings due is
    // 2,580.00), and in March, where Groceries is released, it goes to savings with the rest:
    // 670 + 400 = 1,070.00 + Fun 100.00 + the pool 2,500.00 = 3,670.00. The two months together
    // owe what they did: 2,580 + 3,670 = 6,250 = 2,600 + 3,650.
    const inFebruary = await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: fun.id,
      toBudgetId: groceries.id,
      amount: 2000,
    });
    const february = await snapshotOf(app, MODES);
    expectNothingChangedBefore(before, february, '2026-02');
    expect(viewOf(february, '2026-02').savingsDue.total).toBe(258000);
    expect(rowOf(budgetLine(viewOf(february, '2026-02'), 'Groceries'))).toEqual([
      25000, 40000, 2000, 67000, 0, 67000, 67000, 0,
    ]);
    expect(rowOf(budgetLine(viewOf(february, '2026-03'), 'Groceries'))).toEqual([
      67000, 40000, 0, 107000, 0, 107000, 0, 107000,
    ]);
    expect(viewOf(february, '2026-03').savingsDue).toEqual({
      unallocated: 250000,
      budgetsSettled: 117000,
      reservesReleased: 0,
      total: 367000,
    });
    const owed = (snapshot: typeof february) =>
      viewOf(snapshot, '2026-02').savingsDue.total + viewOf(snapshot, '2026-03').savingsDue.total;
    expect(owed(february)).toBe(625000);
    expect(owed(before)).toBe(625000);
    expectChainIdentities(february.views, { startsAtLedgerStart: true });
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-04' });
    await request(app).delete(`/api/transfers/${inFebruary.id}`).expect(204);
    expectSameSnapshot(await snapshotOf(app, MODES), before);
  });
});
