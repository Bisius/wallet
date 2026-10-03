/**
 * What a transfer made through `POST /api/transfers` does to the numbers, read back through
 * `GET /api/months/:month` (docs/DOMAIN.md, "Transfers", "Unallocated" and invariant 8), and how
 * the rules about a budget's months and about `settings.startMonth` treat it.
 *
 * Today is 2026-03-15 and tracking started in 2026-01 with a salary of 3,000.00 and no
 * subscriptions. Groceries (400.00) and Fun (100.00) are not incremental, so March holds nothing
 * from earlier months: 3,000.00 comes in, 500.00 is allocated and 2,500.00 is unallocated.
 */
import type { BudgetDto, MonthBudgetLine, MonthView, SavingsDto } from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addBudget,
  addSpending,
  addTransfer,
  expectApiError,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { expectMonthIdentities } from '../../testing/month-identities';
import { budgetLine, getJson, monthView } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let groceries: BudgetDto;
let fun: BudgetDto;

beforeEach(async () => {
  ({ app } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 0 });
  groceries = await addBudget(app, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
    startMonth: '2026-01',
  });
  fun = await addBudget(app, {
    name: 'Fun',
    amount: 10000,
    incremental: false,
    startMonth: '2026-01',
  });
});

/** A month view that also satisfies every identity of the contract. */
async function checkedMonth(month: string): Promise<MonthView> {
  const view = await monthView(app, month);
  expectMonthIdentities(view);
  return view;
}

/** What a transfer changes on a budget line. */
const moved = (line: MonthBudgetLine) => ({
  transfersNet: line.transfersNet,
  available: line.available,
  remaining: line.remaining,
});

/** The figures of a month that a transfer can move, without the budget lines. */
const monthFigures = (view: MonthView) => ({
  totals: view.totals,
  unallocated: view.unallocated,
  overAllocated: view.overAllocated,
  savingsDue: view.savingsDue,
});

/** March before any transfer: 3,000.00 in, 500.00 allocated, 2,500.00 unallocated. */
const MARCH = {
  totals: { allocated: 50000, spent: 0, remaining: 50000, transfersNet: 0 },
  unallocated: 250000,
  overAllocated: false,
  savingsDue: { unallocated: 250000, budgetsSettled: 50000, reservesReleased: 0, total: 300000 },
};

describe('a transfer in the current month (2026-03)', () => {
  it('starts from the numbers the other tests build on', async () => {
    const view = await checkedMonth('2026-03');
    expect(monthFigures(view)).toEqual(MARCH);
    expect(moved(budgetLine(view, 'Groceries'))).toEqual({
      transfersNet: 0,
      available: 40000,
      remaining: 40000,
    });
    expect(moved(budgetLine(view, 'Fun'))).toEqual({
      transfersNet: 0,
      available: 10000,
      remaining: 10000,
    });
  });

  it('budget to budget: the two budgets move by the amount, the month does not', async () => {
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 2500,
    });
    const view = await checkedMonth('2026-03');
    expect(moved(budgetLine(view, 'Groceries'))).toEqual({
      transfersNet: -2500,
      available: 37500,
      remaining: 37500,
    });
    expect(moved(budgetLine(view, 'Fun'))).toEqual({
      transfersNet: 2500,
      available: 12500,
      remaining: 12500,
    });
    // Invariant 8: no field of the totals and not `unallocated` changes.
    expect(monthFigures(view)).toEqual(MARCH);
  });

  it('pool to budget: the budget goes up and the unallocated pool goes down', async () => {
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 4000,
    });
    const view = await checkedMonth('2026-03');
    expect(moved(budgetLine(view, 'Groceries'))).toEqual({
      transfersNet: 4000,
      available: 44000,
      remaining: 44000,
    });
    expect(moved(budgetLine(view, 'Fun'))).toEqual({
      transfersNet: 0,
      available: 10000,
      remaining: 10000,
    });
    expect(monthFigures(view)).toEqual({
      totals: { allocated: 50000, spent: 0, remaining: 54000, transfersNet: 4000 },
      unallocated: 246000,
      overAllocated: false,
      // 40.00 left the pool and sits in Groceries: the money due to savings is the same.
      savingsDue: {
        unallocated: 246000,
        budgetsSettled: 54000,
        reservesReleased: 0,
        total: 300000,
      },
    });
  });

  it('budget to pool: the budget goes down and the unallocated pool goes up', async () => {
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: fun.id,
      toBudgetId: null,
      amount: 1000,
    });
    const view = await checkedMonth('2026-03');
    expect(moved(budgetLine(view, 'Fun'))).toEqual({
      transfersNet: -1000,
      available: 9000,
      remaining: 9000,
    });
    expect(moved(budgetLine(view, 'Groceries'))).toEqual({
      transfersNet: 0,
      available: 40000,
      remaining: 40000,
    });
    expect(monthFigures(view)).toEqual({
      totals: { allocated: 50000, spent: 0, remaining: 49000, transfersNet: -1000 },
      unallocated: 251000,
      overAllocated: false,
      savingsDue: {
        unallocated: 251000,
        budgetsSettled: 49000,
        reservesReleased: 0,
        total: 300000,
      },
    });
  });

  it('every kind together: the transfers of a month add up per budget and in the totals', async () => {
    const date = '2026-03-10';
    await addTransfer(app, { date, fromBudgetId: groceries.id, toBudgetId: fun.id, amount: 2500 });
    await addTransfer(app, { date, fromBudgetId: null, toBudgetId: groceries.id, amount: 4000 });
    await addTransfer(app, { date, fromBudgetId: fun.id, toBudgetId: null, amount: 1000 });
    const view = await checkedMonth('2026-03');
    // Groceries: -25.00 out to Fun and +40.00 from the pool. Fun: +25.00 in and -10.00 to the pool.
    expect(moved(budgetLine(view, 'Groceries'))).toEqual({
      transfersNet: 1500,
      available: 41500,
      remaining: 41500,
    });
    expect(moved(budgetLine(view, 'Fun'))).toEqual({
      transfersNet: 1500,
      available: 11500,
      remaining: 11500,
    });
    // Only the pool legs reach the totals: +40.00 from the pool, -10.00 back to it.
    expect(monthFigures(view)).toEqual({
      totals: { allocated: 50000, spent: 0, remaining: 53000, transfersNet: 3000 },
      unallocated: 247000,
      overAllocated: false,
      savingsDue: {
        unallocated: 247000,
        budgetsSettled: 53000,
        reservesReleased: 0,
        total: 300000,
      },
    });
  });

  it('counts the month of the date: the last day is in March, the first of April is not', async () => {
    await addTransfer(app, {
      date: '2026-03-31',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 1000,
    });
    await addTransfer(app, {
      date: '2026-04-01',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 7000,
    });
    const march = await checkedMonth('2026-03');
    expect(march.totals.transfersNet).toBe(1000);
    expect(march.unallocated).toBe(249000);
    expect(budgetLine(march, 'Fun').transfersNet).toBe(0);

    // April is a projection: the budgets are not incremental, so nothing came over from March.
    const april = await checkedMonth('2026-04');
    expect(april.totals.transfersNet).toBe(7000);
    expect(april.unallocated).toBe(243000);
    expect(budgetLine(april, 'Fun')).toMatchObject({ transfersNet: 7000, available: 17000 });
    expect(budgetLine(april, 'Groceries')).toMatchObject({ transfersNet: 0, available: 40000 });
  });

  it('a transfer dated after today but in this month already counts in it', async () => {
    await addTransfer(app, {
      date: '2026-03-30',
      fromBudgetId: groceries.id,
      toBudgetId: null,
      amount: 5000,
    });
    const view = await checkedMonth('2026-03');
    expect(budgetLine(view, 'Groceries').available).toBe(35000);
    expect(view.unallocated).toBe(255000);
  });
});

describe('a transfer is never refused for lack of money', () => {
  it('a budget that holds less than the amount goes negative and is over budget', async () => {
    // Groceries holds 400.00, of which 300.00 are spent: 100.00 remain. Move 200.00 out of it.
    await addSpending(app, { budgetId: groceries.id, date: '2026-03-05', amount: 30000 });
    const before = budgetLine(await checkedMonth('2026-03'), 'Groceries');
    expect(before).toMatchObject({ remaining: 10000, usagePercent: 75, alert: 'ok' });

    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 20000,
    });
    const view = await checkedMonth('2026-03');
    expect(budgetLine(view, 'Groceries')).toMatchObject({
      transfersNet: -20000,
      available: 20000,
      spent: 30000,
      remaining: -10000,
      usagePercent: 150,
      alert: 'over',
      // Not incremental: the deficit is taken from savings.
      carriedOut: 0,
      toSavings: -10000,
    });
    expect(budgetLine(view, 'Fun')).toMatchObject({ available: 30000, remaining: 30000 });
    expect(view.totals).toEqual({
      allocated: 50000,
      spent: 30000,
      remaining: 20000,
      transfersNet: 0,
    });
    expect(view.unallocated).toBe(250000);
    expect(view.savingsDue.budgetsSettled).toBe(20000);
  });

  it('a budget moved empty into the pool has no usage figure and is over budget', async () => {
    // Fun holds 100.00; 150.00 go back to the pool.
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: fun.id,
      toBudgetId: null,
      amount: 15000,
    });
    const view = await checkedMonth('2026-03');
    expect(budgetLine(view, 'Fun')).toMatchObject({
      transfersNet: -15000,
      available: -5000,
      remaining: -5000,
      usagePercent: null,
      alert: 'over',
      toSavings: -5000,
    });
    expect(view.totals.transfersNet).toBe(-15000);
    expect(view.unallocated).toBe(265000);
    expect(view.overAllocated).toBe(false);
  });

  it('more than the pool holds leaves the month over-allocated', async () => {
    // The pool holds 2,500.00. Move 2,600.00 out of it into Fun.
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: null,
      toBudgetId: fun.id,
      amount: 260000,
    });
    const view = await checkedMonth('2026-03');
    expect(view.unallocated).toBe(-10000);
    expect(view.overAllocated).toBe(true);
    expect(view.totals.transfersNet).toBe(260000);
    expect(budgetLine(view, 'Fun')).toMatchObject({ available: 270000, remaining: 270000 });
    // The shortfall is taken from savings when the month closes.
    expect(view.savingsDue).toEqual({
      unallocated: -10000,
      budgetsSettled: 310000,
      reservesReleased: 0,
      total: 300000,
    });
  });

  it('a transfer that exactly empties the source is nothing special', async () => {
    await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: fun.id,
      toBudgetId: groceries.id,
      amount: 10000,
    });
    const view = await checkedMonth('2026-03');
    expect(budgetLine(view, 'Fun')).toMatchObject({ available: 0, remaining: 0, alert: 'ok' });
    expect(budgetLine(view, 'Groceries')).toMatchObject({ available: 50000, remaining: 50000 });
  });
});

describe('a transfer in a closed month', () => {
  let holiday: BudgetDto;
  beforeEach(async () => {
    // Incremental: what it does not spend carries into the next month. Jan and Feb hold 200.00 and
    // 400.00 of it at their ends, March starts with 400.00 and projects 600.00.
    holiday = await addBudget(app, {
      name: 'Holiday',
      amount: 20000,
      incremental: true,
      startMonth: '2026-01',
    });
  });

  it('rewrites that month and carries on through the incremental budget, not before it', async () => {
    const janBefore = await checkedMonth('2026-01');
    const febBefore = await checkedMonth('2026-02');
    const marchBefore = await checkedMonth('2026-03');
    expect(budgetLine(febBefore, 'Holiday')).toMatchObject({
      carriedIn: 20000,
      available: 40000,
      carriedOut: 40000,
    });
    expect(febBefore.unallocated).toBe(230000);
    expect(febBefore.savingsDue.total).toBe(280000);

    await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: holiday.id,
      amount: 5000,
    });

    // January is before the transfer: untouched, to the last field.
    expect(await checkedMonth('2026-01')).toEqual(janBefore);

    // February changes: Holiday gets 50.00 more, the pool 50.00 less, and the savings due follows.
    const feb = await checkedMonth('2026-02');
    expect(budgetLine(feb, 'Holiday')).toMatchObject({
      transfersNet: 5000,
      available: 45000,
      remaining: 45000,
      carriedOut: 45000,
      toSavings: 0,
    });
    expect(feb.totals.transfersNet).toBe(5000);
    expect(feb.unallocated).toBe(225000);
    expect(feb.savingsDue).toEqual({
      unallocated: 225000,
      budgetsSettled: 50000,
      reservesReleased: 0,
      total: 275000,
    });

    // March only sees it through the carry-over of Holiday.
    const march = await checkedMonth('2026-03');
    expect(budgetLine(march, 'Holiday')).toMatchObject({
      carriedIn: 45000,
      transfersNet: 0,
      available: 65000,
    });
    expect(budgetLine(marchBefore, 'Holiday')).toMatchObject({
      carriedIn: 40000,
      available: 60000,
    });
    expect(march.unallocated).toBe(marchBefore.unallocated);
    expect(march.savingsDue).toEqual(marchBefore.savingsDue);
    expect(budgetLine(march, 'Groceries')).toEqual(budgetLine(marchBefore, 'Groceries'));
  });

  it('changes the savings due of that month: it is outstanding for the new amount', async () => {
    await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: null,
      toBudgetId: holiday.id,
      amount: 5000,
    });
    const savings = await getJson<SavingsDto>(app, '/api/savings');
    expect(savings.outstanding.map((o) => [o.month, o.savingsDue, o.outstanding])).toEqual([
      ['2026-01', 280000, 280000],
      ['2026-02', 275000, 275000],
    ]);
  });

  it('between budgets in different modes it moves the amount from toSavings to carriedOut', async () => {
    // Groceries is settled to savings every month, Holiday is carried over (invariant 8).
    const before = await checkedMonth('2026-02');
    await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
      amount: 2500,
    });
    const after = await checkedMonth('2026-02');

    expect(budgetLine(after, 'Groceries')).toMatchObject({
      transfersNet: -2500,
      available: 37500,
      carriedOut: 0,
      toSavings: 37500,
    });
    expect(budgetLine(after, 'Holiday')).toMatchObject({
      transfersNet: 2500,
      available: 42500,
      carriedOut: 42500,
      toSavings: 0,
    });
    expect(after.totals.transfersNet).toBe(0);
    expect(after.unallocated).toBe(before.unallocated);
    expect(after.savingsDue.total).toBe(before.savingsDue.total - 2500);

    // What invariant 2 balances does not change: the 25.00 left the savings due and is held.
    const held = (view: MonthView) => view.budgets.reduce((sum, b) => sum + b.carriedOut, 0);
    expect(held(after) + after.savingsDue.total).toBe(held(before) + before.savingsDue.total);
  });
});

describe('deleting a transfer', () => {
  /** Every month the transfers below can touch, and the lists derived from them. */
  async function snapshot() {
    const views: MonthView[] = [];
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      views.push(await checkedMonth(month));
    }
    return {
      views,
      summaries: await getJson(app, '/api/months?from=2026-01&to=2026-06'),
      savings: await getJson(app, '/api/savings'),
      budgets: await getJson(app, '/api/budgets'),
    };
  }

  let holiday: BudgetDto;
  beforeEach(async () => {
    holiday = await addBudget(app, {
      name: 'Holiday',
      amount: 20000,
      incremental: true,
      startMonth: '2026-01',
    });
  });

  type Budgets = { groceries: BudgetDto; fun: BudgetDto; holiday: BudgetDto };
  const CASES: [string, (b: Budgets) => Parameters<typeof addTransfer>[1]][] = [
    [
      'budget to budget in the current month',
      (b) => ({
        date: '2026-03-10',
        fromBudgetId: b.groceries.id,
        toBudgetId: b.fun.id,
        amount: 2500,
      }),
    ],
    [
      'pool to an incremental budget in a closed month',
      (b) => ({ date: '2026-02-10', fromBudgetId: null, toBudgetId: b.holiday.id, amount: 5000 }),
    ],
    [
      'an incremental budget to the pool in the first month',
      (b) => ({ date: '2026-01-05', fromBudgetId: b.holiday.id, toBudgetId: null, amount: 1234 }),
    ],
    [
      'across modes in a future month',
      (b) => ({
        date: '2026-05-20',
        fromBudgetId: b.groceries.id,
        toBudgetId: b.holiday.id,
        amount: 7,
      }),
    ],
    [
      'more than the source holds',
      (b) => ({ date: '2026-03-02', fromBudgetId: null, toBudgetId: b.fun.id, amount: 900_000 }),
    ],
  ];

  it.each(CASES)('puts every month back to the cent: %s', async (_label, make) => {
    const before = await snapshot();
    const transfer = await addTransfer(app, make({ groceries, fun, holiday }));
    const during = await snapshot();
    expect(during).not.toEqual(before);

    await request(app).delete(`/api/transfers/${transfer.id}`).expect(204);
    expect(await snapshot()).toEqual(before);
  });

  it('only undoes the transfer it deletes', async () => {
    const keep = await addTransfer(app, {
      date: '2026-03-10',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 2500,
    });
    const afterKeep = await snapshot();
    const gone = await addTransfer(app, {
      date: '2026-03-12',
      fromBudgetId: null,
      toBudgetId: groceries.id,
      amount: 4000,
    });
    await request(app).delete(`/api/transfers/${gone.id}`).expect(204);
    expect(await snapshot()).toEqual(afterKeep);

    await request(app).delete(`/api/transfers/${keep.id}`).expect(204);
    const march = await checkedMonth('2026-03');
    expect(march.totals.transfersNet).toBe(0);
    expect(budgetLine(march, 'Groceries').transfersNet).toBe(0);
  });
});

describe('the rules about budgets and the start month see the transfers made through the API', () => {
  const patch = (budget: BudgetDto, payload: object) =>
    request(app).patch(`/api/budgets/${budget.id}`).send(payload);
  const archive = (budget: BudgetDto, endMonth: string) =>
    request(app).post(`/api/budgets/${budget.id}/archive`).send({ endMonth });

  describe('start_after_activity: a start month cannot move past the earliest transfer', () => {
    it.each([
      ['its source', 'groceries'],
      ['its destination', 'fun'],
    ])('a budget that is %s', async (_label, which) => {
      await addTransfer(app, {
        date: '2026-02-10',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
      });
      const budget = which === 'groceries' ? groceries : fun;
      expectRuleViolation(
        await patch(budget, { startMonth: '2026-03' }),
        'start_after_activity',
        'startMonth',
      );
      // The month of the transfer itself is still fine, and so is anything earlier.
      await patch(budget, { startMonth: '2026-02' }).expect(200);
      await patch(budget, { startMonth: '2026-01' }).expect(200);
    });

    it('a transfer from or to the pool counts for its budget only', async () => {
      await addTransfer(app, { date: '2026-02-10', fromBudgetId: null, toBudgetId: fun.id });
      expectRuleViolation(
        await patch(fun, { startMonth: '2026-03' }),
        'start_after_activity',
        'startMonth',
      );
      // Groceries has no transfer and no spending: it may start later.
      await patch(groceries, { startMonth: '2026-03' }).expect(200);
    });

    it('the earliest transfer decides, not the latest', async () => {
      await addTransfer(app, { date: '2026-05-10', fromBudgetId: null, toBudgetId: fun.id });
      await addTransfer(app, { date: '2026-04-10', fromBudgetId: fun.id, toBudgetId: null });
      expectRuleViolation(
        await patch(fun, { startMonth: '2026-05' }),
        'start_after_activity',
        'startMonth',
      );
      await patch(fun, { startMonth: '2026-04' }).expect(200);
    });
  });

  describe('end_before_activity: an end month cannot move before the latest transfer', () => {
    it.each([
      ['its source', 'groceries'],
      ['its destination', 'fun'],
    ])('a budget that is %s', async (_label, which) => {
      await addTransfer(app, {
        date: '2026-04-05',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
      });
      const budget = which === 'groceries' ? groceries : fun;
      expectRuleViolation(await archive(budget, '2026-03'), 'end_before_activity', 'endMonth');
      // The month of the transfer itself is fine: the budget is still active in it.
      await archive(budget, '2026-04').expect(200);
    });

    it('a transfer to the pool counts for its budget only', async () => {
      await addTransfer(app, { date: '2026-03-20', fromBudgetId: groceries.id, toBudgetId: null });
      expectRuleViolation(await archive(groceries, '2026-02'), 'end_before_activity', 'endMonth');
      await archive(fun, '2026-02').expect(200);
    });
  });

  describe('has_history: a budget with a transfer can only be archived', () => {
    it('refuses to delete either budget, and the budget list says why', async () => {
      const transfer = await addTransfer(app, {
        date: '2026-03-10',
        fromBudgetId: groceries.id,
        toBudgetId: fun.id,
      });
      expectApiError(await request(app).delete(`/api/budgets/${groceries.id}`), 'has_history');
      expectApiError(await request(app).delete(`/api/budgets/${fun.id}`), 'has_history');
      const budgets = await getJson<BudgetDto[]>(app, '/api/budgets');
      expect(budgets.map((b) => [b.name, b.hasHistory])).toEqual([
        ['Groceries', true],
        ['Fun', true],
      ]);

      // Deleting the transfer gives the history back.
      await request(app).delete(`/api/transfers/${transfer.id}`).expect(204);
      expect((await getJson<BudgetDto[]>(app, '/api/budgets')).map((b) => b.hasHistory)).toEqual([
        false,
        false,
      ]);
      await request(app).delete(`/api/budgets/${groceries.id}`).expect(204);
      await request(app).delete(`/api/budgets/${fun.id}`).expect(204);
    });

    it('a pool transfer is history for its budget only', async () => {
      await addTransfer(app, { date: '2026-03-10', fromBudgetId: null, toBudgetId: fun.id });
      expectApiError(await request(app).delete(`/api/budgets/${fun.id}`), 'has_history');
      await request(app).delete(`/api/budgets/${groceries.id}`).expect(204);
    });
  });

  describe('start_month_after_facts: settings.startMonth cannot move past a transfer', () => {
    // The budgets a transfer needs start in the month of the transfer at the latest, so a budget
    // blocks the move as early as the transfer does: this checks the refusal and its boundary.
    it('refuses a later start month, and accepts the month of the transfer', async () => {
      const { app: fresh } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
      await onboard(fresh, { startMonth: '2026-01', salary: 300000, openingSavings: 0 });
      await request(fresh).delete('/api/salary/2026-01').expect(204);
      const a = await addBudget(fresh, { name: 'A', startMonth: '2026-02' });
      const b = await addBudget(fresh, { name: 'B', startMonth: '2026-02' });
      await addTransfer(fresh, { date: '2026-02-10', fromBudgetId: a.id, toBudgetId: b.id });

      const settings = (startMonth: string) =>
        request(fresh).put('/api/settings').send({
          currency: 'EUR',
          locale: 'en-US',
          startMonth,
          theme: 'system',
          alertWarnPercent: 80,
        });
      expectRuleViolation(await settings('2026-03'), 'start_month_after_facts', 'startMonth');
      expect((await getJson<{ startMonth: string }>(fresh, '/api/settings')).startMonth).toBe(
        '2026-01',
      );
      await settings('2026-02').expect(200);
    });
  });

  it('the changes the rules allow never leave a transfer uncounted', async () => {
    // A transfer in February, then each budget is narrowed to exactly February.
    await addTransfer(app, {
      date: '2026-02-10',
      fromBudgetId: groceries.id,
      toBudgetId: fun.id,
      amount: 2500,
    });
    await patch(fun, { startMonth: '2026-02' }).expect(200);
    await archive(groceries, '2026-02').expect(200);

    const feb = await checkedMonth('2026-02');
    expect(budgetLine(feb, 'Groceries')).toMatchObject({ transfersNet: -2500, available: 37500 });
    expect(budgetLine(feb, 'Fun')).toMatchObject({ transfersNet: 2500, available: 12500 });
    expect(feb.totals.transfersNet).toBe(0);
    expect(feb.unallocated).toBe(250000);
  });
});
