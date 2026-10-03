/**
 * Multi-month HTTP scenarios for savings, driven only through the public endpoints, with a clock
 * that moves forward and figures worked out by hand (every number below is cents). After each step
 * `expectSavingsIdentities` checks the identities of docs/DOMAIN.md against numbers it reads from
 * other endpoints, so each scenario is also a test of invariants 6 and 7.
 *
 * The world of most scenarios (`setUpTwoClosedMonths`): tracking from 2026-01, today is 2026-03-15,
 * a salary of 3,000.00, 500.00 opening savings, Groceries 400.00 (not incremental) and two
 * subscriptions. January's savings due is 265701 and February's 255701 (see the helper).
 */
import type { OutstandingMonthDto } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  expectApiError,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import {
  addGoal,
  addTransaction,
  allTransactions,
  expectSavingsIdentities,
  getSavings,
  postTransaction,
  setUpTwoClosedMonths,
  settle,
  settleOk,
  undoSettlement,
} from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

const entry = (savings: { outstanding: OutstandingMonthDto[] }, month: string) =>
  savings.outstanding.find((candidate) => candidate.month === month);

/** The January and February facts of `setUpTwoClosedMonths`, but built while January is current. */
async function setUpJanuary(clockIso: string) {
  const clock = mutableClock(clockIso);
  const { app, db } = createTestApp(clock);
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
  const groceries = await addBudget(app, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
    startMonth: '2026-01',
  });
  await addSubscription(app, {
    name: 'Netflix',
    frequency: 'monthly',
    anchorDate: '2026-01-15',
    amount: 1299,
    startMonth: '2026-01',
  });
  await addSubscription(app, {
    name: 'Insurance',
    frequency: 'yearly',
    anchorDate: '2026-06-15',
    amount: 12000,
    startMonth: '2026-01',
  });
  await addSpending(app, { budgetId: groceries.id, date: '2026-01-12', amount: 31000 });
  return { app, db, clock, groceries };
}

describe('scenario 1: a month closes, is outstanding, is settled across two goals and disappears', () => {
  it('follows January and February as the clock moves', async () => {
    const { app, clock } = await setUpJanuary('2026-01-20T10:00:00Z');

    // January is the current month: it holds money but nothing is due yet.
    expect(await getSavings(app)).toEqual({
      balance: 50000,
      unassigned: 50000,
      goals: [],
      outstanding: [],
      outstandingTotal: 0,
    });

    // The month ends. January: 3,000.00 - 12.99 Netflix - 20.00 insurance reserve - 400.00 budget
    // is 2,567.01 unallocated, plus 90.00 left in Groceries (400.00 - 310.00): 2,657.01 to move.
    clock.set('2026-02-01T08:00:00Z');
    const closed = await expectSavingsIdentities(app);
    expect(closed.outstanding).toEqual([
      {
        month: '2026-01',
        savingsDue: 265701,
        settled: 0,
        outstanding: 265701,
        direction: 'move',
        breakdown: { unallocated: 256701, budgetsSettled: 9000, reservesReleased: 0 },
        adjustment: false,
      },
    ]);
    expect(closed.outstandingTotal).toBe(265701);

    // Settle it: 1,000.00 to the holiday, 500.00 to the car, the rest (1,157.01) unassigned.
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const car = await addGoal(app, {
      name: 'Car',
      targetAmount: 500000,
      deadline: '2027-03-15',
    });
    const rows = await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: holiday.id, amount: 100000 },
        { goalId: car.id, amount: 50000 },
        { goalId: null, amount: 115701 },
      ],
    });
    expect(rows.map((row) => [row.id, row.date, row.amount, row.goalId, row.settlesMonth])).toEqual(
      [
        [2, '2026-02-01', 100000, holiday.id, '2026-01'],
        [3, '2026-02-01', 50000, car.id, '2026-01'],
        [4, '2026-02-01', 115701, null, '2026-01'],
      ],
    );

    const settled = await expectSavingsIdentities(app);
    expect(settled).toMatchObject({
      balance: 315701,
      unassigned: 165701,
      outstanding: [],
      outstandingTotal: 0,
    });
    expect(settled.goals).toEqual([
      {
        id: holiday.id,
        name: 'Holiday',
        targetAmount: 100000,
        deadline: null,
        color: null,
        archived: false,
        balance: 100000,
        progressPercent: 100,
        remaining: 0,
        reached: true,
        monthlyNeeded: null,
        status: 'reached',
      },
      {
        // 450000 is missing, and February 2026 to March 2027 is 14 months: ceilDiv(450000, 14).
        id: car.id,
        name: 'Car',
        targetAmount: 500000,
        deadline: '2027-03-15',
        color: null,
        archived: false,
        balance: 50000,
        progressPercent: 10,
        remaining: 450000,
        reached: false,
        monthlyNeeded: 32143,
        status: 'active',
      },
    ]);

    // February closes: nothing was spent, so all 400.00 of Groceries move to savings as well.
    // 3,000.00 - 12.99 - 20.00 - 400.00 = 2,567.01, plus 400.00.
    clock.set('2026-03-02T08:00:00Z');
    const next = await expectSavingsIdentities(app);
    expect(next.outstanding).toEqual([
      {
        month: '2026-02',
        savingsDue: 296701,
        settled: 0,
        outstanding: 296701,
        direction: 'move',
        breakdown: { unallocated: 256701, budgetsSettled: 40000, reservesReleased: 0 },
        adjustment: false,
      },
    ]);
    // One month later the car needs the same 450000 over 13 months: ceilDiv(450000, 13).
    expect(next.goals[1]?.monthlyNeeded).toBe(34616);

    const [row] = await settleOk(app, '2026-02', { amount: 296701 });
    expect(row).toMatchObject({ id: 5, date: '2026-03-02', goalId: null, amount: 296701 });
    const done = await expectSavingsIdentities(app);
    expect(done).toMatchObject({
      balance: 612402,
      unassigned: 462402,
      outstanding: [],
      outstandingTotal: 0,
    });
  });

  it('months that close while nobody looks are listed exactly as if they had been followed one by one', async () => {
    // One app follows the months, the other wakes up in April and finds three closed months.
    const stepped = await setUpJanuary('2026-01-20T10:00:00Z');
    const jumped = await setUpJanuary('2026-01-20T10:00:00Z');

    stepped.clock.set('2026-02-01T08:00:00Z');
    const afterJanuary = await getSavings(stepped.app);
    stepped.clock.set('2026-03-01T08:00:00Z');
    const afterFebruary = await getSavings(stepped.app);
    stepped.clock.set('2026-04-01T08:00:00Z');
    const afterMarch = await expectSavingsIdentities(stepped.app);

    // A month that closes never changes the ones before it (causality): each list extends the last.
    expect(afterFebruary.outstanding.slice(0, 1)).toEqual(afterJanuary.outstanding);
    expect(afterMarch.outstanding.slice(0, 2)).toEqual(afterFebruary.outstanding);
    // January 2,657.01 and, February and March each 2,967.01 (nothing was spent in them).
    expect(afterMarch.outstanding.map((m) => [m.month, m.outstanding])).toEqual([
      ['2026-01', 265701],
      ['2026-02', 296701],
      ['2026-03', 296701],
    ]);
    expect(afterMarch.outstandingTotal).toBe(859103);

    jumped.clock.set('2026-04-01T08:00:00Z');
    expect(await expectSavingsIdentities(jumped.app)).toEqual(afterMarch);

    // The months can then be settled in any order, with the same result.
    await settleOk(stepped.app, '2026-01', { amount: 265701 });
    await settleOk(stepped.app, '2026-02', { amount: 296701 });
    await settleOk(stepped.app, '2026-03', { amount: 296701 });
    await settleOk(jumped.app, '2026-03', { amount: 296701 });
    await settleOk(jumped.app, '2026-01', { amount: 265701 });
    await settleOk(jumped.app, '2026-02', { amount: 296701 });
    const [a, b] = [
      await expectSavingsIdentities(stepped.app),
      await expectSavingsIdentities(jumped.app),
    ];
    expect(a).toEqual(b);
    expect(a).toMatchObject({ balance: 50000 + 859103, outstanding: [], outstandingTotal: 0 });
  });
});

describe('scenario 2: a forgotten edit to a settled month comes back as an adjustment', () => {
  it('a forgotten spending, a refund and a late income, each settled to exactly the savings due', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: holiday.id, amount: 100000 },
        { goalId: null, amount: 165701 },
      ],
    });
    expect((await expectSavingsIdentities(app)).outstanding.map((m) => m.month)).toEqual([
      '2026-02',
    ]);

    // 1. A forgotten 50.00 spending dated in January. Groceries had 90.00 left, now 40.00: January
    // owes 50.00 less than was moved, so 50.00 is to be taken back.
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-20', amount: 5000 });
    let savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 260701,
      settled: 265701,
      outstanding: -5000,
      direction: 'take',
      breakdown: { unallocated: 256701, budgetsSettled: 4000, reservesReleased: 0 },
      adjustment: true,
    });
    // February did not move (causality), and the total is the signed sum of both.
    expect(entry(savings, '2026-02')).toMatchObject({ outstanding: 255701, adjustment: false });
    expect(savings.outstandingTotal).toBe(250701);

    // Settling it brings the total settled back to exactly the savings due: 2,657.01 - 50.00.
    const [taken] = await settleOk(app, '2026-01', { amount: -5000 });
    expect(taken).toMatchObject({ amount: -5000, goalId: null, settlesMonth: '2026-01', id: 4 });
    savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-01')).toBeUndefined();
    expect(savings.balance).toBe(50000 + 265701 - 5000);
    const januaryRows = (await allTransactions(app)).filter((r) => r.settlesMonth === '2026-01');
    expect(januaryRows.reduce((total, row) => total + row.amount, 0)).toBe(260701);

    // 2. A refund of 30.00 into Groceries, dated in January: 30.00 more is due.
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-28', amount: -3000 });
    savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 263701,
      settled: 260701,
      outstanding: 3000,
      direction: 'move',
      breakdown: { unallocated: 256701, budgetsSettled: 7000, reservesReleased: 0 },
      adjustment: true,
    });
    await settleOk(app, '2026-01', { amount: 3000 });

    // 3. A bonus of 200.00 added late to January: unallocated income goes up by 200.00.
    await addIncome(app, { date: '2026-01-25', amount: 20000, description: 'Late bonus' });
    savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 283701,
      settled: 263701,
      outstanding: 20000,
      direction: 'move',
      breakdown: { unallocated: 276701, budgetsSettled: 7000, reservesReleased: 0 },
      adjustment: true,
    });
    await settleOk(app, '2026-01', { amount: 20000 });
    savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-01')).toBeUndefined();
    // Four settlements of January: 2,657.01 - 50.00 + 30.00 + 200.00 = 2,837.01, its savings due.
    const rows = (await allTransactions(app)).filter((r) => r.settlesMonth === '2026-01');
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([
      -5000, 3000, 20000, 100000, 165701,
    ]);
    expect(rows.reduce((total, row) => total + row.amount, 0)).toBe(283701);
  });

  it('an edit that nets to the same savings due leaves nothing to settle', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-02', { amount: 255701 });
    // Spend 40.00 and get 40.00 back: February's savings due is what it was.
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-20', amount: 4000 });
    expect(entry(await getSavings(app), '2026-02')).toMatchObject({ outstanding: -4000 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-21', amount: -4000 });
    const savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-02')).toBeUndefined();
    expectApiError(await settle(app, '2026-02', { amount: 4000 }), 'nothing_to_settle');
  });

  it('a month whose earlier settlements net to 0 is still an adjustment, though settled is 0', async () => {
    const { app } = await setUpTwoClosedMonths();
    const wipe = await addBudget(app, {
      name: 'Wipe',
      amount: 0,
      incremental: false,
      startMonth: '2026-01',
    });
    await settleOk(app, '2026-01', { amount: 265701 });

    // A forgotten 2,657.01 spending in a budget with nothing allocated: January is due nothing
    // any more (unallocated 2,567.01 + 90.00 left in Groceries - 2,657.01), so all of it is taken back.
    const spending = await addSpending(app, {
      budgetId: wipe.id,
      date: '2026-01-30',
      amount: 265701,
    });
    expect(entry(await expectSavingsIdentities(app), '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 0,
      settled: 265701,
      outstanding: -265701,
      direction: 'take',
      breakdown: { unallocated: 256701, budgetsSettled: -256701, reservesReleased: 0 },
      adjustment: true,
    });
    await settleOk(app, '2026-01', { amount: -265701 });
    expect(entry(await expectSavingsIdentities(app), '2026-01')).toBeUndefined();

    // The spending is deleted again: January is due its 2,657.01 again and the two settlements net
    // to 0, so `settled` is 0. It is still a correction of earlier settlements, not a first move.
    await request(app).delete(`/api/spendings/${spending.id}`).expect(204);
    expect(entry(await expectSavingsIdentities(app), '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 265701,
      settled: 0,
      outstanding: 265701,
      direction: 'move',
      breakdown: { unallocated: 256701, budgetsSettled: 9000, reservesReleased: 0 },
      adjustment: true,
    });
  });
});

describe('scenario 3: the amount is an optimistic lock', () => {
  it('refuses the figure the user saw when an edit landed in between, and takes the new one', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();

    // The user opens the inbox and sees "February: move 2,557.01".
    const seen = entry(await getSavings(app), '2026-02');
    expect(seen?.outstanding).toBe(255701);

    // Meanwhile a forgotten 20.00 spending is added to February: Groceries goes from -50.00 to
    // -70.00, so February is due 258701 - 7000 + 2000 = 253701.
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-20', amount: 2000 });
    const before = await allTransactions(app);

    const res = await settle(app, '2026-02', { amount: 255701 });
    expectApiError(res, 'outstanding_changed');
    expect(res.body.error.details).toEqual({ month: '2026-02', outstanding: 253701 });
    expect(await allTransactions(app)).toEqual(before); // nothing was stored

    // The UI shows the current value, the user confirms it, and it goes through.
    const [row] = await settleOk(app, '2026-02', { amount: res.body.error.details.outstanding });
    expect(row).toMatchObject({ amount: 253701, settlesMonth: '2026-02' });
    const savings = await expectSavingsIdentities(app);
    expect(entry(savings, '2026-02')).toBeUndefined();
    expect(savings.balance).toBe(50000 + 253701);
  });

  it('is only an equality check: an edit that is reverted leaves the old figure valid again', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    const spending = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-02-20',
      amount: 2000,
    });
    expectApiError(await settle(app, '2026-02', { amount: 255701 }), 'outstanding_changed');
    await request(app).delete(`/api/spendings/${spending.id}`).expect(204);
    await settle(app, '2026-02', { amount: 255701 }).expect(201);
  });

  it('also guards the correction of a month that was settled before', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-01', { amount: 265701 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-20', amount: 5000 });
    const seen = entry(await getSavings(app), '2026-01');
    expect(seen?.outstanding).toBe(-5000);
    // Another forgotten 10.00 spending lands before the user confirms.
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-21', amount: 1000 });
    const res = await settle(app, '2026-01', { amount: -5000 });
    expectApiError(res, 'outstanding_changed');
    expect(res.body.error.details).toEqual({ month: '2026-01', outstanding: -6000 });
    await settleOk(app, '2026-01', { amount: -6000 });
    expect(entry(await expectSavingsIdentities(app), '2026-01')).toBeUndefined();
  });
});

describe('scenario 4: taking money from savings', () => {
  /**
   * Tracking from 2026-01, today 2026-03-15, salary 1,000.00 and 200.00 of opening savings. Rent is
   * 800.00 a month, not incremental, and 1,300.00 is spent on it in January: 500.00 over. In
   * February 750.00 is spent. Unallocated is 200.00 in both months.
   *
   *   January:  unallocated 200.00, Rent remaining -500.00 -> savings due -300.00 (take)
   *   February: unallocated 200.00, Rent remaining   50.00 -> savings due  250.00 (move)
   */
  async function setUpOverspending() {
    const clock = mutableClock('2026-03-15T10:00:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-01', salary: 100000, openingSavings: 20000 });
    const rent = await addBudget(app, {
      name: 'Rent',
      amount: 80000,
      incremental: false,
      startMonth: '2026-01',
    });
    await addSpending(app, { budgetId: rent.id, date: '2026-01-05', amount: 130000 });
    await addSpending(app, { budgetId: rent.id, date: '2026-02-05', amount: 75000 });
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const emergency = await addGoal(app, { name: 'Emergency', targetAmount: 300000 });
    await addTransaction(app, {
      kind: 'deposit',
      amount: 5000,
      goalId: holiday.id,
      date: '2026-02-10',
    });
    await addTransaction(app, {
      kind: 'deposit',
      amount: 8000,
      goalId: emergency.id,
      date: '2026-02-11',
    });
    return { app, rent, holiday, emergency };
  }

  it('lists a month that took more than it saved as "take", with a negative amount', async () => {
    const { app } = await setUpOverspending();
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding).toEqual([
      {
        month: '2026-01',
        savingsDue: -30000,
        settled: 0,
        outstanding: -30000,
        direction: 'take',
        breakdown: { unallocated: 20000, budgetsSettled: -50000, reservesReleased: 0 },
        adjustment: false,
      },
      {
        month: '2026-02',
        savingsDue: 25000,
        settled: 0,
        outstanding: 25000,
        direction: 'move',
        breakdown: { unallocated: 20000, budgetsSettled: 5000, reservesReleased: 0 },
        adjustment: false,
      },
    ]);
    expect(savings.outstandingTotal).toBe(-5000);
    expect(savings.balance).toBe(33000);
  });

  it('splits the amount taken across a goal and unassigned savings, which takes the goal below 0', async () => {
    const { app, holiday, emergency } = await setUpOverspending();
    // Take 300.00: 200.00 from Holiday (which holds 50.00) and 100.00 from unassigned (200.00).
    const rows = await settleOk(app, '2026-01', {
      amount: -30000,
      allocations: [
        { goalId: holiday.id, amount: -20000 },
        { goalId: null, amount: -10000 },
      ],
    });
    expect(rows.map((row) => [row.amount, row.goalId, row.settlesMonth])).toEqual([
      [-20000, holiday.id, '2026-01'],
      [-10000, null, '2026-01'],
    ]);
    const savings = await expectSavingsIdentities(app);
    // Holiday: 50.00 - 200.00 = -150.00. Unassigned: 200.00 - 100.00. Emergency is untouched.
    expect(savings).toMatchObject({ balance: 3000, unassigned: 10000, outstandingTotal: 25000 });
    expect(savings.goals).toMatchObject([
      {
        id: holiday.id,
        balance: -15000,
        progressPercent: 0,
        remaining: 115000,
        reached: false,
        status: 'active',
      },
      { id: emergency.id, balance: 8000, progressPercent: 2, remaining: 292000 },
    ]);
  });

  it('can take the whole balance below 0, and the identities still hold', async () => {
    const { app, holiday, emergency } = await setUpOverspending();
    await settleOk(app, '2026-01', {
      amount: -30000,
      allocations: [
        { goalId: holiday.id, amount: -20000 },
        { goalId: null, amount: -10000 },
      ],
    });
    // A forgotten 400.00 Rent payment in February: 50.00 left becomes -350.00, so 200.00 - 350.00
    // = 150.00 is to be taken.
    const rent = (await request(app).get('/api/budgets').expect(200)).body[0];
    await addSpending(app, { budgetId: rent.id, date: '2026-02-20', amount: 40000 });
    const before = await expectSavingsIdentities(app);
    expect(entry(before, '2026-02')).toMatchObject({
      savingsDue: -15000,
      outstanding: -15000,
      direction: 'take',
      breakdown: { unallocated: 20000, budgetsSettled: -35000, reservesReleased: 0 },
    });

    // Take 150.00 from the Emergency goal, which holds 80.00.
    await settleOk(app, '2026-02', {
      amount: -15000,
      allocations: [{ goalId: emergency.id, amount: -15000 }],
    });
    const after = await expectSavingsIdentities(app);
    expect(after.outstanding).toEqual([]);
    // 100.00 unassigned, -150.00 Holiday, -70.00 Emergency: 120.00 below 0 in all.
    expect(after).toMatchObject({ balance: -12000, unassigned: 10000 });
    expect(after.goals.map((goal) => goal.balance)).toEqual([-15000, -7000]);
  });

  it('takes from unassigned savings when no allocation is given, and that can go below 0', async () => {
    const { app } = await setUpOverspending();
    const [row] = await settleOk(app, '2026-01', { amount: -30000 });
    expect(row).toMatchObject({ amount: -30000, goalId: null });
    // 200.00 of opening savings - 300.00.
    expect(await expectSavingsIdentities(app)).toMatchObject({ unassigned: -10000, balance: 3000 });
  });

  it('refuses a negative allocation that names an archived goal, but lets its money be withdrawn', async () => {
    const { app, emergency } = await setUpOverspending();
    await request(app).patch(`/api/goals/${emergency.id}`).send({ archived: true }).expect(200);
    expectRuleViolation(
      await settle(app, '2026-01', {
        amount: -30000,
        allocations: [{ goalId: emergency.id, amount: -30000 }],
      }),
      'goal_archived',
      'allocations.0.goalId',
    );
    // Its 80.00 are not frozen: they can be withdrawn.
    await postTransaction(app, { kind: 'withdrawal', amount: 8000, goalId: emergency.id }).expect(
      201,
    );
    expect((await expectSavingsIdentities(app)).goals[1]?.balance).toBe(0);
  });

  it('a negative settlement is never refused for lack of balance, a withdrawal is', async () => {
    const { app, holiday } = await setUpOverspending();
    expectRuleViolation(
      await postTransaction(app, { kind: 'withdrawal', amount: 20000, goalId: holiday.id }),
      'insufficient_balance',
      'amount',
    );
    await settle(app, '2026-01', {
      amount: -30000,
      allocations: [{ goalId: holiday.id, amount: -30000 }],
    }).expect(201);
    expect((await expectSavingsIdentities(app)).goals[0]?.balance).toBe(-25000);
  });
});

describe('scenario 5: undoing a settlement', () => {
  it('restores the original outstanding, and the month is no longer an adjustment', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: holiday.id, amount: 100000 },
        { goalId: null, amount: 165701 },
      ],
    });
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-20', amount: 5000 });
    await settleOk(app, '2026-01', { amount: -5000 });
    const adjusted = await expectSavingsIdentities(app);
    expect(entry(adjusted, '2026-01')).toBeUndefined();
    expect(adjusted.balance).toBe(50000 + 260701);

    await undoSettlement(app, '2026-01');
    const undone = await expectSavingsIdentities(app);
    // No settlement rows are left: January is due its whole 2,607.01 again, not as an adjustment.
    expect(entry(undone, '2026-01')).toEqual({
      month: '2026-01',
      savingsDue: 260701,
      settled: 0,
      outstanding: 260701,
      direction: 'move',
      breakdown: { unallocated: 256701, budgetsSettled: 4000, reservesReleased: 0 },
      adjustment: false,
    });
    expect(undone).toMatchObject({ balance: 50000, unassigned: 50000 });
    expect(undone.goals[0]).toMatchObject({ id: holiday.id, balance: 0, progressPercent: 0 });
    expect((await allTransactions(app)).map((row) => row.kind)).toEqual(['opening']);

    // And it can be settled again, with the figure it shows now.
    await settleOk(app, '2026-01', { amount: 260701 });
    expect(entry(await expectSavingsIdentities(app), '2026-01')).toBeUndefined();
  });

  it('settling a month and undoing it at once leaves every balance as it was', async () => {
    const { app } = await setUpTwoClosedMonths();
    const holiday = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const car = await addGoal(app, { name: 'Car', targetAmount: 500000 });
    await addTransaction(app, { kind: 'deposit', amount: 4000, goalId: car.id });
    const before = await expectSavingsIdentities(app);
    const rowsBefore = await allTransactions(app);

    await settleOk(app, '2026-02', {
      amount: 255701,
      allocations: [
        { goalId: holiday.id, amount: 55701 },
        { goalId: car.id, amount: 200000 },
      ],
    });
    await undoSettlement(app, '2026-02');
    expect(await expectSavingsIdentities(app)).toEqual(before);
    expect(await allTransactions(app)).toEqual(rowsBefore);
  });

  it('undoes one month only: the other months stay settled', async () => {
    const { app } = await setUpTwoClosedMonths();
    await settleOk(app, '2026-01', { amount: 265701 });
    await settleOk(app, '2026-02', { amount: 255701 });
    await undoSettlement(app, '2026-01');
    const savings = await expectSavingsIdentities(app);
    expect(savings.outstanding.map((m) => [m.month, m.outstanding, m.adjustment])).toEqual([
      ['2026-01', 265701, false],
    ]);
    expect(savings.balance).toBe(50000 + 255701);
  });

  it('undoes a month that was settled in several slices, one request for all of them', async () => {
    const { app } = await setUpTwoClosedMonths();
    const a = await addGoal(app, { name: 'A' });
    const b = await addGoal(app, { name: 'B' });
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: a.id, amount: 100000 },
        { goalId: b.id, amount: 100000 },
        { goalId: null, amount: 65701 },
      ],
    });
    expect((await allTransactions(app)).filter((row) => row.kind === 'settlement')).toHaveLength(3);
    await undoSettlement(app, '2026-01');
    expect((await allTransactions(app)).filter((row) => row.kind === 'settlement')).toEqual([]);
  });
});

describe('scenario 9: every identity holds after every step of a long story', () => {
  it('survives settling, adjusting, reallocating, archiving, deleting, undoing and a new month', async () => {
    const { app, clock, groceries } = await setUpTwoClosedMonths();
    const check = () => expectSavingsIdentities(app);
    await check();

    // Goals and manual money.
    const g1 = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const g2 = await addGoal(app, { name: 'Car', targetAmount: 500000 });
    const g3 = await addGoal(app, { name: 'Old laptop', targetAmount: 50000 });
    await check();
    await addTransaction(app, { kind: 'deposit', amount: 30000, goalId: g1.id });
    await addTransaction(app, { kind: 'deposit', amount: 10000, goalId: g2.id });
    await addTransaction(app, { kind: 'deposit', amount: 5000, goalId: g3.id });
    await addTransaction(app, { kind: 'deposit', amount: 700 });
    await check();

    // January, split three ways.
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: g1.id, amount: 100000 },
        { goalId: g2.id, amount: 100000 },
        { goalId: null, amount: 65701 },
      ],
    });
    await check();

    // Reallocations never change the balance.
    const balance = (await getSavings(app)).balance;
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 25000,
      fromGoalId: g1.id,
      toGoalId: g2.id,
    });
    const second = (
      await addTransaction(app, {
        kind: 'reallocation',
        amount: 10000,
        fromGoalId: g2.id,
        toGoalId: null,
      })
    )[1];
    expect((await check()).balance).toBe(balance);

    // Archive a goal, and take its money out.
    await request(app).patch(`/api/goals/${g3.id}`).send({ archived: true }).expect(200);
    await addTransaction(app, { kind: 'withdrawal', amount: 2000, goalId: g3.id });
    await check();

    // A forgotten spending in January, settled as an adjustment of -50.00.
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-20', amount: 5000 });
    await check();
    await settleOk(app, '2026-01', {
      amount: -5000,
      allocations: [{ goalId: g1.id, amount: -5000 }],
    });
    await check();

    // February, then a late bonus in February that is settled as an adjustment too.
    await settleOk(app, '2026-02', {
      amount: 255701,
      allocations: [{ goalId: g2.id, amount: 255701 }],
    });
    await check();
    await addIncome(app, { date: '2026-02-25', amount: 20000, description: 'Late bonus' });
    await check();

    // Delete a goal: its money moves to unassigned and nothing else changes.
    const beforeDelete = await getSavings(app);
    await request(app).delete(`/api/goals/${g1.id}`).expect(204);
    const afterDelete = await check();
    expect(afterDelete.balance).toBe(beforeDelete.balance);
    expect(afterDelete.outstanding).toEqual(beforeDelete.outstanding);

    // Undo January altogether, and delete the second reallocation by its second row.
    await undoSettlement(app, '2026-01');
    await check();
    await request(app).delete(`/api/savings/transactions/${second?.id}`).expect(204);
    await check();

    // Bring the archived goal back and use it, and replace the opening balance.
    await request(app).patch(`/api/goals/${g3.id}`).send({ archived: false }).expect(200);
    await addTransaction(app, { kind: 'deposit', amount: 1500, goalId: g3.id });
    await request(app).put('/api/savings/opening').send({ amount: 10000 }).expect(200);
    const midway = await check();
    expect(midway.outstanding.map((m) => [m.month, m.outstanding, m.adjustment])).toEqual([
      ['2026-01', 260701, false],
      ['2026-02', 20000, true],
    ]);

    // A new month closes (March, nothing spent: 2,587.01 + 400.00 = 2,987.01) and all is settled.
    clock.set('2026-04-02T07:00:00Z');
    const withMarch = await check();
    expect(withMarch.outstanding.map((m) => [m.month, m.outstanding])).toEqual([
      ['2026-01', 260701],
      ['2026-02', 20000],
      ['2026-03', 298701],
    ]);
    await settleOk(app, '2026-01', { amount: 260701 });
    await settleOk(app, '2026-02', { amount: 20000 });
    await settleOk(app, '2026-03', { amount: 298701 });
    const done = await check();
    expect(done.outstanding).toEqual([]);
    expect(done.outstandingTotal).toBe(0);
    // 100.00 opening + the money due of the closed months (January 2,607.01, February 2,757.01,
    // March 2,987.01) + the manual money (300.00 + 100.00 + 50.00 + 7.00 + 15.00 - 20.00).
    expect(done.balance).toBe(10000 + 260701 + 275701 + 298701 + 45200);
  });
});
