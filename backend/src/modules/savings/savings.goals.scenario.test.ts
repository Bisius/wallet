/**
 * HTTP scenarios for goals and the opening balance, with a clock that moves forward and figures
 * worked out by hand (every number below is cents): scenario 6 (progress, monthly amount needed and
 * status over the months), 7 (deleting a goal, deleting a reallocation) and 8 (the opening balance
 * and the start month). After each step `expectSavingsIdentities` checks the identities of
 * docs/DOMAIN.md, so these are tests of invariant 6 too.
 */
import type { GoalDto } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { mutableClock, onboard } from '../../testing/helpers';
import {
  addGoal,
  addTransaction,
  allTransactions,
  expectSavingsIdentities,
  getSavings,
  setUpTwoClosedMonths,
  settleOk,
} from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

/** A world that starts tracking in October 2026, on 2 October, with no money coming in. */
async function setUpOctober() {
  const clock = mutableClock('2026-10-02T09:00:00Z');
  const { app } = createTestApp(clock);
  await onboard(app, { startMonth: '2026-10', salary: 0, openingSavings: 0 });
  const goalOf = async (id: number) => {
    const goals = (await request(app).get('/api/goals').expect(200)).body as GoalDto[];
    const goal = goals.find((candidate) => candidate.id === id);
    if (!goal) throw new Error(`no goal ${id}`);
    return goal;
  };
  return { app, clock, goalOf };
}

describe('scenario 6: goal progress, monthly amount needed and status as the months go by', () => {
  it('follows the worked example of docs/DOMAIN.md: 1,000.00 by 15 March 2027', async () => {
    const { app, clock, goalOf } = await setUpOctober();
    const laptop = await addGoal(app, {
      name: 'Laptop',
      targetAmount: 100000,
      deadline: '2027-03-15',
    });

    // Nothing saved on 2 October 2026. The deadline's month, 2027-03, is 5 months after 2026-10, so
    // October to March is 6 months: ceilDiv(100000, 6) = 16667. Six of them are 1,000.02: the last
    // month needs 2 cents less.
    expect(await goalOf(laptop.id)).toEqual({
      id: laptop.id,
      name: 'Laptop',
      targetAmount: 100000,
      deadline: '2027-03-15',
      color: null,
      archived: false,
      balance: 0,
      progressPercent: 0,
      remaining: 100000,
      reached: false,
      monthlyNeeded: 16667,
      status: 'active',
    });

    // With 300.00 saved, 700.00 is missing: ceilDiv(70000, 6) = 11667.
    await addTransaction(app, { kind: 'deposit', amount: 30000, goalId: laptop.id });
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 30000,
      progressPercent: 30,
      remaining: 70000,
      reached: false,
      monthlyNeeded: 11667,
      status: 'active',
    });

    // The same 700.00 over the months that are left. The deadline's own month still counts, and
    // after it the whole remainder is needed now, so the goal is overdue.
    const months: [clock: string, monthsLeft: number, monthlyNeeded: number, status: string][] = [
      ['2026-10-02T09:00:00Z', 6, 11667, 'active'],
      ['2026-11-20T09:00:00Z', 5, 14000, 'active'],
      ['2026-12-31T09:00:00Z', 4, 17500, 'active'],
      ['2027-01-01T09:00:00Z', 3, 23334, 'active'], // ceilDiv(70000, 3): the last month needs less
      ['2027-02-28T09:00:00Z', 2, 35000, 'active'],
      ['2027-03-15T09:00:00Z', 1, 70000, 'active'],
      ['2027-03-31T20:00:00Z', 1, 70000, 'active'], // still March
      ['2027-04-01T09:00:00Z', 1, 70000, 'overdue'], // the deadline's month has passed
      ['2027-09-10T09:00:00Z', 1, 70000, 'overdue'], // and monthsLeft stays at 1
    ];
    for (const [now, , monthlyNeeded, status] of months) {
      clock.set(now);
      expect(await goalOf(laptop.id), now).toMatchObject({
        balance: 30000,
        remaining: 70000,
        monthlyNeeded,
        status,
      });
    }
    await expectSavingsIdentities(app);

    // One cent short of the target: 99% (rounded down), and 0.01 is still needed.
    await addTransaction(app, { kind: 'deposit', amount: 69999, goalId: laptop.id });
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 99999,
      progressPercent: 99,
      remaining: 1,
      reached: false,
      monthlyNeeded: 1,
      status: 'overdue',
    });

    // Reached, past its deadline: `reached`, not `overdue`, and nothing more is needed.
    await addTransaction(app, { kind: 'deposit', amount: 1, goalId: laptop.id });
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 100000,
      progressPercent: 100,
      remaining: 0,
      reached: true,
      monthlyNeeded: null,
      status: 'reached',
    });

    // More than the target: the percentage is not capped.
    await addTransaction(app, { kind: 'deposit', amount: 50000, goalId: laptop.id });
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 150000,
      progressPercent: 150,
      remaining: 0,
      reached: true,
      monthlyNeeded: null,
      status: 'reached',
    });

    // Paying for it from the goal: 1,200.00 out, so 300.00 is left and it is overdue again.
    await addTransaction(app, { kind: 'withdrawal', amount: 120000, goalId: laptop.id });
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 30000,
      progressPercent: 30,
      remaining: 70000,
      reached: false,
      monthlyNeeded: 70000,
      status: 'overdue',
    });

    // Archived: its balance stays, and no monthly amount is needed.
    await request(app).patch(`/api/goals/${laptop.id}`).send({ archived: true }).expect(200);
    expect(await goalOf(laptop.id)).toMatchObject({
      balance: 30000,
      archived: true,
      reached: false,
      monthlyNeeded: null,
      status: 'archived',
    });
    const savings = await expectSavingsIdentities(app);
    expect(savings).toMatchObject({ balance: 30000, unassigned: 0 });
  });

  it('a goal past its deadline needs all of what is missing now, until it is reached', async () => {
    const { app, goalOf } = await setUpOctober();
    // The deadline was 31 August, before today: the goal is overdue the day it is created.
    const late = await addGoal(app, { name: 'Late', targetAmount: 50000, deadline: '2026-08-31' });
    expect(await goalOf(late.id)).toMatchObject({
      balance: 0,
      remaining: 50000,
      monthlyNeeded: 50000,
      status: 'overdue',
    });

    await addTransaction(app, { kind: 'deposit', amount: 20000, goalId: late.id });
    expect(await goalOf(late.id)).toMatchObject({
      progressPercent: 40,
      remaining: 30000,
      monthlyNeeded: 30000,
      status: 'overdue',
    });

    await addTransaction(app, { kind: 'deposit', amount: 30000, goalId: late.id });
    expect(await goalOf(late.id)).toMatchObject({
      progressPercent: 100,
      remaining: 0,
      reached: true,
      monthlyNeeded: null,
      status: 'reached',
    });

    // Taking 1 cent out of it makes it late again, by exactly that cent.
    await addTransaction(app, { kind: 'withdrawal', amount: 1, goalId: late.id });
    expect(await goalOf(late.id)).toMatchObject({
      balance: 49999,
      progressPercent: 99,
      remaining: 1,
      reached: false,
      monthlyNeeded: 1,
      status: 'overdue',
    });
  });

  it('a deadline in the current month is not overdue yet, whatever the day', async () => {
    const { app, clock, goalOf } = await setUpOctober();
    // The deadline, 1 October, is before today (2 October) but in the current month: one month
    // left, and it is not overdue. Only the month of a deadline counts.
    const early = await addGoal(app, { targetAmount: 12000, deadline: '2026-10-01' });
    expect(await goalOf(early.id)).toMatchObject({ monthlyNeeded: 12000, status: 'active' });
    clock.set('2026-11-01T00:00:00Z');
    expect(await goalOf(early.id)).toMatchObject({ monthlyNeeded: 12000, status: 'overdue' });
  });

  it('rounds the progress down, so a displayed 100 always means reached', async () => {
    const { app, goalOf } = await setUpOctober();
    const goal = await addGoal(app, { name: 'Tiny', targetAmount: 300 });
    // [deposit, balance, progressPercent, remaining]: floor(100 * balance / 300)
    const steps: [number, number, number, number][] = [
      [1, 1, 0, 299], // 0.33
      [99, 100, 33, 200], // 33.33
      [99, 199, 66, 101], // 66.33
      [100, 299, 99, 1], // 99.67
      [1, 300, 100, 0], // 100: reached
      [150, 450, 150, 0], // not capped
    ];
    for (const [deposit, balance, progressPercent, remaining] of steps) {
      await addTransaction(app, { kind: 'deposit', amount: deposit, goalId: goal.id });
      const figures = await goalOf(goal.id);
      expect(figures, `balance ${balance}`).toMatchObject({
        balance,
        progressPercent,
        remaining,
        reached: balance >= 300,
      });
    }
  });

  it('a goal that holds less than nothing has no progress and needs more than its target', async () => {
    const { app, goalOf } = await setUpOctober();
    const goal = await addGoal(app, { targetAmount: 10000, deadline: '2027-03-15' });
    const [deposit] = await addTransaction(app, { kind: 'deposit', amount: 500, goalId: goal.id });
    await addTransaction(app, { kind: 'withdrawal', amount: 500, goalId: goal.id });
    // A deletion is not limited by the balances: the goal now holds -500.
    await request(app).delete(`/api/savings/transactions/${deposit?.id}`).expect(204);
    // 10500 is missing, over 6 months: ceilDiv(10500, 6) = 1750.
    expect(await goalOf(goal.id)).toMatchObject({
      balance: -500,
      progressPercent: 0,
      remaining: 10500,
      reached: false,
      monthlyNeeded: 1750,
      status: 'active',
    });
    await expectSavingsIdentities(app);
  });
});

describe('scenario 7: deleting a goal and deleting a reallocation', () => {
  it('moves the goal to unassigned savings and changes no total, and the two rows of a reallocation delete together', async () => {
    const { app } = await setUpTwoClosedMonths();
    const a = await addGoal(app, { name: 'A', targetAmount: 200000 });
    const b = await addGoal(app, { name: 'B', targetAmount: 200000 });

    // January split three ways (ids 2, 3, 4), then two reallocations (ids 5-6 and 7-8).
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [
        { goalId: a.id, amount: 100000 },
        { goalId: b.id, amount: 50000 },
        { goalId: null, amount: 115701 },
      ],
    });
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 15000,
      fromGoalId: a.id,
      toGoalId: b.id,
      date: '2026-03-10',
    });
    await addTransaction(app, {
      kind: 'reallocation',
      amount: 5000,
      fromGoalId: b.id,
      toGoalId: null,
      date: '2026-03-12',
    });

    // A holds 1,000.00 - 150.00 and B holds 500.00 + 150.00 - 50.00. Unassigned: 500.00 opening +
    // 1,157.01 + 50.00. The balance is 500.00 + 2,657.01, the reallocations moved nothing in or out.
    const before = await expectSavingsIdentities(app);
    expect(before).toMatchObject({ balance: 315701, unassigned: 170701, outstandingTotal: 255701 });
    expect(before.goals.map((goal) => [goal.name, goal.balance])).toEqual([
      ['A', 85000],
      ['B', 60000],
    ]);
    const rowsBefore = await allTransactions(app);

    // Delete A: its 850.00 become unassigned, nothing is lost and no other goal changes.
    await request(app).delete(`/api/goals/${a.id}`).expect(204);
    const after = await expectSavingsIdentities(app);
    expect(after).toMatchObject({ balance: 315701, unassigned: 255701, outstandingTotal: 255701 });
    expect(after.goals.map((goal) => [goal.name, goal.balance])).toEqual([['B', 60000]]);
    // January is still settled for the same amount: the settlement rows are only unassigned now.
    expect(after.outstanding).toEqual(before.outstanding);

    // The rows are the same, in the same order, except that A's now belong to no goal.
    const rowsAfter = await allTransactions(app);
    expect(rowsAfter).toEqual(
      rowsBefore.map((row) => (row.goalId === a.id ? { ...row, goalId: null } : row)),
    );

    // The reallocation of 150.00 (rows 5 and 6, group 5) is deleted by the id of its second row:
    // both rows go. Unassigned gets back the -150.00 that left A, and B loses the +150.00.
    const reallocation = rowsAfter.filter((row) => row.groupId === 5);
    expect(reallocation.map((row) => [row.id, row.amount, row.goalId])).toEqual([
      [6, 15000, b.id],
      [5, -15000, null], // A's row: A does not exist any more
    ]);
    await request(app).delete('/api/savings/transactions/6').expect(204);
    const last = await expectSavingsIdentities(app);
    expect((await allTransactions(app)).some((row) => row.groupId === 5)).toBe(false);
    expect(last).toMatchObject({ balance: 315701, unassigned: 270701 });
    expect(last.goals.map((goal) => [goal.name, goal.balance])).toEqual([['B', 45000]]);
  });

  it('deleting a goal changes neither the balance nor another goal, even with a goal below 0', async () => {
    const { app, groceries } = await setUpTwoClosedMonths();
    const a = await addGoal(app, { name: 'A' });
    const b = await addGoal(app, { name: 'B' });
    await addTransaction(app, { kind: 'deposit', amount: 4000, goalId: b.id });
    // January's 2,657.01 is moved, and later 50.00 is taken back from A, which holds nothing.
    await settleOk(app, '2026-01', { amount: 265701 });
    await request(app)
      .post('/api/spendings')
      .send({ budgetId: groceries.id, date: '2026-01-20', amount: 5000 })
      .expect(201);
    await settleOk(app, '2026-01', {
      amount: -5000,
      allocations: [{ goalId: a.id, amount: -5000 }],
    });
    const before = await expectSavingsIdentities(app);
    expect(before.goals.map((goal) => [goal.name, goal.balance])).toEqual([
      ['A', -5000],
      ['B', 4000],
    ]);

    await request(app).delete(`/api/goals/${a.id}`).expect(204);
    const after = await expectSavingsIdentities(app);
    expect(after.balance).toBe(before.balance);
    // The -50.00 now lowers the unassigned savings, which hold what they held before.
    expect(after.unassigned).toBe(before.unassigned - 5000);
    expect(after.goals.map((goal) => [goal.name, goal.balance])).toEqual([['B', 4000]]);
  });
});

describe('scenario 8: the opening balance follows the start month, its amount does not', () => {
  const settings = (startMonth: string) => ({
    currency: 'EUR',
    locale: 'en-US',
    startMonth,
    theme: 'system',
    alertWarnPercent: 80,
  });

  it('has no row after a first PUT /api/settings, is created by PUT, and keeps its amount when the start month moves', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await request(app).put('/api/settings').send(settings('2026-01')).expect(200);

    // No opening row: 0, dated like a stored one.
    expect((await request(app).get('/api/savings/opening').expect(200)).body).toEqual({
      amount: 0,
      date: '2026-01-01',
    });
    expect(await getSavings(app)).toMatchObject({ balance: 0, unassigned: 0 });

    const put = await request(app).put('/api/savings/opening').send({ amount: 123456 }).expect(200);
    expect(put.body).toEqual({ amount: 123456, date: '2026-01-01' });
    expect(await getSavings(app)).toMatchObject({ balance: 123456, unassigned: 123456 });

    // Tracking starts earlier: the date moves, the amount does not, and nothing is invented.
    await request(app).put('/api/settings').send(settings('2025-10')).expect(200);
    expect((await request(app).get('/api/savings/opening').expect(200)).body).toEqual({
      amount: 123456,
      date: '2025-10-01',
    });
    expect(await getSavings(app)).toMatchObject({ balance: 123456, unassigned: 123456 });
    const [opening] = await allTransactions(app);
    expect(opening).toMatchObject({
      kind: 'opening',
      amount: 123456,
      date: '2025-10-01',
      goalId: null,
    });

    // ...and later (there is no fact before February, so it is allowed): again only the date moves.
    await request(app).put('/api/settings').send(settings('2026-02')).expect(200);
    expect((await request(app).get('/api/savings/opening').expect(200)).body).toEqual({
      amount: 123456,
      date: '2026-02-01',
    });

    // The UI asks for the balance on the new first day, and the amount is replaced, not added.
    const replaced = await request(app)
      .put('/api/savings/opening')
      .send({ amount: 99900 })
      .expect(200);
    expect(replaced.body).toEqual({ amount: 99900, date: '2026-02-01' });
    expect(await expectSavingsIdentities(app)).toMatchObject({ balance: 99900, unassigned: 99900 });
    expect(await allTransactions(app)).toHaveLength(1);
  });

  it('is part of the unassigned savings and of no goal, whatever else happens', async () => {
    const { app } = await setUpTwoClosedMonths();
    const goal = await addGoal(app);
    await settleOk(app, '2026-01', {
      amount: 265701,
      allocations: [{ goalId: goal.id, amount: 265701 }],
    });
    await request(app).put('/api/savings/opening').send({ amount: 70000 }).expect(200);
    const savings = await expectSavingsIdentities(app);
    expect(savings).toMatchObject({ balance: 70000 + 265701, unassigned: 70000 });
    expect(savings.goals[0]?.balance).toBe(265701);
    // Deleting the goal does not touch the opening balance either.
    await request(app).delete(`/api/goals/${goal.id}`).expect(204);
    expect((await request(app).get('/api/savings/opening').expect(200)).body.amount).toBe(70000);
  });
});
