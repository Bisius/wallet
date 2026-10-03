/**
 * Multi-month scenarios through the real API: set up salary, budgets and subscriptions, add
 * spendings, move the clock forward, and assert the figures of `GET /api/months/:month` and
 * `GET /api/months` to the cent. Every expected number is worked out by hand in the comments.
 *
 * Each scenario also runs `expectApiMatchesOracle`: on every month it checks the identities of the
 * contract and an independent oracle (testing/ledger-oracle.ts) built from the facts as read back
 * through the Phase 1 endpoints, so what is asserted by hand is also cross-checked by conservation
 * of money.
 */
import type {
  BudgetAlert,
  BudgetDto,
  MonthBudgetLine,
  MonthSubscriptionLine,
  MonthSummary,
  MonthView,
} from '@wallet/shared';
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
import { expectApiMatchesOracle } from '../../testing/scenario';
import { createTestApp } from '../../testing/test-app';

// -------------------------------------------------------------------------------------------------
// Compact builders for the expected figures. Every derived number is passed in explicitly.
// -------------------------------------------------------------------------------------------------

/**
 * One expected budget line. The figures are written as a table, in the order the month view lists
 * them: [carriedIn, allocated, available, spent, remaining], usagePercent, alert,
 * [carriedOut, toSavings]. Every derived figure is typed in by hand, not computed here.
 */
const budgetLine = (
  id: number,
  name: string,
  [carriedIn, allocated, available, spent, remaining]: [number, number, number, number, number],
  usagePercent: number | null,
  alert: BudgetAlert,
  [carriedOut, toSavings]: [number, number],
  flags: Partial<MonthBudgetLine> = {},
): MonthBudgetLine => ({
  id,
  name,
  color: null,
  icon: null,
  incremental: false,
  endsThisMonth: false,
  carriedIn,
  allocated,
  transfersNet: 0,
  available,
  spent,
  remaining,
  usagePercent,
  warnPercent: 80,
  alert,
  carriedOut,
  toSavings,
  ...flags,
});

const monthly = (
  id: number,
  name: string,
  price: number,
  extra: Partial<MonthSubscriptionLine> = {},
) =>
  ({
    id,
    name,
    color: null,
    frequency: 'monthly',
    price,
    charge: price,
    reserveBalance: 0,
    renewalThisMonth: false,
    nextRenewalMonth: null,
    nextRenewalPrice: null,
    reserveReleased: 0,
    endsThisMonth: false,
    ...extra,
  }) satisfies MonthSubscriptionLine;

const yearly = (
  id: number,
  name: string,
  line: Pick<
    MonthSubscriptionLine,
    'price' | 'charge' | 'reserveBalance' | 'nextRenewalMonth' | 'nextRenewalPrice'
  > &
    Partial<MonthSubscriptionLine>,
): MonthSubscriptionLine => ({
  id,
  name,
  color: null,
  frequency: 'yearly',
  renewalThisMonth: false,
  reserveReleased: 0,
  endsThisMonth: false,
  ...line,
});

interface ViewInput {
  month: string;
  status: MonthView['status'];
  salary: number;
  extra?: number;
  fixedCosts: number;
  subscriptions: MonthSubscriptionLine[];
  budgets: MonthBudgetLine[];
  totals: MonthView['totals'];
  unallocated: number;
  budgetsSettled: number;
}

const view = (v: ViewInput): MonthView => ({
  month: v.month,
  status: v.status,
  income: { salary: v.salary, extra: v.extra ?? 0, total: v.salary + (v.extra ?? 0) },
  fixedCosts: v.fixedCosts,
  subscriptions: v.subscriptions,
  budgets: v.budgets,
  totals: v.totals,
  unallocated: v.unallocated,
  overAllocated: v.unallocated < 0,
  savingsDue: {
    unallocated: v.unallocated,
    budgetsSettled: v.budgetsSettled,
    reservesReleased: 0,
    total: v.unallocated + v.budgetsSettled,
  },
});

const summaryOf = (v: MonthView): MonthSummary => ({
  month: v.month,
  status: v.status,
  income: v.income.total,
  fixedCosts: v.fixedCosts,
  allocated: v.totals.allocated,
  spent: v.totals.spent,
  unallocated: v.unallocated,
  savingsDue: v.savingsDue.total,
});

// -------------------------------------------------------------------------------------------------
// Scenario 1: a household from July to December
// -------------------------------------------------------------------------------------------------

describe('scenario: a household from July to December 2026', () => {
  async function setUp() {
    const clock = mutableClock('2026-07-05T10:00:00Z');
    const { app, db } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;

    // --- July: onboarding, subscriptions, the first spendings ---------------------------------
    const done = await onboard(app, {
      startMonth: '2026-07',
      salary: 250000,
      openingSavings: 100000,
      budgets: [
        { name: 'Groceries', amount: 40000, incremental: false },
        { name: 'Holiday', amount: 15000, incremental: true },
      ],
    });
    const [groceries, holiday] = done.budgets as [BudgetDto, BudgetDto];
    const netflix = await addSubscription(app, {
      name: 'Netflix',
      amount: 1299,
      anchorDate: '2026-07-15',
    });
    const cloud = await addSubscription(app, {
      name: 'Cloud',
      frequency: 'yearly',
      amount: 10000,
      anchorDate: '2025-06-30',
    });
    await addSpending(app, { budgetId: groceries.id, date: '2026-07-03', amount: 8450 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-07-09', amount: 12075 });
    await addSpending(app, { budgetId: holiday.id, date: '2026-07-08', amount: 5000 });

    // --- August: an overspend-free month with a refund and a bonus -----------------------------
    clock.set('2026-08-15T10:00:00Z');
    await addSpending(app, { budgetId: groceries.id, date: '2026-08-01', amount: 41000 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-08-02', amount: -2500 }); // refund
    await addSpending(app, { budgetId: holiday.id, date: '2026-08-01', amount: 7000 });
    await addIncome(app, { date: '2026-08-14', amount: 50000, description: 'Bonus' });

    // --- September: a raise, a new budget that overspends on its first day ----------------------
    clock.set('2026-09-03T10:00:00Z');
    await request(app).put('/api/salary/2026-09').send({ amount: 260000 }).expect(200);
    const fun = await addBudget(app, { name: 'Fun', amount: 5000, incremental: false });
    expect(fun.startMonth).toBe('2026-09');
    await addSpending(app, { budgetId: groceries.id, date: '2026-09-02', amount: 30000 });
    await addSpending(app, { budgetId: fun.id, date: '2026-09-02', amount: 6500 });

    // --- October: Netflix gets dearer, Holiday is archived -----------------------------------
    clock.set('2026-10-12T10:00:00Z');
    await request(app)
      .put(`/api/subscriptions/${netflix.id}/prices/2026-10`)
      .send({ amount: 1399 })
      .expect(200);
    await addSpending(app, { budgetId: groceries.id, date: '2026-10-05', amount: 15000 });
    await addSpending(app, { budgetId: holiday.id, date: '2026-10-06', amount: 2000 });
    await request(app).post(`/api/budgets/${holiday.id}/archive`).send({}).expect(200);

    return { app, db, clock, get, groceries, holiday, fun, netflix, cloud };
  }

  // The figures of each month, by hand (see the arithmetic next to each).
  const cloudLine = (charge: number, reserveBalance: number) =>
    yearly(2, 'Cloud', {
      price: 10000,
      charge,
      reserveBalance,
      nextRenewalMonth: '2027-06',
      nextRenewalPrice: 10000,
    });

  // Cloud: 100.00 a year renewing in June, started in July: 12 months to go, so 8.34 four times
  // (July to October) and then 8.33 eight times (November to June).
  const expected = (): MonthView[] => [
    // July. Income 2500.00. Fixed: Netflix 12.99 + Cloud 8.34 = 21.33.
    // Groceries: 400.00 - 205.25 spent = 194.75 settles. Holiday: 150.00 - 50.00 = 100.00 carried.
    // Unallocated: 2500.00 - 21.33 - (400.00 + 150.00) = 1928.67. Savings due: 1928.67 + 194.75.
    view({
      month: '2026-07',
      status: 'closed',
      salary: 250000,
      fixedCosts: 2133,
      subscriptions: [cloudLine(834, 834), monthly(1, 'Netflix', 1299)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 20525, 19475], 51, 'ok', [0, 19475]),
        budgetLine(2, 'Holiday', [0, 15000, 15000, 5000, 10000], 33, 'ok', [10000, 0], {
          incremental: true,
        }),
      ],
      totals: { allocated: 55000, spent: 25525, remaining: 29475, transfersNet: 0 },
      unallocated: 192867,
      budgetsSettled: 19475,
    }),
    // August. Income 2500.00 + 500.00 bonus. Groceries: 410.00 - 25.00 refund = 385.00 spent of
    // 400.00: 96%, a warning, 15.00 settles. Holiday: 100.00 carried in + 150.00 - 70.00 = 180.00 carried.
    // Unallocated: 3000.00 - 21.33 - 550.00 = 2428.67.
    view({
      month: '2026-08',
      status: 'closed',
      salary: 250000,
      extra: 50000,
      fixedCosts: 2133,
      subscriptions: [cloudLine(834, 1668), monthly(1, 'Netflix', 1299)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 38500, 1500], 96, 'warning', [0, 1500]),
        budgetLine(2, 'Holiday', [10000, 15000, 25000, 7000, 18000], 28, 'ok', [18000, 0], {
          incremental: true,
        }),
      ],
      totals: { allocated: 55000, spent: 45500, remaining: 19500, transfersNet: 0 },
      unallocated: 242867,
      budgetsSettled: 1500,
    }),
    // September. Salary 2600.00. Fun (new, 50.00) overspends by 15.00, taken from savings.
    // Groceries: 400.00 - 300.00 = 100.00 settles (75%, no warning). Holiday: 180.00 + 150.00 = 330.00 carried.
    // Unallocated: 2600.00 - 21.33 - (400.00 + 150.00 + 50.00) = 1978.67. Settled: 100.00 + 0 - 15.00.
    view({
      month: '2026-09',
      status: 'closed',
      salary: 260000,
      fixedCosts: 2133,
      subscriptions: [cloudLine(834, 2502), monthly(1, 'Netflix', 1299)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 30000, 10000], 75, 'ok', [0, 10000]),
        budgetLine(2, 'Holiday', [18000, 15000, 33000, 0, 33000], 0, 'ok', [33000, 0], {
          incremental: true,
        }),
        budgetLine(3, 'Fun', [0, 5000, 5000, 6500, -1500], 130, 'over', [0, -1500]),
      ],
      totals: { allocated: 60000, spent: 36500, remaining: 41500, transfersNet: 0 },
      unallocated: 197867,
      budgetsSettled: 8500,
    }),
    // October, the current month. Netflix is 13.99, so fixed costs are 13.99 + 8.34 = 22.33.
    // Holiday is archived with endMonth = October: it ends this month, so its whole balance
    // (330.00 carried in + 150.00 - 20.00 = 460.00) is projected to move to savings.
    // Groceries 400.00 - 150.00 = 250.00 and Fun 50.00 are projected to settle as well.
    view({
      month: '2026-10',
      status: 'current',
      salary: 260000,
      fixedCosts: 2233,
      subscriptions: [cloudLine(834, 3336), monthly(1, 'Netflix', 1399)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 15000, 25000], 37, 'ok', [0, 25000]),
        budgetLine(2, 'Holiday', [33000, 15000, 48000, 2000, 46000], 4, 'ok', [0, 46000], {
          incremental: true,
          endsThisMonth: true,
        }),
        budgetLine(3, 'Fun', [0, 5000, 5000, 0, 5000], 0, 'ok', [0, 5000]),
      ],
      totals: { allocated: 60000, spent: 17000, remaining: 76000, transfersNet: 0 },
      unallocated: 197767,
      budgetsSettled: 76000,
    }),
    // November, a projection: Holiday is gone, Cloud's contribution drops to 8.33.
    // Unallocated: 2600.00 - (13.99 + 8.33) - (400.00 + 50.00) = 2127.68.
    view({
      month: '2026-11',
      status: 'future',
      salary: 260000,
      fixedCosts: 2232,
      subscriptions: [cloudLine(833, 4169), monthly(1, 'Netflix', 1399)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 0, 40000], 0, 'ok', [0, 40000]),
        budgetLine(3, 'Fun', [0, 5000, 5000, 0, 5000], 0, 'ok', [0, 5000]),
      ],
      totals: { allocated: 45000, spent: 0, remaining: 45000, transfersNet: 0 },
      unallocated: 212768,
      budgetsSettled: 45000,
    }),
    view({
      month: '2026-12',
      status: 'future',
      salary: 260000,
      fixedCosts: 2232,
      subscriptions: [cloudLine(833, 5002), monthly(1, 'Netflix', 1399)],
      budgets: [
        budgetLine(1, 'Groceries', [0, 40000, 40000, 0, 40000], 0, 'ok', [0, 40000]),
        budgetLine(3, 'Fun', [0, 5000, 5000, 0, 5000], 0, 'ok', [0, 5000]),
      ],
      totals: { allocated: 45000, spent: 0, remaining: 45000, transfersNet: 0 },
      unallocated: 212768,
      budgetsSettled: 45000,
    }),
  ];

  it('reports every month to the cent: closed, current and projected', async () => {
    const { get } = await setUp();
    const months = expected();
    for (const month of months) {
      expect(await get<MonthView>(`/api/months/${month.month}`)).toEqual(month);
    }
  });

  it('lists the same figures as compact rows, 15 months by default (start month to current + 11)', async () => {
    const { get } = await setUp();
    const rows = await get<MonthSummary[]>('/api/months');
    expect(rows).toHaveLength(15);
    expect(rows[0]?.month).toBe('2026-07');
    expect(rows.at(-1)?.month).toBe('2027-09');
    expect(rows.slice(0, 6)).toEqual(expected().map(summaryOf));
    expect(rows.map((r) => r.status)).toEqual([
      'closed',
      'closed',
      'closed',
      'current',
      ...Array(11).fill('future'),
    ]);
    // December is the same projection as November (rows[4]).
    expect(rows[5]).toEqual({ ...rows[4], month: '2026-12' });
    // Cloud contributes 8.33 from November to its renewal in June 2027, then 8.34 (a new cycle
    // starts in July 2027), so with Netflix at 13.99 the fixed costs and the savings due are:
    expect(rows.slice(4, 12).map((r) => [r.fixedCosts, r.savingsDue])).toEqual(
      Array(8).fill([2232, 257768]),
    );
    expect(rows.slice(12).map((r) => [r.month, r.fixedCosts, r.savingsDue])).toEqual([
      ['2027-07', 2233, 257767],
      ['2027-08', 2233, 257767],
      ['2027-09', 2233, 257767],
    ]);
  });

  it('agrees with the identities and the independent oracle on every month, the future ones included', async () => {
    const { app } = await setUp();
    const { views } = await expectApiMatchesOracle(app, { from: '2026-07', to: '2027-09' });
    expect(views).toHaveLength(15);
    expect(views.at(-1)?.month).toBe('2027-09'); // past Cloud's renewal in June 2027
  });

  it('moving the clock to November turns October into a closed month and changes nothing but the labels', async () => {
    const { get, clock } = await setUp();
    const before = expected();
    clock.set('2026-11-02T08:00:00Z');
    const october = await get<MonthView>('/api/months/2026-10');
    expect(october).toEqual({ ...before[3], status: 'closed' });
    const november = await get<MonthView>('/api/months/2026-11');
    expect(november).toEqual({ ...before[4], status: 'current' });
    expect((await get<MonthSummary[]>('/api/months')).slice(0, 5).map((r) => r.status)).toEqual([
      'closed',
      'closed',
      'closed',
      'closed',
      'current',
    ]);
    // The default window moved with the clock: current month + 11 is now 2027-10.
    expect((await get<MonthSummary[]>('/api/months')).at(-1)?.month).toBe('2027-10');
  });

  it("a late edit to a closed month changes that month's savings due, and only that one", async () => {
    const { get, app, groceries } = await setUp();
    // A 40.00 grocery shop from 20 August that was forgotten. August: 425.00 spent of 400.00.
    await addSpending(app, { budgetId: groceries.id, date: '2026-08-20', amount: 4000 });

    const august = await get<MonthView>('/api/months/2026-08');
    expect(august.status).toBe('closed');
    expect(august.budgets[0]).toMatchObject({
      name: 'Groceries',
      spent: 42500,
      remaining: -2500,
      usagePercent: 106,
      alert: 'over',
      toSavings: -2500, // taken from savings
    });
    expect(august.totals).toEqual({
      allocated: 55000,
      spent: 49500,
      remaining: 15500,
      transfersNet: 0,
    });
    expect(august.savingsDue).toEqual({
      unallocated: 242867,
      budgetsSettled: -2500,
      reservesReleased: 0,
      total: 240367, // was 244367: exactly 40.00 less
    });
    const others = expected();
    for (const month of ['2026-07', '2026-09', '2026-10', '2026-11']) {
      expect(await get<MonthView>(`/api/months/${month}`)).toEqual(
        others.find((m) => m.month === month),
      );
    }
    await expectApiMatchesOracle(app, { from: '2026-07', to: '2027-03' });
  });
});

// -------------------------------------------------------------------------------------------------
// Scenario 2: lifecycles: a mode switch, an archived budget, a cancelled subscription, a month
// that is planned beyond the income, and a yearly renewal
// -------------------------------------------------------------------------------------------------

describe('scenario: lifecycles from January to July 2026', () => {
  async function setUp() {
    const clock = mutableClock('2026-01-20T10:00:00Z');
    const { app, db } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;

    // --- January ---------------------------------------------------------------------------
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 100000,
      openingSavings: 0,
      budgets: [
        { name: 'Food', amount: 30000, incremental: true },
        { name: 'Fun', amount: 20000, incremental: true },
      ],
    });
    const [food, fun] = done.budgets as [BudgetDto, BudgetDto];
    const gym = await addSubscription(app, { name: 'Gym', amount: 3000, anchorDate: '2026-01-05' });
    const insurance = await addSubscription(app, {
      name: 'Insurance',
      frequency: 'yearly',
      amount: 24000,
      anchorDate: '2025-04-10',
    });
    await addSpending(app, { budgetId: food.id, date: '2026-01-10', amount: 25000 });
    await addSpending(app, { budgetId: fun.id, date: '2026-01-12', amount: 5000 });

    // --- February: Food overspends, a raise is planned for March ---------------------------------
    clock.set('2026-02-10T10:00:00Z');
    await addSpending(app, { budgetId: food.id, date: '2026-02-03', amount: 40000 });
    await addSpending(app, { budgetId: fun.id, date: '2026-02-04', amount: 25000 });
    await request(app).put('/api/salary/2026-03').send({ amount: 120000 }).expect(200);

    // --- March: Food stops carrying over; a new budget over-allocates the month ------------------
    clock.set('2026-03-12T10:00:00Z');
    await request(app)
      .put(`/api/budgets/${food.id}/versions/2026-03`)
      .send({ amount: 30000, incremental: false })
      .expect(200);
    const splurge = await addBudget(app, { name: 'Splurge', amount: 70000, incremental: false });
    await addSpending(app, { budgetId: food.id, date: '2026-03-05', amount: 10000 });
    await addSpending(app, { budgetId: splurge.id, date: '2026-03-06', amount: 60000 });

    // --- April: the allocation of Splurge is cut; the yearly insurance renews ------------------
    clock.set('2026-04-09T10:00:00Z');
    await request(app)
      .put(`/api/budgets/${splurge.id}/versions/2026-04`)
      .send({ amount: 40000, incremental: false })
      .expect(200);
    await addSpending(app, { budgetId: fun.id, date: '2026-04-02', amount: 18000 });
    await addSpending(app, { budgetId: splurge.id, date: '2026-04-03', amount: 45000 });

    // --- May: the last month of Gym and of Fun -----------------------------------------------
    clock.set('2026-05-10T10:00:00Z');
    await addSpending(app, { budgetId: food.id, date: '2026-05-04', amount: 12000 });
    await addSpending(app, { budgetId: fun.id, date: '2026-05-06', amount: 3000 });
    await request(app)
      .post(`/api/subscriptions/${gym.id}/cancel`)
      .send({ endMonth: '2026-05' })
      .expect(200);
    await request(app)
      .post(`/api/budgets/${fun.id}/archive`)
      .send({ endMonth: '2026-05' })
      .expect(200);

    // --- June: the month to look back from -----------------------------------------------------
    clock.set('2026-06-15T10:00:00Z');
    return { app, db, clock, get, food, fun, splurge, gym, insurance };
  }

  const insurance = (
    charge: number,
    reserveBalance: number,
    extra: Partial<MonthSubscriptionLine> = {},
  ) =>
    yearly(2, 'Insurance', {
      price: 24000,
      charge,
      reserveBalance,
      nextRenewalMonth: '2026-04',
      nextRenewalPrice: 24000,
      ...extra,
    });

  const expected = (): MonthView[] => [
    // January. Fixed: Gym 30.00 + Insurance 60.00 (24000 over Jan to Apr, 4 months) = 90.00.
    // Food (incremental): 300.00 - 250.00 = 50.00 carried, 83%: a warning. Fun: 200.00 - 50.00 = 150.00 carried.
    // Unallocated: 1000.00 - 90.00 - 500.00 = 410.00. Nothing is settled: both budgets carry.
    view({
      month: '2026-01',
      status: 'closed',
      salary: 100000,
      fixedCosts: 9000,
      subscriptions: [monthly(1, 'Gym', 3000), insurance(6000, 6000)],
      budgets: [
        budgetLine(1, 'Food', [0, 30000, 30000, 25000, 5000], 83, 'warning', [5000, 0], {
          incremental: true,
        }),
        budgetLine(2, 'Fun', [0, 20000, 20000, 5000, 15000], 25, 'ok', [15000, 0], {
          incremental: true,
        }),
      ],
      totals: { allocated: 50000, spent: 30000, remaining: 20000, transfersNet: 0 },
      unallocated: 41000,
      budgetsSettled: 0,
    }),
    // February. Food: 50.00 + 300.00 = 350.00 available, 400.00 spent: -50.00 carried (114%, over).
    // Fun: 150.00 + 200.00 = 350.00, 250.00 spent: 100.00 carried (71%).
    view({
      month: '2026-02',
      status: 'closed',
      salary: 100000,
      fixedCosts: 9000,
      subscriptions: [monthly(1, 'Gym', 3000), insurance(6000, 12000)],
      budgets: [
        budgetLine(1, 'Food', [5000, 30000, 35000, 40000, -5000], 114, 'over', [-5000, 0], {
          incremental: true,
        }),
        budgetLine(2, 'Fun', [15000, 20000, 35000, 25000, 10000], 71, 'ok', [10000, 0], {
          incremental: true,
        }),
      ],
      totals: { allocated: 50000, spent: 65000, remaining: 5000, transfersNet: 0 },
      unallocated: 41000,
      budgetsSettled: 0,
    }),
    // March. Salary 1200.00. Food is NOT incremental from now on, so the -50.00 it carried is
    // settled in this month: 300.00 - 50.00 = 250.00 available, 100.00 spent, 150.00 settles.
    // Fun keeps carrying: 100.00 + 200.00 = 300.00. Splurge (700.00) spends 600.00: 100.00 settles (85%: a warning).
    // Over-allocated: 1200.00 - 90.00 - (300.00 + 200.00 + 700.00) = -90.00.
    // Savings due: -90.00 + 150.00 + 0 + 100.00 = 160.00.
    view({
      month: '2026-03',
      status: 'closed',
      salary: 120000,
      fixedCosts: 9000,
      subscriptions: [monthly(1, 'Gym', 3000), insurance(6000, 18000)],
      budgets: [
        budgetLine(1, 'Food', [-5000, 30000, 25000, 10000, 15000], 40, 'ok', [0, 15000]),
        budgetLine(2, 'Fun', [10000, 20000, 30000, 0, 30000], 0, 'ok', [30000, 0], {
          incremental: true,
        }),
        budgetLine(3, 'Splurge', [0, 70000, 70000, 60000, 10000], 85, 'warning', [0, 10000]),
      ],
      totals: { allocated: 120000, spent: 70000, remaining: 55000, transfersNet: 0 },
      unallocated: -9000,
      budgetsSettled: 25000,
    }),
    // April. Insurance renews: its last 60.00 tops the reserve up to 240.00, which is paid out,
    // leaving 0. Splurge is cut to 400.00 and spends 450.00: -50.00 taken from savings (112%).
    // Fun: 300.00 + 200.00 = 500.00, 180.00 spent: 320.00 carried.
    // Unallocated: 1200.00 - 90.00 - (300.00 + 200.00 + 400.00) = 210.00.
    view({
      month: '2026-04',
      status: 'closed',
      salary: 120000,
      fixedCosts: 9000,
      subscriptions: [monthly(1, 'Gym', 3000), insurance(6000, 0, { renewalThisMonth: true })],
      budgets: [
        budgetLine(1, 'Food', [0, 30000, 30000, 0, 30000], 0, 'ok', [0, 30000]),
        budgetLine(2, 'Fun', [30000, 20000, 50000, 18000, 32000], 36, 'ok', [32000, 0], {
          incremental: true,
        }),
        budgetLine(3, 'Splurge', [0, 40000, 40000, 45000, -5000], 112, 'over', [0, -5000]),
      ],
      totals: { allocated: 90000, spent: 63000, remaining: 57000, transfersNet: 0 },
      unallocated: 21000,
      budgetsSettled: 25000,
    }),
    // May. Gym and Fun both end this month. Insurance starts a new cycle: 240.00 over May to April
    // (12 months) = 20.00. Fun settles everything it holds: 320.00 + 200.00 - 30.00 = 490.00.
    // Fixed: Gym 30.00 + 20.00 = 50.00. Unallocated: 1200.00 - 50.00 - 900.00 = 250.00.
    view({
      month: '2026-05',
      status: 'closed',
      salary: 120000,
      fixedCosts: 5000,
      subscriptions: [
        monthly(1, 'Gym', 3000, { endsThisMonth: true }),
        insurance(2000, 2000, { nextRenewalMonth: '2027-04' }),
      ],
      budgets: [
        budgetLine(1, 'Food', [0, 30000, 30000, 12000, 18000], 40, 'ok', [0, 18000]),
        budgetLine(2, 'Fun', [32000, 20000, 52000, 3000, 49000], 5, 'ok', [0, 49000], {
          incremental: true,
          endsThisMonth: true,
        }),
        budgetLine(3, 'Splurge', [0, 40000, 40000, 0, 40000], 0, 'ok', [0, 40000]),
      ],
      totals: { allocated: 90000, spent: 15000, remaining: 107000, transfersNet: 0 },
      unallocated: 25000,
      budgetsSettled: 107000,
    }),
    // June, the current month: Gym and Fun are gone.
    view({
      month: '2026-06',
      status: 'current',
      salary: 120000,
      fixedCosts: 2000,
      subscriptions: [insurance(2000, 4000, { nextRenewalMonth: '2027-04' })],
      budgets: [
        budgetLine(1, 'Food', [0, 30000, 30000, 0, 30000], 0, 'ok', [0, 30000]),
        budgetLine(3, 'Splurge', [0, 40000, 40000, 0, 40000], 0, 'ok', [0, 40000]),
      ],
      totals: { allocated: 70000, spent: 0, remaining: 70000, transfersNet: 0 },
      unallocated: 48000,
      budgetsSettled: 70000,
    }),
  ];

  it('reports the carry, the mode switch, the over-allocated month, the renewal and the archive to the cent', async () => {
    const { get } = await setUp();
    for (const month of expected()) {
      expect(await get<MonthView>(`/api/months/${month.month}`)).toEqual(month);
    }
    expect((await get<MonthView>('/api/months/2026-03')).overAllocated).toBe(true);
  });

  it('flags only March as over-allocated, and its savings due is the unallocated shortfall plus what settles', async () => {
    const { get } = await setUp();
    const rows = await get<MonthSummary[]>('/api/months?from=2026-01&to=2026-07');
    expect(rows.map((r) => [r.month, r.unallocated, r.savingsDue])).toEqual([
      ['2026-01', 41000, 41000],
      ['2026-02', 41000, 41000],
      ['2026-03', -9000, 16000],
      ['2026-04', 21000, 46000],
      ['2026-05', 25000, 132000],
      ['2026-06', 48000, 118000],
      ['2026-07', 48000, 118000],
    ]);
  });

  it('agrees with the identities and the independent oracle on every month', async () => {
    const { app } = await setUp();
    const { views } = await expectApiMatchesOracle(app, { from: '2026-01', to: '2027-06' });
    expect(views).toHaveLength(18);
  });

  it('a forgotten March shop on the Food budget changes March only', async () => {
    const { app, get, food } = await setUp();
    await addSpending(app, { budgetId: food.id, date: '2026-03-20', amount: 8000 });
    const march = await get<MonthView>('/api/months/2026-03');
    expect(march.budgets[0]).toMatchObject({ spent: 18000, remaining: 7000, toSavings: 7000 });
    expect(march.savingsDue.total).toBe(8000); // was 16000
    expect(await get<MonthView>('/api/months/2026-02')).toEqual(expected()[1]);
    expect(await get<MonthView>('/api/months/2026-04')).toEqual(expected()[3]);
  });

  it('a late spending on the carrying Fun budget moves to the month it settles', async () => {
    const { app, get, fun } = await setUp();
    // 30.00 forgotten in January: Fun carries 30.00 less from then on, all the way to its last month.
    await addSpending(app, { budgetId: fun.id, date: '2026-01-25', amount: 3000 });
    const january = await get<MonthView>('/api/months/2026-01');
    expect(january.budgets[1]).toMatchObject({ remaining: 12000, carriedOut: 12000, toSavings: 0 });
    expect(january.savingsDue.total).toBe(41000); // unchanged: nothing of Fun settles in January
    const may = await get<MonthView>('/api/months/2026-05');
    expect(may.budgets[1]).toMatchObject({ carriedIn: 29000, remaining: 46000, toSavings: 46000 });
    expect(may.savingsDue.total).toBe(132000 - 3000);
    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-12' });
  });
});

// -------------------------------------------------------------------------------------------------
// Scenario 3: yearly subscriptions through the API
// -------------------------------------------------------------------------------------------------

describe('scenario: yearly subscriptions from October 2026', () => {
  async function setUp() {
    const clock = mutableClock('2026-10-05T10:00:00Z');
    const { app } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;
    await onboard(app, { startMonth: '2026-10', salary: 300000, openingSavings: 0 });
    const domain = await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      amount: 12000,
      anchorDate: '2025-03-14',
    });
    const backup = await addSubscription(app, {
      name: 'Backup',
      frequency: 'yearly',
      amount: 10000,
      anchorDate: '2025-09-30',
    });
    return { app, clock, get, domain, backup };
  }

  const reserves = async (
    get: <T>(path: string) => Promise<T>,
    id: number,
    from: string,
    to: string,
  ) => {
    const rows = await get<MonthSummary[]>(`/api/months?from=${from}&to=${to}`);
    const lines = await Promise.all(
      rows.map(async (r) =>
        (await get<MonthView>(`/api/months/${r.month}`)).subscriptions.find((s) => s.id === id),
      ),
    );
    return lines.map((l) => (l ? [l.charge, l.reserveBalance] : null));
  };

  it('120.00 renewing in March added in October costs 20.00 a month; 100.00 with 12 months to go costs 8.34 x 4 then 8.33 x 8', async () => {
    const { get, domain, backup } = await setUp();

    expect(await reserves(get, domain.id, '2026-10', '2027-04')).toEqual([
      [2000, 2000],
      [2000, 4000],
      [2000, 6000],
      [2000, 8000],
      [2000, 10000],
      [2000, 0],
      [1000, 1000],
    ]);
    expect(await reserves(get, backup.id, '2026-10', '2027-10')).toEqual([
      [834, 834],
      [834, 1668],
      [834, 2502],
      [834, 3336],
      [833, 4169],
      [833, 5002],
      [833, 5835],
      [833, 6668],
      [833, 7501],
      [833, 8334],
      [833, 9167],
      [833, 0], // September 2027: renewal month, the reserve reaches 100.00 and is paid out
      [834, 834],
    ]);

    // Fixed costs: Domain + Backup.
    const rows = await get<MonthSummary[]>('/api/months?from=2026-10&to=2027-10');
    expect(rows.map((r) => r.fixedCosts)).toEqual([
      2834,
      2834,
      2834,
      2834, // Oct to Jan: 20.00 + 8.34
      2833,
      2833, //             Feb, Mar: 20.00 + 8.33 (Domain renews in March)
      1833,
      1833,
      1833,
      1833,
      1833,
      1833, // Apr to Sep: 10.00 + 8.33
      1834, //                   Oct 2027: 10.00 + 8.34
    ]);
    // Each cycle is paid in full: the renewal months show the reserve at 0 and the flag.
    const march = (await get<MonthView>('/api/months/2027-03')).subscriptions.find(
      (s) => s.id === domain.id,
    );
    expect(march).toMatchObject({
      renewalThisMonth: true,
      reserveBalance: 0,
      price: 12000,
      nextRenewalMonth: '2027-03',
    });
    const september = (await get<MonthView>('/api/months/2027-09')).subscriptions.find(
      (s) => s.id === backup.id,
    );
    expect(september).toMatchObject({ renewalThisMonth: true, reserveBalance: 0, charge: 833 });
  });

  it('agrees with the identities and the independent oracle through renewals and a price change', async () => {
    const { app, backup, domain } = await setUp();
    await request(app)
      .put(`/api/subscriptions/${backup.id}/prices/2027-06`)
      .send({ amount: 15000 })
      .expect(200);
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2027-05' })
      .expect(200);
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2028-04' });
  });

  it('cancelling before the next renewal: the months before the end month go on, the end month gives the reserve back', async () => {
    const { app, get, domain } = await setUp();
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2026-12' })
      .expect(200);

    const lines = await Promise.all(
      ['2026-10', '2026-11', '2026-12', '2027-01'].map(
        async (m) =>
          (await get<MonthView>(`/api/months/${m}`)).subscriptions.find(
            (s) => s.id === domain.id,
          ) ?? null,
      ),
    );
    // October and November are computed as if it went on (20.00 each, towards March). December has
    // no renewal left: it sets nothing aside and releases the 40.00 held.
    expect(
      lines.map(
        (l) =>
          l && [l.charge, l.reserveBalance, l.reserveReleased, l.nextRenewalMonth, l.endsThisMonth],
      ),
    ).toEqual([
      [2000, 2000, 0, '2027-03', false],
      [2000, 4000, 0, '2027-03', false],
      [0, 0, 4000, null, true],
      null, // no line once it has ended
    ]);
    // December's savings due: salary 3000.00 - Backup's 8.34 + the 40.00 released.
    expect((await get<MonthView>('/api/months/2026-12')).savingsDue).toEqual({
      unallocated: 300000 - 834,
      budgetsSettled: 0,
      reservesReleased: 4000,
      total: 300000 - 834 + 4000,
    });
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-04' });
  });

  it('a price change dated January leaves October to December alone, and the rest of the cycle is topped up (docs/DOMAIN.md, "Causality")', async () => {
    const { app, clock, get, backup } = await setUp();
    clock.set('2027-01-10T10:00:00Z'); // October to December are closed
    const lineOf = async (month: string) =>
      (await get<MonthView>(`/api/months/${month}`)).subscriptions.find((s) => s.id === backup.id);
    const closedBefore = await Promise.all(
      ['2026-10', '2026-11', '2026-12'].map((m) => get<MonthView>(`/api/months/${m}`)),
    );
    expect(await lineOf('2026-10')).toMatchObject({ charge: 834, price: 10000 });

    // The renewal in September 2027 now costs 120.00, effective from January 2027.
    await request(app)
      .put(`/api/subscriptions/${backup.id}/prices/2027-01`)
      .send({ amount: 12000 })
      .expect(200);

    // The closed months are exactly what they were, the whole month view and all.
    const closedAfter = await Promise.all(
      ['2026-10', '2026-11', '2026-12'].map((m) => get<MonthView>(`/api/months/${m}`)),
    );
    expect(closedAfter.map((v) => v.status)).toEqual(['closed', 'closed', 'closed']);
    expect(closedAfter).toEqual(closedBefore);
    expect(await lineOf('2026-12')).toMatchObject({ charge: 834, reserveBalance: 2502 });

    // From January the reserve saves towards 120.00: 2502 is held, 9498 is still to find over
    // January to September (9 months): 1056 three times, then 1055 six times.
    const charges = await Promise.all(
      [
        '2027-01',
        '2027-02',
        '2027-03',
        '2027-04',
        '2027-05',
        '2027-06',
        '2027-07',
        '2027-08',
        '2027-09',
      ].map(async (m) => (await lineOf(m))?.charge),
    );
    expect(charges).toEqual([1056, 1056, 1056, 1055, 1055, 1055, 1055, 1055, 1055]);
    expect(await lineOf('2027-01')).toMatchObject({
      price: 12000,
      nextRenewalPrice: 12000,
      reserveBalance: 3558,
    });
    expect(await lineOf('2027-09')).toMatchObject({
      price: 12000,
      charge: 1055,
      reserveBalance: 0,
      renewalThisMonth: true,
    });
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-12' });
  });
});

// -------------------------------------------------------------------------------------------------
// Scenario 3b: the causal reserve through the API, with the clock moving between the edits
// -------------------------------------------------------------------------------------------------

describe('scenario: a yearly subscription whose price changes or which is cancelled, with the clock moving', () => {
  // 120.00 a year renewing in March, added in October 2026 (6 months to go), next to a monthly
  // 12.99 subscription and an incremental budget of 100.00 (40.00 spent in October). Income 3000.00.
  async function setUp() {
    const clock = mutableClock('2026-10-05T10:00:00Z');
    const { app } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;
    const done = await onboard(app, {
      startMonth: '2026-10',
      salary: 300000,
      openingSavings: 0,
      budgets: [{ name: 'Fun', amount: 10000, incremental: true }],
    });
    const [fun] = done.budgets as [BudgetDto];
    await addSubscription(app, { name: 'Netflix', amount: 1299, anchorDate: '2026-10-15' });
    const domain = await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      amount: 12000,
      anchorDate: '2025-03-14',
    });
    await addSpending(app, { budgetId: fun.id, date: '2026-10-09', amount: 4000 });
    return { app, clock, get, domain };
  }

  /** [charge, reserveBalance, reserveReleased] of Domain, and the month's fixed costs and savings due. */
  const figures = async (get: <T>(path: string) => Promise<T>, id: number, months: string[]) =>
    Promise.all(
      months.map(async (m) => {
        const view = await get<MonthView>(`/api/months/${m}`);
        const line = view.subscriptions.find((s) => s.id === id);
        return [
          line ? [line.charge, line.reserveBalance, line.reserveReleased] : null,
          view.fixedCosts,
          view.savingsDue.total,
        ] as const;
      }),
    );
  const MONTHS = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

  it('a) untouched: 20.00 a month for six months, then the renewal is paid from the reserve', async () => {
    const { app, get, domain } = await setUp();
    // Fixed costs: Netflix 12.99 + Domain 20.00 = 32.99. Fun is incremental: it carries, so the
    // savings due is the unallocated: 3000.00 - 32.99 - 100.00 = 2867.01.
    expect(await figures(get, domain.id, MONTHS)).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      [[2000, 6000, 0], 3299, 286701],
      [[2000, 8000, 0], 3299, 286701],
      [[2000, 10000, 0], 3299, 286701],
      [[2000, 0, 0], 3299, 286701],
    ]);
    const march = await get<MonthView>('/api/months/2027-03');
    expect(march.subscriptions.find((s) => s.id === domain.id)).toMatchObject({
      renewalThisMonth: true,
      price: 12000,
    });
    // Fun carries 60.00 out of October and 100.00 more each month: 60.00 + 5 * 100.00 = 560.00 out
    // of March, after 460.00 carried in and 560.00 available (nothing else is spent).
    expect(march.budgets[0]).toMatchObject({
      carriedIn: 46000,
      available: 56000,
      carriedOut: 56000,
    });
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-06' });
  });

  it('b) a rise to 180.00 from January, entered in December: the months before January stay as they were', async () => {
    const { app, clock, get, domain } = await setUp();
    const before = await Promise.all(
      MONTHS.slice(0, 3).map((m) => get<MonthView>(`/api/months/${m}`)),
    );
    clock.set('2026-12-10T10:00:00Z'); // October and November are closed, December is current
    await request(app)
      .put(`/api/subscriptions/${domain.id}/prices/2027-01`)
      .send({ amount: 18000 })
      .expect(200);

    const after = await Promise.all(
      MONTHS.slice(0, 3).map((m) => get<MonthView>(`/api/months/${m}`)),
    );
    expect(after.map((v) => v.status)).toEqual(['closed', 'closed', 'current']);
    // October to December: 20.00 each, exactly as before (only the status labels differ).
    expect(after.map(({ status: _status, ...rest }) => rest)).toEqual(
      before.map(({ status: _status, ...rest }) => rest),
    );
    expect(await figures(get, domain.id, MONTHS)).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      [[2000, 6000, 0], 3299, 286701],
      // January to March: (18000 - 6000) / 3 = 40.00 each; fixed 52.99, so 2847.01 is left.
      [[4000, 10000, 0], 5299, 284701],
      [[4000, 14000, 0], 5299, 284701],
      [[4000, 0, 0], 5299, 284701],
    ]);
    const march = (await get<MonthView>('/api/months/2027-03')).subscriptions.find(
      (s) => s.id === domain.id,
    );
    expect(march).toMatchObject({ price: 18000, renewalThisMonth: true, reserveBalance: 0 });
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-06' });
  });

  it('c) a drop to 40.00 from January: no more is set aside, and March releases the 20.00 left over', async () => {
    const { app, clock, get, domain } = await setUp();
    clock.set('2026-12-10T10:00:00Z');
    await request(app)
      .put(`/api/subscriptions/${domain.id}/prices/2027-01`)
      .send({ amount: 4000 })
      .expect(200);

    expect(await figures(get, domain.id, MONTHS)).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      [[2000, 6000, 0], 3299, 286701],
      // 60.00 is held, more than the 40.00 now due: nothing is set aside until the renewal.
      [[0, 6000, 0], 1299, 288701],
      [[0, 6000, 0], 1299, 288701],
      // March pays 40.00 and the other 20.00 goes back to savings: 2887.01 + 20.00.
      [[0, 0, 2000], 1299, 290701],
    ]);
    const march = await get<MonthView>('/api/months/2027-03');
    expect(march.savingsDue).toEqual({
      unallocated: 288701,
      budgetsSettled: 0,
      reservesReleased: 2000,
      total: 290701,
    });
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-06' });
  });

  it('d) cancelled with end month December, then with March: December gives the reserve back, and takes it again', async () => {
    const { app, clock, get, domain } = await setUp();
    clock.set('2026-12-10T10:00:00Z'); // October and November are closed
    const untouched = await Promise.all(
      MONTHS.slice(0, 2).map((m) => get<MonthView>(`/api/months/${m}`)),
    );

    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2026-12' })
      .expect(200);
    expect(await figures(get, domain.id, MONTHS.slice(0, 4))).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      // December: nothing set aside, the 40.00 held goes to savings: 2887.01 + 40.00 = 2927.01.
      [[0, 0, 4000], 1299, 292701],
      [null, 1299, 288701], // January: no Domain line any more
    ]);
    // October and November did not move.
    expect(
      await Promise.all(MONTHS.slice(0, 2).map((m) => get<MonthView>(`/api/months/${m}`))),
    ).toEqual(untouched.map((v) => ({ ...v, status: 'closed' })));
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-04' });

    // Cancelling again, now ending on the March renewal: December sets 20.00 aside again and the
    // renewal is paid as usual. Nothing was lost by the first cancellation.
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2027-03' })
      .expect(200);
    expect(await figures(get, domain.id, MONTHS)).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      [[2000, 6000, 0], 3299, 286701],
      [[2000, 8000, 0], 3299, 286701],
      [[2000, 10000, 0], 3299, 286701],
      [[2000, 0, 0], 3299, 286701],
    ]);
    expect((await get<MonthView>('/api/months/2027-04')).subscriptions).toEqual([
      expect.objectContaining({ name: 'Netflix' }),
    ]);
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-06' });
  });

  it('e) an end month on the renewal month: the renewal is paid as usual and nothing is released', async () => {
    const { app, get, domain } = await setUp();
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2027-03' })
      .expect(200);
    expect(await figures(get, domain.id, MONTHS)).toEqual([
      [[2000, 2000, 0], 3299, 286701],
      [[2000, 4000, 0], 3299, 286701],
      [[2000, 6000, 0], 3299, 286701],
      [[2000, 8000, 0], 3299, 286701],
      [[2000, 10000, 0], 3299, 286701],
      [[2000, 0, 0], 3299, 286701],
    ]);
    await expectApiMatchesOracle(app, { from: '2026-10', to: '2027-06' });
  });

  it('f) a yearly subscription renewing in its own start month is charged in full that month', async () => {
    const clock = mutableClock('2026-03-10T10:00:00Z');
    const { app } = createTestApp(clock);
    await onboard(app, { startMonth: '2026-03', salary: 100000, openingSavings: 0 });
    const gym = await addSubscription(app, {
      name: 'Gym',
      frequency: 'yearly',
      amount: 6000,
      anchorDate: '2025-03-20',
    });
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;
    // March: 60.00 charged and paid out at once; the next cycle (April to March) saves 5.00 a month.
    expect(await figures(get, gym.id, ['2026-03', '2026-04', '2026-05'])).toEqual([
      [[6000, 0, 0], 6000, 94000],
      [[500, 500, 0], 500, 99500],
      [[500, 1000, 0], 500, 99500],
    ]);
    await expectApiMatchesOracle(app, { from: '2026-03', to: '2027-04' });
  });
});

// -------------------------------------------------------------------------------------------------
// Scenario 4: transfers, made through POST /api/transfers
// -------------------------------------------------------------------------------------------------

describe('scenario: transfers between budgets and the pool', () => {
  it('moves money in the month of the transfer without changing what the month owes in total', async () => {
    const clock = mutableClock('2026-03-20T10:00:00Z');
    const { app } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 100000,
      openingSavings: 0,
      budgets: [
        { name: 'Rent', amount: 50000, incremental: false },
        { name: 'Fun', amount: 10000, incremental: true },
      ],
    });
    const [rent, fun] = done.budgets as [BudgetDto, BudgetDto];
    await addSpending(app, { budgetId: fun.id, date: '2026-02-10', amount: 14000 });

    // February: Fun overspends by 40.00, so 50.00 moves in from Rent; 20.00 more goes from the pool to Rent.
    await addTransfer(app, {
      date: '2026-02-12',
      amount: 5000,
      fromBudgetId: rent.id,
      toBudgetId: fun.id,
    });
    await addTransfer(app, {
      date: '2026-02-12',
      amount: 2000,
      fromBudgetId: null,
      toBudgetId: rent.id,
    });
    // March: 100.00 of Rent is given back to the pool.
    await addTransfer(app, {
      date: '2026-03-02',
      amount: 10000,
      fromBudgetId: rent.id,
      toBudgetId: null,
    });
    // The API lists them newest first (date, then id, descending).
    expect(
      (await get<{ id: number; date: string; amount: number }[]>('/api/transfers')).map((t) => [
        t.id,
        t.date,
        t.amount,
      ]),
    ).toEqual([
      [3, '2026-03-02', 10000],
      [2, '2026-02-12', 2000],
      [1, '2026-02-12', 5000],
    ]);

    const february = await get<MonthView>('/api/months/2026-02');
    // Fun: 100.00 carried from January + 100.00 + 50.00 in = 250.00 available, 140.00 spent: 110.00 carried.
    expect(february.budgets[1]).toMatchObject({
      name: 'Fun',
      carriedIn: 10000,
      allocated: 10000,
      transfersNet: 5000,
      available: 25000,
      spent: 14000,
      remaining: 11000,
      carriedOut: 11000,
    });
    // Rent: 500.00 - 50.00 + 20.00 = 470.00 available, nothing spent, all of it settles.
    expect(february.budgets[0]).toMatchObject({
      name: 'Rent',
      transfersNet: -3000,
      available: 47000,
      toSavings: 47000,
    });
    expect(february.totals.transfersNet).toBe(2000);
    // Unallocated: 1000.00 - 600.00 allocated - 20.00 the pool gave to Rent = 380.00.
    expect(february.unallocated).toBe(38000);
    expect(february.savingsDue).toEqual({
      unallocated: 38000,
      budgetsSettled: 47000,
      reservesReleased: 0,
      total: 85000,
    });

    const march = await get<MonthView>('/api/months/2026-03');
    expect(march.budgets[0]).toMatchObject({
      name: 'Rent',
      transfersNet: -10000,
      available: 40000,
    });
    expect(march.unallocated).toBe(100000 - 60000 + 10000);

    await expectApiMatchesOracle(app, { from: '2026-01', to: '2026-06' }, [
      { month: '2026-02', fromBudgetId: rent.id, toBudgetId: fun.id, amount: 5000 },
      { month: '2026-02', fromBudgetId: null, toBudgetId: rent.id, amount: 2000 },
      { month: '2026-03', fromBudgetId: rent.id, toBudgetId: null, amount: 10000 },
    ]);
  });
});
