/**
 * The independent model (prop-model.ts) against the worked examples of docs/DOMAIN.md, with every
 * expected number worked out by hand. The property tests trust the model, so it is pinned here to
 * the doc and never to the engine: nothing in this file imports `domain/ledger.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFact,
  income,
  makeFacts,
  salary,
  spending,
  subscriptionFact,
  transfer,
} from './facts';
import { daysInMonth, isLeapYear, modelLedger, monthIndex, monthKey } from './prop-model';

const TODAY = '2026-06-15';

/** One subscription's figure in each month of a run, as `[month, value]` pairs. */
function series(
  facts: ReturnType<typeof makeFacts>,
  through: string,
  field: 'charge' | 'reserveBalance' | 'reserveReleased',
  subscriptionId = 1,
  today = TODAY,
) {
  return modelLedger(facts, through, today).flatMap((m) => {
    const line = m.view.subscriptions.find((s) => s.id === subscriptionId);
    return line ? [[m.view.month, line[field]] as const] : [];
  });
}

describe('model month helpers', () => {
  it.each([
    ['2026-01', 24312],
    ['2026-12', 24323],
    ['2027-01', 24324],
    ['0000-01', 0],
  ])('monthIndex(%s) is %i and monthKey inverts it', (month, index) => {
    expect(monthIndex(month)).toBe(index);
    expect(monthKey(index)).toBe(month);
  });

  it.each([
    [2024, 2, 29],
    [2025, 2, 28],
    [2100, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('daysInMonth(%i, %i) is %i', (year, month, days) => {
    expect(daysInMonth(year, month)).toBe(days);
  });

  it('knows the Gregorian leap years', () => {
    expect([1900, 2000, 2023, 2024, 2100].map(isLeapYear)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });
});

describe('model: yearly subscriptions (the worked examples of docs/DOMAIN.md)', () => {
  const yearly = (price: number, opts: Parameters<typeof subscriptionFact>[1] = { price }) =>
    makeFacts({
      startMonth: '2026-10',
      subscriptions: [
        subscriptionFact(1, {
          frequency: 'yearly',
          anchor: '2025-03-14',
          start: '2026-10',
          ...opts,
        }),
      ],
    });

  it('120.00/year renewing in March, added in October: 20.00 a month, and March pays from the reserve', () => {
    // October to March is 6 months: 12000 / 6 = 2000 each. Reserve 2000, 4000, ..., 10000, then in
    // March 10000 + 2000 = 12000 is paid out, leaving 0. April starts a new cycle of 12 months.
    const facts = yearly(12000);
    expect(series(facts, '2027-04', 'charge')).toEqual([
      ['2026-10', 2000],
      ['2026-11', 2000],
      ['2026-12', 2000],
      ['2027-01', 2000],
      ['2027-02', 2000],
      ['2027-03', 2000],
      ['2027-04', 1000], // 12000 / 12 for the next March
    ]);
    expect(series(facts, '2027-04', 'reserveBalance')).toEqual([
      ['2026-10', 2000],
      ['2026-11', 4000],
      ['2026-12', 6000],
      ['2027-01', 8000],
      ['2027-02', 10000],
      ['2027-03', 0],
      ['2027-04', 1000],
    ]);
    const months = modelLedger(facts, '2027-03', TODAY);
    expect(months.map((m) => m.subscriptionPayments)).toEqual([0, 0, 0, 0, 0, 12000]);
    expect(months.at(-1)?.view.subscriptions[0]).toMatchObject({
      renewalThisMonth: true,
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      reserveReleased: 0,
    });
  });

  it('100.00/year with 12 months to go: 8.34 four times, then 8.33 eight times, exactly 100.00', () => {
    // Renewal in June, starting in July: 12 months. 10000 / 12 = 833.33 so the ceiling is 834.
    // ceil((10000 - 834) / 11) = 834, ceil((10000 - 1668) / 10) = 834, ceil((10000 - 2502) / 9) = 834,
    // ceil((10000 - 3336) / 8) = 833, and from there on 833 (the last month tops it up exactly).
    const facts = makeFacts({
      startMonth: '2026-07',
      subscriptions: [
        subscriptionFact(1, {
          frequency: 'yearly',
          anchor: '2025-06-30',
          start: '2026-07',
          price: 10000,
        }),
      ],
    });
    const charges = series(facts, '2027-06', 'charge').map(([, c]) => c);
    expect(charges).toEqual([834, 834, 834, 834, 833, 833, 833, 833, 833, 833, 833, 833]);
    expect(charges.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(series(facts, '2027-06', 'reserveBalance').at(-1)).toEqual(['2027-06', 0]);
  });

  it('a rise to 180.00 in January: October to December stay at 20.00, January to March 40.00, March pays 180.00', () => {
    // October to December: 2000 each (6000 held). January: ceil((18000 - 6000) / 3) = 4000, then
    // ceil((18000 - 10000) / 2) = 4000, then the last month 18000 - 14000 = 4000. Paid: 18000.
    const facts = yearly(12000, { price: 12000, priceChanges: [['2027-01', 18000]] });
    expect(series(facts, '2027-03', 'charge').map(([, c]) => c)).toEqual([
      2000, 2000, 2000, 4000, 4000, 4000,
    ]);
    const months = modelLedger(facts, '2027-03', TODAY);
    expect(months.at(-1)?.subscriptionPayments).toBe(18000);
    expect(months.at(-1)?.view.subscriptions[0]?.reserveBalance).toBe(0);
    expect(months.at(-1)?.view.subscriptions[0]?.reserveReleased).toBe(0);
  });

  it('a drop to 40.00 in January: nothing more is set aside, March pays 40.00 and releases 20.00', () => {
    // Held after December: 6000. January: ceil((4000 - 6000) / 3) is negative, so 0. March: pays
    // 4000 out of 6000 and the other 2000 goes back to savings.
    const facts = yearly(12000, { price: 12000, priceChanges: [['2027-01', 4000]] });
    expect(series(facts, '2027-03', 'charge').map(([, c]) => c)).toEqual([
      2000, 2000, 2000, 0, 0, 0,
    ]);
    expect(series(facts, '2027-03', 'reserveBalance').map(([, c]) => c)).toEqual([
      2000, 4000, 6000, 6000, 6000, 0,
    ]);
    const march = modelLedger(facts, '2027-03', TODAY).at(-1);
    expect(march?.subscriptionPayments).toBe(4000);
    expect(march?.view.subscriptions[0]?.reserveReleased).toBe(2000);
    expect(march?.view.savingsDue.reservesReleased).toBe(2000);
  });

  it('cancelled with end month December: December sets nothing aside and gives the 40.00 back', () => {
    const facts = yearly(12000, { price: 12000, end: '2026-12' });
    expect(series(facts, '2027-03', 'charge')).toEqual([
      ['2026-10', 2000],
      ['2026-11', 2000],
      ['2026-12', 0],
    ]);
    const december = modelLedger(facts, '2026-12', TODAY).at(-1);
    expect(december?.view.subscriptions[0]).toMatchObject({
      reserveBalance: 0,
      reserveReleased: 4000,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      renewalThisMonth: false,
      endsThisMonth: true,
    });
    expect(december?.subscriptionPayments).toBe(0);
    expect(december?.view.savingsDue.reservesReleased).toBe(4000);
    // The months before the end month are computed as if the subscription went on: 6 months to go.
    expect(modelLedger(facts, '2026-12', TODAY)[0]?.view.subscriptions[0]).toMatchObject({
      charge: 2000,
      nextRenewalMonth: '2027-03',
    });
  });

  it('cancelled again with end month March: December gets its 20.00 back and the renewal is paid', () => {
    const facts = yearly(12000, { price: 12000, end: '2027-03' });
    expect(series(facts, '2027-06', 'charge').map(([, c]) => c)).toEqual([
      2000, 2000, 2000, 2000, 2000, 2000,
    ]);
    const rows = modelLedger(facts, '2027-06', TODAY);
    expect(rows).toHaveLength(9); // the subscription has no line after March, but the months go on
    const march = rows.find((m) => m.view.month === '2027-03');
    expect(march?.subscriptionPayments).toBe(12000);
    expect(march?.view.subscriptions[0]).toMatchObject({ reserveReleased: 0, reserveBalance: 0 });
  });

  it('a yearly subscription that renews in its own start month is charged the full price that month', () => {
    const facts = makeFacts({
      startMonth: '2026-03',
      subscriptions: [
        subscriptionFact(1, {
          frequency: 'yearly',
          anchor: '2025-03-01',
          start: '2026-03',
          price: 9900,
        }),
      ],
    });
    const march = modelLedger(facts, '2026-03', TODAY)[0];
    expect(march?.view.subscriptions[0]).toMatchObject({
      charge: 9900,
      reserveBalance: 0,
      renewalThisMonth: true,
    });
    expect(march?.subscriptionPayments).toBe(9900);
    expect(march?.view.fixedCosts).toBe(9900);
  });

  it('a price rise dated in the renewal month is topped up in that month alone', () => {
    // 12000 over October to March (2000 each, 10000 held by February), the price becomes 15000 in
    // March: the contribution is 15000 - 10000 = 5000, and 15000 is paid.
    const facts = yearly(12000, { price: 12000, priceChanges: [['2027-03', 15000]] });
    const rows = modelLedger(facts, '2027-03', TODAY);
    expect(rows.map((m) => m.view.subscriptions[0]?.charge)).toEqual([
      2000, 2000, 2000, 2000, 2000, 5000,
    ]);
    expect(rows.at(-1)?.subscriptionPayments).toBe(15000);
  });

  it('a price row dated after the end month is inert, and one before the start month is in effect at it', () => {
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [
        subscriptionFact(1, {
          frequency: 'yearly',
          anchor: '2025-03-14',
          start: '2026-10',
          end: '2026-12',
          price: 12000,
          priceChanges: [
            ['2027-01', 99999], // after the end month: inert
            ['2026-05', 6000], // before the start month, older than the first row
          ],
        }),
      ],
    });
    // The first row (dated at the start month, 12000) is the latest one at or before October.
    expect(series(facts, '2027-03', 'charge').map(([, c]) => c)).toEqual([2000, 2000, 0]);

    const older = makeFacts({
      startMonth: '2026-10',
      subscriptions: [
        {
          ...subscriptionFact(1, {
            frequency: 'yearly',
            anchor: '2025-03-14',
            start: '2026-10',
            price: 1,
          }),
          prices: [{ effectiveMonth: '2026-05', amount: 12000 }], // the only row, older than the start
        },
      ],
    });
    expect(series(older, '2026-10', 'charge')).toEqual([['2026-10', 2000]]);
  });
});

describe('model: monthly subscriptions, income and budgets', () => {
  it('charges a monthly subscription in full in every active month, the end month included', () => {
    const facts = makeFacts({
      subscriptions: [subscriptionFact(1, { price: 1299, start: '2026-02', end: '2026-04' })],
    });
    const rows = modelLedger(facts, '2026-06', TODAY);
    expect(rows.map((m) => [m.view.month, m.view.fixedCosts, m.subscriptionPayments])).toEqual([
      ['2026-01', 0, 0],
      ['2026-02', 1299, 1299],
      ['2026-03', 1299, 1299],
      ['2026-04', 1299, 1299],
      ['2026-05', 0, 0],
      ['2026-06', 0, 0],
    ]);
  });

  it('takes the salary of the latest row at or before the month, and adds the incomes of the month', () => {
    const facts = makeFacts({
      salary: [salary('2026-01', 100000), salary('2026-03', 120000)],
      incomes: [income('2026-02', 5000), income('2026-02', 2500), income('2026-04', 1)],
    });
    expect(
      modelLedger(facts, '2026-04', TODAY).map((m) => [m.view.income.salary, m.view.income.extra]),
    ).toEqual([
      [100000, 0],
      [100000, 7500],
      [120000, 0],
      [120000, 1],
    ]);
    // No salary row yet: 0.
    expect(
      modelLedger(makeFacts({ salary: [salary('2026-03', 5)] }), '2026-02', TODAY)[1]?.view.income,
    ).toEqual({
      salary: 0,
      extra: 0,
      total: 0,
    });
  });

  it('labels the months closed, current and future by the month of today', () => {
    const rows = modelLedger(makeFacts(), '2026-05', '2026-03-31');
    expect(rows.map((m) => m.view.status)).toEqual([
      'closed',
      'closed',
      'current',
      'future',
      'future',
    ]);
  });

  // Facts for the budget tests: 1000.00 salary a month, today in March.
  const base = (overrides: Parameters<typeof makeFacts>[0]) =>
    makeFacts({ salary: [salary('2026-01', 100000)], ...overrides });

  it('carries an incremental budget (a deficit too) and settles a non-incremental one', () => {
    // Budget 1 (incremental, 100.00): Jan 70.00 spent -> 30.00 carried. Feb: 30.00 + 100.00 = 130.00
    // available, 140.00 spent -> -10.00 carried. March: -10.00 + 100.00 = 90.00, nothing spent.
    // Budget 2 (not incremental, 50.00): Jan 60.00 spent -> -10.00 taken from savings. Feb 10.00 spent -> 40.00 moves.
    const facts = base({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: true }),
        budgetFact(2, { amount: 5000, incremental: false }),
      ],
      spendings: [
        spending(1, '2026-01', 7000),
        spending(1, '2026-02', 14000),
        spending(2, '2026-01', 6000),
        spending(2, '2026-02', 1000),
      ],
    });
    const rows = modelLedger(facts, '2026-03', '2026-03-10');
    const b1 = rows.map((m) => m.view.budgets[0]);
    expect(
      b1.map((b) => [b?.carriedIn, b?.available, b?.remaining, b?.carriedOut, b?.toSavings]),
    ).toEqual([
      [0, 10000, 3000, 3000, 0],
      [3000, 13000, -1000, -1000, 0],
      [-1000, 9000, 9000, 9000, 0],
    ]);
    const b2 = rows.map((m) => m.view.budgets[1]);
    expect(b2.map((b) => [b?.remaining, b?.carriedOut, b?.toSavings])).toEqual([
      [-1000, 0, -1000],
      [4000, 0, 4000],
      [5000, 0, 5000],
    ]);
    // Unallocated: 1000.00 - 150.00 = 850.00 every month. Savings due: 850.00 + what settles.
    expect(rows.map((m) => [m.view.unallocated, m.view.savingsDue.total, m.heldInBudgets])).toEqual(
      [
        [85000, 84000, 3000],
        [85000, 89000, -1000],
        [85000, 90000, 9000],
      ],
    );
  });

  it('settles the whole balance of an archived budget in its end month, deficit included', () => {
    const facts = base({
      budgets: [budgetFact(1, { amount: 10000, incremental: true, end: '2026-02' })],
      spendings: [spending(1, '2026-01', 7000), spending(1, '2026-02', 14000)],
    });
    const rows = modelLedger(facts, '2026-03', '2026-03-10');
    // February: 30.00 + 100.00 - 140.00 = -10.00, and being the last month it is taken from savings.
    expect(rows[1]?.view.budgets[0]).toMatchObject({
      endsThisMonth: true,
      remaining: -1000,
      carriedOut: 0,
      toSavings: -1000,
    });
    // Unallocated: 1000.00 - 100.00 = 900.00, so the savings due is 900.00 - 10.00.
    expect(rows[1]?.view.savingsDue.total).toBe(90000 - 1000);
    expect(rows[2]?.view.budgets).toEqual([]);
    expect(rows[2]?.view.unallocated).toBe(100000);
  });

  it('releases the accumulated balance when an incremental budget switches to non-incremental', () => {
    const facts = base({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: true, changes: [['2026-03', 10000, false]] }),
      ],
      spendings: [spending(1, '2026-01', 7000), spending(1, '2026-02', 14000)],
    });
    const march = modelLedger(facts, '2026-03', '2026-03-10')[2]?.view.budgets[0];
    // Carried in -10.00, allocated 100.00, nothing spent: 90.00 moves to savings and nothing carries.
    expect(march).toMatchObject({
      incremental: false,
      carriedIn: -1000,
      remaining: 9000,
      carriedOut: 0,
      toSavings: 9000,
    });
  });

  it('starts an incremental budget from zero when it switches from non-incremental', () => {
    const facts = base({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: false, changes: [['2026-02', 10000, true]] }),
      ],
      spendings: [spending(1, '2026-01', 4000)],
    });
    const rows = modelLedger(facts, '2026-02', TODAY);
    expect(rows[0]?.view.budgets[0]).toMatchObject({
      remaining: 6000,
      carriedOut: 0,
      toSavings: 6000,
    });
    expect(rows[1]?.view.budgets[0]).toMatchObject({
      carriedIn: 0,
      carriedOut: 10000,
      toSavings: 0,
    });
  });

  it('computes usagePercent (rounded down, null at available <= 0) and the alert', () => {
    // available 1000: 799 spent = 79% ok; 800 = 80% warning; 1000 = 100% warning; 1001 = over.
    const usage = (spent: number, allocated = 1000, warn: number | null = null) => {
      const facts = base({
        budgets: [budgetFact(1, { amount: allocated, warn })],
        spendings: [spending(1, '2026-01', spent)],
      });
      const b = modelLedger(facts, '2026-01', TODAY)[0]?.view.budgets[0];
      return [b?.usagePercent, b?.alert, b?.warnPercent];
    };
    expect(usage(799)).toEqual([79, 'ok', 80]);
    expect(usage(800)).toEqual([80, 'warning', 80]);
    expect(usage(1000)).toEqual([100, 'warning', 80]);
    expect(usage(1001)).toEqual([100, 'over', 80]); // floor(100.1)
    expect(usage(1500)).toEqual([150, 'over', 80]); // not capped
    expect(usage(-300)).toEqual([0, 'ok', 80]); // a refund
    expect(usage(500, 1000, 50)).toEqual([50, 'warning', 50]); // the budget's own threshold
    expect(usage(0, 0)).toEqual([null, 'ok', 80]); // nothing available, nothing spent
    expect(usage(1, 0)).toEqual([null, 'over', 80]); // nothing available, something spent
  });

  it('counts transfers between budgets and the pool, and ignores the ones that name an inactive budget', () => {
    const facts = base({
      budgets: [
        budgetFact(1, { amount: 10000, incremental: true }),
        budgetFact(2, { amount: 5000, incremental: false }),
        budgetFact(3, { amount: 1000, start: '2026-02' }),
      ],
      transfers: [
        transfer('2026-01', null, 1, 2000), // pool -> 1
        transfer('2026-01', 2, null, 1500), // 2 -> pool
        transfer('2026-01', 1, 2, 1000), // 1 -> 2
        transfer('2026-01', 1, 3, 777), // 3 is not active in January: the whole transfer is ignored
        transfer('2026-01', 1, 1, 555), // to itself: moves nothing
        transfer('2026-01', null, null, 444), // pool to pool: moves nothing
        transfer('2026-01', 9, null, 333), // an unknown budget: ignored
      ],
    });
    const january = modelLedger(facts, '2026-01', TODAY)[0]?.view;
    // Budget 1: +2000 - 1000 = +1000, available 11000. Budget 2: -1500 + 1000 = -500, available 4500.
    expect(january?.budgets.map((b) => [b.transfersNet, b.available])).toEqual([
      [1000, 11000],
      [-500, 4500],
    ]);
    expect(january?.totals.transfersNet).toBe(500);
    // Unallocated: 1000.00 - 150.00 - 2000 + 1500 = 845.00 (the budget to budget transfer changes nothing).
    expect(january?.unallocated).toBe(84500);
    expect(january?.savingsDue).toEqual({
      unallocated: 84500,
      budgetsSettled: 4500,
      reservesReleased: 0,
      total: 89000,
    });
  });

  it('is empty before its first month, and has no row when through is before the start', () => {
    expect(modelLedger(makeFacts(), '2025-12', TODAY)).toEqual([]);
    expect(modelLedger(makeFacts(), '2026-01', TODAY)).toHaveLength(1);
  });
});
