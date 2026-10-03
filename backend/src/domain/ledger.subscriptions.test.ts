/**
 * Subscriptions in the ledger (docs/DOMAIN.md, "Subscriptions"): monthly charges, and the yearly
 * sinking fund with its renewal, its price changes, its end and its release. Every expected figure
 * is worked out by hand in the comments.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFact,
  makeFacts,
  monthOf,
  run,
  salary,
  subscriptionFact,
  subscriptionLineOf,
  subscriptionSeries,
} from '../testing/facts';
import { expectChainIdentities, expectMonthIdentities } from '../testing/month-identities';
import { stepYearlyReserve } from './ledger';

const yearly = (opts: Parameters<typeof subscriptionFact>[1]) =>
  subscriptionFact(1, { frequency: 'yearly', anchor: '2025-03-14', ...opts });

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/**
 * What the yearly reserves hold at the end of the ledger, by the money that went through them:
 * set aside, less returned to savings, less paid to the provider. 0 once every cycle is paid and
 * every subscription has ended.
 */
const netHeld = (ledger: ReturnType<typeof run>) =>
  sum(
    ledger.months.flatMap((m) =>
      m.subscriptions.map((s) => s.charge - s.reserveReleased - (s.renewalThisMonth ? s.price : 0)),
    ),
  );

describe('yearly subscriptions: the sinking fund', () => {
  it('120.00 a year renewing in March, added in October: 20.00 for 6 months, paid from the reserve', () => {
    // October to March is 6 months: 12000 / 6 = 2000 a month. The March renewal (12000) is paid
    // from the reserve, which is back to 0. April starts the next cycle: 12000 / 12 = 1000.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10' })],
    });
    const ledger = run(facts, '2027-04', '2026-10-15');

    expect(subscriptionSeries(ledger, 1, 'charge')).toEqual([
      ['2026-10', 2000],
      ['2026-11', 2000],
      ['2026-12', 2000],
      ['2027-01', 2000],
      ['2027-02', 2000],
      ['2027-03', 2000],
      ['2027-04', 1000],
    ]);
    expect(subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v)).toEqual([
      2000, 4000, 6000, 8000, 10000, 0, 1000,
    ]);
    expect(subscriptionSeries(ledger, 1, 'renewalThisMonth').map(([, v]) => v)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(subscriptionSeries(ledger, 1, 'nextRenewalMonth').map(([, v]) => v)).toEqual([
      '2027-03',
      '2027-03',
      '2027-03',
      '2027-03',
      '2027-03',
      '2027-03',
      '2028-03',
    ]);
    expect(subscriptionSeries(ledger, 1, 'nextRenewalPrice').map(([, v]) => v)).toEqual(
      Array(7).fill(12000),
    );
    // The month's fixed costs are the contribution, not the renewal price.
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([
      2000, 2000, 2000, 2000, 2000, 2000, 1000,
    ]);
    // The renewal itself was paid to the provider in March.
    expect(ledger.months.map((m) => m.subscriptionPayments)).toEqual([0, 0, 0, 0, 0, 12000, 0]);
  });

  it('100.00 a year with 12 months to go: 8.34 four times, then 8.33 eight times', () => {
    // April to March is 12 months. ceil(10000 / 12) = 834 while the remainder lasts:
    // 834 * 4 = 3336 left 6664 over 8 months = 833 exactly. Total: 3336 + 6664 = 10000.
    const facts = makeFacts({
      startMonth: '2026-04',
      subscriptions: [yearly({ price: 10000, start: '2026-04', anchor: '2025-03-31' })],
    });
    const ledger = run(facts, '2027-04', '2026-04-15');

    const charges = subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v);
    expect(charges).toEqual([834, 834, 834, 834, 833, 833, 833, 833, 833, 833, 833, 833, 834]);
    expect(charges.slice(0, 12).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v)).toEqual([
      834, 1668, 2502, 3336, 4169, 5002, 5835, 6668, 7501, 8334, 9167, 0, 834,
    ]);
  });

  it('charges the full price in the month it renews in, when that is its start month', () => {
    // Started in March, renews in March: the whole 60.00 is charged at once and paid out at once.
    // The next cycle (April to March, 12 months) saves 6000 / 12 = 500 a month.
    const facts = makeFacts({
      startMonth: '2026-03',
      subscriptions: [yearly({ price: 6000, start: '2026-03' })],
    });
    const ledger = run(facts, '2027-03', '2026-03-10');

    expect(subscriptionLineOf(ledger, '2026-03', 1)).toMatchObject({
      charge: 6000,
      reserveBalance: 0,
      renewalThisMonth: true,
      nextRenewalMonth: '2026-03',
      nextRenewalPrice: 6000,
      reserveReleased: 0,
    });
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      6000, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
    ]);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      charge: 500,
      reserveBalance: 0,
      renewalThisMonth: true,
    });
    expect(monthOf(ledger, '2026-03').subscriptionPayments).toBe(6000);
  });

  it('never leaves a cent unreserved: a cycle splits its price exactly, whatever the length', () => {
    // 7 months to go (September to March): 10000 = 1429 * 4 + 1428 * 3 (ceil(10000 / 7) = 1429).
    const facts = makeFacts({
      startMonth: '2026-09',
      subscriptions: [yearly({ price: 10000, start: '2026-09' })],
    });
    const ledger = run(facts, '2027-03', '2026-09-10');
    const charges = subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v);
    expect(charges).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
    expect(charges.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(subscriptionLineOf(ledger, '2027-03', 1).reserveBalance).toBe(0);
  });

  it('reports the amount in each month it is active, with the price in effect then', () => {
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10', color: '#2563eb', name: 'Domain' })],
    });
    expect(subscriptionLineOf(run(facts, '2026-10', '2026-10-15'), '2026-10', 1)).toEqual({
      id: 1,
      name: 'Domain',
      color: '#2563eb',
      frequency: 'yearly',
      price: 12000,
      charge: 2000,
      reserveBalance: 2000,
      renewalThisMonth: false,
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      reserveReleased: 0,
      endsThisMonth: false,
    });
  });
});

describe('yearly subscriptions: price changes', () => {
  const base = { price: 12000, start: '2026-10' } as const;

  it.each<[string, [string, number][], number[], number[], number[], number[]]>([
    // [label, price changes, charges Oct..Mar, reserve Oct..Mar, price column Oct..Mar, released Oct..Mar]
    [
      'a rise effective before the renewal (Jan): the months before it keep 20.00, the rest is topped up to 180.00',
      [['2027-01', 18000]],
      // Oct to Dec: 12000 / 6 = 2000 each (6000 held). Jan: (18000 - 6000) / 3 = 4000, and again.
      [2000, 2000, 2000, 4000, 4000, 4000],
      [2000, 4000, 6000, 10000, 14000, 0],
      [12000, 12000, 12000, 18000, 18000, 18000],
      [0, 0, 0, 0, 0, 0],
    ],
    [
      'a rise effective in the renewal month itself: the whole top-up falls in that month',
      [['2027-03', 18000]],
      // Oct to Feb: 2000 each (10000 held). March: 18000 - 10000 = 8000, then 18000 is paid.
      [2000, 2000, 2000, 2000, 2000, 8000],
      [2000, 4000, 6000, 8000, 10000, 0],
      [12000, 12000, 12000, 12000, 12000, 18000],
      [0, 0, 0, 0, 0, 0],
    ],
    [
      'a drop effective before the renewal (Feb): nothing more is set aside, and the leftover is released at the renewal',
      [['2027-02', 6000]],
      // Oct to Jan: 2000 each (8000 held, more than the 6000 now due). Feb and Mar: nothing.
      // March pays 6000 and releases the 2000 left.
      [2000, 2000, 2000, 2000, 0, 0],
      [2000, 4000, 6000, 8000, 8000, 0],
      [12000, 12000, 12000, 12000, 6000, 6000],
      [0, 0, 0, 0, 0, 2000],
    ],
    [
      'a rise effective after the renewal does not touch this cycle',
      [['2027-04', 18000]],
      [2000, 2000, 2000, 2000, 2000, 2000],
      [2000, 4000, 6000, 8000, 10000, 0],
      [12000, 12000, 12000, 12000, 12000, 12000],
      [0, 0, 0, 0, 0, 0],
    ],
    [
      'a drop effective after the renewal does not touch this cycle',
      [['2027-04', 6000]],
      [2000, 2000, 2000, 2000, 2000, 2000],
      [2000, 4000, 6000, 8000, 10000, 0],
      [12000, 12000, 12000, 12000, 12000, 12000],
      [0, 0, 0, 0, 0, 0],
    ],
  ])('%s', (_label, priceChanges, charges, reserves, prices, released) => {
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ ...base, priceChanges })],
    });
    const ledger = run(facts, '2027-03', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual(charges);
    expect(subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v)).toEqual(reserves);
    expect(subscriptionSeries(ledger, 1, 'price').map(([, v]) => v)).toEqual(prices);
    expect(subscriptionSeries(ledger, 1, 'reserveReleased').map(([, v]) => v)).toEqual(released);
    // Money leaves a reserve only to the provider or back to savings: what is set aside over the
    // cycle is the renewal paid (the price in March) plus what is released.
    expect(sum(charges)).toBe(prices[5]! + sum(released));
    expect(netHeld(ledger)).toBe(0);
  });

  it('a rise effective after the renewal starts the next cycle at the new price', () => {
    // Cycle 2 is April to March (12 months) towards 18000: 1500 a month.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ ...base, priceChanges: [['2027-04', 18000]] })],
    });
    const ledger = run(facts, '2027-05', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      2000, 2000, 2000, 2000, 2000, 2000, 1500, 1500,
    ]);
    expect(subscriptionLineOf(ledger, '2027-04', 1)).toMatchObject({
      price: 18000,
      nextRenewalMonth: '2028-03',
      nextRenewalPrice: 18000,
    });
  });

  it('the reserve saves towards the price in effect THIS month, so a later change is not seen yet', () => {
    // A rise to 180.00 is stored for January. In October the line still says 120.00; from January on
    // it says 180.00. The renewal month is the same throughout.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ ...base, priceChanges: [['2027-01', 18000]] })],
    });
    const ledger = run(facts, '2027-03', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'nextRenewalPrice').map(([, v]) => v)).toEqual([
      12000, 12000, 12000, 18000, 18000, 18000,
    ]);
    expect(subscriptionSeries(ledger, 1, 'nextRenewalMonth').map(([, v]) => v)).toEqual(
      Array(6).fill('2027-03'),
    );
    expect(subscriptionLineOf(ledger, '2026-10', 1)).toMatchObject({
      price: 12000,
      nextRenewalPrice: 12000,
    });
  });
});

describe('yearly subscriptions: the reserve is causal (docs/DOMAIN.md, "Causality")', () => {
  // The cases of the specification, in cents: 120.00 a year, renewing in March, added in October,
  // so October to March is 6 months. Every number is worked out in the comments.
  const facts = (extra: Partial<Parameters<typeof yearly>[0]> = {}) =>
    makeFacts({
      startMonth: '2026-10',
      salary: [salary('2026-10', 100000)],
      subscriptions: [yearly({ price: 12000, start: '2026-10', ...extra })],
    });
  const charges = (ledger: ReturnType<typeof run>) =>
    subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v);
  const reserves = (ledger: ReturnType<typeof run>) =>
    subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v);
  const released = (ledger: ReturnType<typeof run>) =>
    subscriptionSeries(ledger, 1, 'reserveReleased').map(([, v]) => v);

  it('a) no changes: 20.00 six times, and the reserve is 0 after the March renewal', () => {
    // 12000/6 = 2000; then (12000-2000)/5 = 2000, (12000-4000)/4 = 2000, ... the last month tops up 2000.
    const ledger = run(facts(), '2027-03', '2026-10-15');
    expect(charges(ledger)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(reserves(ledger)).toEqual([2000, 4000, 6000, 8000, 10000, 0]);
    expect(released(ledger)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(monthOf(ledger, '2027-03').subscriptionPayments).toBe(12000);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      renewalThisMonth: true,
      reserveBalance: 0,
    });
  });

  it('b) a rise to 180.00 from January, recorded in December: October to December do NOT move', () => {
    // The change is recorded while December is the current month, so October and November are
    // closed. The months before January are exactly what they were; January to March split the
    // 18000 - 6000 = 12000 still to find: 4000 each. The March renewal pays 18000, reserve 0.
    const before = facts();
    const after = facts({ priceChanges: [['2027-01', 18000]] });
    const today = '2026-12-05';
    const ledgerBefore = run(before, '2027-03', today);
    const ledgerAfter = run(after, '2027-03', today);

    expect(charges(ledgerAfter)).toEqual([2000, 2000, 2000, 4000, 4000, 4000]);
    expect(reserves(ledgerAfter)).toEqual([2000, 4000, 6000, 10000, 14000, 0]);
    expect(monthOf(ledgerAfter, '2027-03').subscriptionPayments).toBe(18000);
    expect(subscriptionLineOf(ledgerAfter, '2027-03', 1)).toMatchObject({
      price: 18000,
      renewalThisMonth: true,
      reserveBalance: 0,
      reserveReleased: 0,
    });
    // The regression test: the closed months and the current one are identical, row for row.
    expect(ledgerAfter.months.slice(0, 3).map((m) => m.status)).toEqual([
      'closed',
      'closed',
      'current',
    ]);
    expect(ledgerAfter.months.slice(0, 3)).toEqual(ledgerBefore.months.slice(0, 3));
    expect(ledgerAfter.months.slice(0, 3).map((m) => m.fixedCosts)).toEqual([2000, 2000, 2000]);
    // ...while January on does change.
    expect(monthOf(ledgerAfter, '2027-01').fixedCosts).toBe(4000);
    expect(monthOf(ledgerBefore, '2027-01').fixedCosts).toBe(2000);
  });

  it('c) a drop to 40.00 from January: nothing more is set aside, March pays 40.00 and releases 20.00', () => {
    // 6000 is held after December, more than the 4000 now due: January to March contribute 0.
    // The March renewal pays 4000 and the 2000 left goes back to savings in March.
    const ledger = run(facts({ priceChanges: [['2027-01', 4000]] }), '2027-03', '2026-12-05');
    expect(charges(ledger)).toEqual([2000, 2000, 2000, 0, 0, 0]);
    expect(reserves(ledger)).toEqual([2000, 4000, 6000, 6000, 6000, 0]);
    expect(released(ledger)).toEqual([0, 0, 0, 0, 0, 2000]);
    const march = monthOf(ledger, '2027-03');
    expect(march.subscriptionPayments).toBe(4000);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      price: 4000,
      charge: 0,
      reserveBalance: 0,
      reserveReleased: 2000,
      renewalThisMonth: true,
    });
    // March's savings due includes the 20.00: income 1000.00, nothing else is planned.
    expect(march.savingsDue).toEqual({
      unallocated: 100000,
      budgetsSettled: 0,
      reservesReleased: 2000,
      total: 102000,
    });
    expectChainIdentities(ledger.months, { startsAtLedgerStart: true });
  });

  it('d) cancelled with end month December: 20.00, 20.00, then December sets nothing aside and releases 40.00; a later end month gives it all back', () => {
    const today = '2026-12-05'; // October and November are closed, December is current
    const cancelled = run(facts({ end: '2026-12' }), '2027-01', today);
    // October and November are what they were without the cancellation (it is only dated December).
    const continuing = run(facts(), '2027-01', today);
    expect(cancelled.months.slice(0, 2)).toEqual(continuing.months.slice(0, 2));
    expect(charges(cancelled)).toEqual([2000, 2000, 0]);
    expect(reserves(cancelled)).toEqual([2000, 4000, 0]);
    expect(released(cancelled)).toEqual([0, 0, 4000]);
    expect(subscriptionLineOf(cancelled, '2026-12', 1)).toMatchObject({
      charge: 0,
      reserveBalance: 0,
      reserveReleased: 4000,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      endsThisMonth: true,
      renewalThisMonth: false,
    });
    // The October and November lines still name the March renewal, as if it went on.
    expect(subscriptionLineOf(cancelled, '2026-11', 1)).toMatchObject({
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      endsThisMonth: false,
    });
    // December's savings due gets the 40.00 back: income 1000.00 and nothing set aside.
    expect(monthOf(cancelled, '2026-12').savingsDue).toEqual({
      unallocated: 100000,
      budgetsSettled: 0,
      reservesReleased: 4000,
      total: 104000,
    });
    // Nothing was lost over the three months: 40.00 set aside, 40.00 returned.
    expect(sum(charges(cancelled))).toBe(4000);
    expect(sum(released(cancelled))).toBe(4000);
    expect(netHeld(cancelled)).toBe(0);
    expect(monthOf(cancelled, '2027-01').subscriptions).toEqual([]);

    // Cancelling again with the end month moved to the March renewal: December contributes 20.00
    // again, so the closed-month figures follow the end month in both directions (lossless), and
    // March pays the renewal as usual.
    const later = run(facts({ end: '2027-03' }), '2027-03', today);
    expect(charges(later)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(reserves(later)).toEqual([2000, 4000, 6000, 8000, 10000, 0]);
    expect(released(later)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(monthOf(later, '2027-03').subscriptionPayments).toBe(12000);
    expect(monthOf(later, '2026-12').subscriptions[0]).toMatchObject({
      charge: 2000,
      reserveBalance: 6000,
      reserveReleased: 0,
      endsThisMonth: false,
    });
    expect(later.months.slice(0, 2)).toEqual(continuing.months.slice(0, 2));
  });

  it('e) an end month that is a renewal month: the rule applies as usual, nothing is released', () => {
    const ledger = run(facts({ end: '2027-03' }), '2027-04', '2026-10-15');
    expect(charges(ledger)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(reserves(ledger)).toEqual([2000, 4000, 6000, 8000, 10000, 0]);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      renewalThisMonth: true,
      endsThisMonth: true,
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      reserveBalance: 0,
      reserveReleased: 0,
    });
    expect(monthOf(ledger, '2027-03').subscriptionPayments).toBe(12000);
    expect(monthOf(ledger, '2027-04').subscriptions).toEqual([]);
  });

  it('e2) an end month that is a renewal month, where the price dropped: pays the new price and releases the leftover', () => {
    // 8000 held after January; the price falls to 50.00 in February, so February contributes 0.
    // March (also the end month) pays 5000 and releases the 3000 left.
    const ledger = run(
      facts({ end: '2027-03', priceChanges: [['2027-02', 5000]] }),
      '2027-03',
      '2026-10-15',
    );
    expect(charges(ledger)).toEqual([2000, 2000, 2000, 2000, 0, 0]);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      renewalThisMonth: true,
      endsThisMonth: true,
      reserveBalance: 0,
      reserveReleased: 3000,
    });
    expect(monthOf(ledger, '2027-03').subscriptionPayments).toBe(5000);
  });

  it('f) a renewal in its own start month: the full price is charged that month', () => {
    // Started in March, renews in March: 60.00 charged and paid out at once; the next cycle
    // (April to March) saves 6000 / 12 = 500 a month.
    const ledger = run(
      makeFacts({
        startMonth: '2026-03',
        subscriptions: [yearly({ price: 6000, start: '2026-03' })],
      }),
      '2026-05',
      '2026-03-10',
    );
    expect(charges(ledger)).toEqual([6000, 500, 500]);
    expect(reserves(ledger)).toEqual([0, 500, 1000]);
    expect(subscriptionLineOf(ledger, '2026-03', 1)).toMatchObject({
      charge: 6000,
      renewalThisMonth: true,
      reserveBalance: 0,
      reserveReleased: 0,
    });
    expect(monthOf(ledger, '2026-03').subscriptionPayments).toBe(6000);
  });

  it('a price dated in a month never moves an earlier month, in any month of the cycle', () => {
    // For each month X of the cycle: add a price rise and a price drop dated X and compare every
    // month before X with the facts that have no change at all.
    const none = run(facts(), '2027-03', '2026-12-05').months;
    for (const [x, amount] of [
      ['2026-11', 18000],
      ['2026-12', 4000],
      ['2027-01', 18000],
      ['2027-02', 4000],
      ['2027-03', 24000],
    ] as const) {
      const edited = run(facts({ priceChanges: [[x, amount]] }), '2027-03', '2026-12-05').months;
      const before = none.filter((m) => m.month < x);
      expect(
        edited.filter((m) => m.month < x),
        `a price dated ${x}`,
      ).toEqual(before);
      expect(
        edited.find((m) => m.month === x),
        `a price dated ${x} changes ${x}`,
      ).not.toEqual(none.find((m) => m.month === x));
    }
  });

  it('an end month dated in a month never moves an earlier month, and moving it is lossless', () => {
    const none = run(facts(), '2027-03', '2026-12-05').months;
    for (const end of ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']) {
      const ledger = run(facts({ end }), '2027-03', '2026-12-05');
      expect(
        ledger.months.filter((m) => m.month < end),
        `ending ${end}`,
      ).toEqual(none.filter((m) => m.month < end));
      // Whatever was set aside is returned in the last month: nothing is lost.
      expect(netHeld(ledger), `ending ${end}`).toBe(0);
    }
  });
});

describe('yearly subscriptions: ending', () => {
  it('cancelled before its next renewal: the months before the end month go on, the end month gives it all back', () => {
    // endMonth 2026-12 is before the March renewal. October and November are computed as if the
    // subscription went on: 20.00 each, 40.00 held. December has no renewal left: it sets nothing
    // aside and releases the 40.00 into its savings due.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10', end: '2026-12' })],
    });
    const ledger = run(facts, '2027-01', '2026-10-15');

    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([2000, 2000, 0]);
    expect(subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v)).toEqual([
      2000, 4000, 0,
    ]);
    expect(subscriptionSeries(ledger, 1, 'reserveReleased').map(([, v]) => v)).toEqual([
      0, 0, 4000,
    ]);
    expect(subscriptionSeries(ledger, 1, 'nextRenewalMonth').map(([, v]) => v)).toEqual([
      '2027-03',
      '2027-03',
      null,
    ]);
    expect(subscriptionSeries(ledger, 1, 'nextRenewalPrice').map(([, v]) => v)).toEqual([
      12000,
      12000,
      null,
    ]);
    expect(subscriptionSeries(ledger, 1, 'endsThisMonth').map(([, v]) => v)).toEqual([
      false,
      false,
      true,
    ]);
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([2000, 2000, 0, 0]);
    expect(ledger.months.map((m) => m.savingsDue.reservesReleased)).toEqual([0, 0, 4000, 0]);
    expect(monthOf(ledger, '2027-01').subscriptions).toEqual([]); // no line once it has ended
  });

  it('ending in its renewal month: the renewal is the last charge and nothing is left', () => {
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10', end: '2027-03' })],
    });
    const ledger = run(facts, '2027-04', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      2000, 2000, 2000, 2000, 2000, 2000,
    ]);
    expect(subscriptionLineOf(ledger, '2027-03', 1)).toMatchObject({
      reserveBalance: 0,
      renewalThisMonth: true,
      endsThisMonth: true,
      reserveReleased: 0,
    });
    expect(monthOf(ledger, '2027-04').subscriptions).toEqual([]);
    expect(monthOf(ledger, '2027-04').fixedCosts).toBe(0);
  });

  it('renewed in its start month and cancelled later in the cycle: one charge, a new cycle, then the release', () => {
    // March: 60.00 charged and paid. April to August: the next cycle saves 6000 / 12 = 500 a month
    // (2500 held after August). September is the end month and the next renewal (March) is after
    // it: nothing more is set aside and the 25.00 goes back to savings.
    const facts = makeFacts({
      startMonth: '2026-03',
      subscriptions: [yearly({ price: 6000, start: '2026-03', end: '2026-09' })],
    });
    const ledger = run(facts, '2026-10', '2026-03-10');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      6000, 500, 500, 500, 500, 500, 0,
    ]);
    expect(subscriptionSeries(ledger, 1, 'reserveBalance').map(([, v]) => v)).toEqual([
      0, 500, 1000, 1500, 2000, 2500, 0,
    ]);
    expect(subscriptionLineOf(ledger, '2026-09', 1)).toMatchObject({
      charge: 0,
      reserveReleased: 2500,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
    });
    expect(subscriptionLineOf(ledger, '2026-05', 1)).toMatchObject({
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 6000,
    });
    expect(ledger.months.reduce((total, m) => total + m.subscriptionPayments, 0)).toBe(6000);
  });

  it('ending after a second cycle: two renewals paid, the month after the last one gives back what it held', () => {
    const facts = makeFacts({
      startMonth: '2026-03',
      subscriptions: [yearly({ price: 6000, start: '2026-03', end: '2027-05' })],
    });
    const ledger = run(facts, '2027-06', '2026-03-10');
    const charges = subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v);
    // Mar 2026: 6000 (renews at once). Apr 2026 to Mar 2027: 500 * 12, the renewal paid in March.
    // Apr 2027: a new cycle, 500 held. May 2027 is the end month and the next renewal (March 2028)
    // is after it: nothing set aside, the 500 is released.
    expect(charges).toEqual([6000, ...Array(12).fill(500), 500, 0]);
    expect(subscriptionLineOf(ledger, '2027-05', 1)).toMatchObject({
      reserveReleased: 500,
      reserveBalance: 0,
    });
    expect(ledger.months.reduce((total, m) => total + m.subscriptionPayments, 0)).toBe(12000);
  });

  it('ending in its start month with no renewal that month: nothing to set aside, nothing to give back', () => {
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10', end: '2026-10' })],
    });
    const ledger = run(facts, '2026-11', '2026-10-15');
    expect(subscriptionLineOf(ledger, '2026-10', 1)).toMatchObject({
      charge: 0,
      reserveBalance: 0,
      reserveReleased: 0,
      nextRenewalMonth: null,
      endsThisMonth: true,
    });
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([0, 0]);
  });

  it('an end month in the last month before a renewal still releases: the renewal is the month after', () => {
    // End month February, renewal in March: the reserve (10000 after February's contribution would
    // have been 10000) is released in February instead, with no contribution in that month.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [yearly({ price: 12000, start: '2026-10', end: '2027-02' })],
    });
    const ledger = run(facts, '2027-03', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      2000, 2000, 2000, 2000, 0,
    ]);
    expect(subscriptionLineOf(ledger, '2027-02', 1)).toMatchObject({
      reserveBalance: 0,
      reserveReleased: 8000,
    });
  });
});

describe('stepYearlyReserve: the release rules', () => {
  const prices = [{ effectiveMonth: '2026-10', amount: 12000 }];

  it('releases what is still held after a renewal whose price dropped', () => {
    // 100.00 was reserved, but the March price is 50.00: 50.00 is paid, 50.00 goes back to savings.
    const step = stepYearlyReserve({
      month: '2027-03',
      renewalMonthOfYear: 3,
      endMonth: null,
      prices: [...prices, { effectiveMonth: '2027-03', amount: 5000 }],
      reserveBefore: 10000,
    });
    expect(step).toEqual({
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 5000,
      renewalThisMonth: true,
      contribution: 0,
      renewalPayment: 5000,
      reserveReleased: 5000,
      reserveAfter: 0,
    });
  });

  it('tops the reserve up to the price in the renewal month when the price rose', () => {
    const step = stepYearlyReserve({
      month: '2027-03',
      renewalMonthOfYear: 3,
      endMonth: null,
      prices,
      reserveBefore: 9000,
    });
    expect(step).toMatchObject({ contribution: 3000, renewalPayment: 12000, reserveReleased: 0 });
    expect(step.reserveAfter).toBe(0);
  });

  it('releases the reserve in the last month when the subscription ends with no renewal left', () => {
    const step = stepYearlyReserve({
      month: '2026-12',
      renewalMonthOfYear: 3,
      endMonth: '2026-12',
      prices,
      reserveBefore: 4000,
    });
    expect(step).toEqual({
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      renewalThisMonth: false,
      contribution: 0,
      renewalPayment: 0,
      reserveReleased: 4000,
      reserveAfter: 0,
    });
  });

  it('computes the months before the end month as if the subscription went on', () => {
    // November with the end month in December: the end month only matters in December itself, so
    // November still saves towards March: November to March is 5 months, (12000 - 2000) / 5 = 2000.
    const step = stepYearlyReserve({
      month: '2026-11',
      renewalMonthOfYear: 3,
      endMonth: '2026-12',
      prices,
      reserveBefore: 2000,
    });
    expect(step).toEqual({
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      renewalThisMonth: false,
      contribution: 2000,
      renewalPayment: 0,
      reserveReleased: 0,
      reserveAfter: 4000,
    });
  });

  it('applies the normal rule in an end month that is a renewal month', () => {
    const step = stepYearlyReserve({
      month: '2027-03',
      renewalMonthOfYear: 3,
      endMonth: '2027-03',
      prices,
      reserveBefore: 10000,
    });
    expect(step).toEqual({
      nextRenewalMonth: '2027-03',
      nextRenewalPrice: 12000,
      renewalThisMonth: true,
      contribution: 2000,
      renewalPayment: 12000,
      reserveReleased: 0,
      reserveAfter: 0,
    });
  });

  it('releases nothing in an end month with no renewal left when nothing is held', () => {
    const step = stepYearlyReserve({
      month: '2026-10',
      renewalMonthOfYear: 3,
      endMonth: '2026-10',
      prices,
      reserveBefore: 0,
    });
    expect(step).toMatchObject({ contribution: 0, reserveReleased: 0, reserveAfter: 0 });
  });

  it('aims at the price in effect in the month, not at the one in effect at the renewal', () => {
    // Held 6000; the price is 120.00 now and drops to 40.00 in the renewal month. In January the
    // reserve is still topped up towards 120.00: (12000 - 6000) / 3 = 2000.
    const step = stepYearlyReserve({
      month: '2027-01',
      renewalMonthOfYear: 3,
      endMonth: null,
      prices: [...prices, { effectiveMonth: '2027-03', amount: 4000 }],
      reserveBefore: 6000,
    });
    expect(step).toMatchObject({ contribution: 2000, nextRenewalPrice: 12000, reserveAfter: 8000 });
  });

  it('adds nothing, and releases nothing, when the reserve already covers the price before the renewal', () => {
    const step = stepYearlyReserve({
      month: '2027-02',
      renewalMonthOfYear: 3,
      endMonth: null,
      prices: [{ effectiveMonth: '2026-10', amount: 10000 }],
      reserveBefore: 11000,
    });
    expect(step).toMatchObject({
      contribution: 0, // max(0, ceilDiv(10000 - 11000, 2)): never negative
      reserveReleased: 0,
      reserveAfter: 11000,
      renewalThisMonth: false,
    });
  });

  it('wraps over the year end: renewing in January, computed in November', () => {
    const step = stepYearlyReserve({
      month: '2026-11',
      renewalMonthOfYear: 1,
      endMonth: null,
      prices: [{ effectiveMonth: '2026-01', amount: 9000 }],
      reserveBefore: 0,
    });
    // November, December, January: 3 months, 9000 / 3.
    expect(step).toMatchObject({
      nextRenewalMonth: '2027-01',
      contribution: 3000,
      reserveAfter: 3000,
    });
  });
});

describe('monthly subscriptions', () => {
  it('charges its price in every active month and not before or after (starting and ending mid-year)', () => {
    const facts = makeFacts({
      subscriptions: [
        subscriptionFact(1, { name: 'Gym', price: 3000, start: '2026-03', end: '2026-08' }),
      ],
    });
    const ledger = run(facts, '2026-10');

    expect(subscriptionSeries(ledger, 1, 'charge')).toEqual([
      ['2026-03', 3000],
      ['2026-04', 3000],
      ['2026-05', 3000],
      ['2026-06', 3000],
      ['2026-07', 3000],
      ['2026-08', 3000],
    ]);
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([
      0, 0, 3000, 3000, 3000, 3000, 3000, 3000, 0, 0,
    ]);
    expect(subscriptionSeries(ledger, 1, 'endsThisMonth').map(([, v]) => v)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(monthOf(ledger, '2026-02').subscriptions).toEqual([]);
    expect(monthOf(ledger, '2026-09').subscriptions).toEqual([]);
    expect(subscriptionLineOf(ledger, '2026-05', 1)).toEqual({
      id: 1,
      name: 'Gym',
      color: null,
      frequency: 'monthly',
      price: 3000,
      charge: 3000,
      reserveBalance: 0,
      renewalThisMonth: false,
      nextRenewalMonth: null,
      nextRenewalPrice: null,
      reserveReleased: 0,
      endsThisMonth: false,
    });
    expect(ledger.months.map((m) => m.subscriptionPayments)).toEqual(
      ledger.months.map((m) => m.fixedCosts),
    );
  });

  it('follows its price history: a change takes effect from its month', () => {
    const facts = makeFacts({
      subscriptions: [
        subscriptionFact(1, {
          price: 1299,
          start: '2026-01',
          priceChanges: [
            ['2026-04', 1399],
            ['2026-07', 999],
          ],
        }),
      ],
    });
    const ledger = run(facts, '2026-08');
    expect(subscriptionSeries(ledger, 1, 'price').map(([, v]) => v)).toEqual([
      1299, 1299, 1299, 1399, 1399, 1399, 999, 999,
    ]);
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([
      1299, 1299, 1299, 1399, 1399, 1399, 999, 999,
    ]);
  });

  it('a price dated before the start month is the one in effect at the start; one dated after the end month is inert', () => {
    // Started in June after being moved from January: 12.99 from January, 15.99 from May and 9.99
    // from September, with August as the end month. June takes the May price; September is never read.
    const facts = makeFacts({
      subscriptions: [
        {
          ...subscriptionFact(1, { price: 1, start: '2026-06', end: '2026-08' }),
          prices: [
            { effectiveMonth: '2026-01', amount: 1299 },
            { effectiveMonth: '2026-05', amount: 1599 },
            { effectiveMonth: '2026-09', amount: 999 },
          ],
        },
      ],
    });
    const ledger = run(facts, '2026-10');
    expect(subscriptionSeries(ledger, 1, 'charge')).toEqual([
      ['2026-06', 1599],
      ['2026-07', 1599],
      ['2026-08', 1599],
    ]);
    expect(ledger.months.map((m) => m.fixedCosts)).toEqual([0, 0, 0, 0, 0, 1599, 1599, 1599, 0, 0]);
    // With the end month moved to October the September row takes effect again.
    const reopened = run(
      { ...facts, subscriptions: [{ ...facts.subscriptions[0]!, endMonth: '2026-10' }] },
      '2026-10',
    );
    expect(subscriptionSeries(reopened, 1, 'charge').map(([, v]) => v)).toEqual([
      1599, 1599, 1599, 999, 999,
    ]);
  });

  it('a yearly subscription ignores a price dated after its end month, and uses an older row at its start', () => {
    // 120.00 from May (before the October start) and a 999.00 price from April 2027, after the end
    // month (the March renewal): the cycle is the plain 20.00 a month.
    const facts = makeFacts({
      startMonth: '2026-10',
      subscriptions: [
        {
          ...yearly({ price: 1, start: '2026-10', end: '2027-03' }),
          prices: [
            { effectiveMonth: '2026-05', amount: 12000 },
            { effectiveMonth: '2027-04', amount: 99900 },
          ],
        },
      ],
    });
    const ledger = run(facts, '2027-04', '2026-10-15');
    expect(subscriptionSeries(ledger, 1, 'charge').map(([, v]) => v)).toEqual([
      2000, 2000, 2000, 2000, 2000, 2000,
    ]);
    expect(monthOf(ledger, '2027-03').subscriptionPayments).toBe(12000);
    expect(monthOf(ledger, '2027-04').subscriptions).toEqual([]);
  });

  it('lists the lines ascending by name ignoring case, then id, whatever the order of the facts', () => {
    const subscriptions = [
      subscriptionFact(1, { name: 'Netflix', price: 100 }),
      subscriptionFact(2, { name: 'netflix', price: 200 }),
      subscriptionFact(3, { name: 'apple', price: 300 }),
      subscriptionFact(4, { name: 'Zoom', price: 400 }),
      subscriptionFact(5, { name: 'Étoile', price: 500 }),
    ];
    for (const order of [subscriptions, [...subscriptions].reverse()]) {
      const ledger = run(makeFacts({ subscriptions: order }), '2026-01');
      expect(monthOf(ledger, '2026-01').subscriptions.map((s) => s.id)).toEqual([3, 5, 1, 2, 4]);
    }
  });

  it("adds yearly and monthly subscriptions into the month's fixed costs", () => {
    const facts = makeFacts({
      startMonth: '2026-10',
      salary: [salary('2026-10', 300000)],
      subscriptions: [
        subscriptionFact(1, { name: 'Netflix', price: 1299, start: '2026-10' }),
        subscriptionFact(2, {
          name: 'Domain',
          frequency: 'yearly',
          anchor: '2025-03-14',
          price: 12000,
          start: '2026-10',
        }),
      ],
    });
    const october = monthOf(run(facts, '2026-10', '2026-10-15'), '2026-10');
    expect(october.subscriptions.map((s) => [s.name, s.charge])).toEqual([
      ['Domain', 2000],
      ['Netflix', 1299],
    ]);
    expect(october.fixedCosts).toBe(3299);
    expect(october.unallocated).toBe(300000 - 3299);
    expectMonthIdentities(october);
  });
});

describe('subscriptions and the identities', () => {
  it('keeps the reserve chain and conservation right across starts, renewals and ends', () => {
    const facts = makeFacts({
      startMonth: '2026-01',
      salary: [salary('2026-01', 200000)],
      subscriptions: [
        subscriptionFact(1, { name: 'Monthly', price: 999, start: '2026-02', end: '2026-09' }),
        subscriptionFact(2, {
          name: 'Yearly A',
          frequency: 'yearly',
          anchor: '2025-06-30',
          price: 10000,
          start: '2026-01',
          priceChanges: [['2026-09', 12500]],
        }),
        subscriptionFact(3, {
          name: 'Yearly B',
          frequency: 'yearly',
          anchor: '2025-11-02',
          price: 7777,
          start: '2026-04',
          end: '2027-02',
        }),
      ],
      budgets: [budgetFact(1, { amount: 50000 })],
    });
    const ledger = run(facts, '2027-06', '2026-08-20');
    ledger.months.forEach((m) => expectMonthIdentities(m));
    expectChainIdentities(ledger.months, { startsAtLedgerStart: true });
  });
});
