/**
 * Which rule `POST /api/transfers` reports, and on which side, when a request breaks several of
 * them, and that a refusal changes nothing (docs/DOMAIN.md, "Transfers", "Creating one"). The doc
 * checks a request in this order:
 *
 *  1. the shape (400);
 *  2. every budget side exists: 422 `unknown_budget`, field `fromBudgetId`, then `toBudgetId`;
 *  3. the date is not before the start month: 422 `before_start_month`, field `date`;
 *  4. every budget side is active in the month of the date: 422 `outside_active_months`, field
 *     `fromBudgetId`, then `toBudgetId`.
 *
 * So the answer is the first rule broken, and when the two sides break the same rule it is the
 * source that is named, whatever the ids. The expected answers below are read off that list, one
 * request at a time, against a world where each side can be made to fail on its own:
 *
 *   start month 2026-01, today 2026-04-15, three budgets
 *   Always: 2026-01 and on        Early: 2026-01 to 2026-02 (archived)        Late: 2026-04 and on
 *
 * so in March (a closed month: transfers may be dated in one) only Always is active; Early has
 * ended and Late has not begun. Budgets 998 and 999 do not exist.
 *
 * Then the two ends of a transfer's life that the balances do not show, from the contract in
 * `shared/src/transfers.ts` and `schemas.ts`: the note (trimmed, up to 1000 characters, blank is
 * null) and `GET /api/transfers` (newest first by date then id, inclusive dates, `month` against
 * `from`/`to`, `budgetId` out of OR into, filters AND-ed), checked at the edges of the months.
 */
import type { BudgetDto, RuleViolationRule } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  expectApiError,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { dumpDb } from '../../testing/db-dump';
import { createTestApp } from '../../testing/test-app';

async function buildWorld() {
  const clock = mutableClock('2026-04-15T10:00:00Z');
  const { app, db } = createTestApp(clock);
  const done = await onboard(app, {
    startMonth: '2026-01',
    salary: 300000,
    openingSavings: 0,
    budgets: [
      { name: 'Always', amount: 10000, incremental: false },
      { name: 'Early', amount: 10000, incremental: false },
    ],
  });
  const [always, early] = done.budgets as [BudgetDto, BudgetDto];
  await request(app)
    .post(`/api/budgets/${early.id}/archive`)
    .send({ endMonth: '2026-02' })
    .expect(200);
  const late = await addBudget(app, {
    name: 'Late',
    amount: 10000,
    incremental: false,
    startMonth: '2026-04',
  });
  const sides = { A: always.id, E: early.id, L: late.id, pool: null, X: 998, Y: 999 };
  return { app, db, sides };
}

/** A side of a transfer: a budget of the world, the pool, or a budget that does not exist (X, Y). */
type Side = 'A' | 'E' | 'L' | 'pool' | 'X' | 'Y';

type Verdict =
  | 'created'
  | { rule: Extract<RuleViolationRule, 'unknown_budget'>; field: 'fromBudgetId' | 'toBudgetId' }
  | { rule: Extract<RuleViolationRule, 'before_start_month'>; field: 'date' }
  | {
      rule: Extract<RuleViolationRule, 'outside_active_months'>;
      field: 'fromBudgetId' | 'toBudgetId';
    };

const unknown = (field: 'fromBudgetId' | 'toBudgetId'): Verdict => ({
  rule: 'unknown_budget',
  field,
});
const early = (): Verdict => ({ rule: 'before_start_month', field: 'date' });
const outside = (field: 'fromBudgetId' | 'toBudgetId'): Verdict => ({
  rule: 'outside_active_months',
  field,
});

describe('the rule a refused transfer breaks, and the side it names', () => {
  // [what the case shows, source, destination, date, verdict]
  const CASES: [string, Side, Side, string, Verdict][] = [
    // Rule 2: a budget that does not exist. The source is looked at first, whatever the ids.
    ['both sides unknown: the source', 'X', 'Y', '2026-03-10', unknown('fromBudgetId')],
    [
      'both sides unknown, ids the other way round: still the source',
      'Y',
      'X',
      '2026-03-10',
      unknown('fromBudgetId'),
    ],
    ['only the destination unknown', 'A', 'Y', '2026-03-10', unknown('toBudgetId')],
    ['only the source unknown', 'X', 'A', '2026-03-10', unknown('fromBudgetId')],
    ['the pool and an unknown destination', 'pool', 'Y', '2026-03-10', unknown('toBudgetId')],
    ['an unknown source and the pool', 'X', 'pool', '2026-03-10', unknown('fromBudgetId')],
    [
      'an unknown source before an inactive destination',
      'X',
      'E',
      '2026-03-10',
      unknown('fromBudgetId'),
    ],
    [
      'an unknown destination beats an inactive source',
      'E',
      'Y',
      '2026-03-10',
      unknown('toBudgetId'),
    ],
    [
      'an unknown budget beats a date before the start month',
      'A',
      'Y',
      '2025-12-10',
      unknown('toBudgetId'),
    ],

    // Rule 3: before the start month, which is reported before the months the budgets are active in.
    [
      'the day before the start month, budgets that are not active either',
      'A',
      'E',
      '2025-12-31',
      early(),
    ],
    ['a long way before the start month, from the pool', 'pool', 'L', '2025-06-01', early()],
    ['before the start month, to the pool', 'L', 'pool', '2025-12-15', early()],
    ['the first day of the start month is fine', 'A', 'E', '2026-01-01', 'created'],
    ['the last day of that month is fine too', 'A', 'E', '2026-01-31', 'created'],

    // Rule 4: a budget that is not active in the month. Both sides at fault: the source.
    [
      'both inactive (ended, not begun): the source',
      'E',
      'L',
      '2026-03-10',
      outside('fromBudgetId'),
    ],
    [
      'both inactive, the other way round: still the source',
      'L',
      'E',
      '2026-03-10',
      outside('fromBudgetId'),
    ],
    ['only the source inactive (ended)', 'E', 'A', '2026-03-10', outside('fromBudgetId')],
    ['only the destination inactive (ended)', 'A', 'E', '2026-03-10', outside('toBudgetId')],
    ['only the destination inactive (not begun)', 'A', 'L', '2026-03-10', outside('toBudgetId')],
    ['only the source inactive (not begun)', 'L', 'A', '2026-03-10', outside('fromBudgetId')],
    ['from the pool to an inactive budget', 'pool', 'E', '2026-03-10', outside('toBudgetId')],
    ['from an inactive budget to the pool', 'E', 'pool', '2026-03-10', outside('fromBudgetId')],
    [
      'the last day of the month before a budget begins',
      'pool',
      'L',
      '2026-03-31',
      outside('toBudgetId'),
    ],
    [
      'the day before a budget begins, from an active one',
      'A',
      'L',
      '2026-03-31',
      outside('toBudgetId'),
    ],
    ['the first day of the month a budget begins', 'A', 'L', '2026-04-01', 'created'],
    ['the first day after a budget has ended', 'E', 'A', '2026-03-01', outside('fromBudgetId')],
    ['the last day of the month a budget ends in', 'A', 'E', '2026-02-28', 'created'],
    [
      'months later: the one that ended is the source',
      'E',
      'L',
      '2026-05-20',
      outside('fromBudgetId'),
    ],
    [
      'months later: the one that ended is the destination',
      'L',
      'E',
      '2026-05-20',
      outside('toBudgetId'),
    ],
    [
      'in a future month the one that ended is still outside',
      'E',
      'A',
      '2026-09-30',
      outside('fromBudgetId'),
    ],
    ['in a future month an open budget is inside', 'A', 'L', '2026-09-30', 'created'],
  ];

  it.each(CASES)('%s', async (_what, from, to, date, verdict) => {
    const { app, db, sides } = await buildWorld();
    const before = dumpDb(db);
    const body = { date, fromBudgetId: sides[from], toBudgetId: sides[to], amount: 1000 };
    const res = await request(app).post('/api/transfers').send(body);

    if (verdict === 'created') {
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject(body);
      const listed = await request(app).get('/api/transfers').expect(200);
      expect(listed.body).toEqual([res.body]);
      return;
    }
    expectRuleViolation(res, verdict.rule, verdict.field);
    // A refusal stores nothing and changes nothing.
    expect(dumpDb(db)).toBe(before);
    expect((await request(app).get('/api/transfers').expect(200)).body).toEqual([]);
  });
});

describe('the shape is checked before any rule', () => {
  // A request that is badly formed is a 400, whatever else is wrong with it.
  type Sides = Awaited<ReturnType<typeof buildWorld>>['sides'];
  const CASES: [string, (sides: Sides) => Record<string, unknown>][] = [
    [
      'an amount of zero, and an unknown source',
      (s) => ({ date: '2026-03-10', fromBudgetId: s.X, toBudgetId: s.A, amount: 0 }),
    ],
    [
      'a negative amount, and a date before the start month',
      (s) => ({ date: '2025-01-01', fromBudgetId: s.A, toBudgetId: s.L, amount: -5 }),
    ],
    [
      'the same budget on both sides, though it is not active in the month',
      (s) => ({ date: '2026-03-10', fromBudgetId: s.E, toBudgetId: s.E, amount: 1000 }),
    ],
    [
      'the pool on both sides, and a date before the start month',
      () => ({ date: '2025-01-01', fromBudgetId: null, toBudgetId: null, amount: 1000 }),
    ],
    [
      'a destination left out, and an unknown source',
      (s) => ({ date: '2026-03-10', fromBudgetId: s.X, amount: 1000 }),
    ],
    [
      'a source left out, and an inactive destination',
      (s) => ({ date: '2026-03-10', toBudgetId: s.E, amount: 1000 }),
    ],
    [
      'a date that is not a day, and an unknown destination',
      (s) => ({ date: '2026-03-32', fromBudgetId: s.A, toBudgetId: s.Y, amount: 1000 }),
    ],
  ];

  it.each(CASES)('%s', async (_what, bodyOf) => {
    const { app, db, sides } = await buildWorld();
    const before = dumpDb(db);
    const res = await request(app).post('/api/transfers').send(bodyOf(sides));
    expectApiError(res, 'validation_error');
    expect(dumpDb(db)).toBe(before);
  });
});

describe('the note of a transfer', () => {
  // "Free text: trimmed, up to 1000 characters. Empty or blank text becomes null." The length that
  // counts is the one once trimmed.
  const x = (n: number) => 'x'.repeat(n);
  const CASES: [string, Record<string, unknown>, string | null | 400][] = [
    ['left out', {}, null],
    ['null', { note: null }, null],
    ['empty', { note: '' }, null],
    ['blank', { note: '   ' }, null],
    ['with spaces around it', { note: '  memo ' }, 'memo'],
    ['with spaces inside', { note: ' two  words ' }, 'two  words'],
    ['1000 characters', { note: x(1000) }, x(1000)],
    ['1000 characters and spaces around them', { note: ` ${x(1000)} ` }, x(1000)],
    ['1001 characters', { note: x(1001) }, 400],
  ];

  it.each(CASES)('%s', async (_what, extra, stored) => {
    const { app, sides } = await buildWorld();
    const body = {
      date: '2026-03-10',
      fromBudgetId: sides.A,
      toBudgetId: null,
      amount: 1000,
      ...extra,
    };
    const res = await request(app).post('/api/transfers').send(body);
    if (stored === 400) {
      expectApiError(res, 'validation_error');
      expect((await request(app).get('/api/transfers').expect(200)).body).toEqual([]);
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.note).toBe(stored);
    const listed = (await request(app).get('/api/transfers').expect(200)).body;
    expect(listed).toEqual([res.body]);
  });
});

describe('listing transfers', () => {
  /**
   * Six transfers between two budgets (A, B) and the pool, with the ids they get in this order:
   *
   *   1  2026-02-28  A to B       100.00   the last day of February
   *   2  2026-03-01  B to A       200.00   the first day of March
   *   3  2026-03-15  pool to A    300.00
   *   4  2026-03-31  A to pool    400.00   the last day of March
   *   5  2026-04-01  pool to B    500.00   the first day of April
   *   6  2026-03-31  B to A       600.00   the same day as 4, entered after it
   *
   * "Newest first (date, then id, descending)": 5, 6, 4, 3, 2, 1. A filter keeps the order.
   */
  async function listWorld() {
    const clock = mutableClock('2026-04-15T10:00:00Z');
    const { app } = createTestApp(clock);
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 300000,
      openingSavings: 0,
      budgets: [
        { name: 'A', amount: 10000, incremental: false },
        { name: 'B', amount: 10000, incremental: false },
      ],
    });
    const [a, b] = done.budgets as [BudgetDto, BudgetDto];
    const entries: [string, number | null, number | null, number][] = [
      ['2026-02-28', a.id, b.id, 10000],
      ['2026-03-01', b.id, a.id, 20000],
      ['2026-03-15', null, a.id, 30000],
      ['2026-03-31', a.id, null, 40000],
      ['2026-04-01', null, b.id, 50000],
      ['2026-03-31', b.id, a.id, 60000],
    ];
    for (const [date, fromBudgetId, toBudgetId, amount] of entries) {
      await request(app)
        .post('/api/transfers')
        .send({ date, fromBudgetId, toBudgetId, amount })
        .expect(201);
    }
    return { app, a: a.id, b: b.id };
  }

  const idsOf = async (app: Awaited<ReturnType<typeof listWorld>>['app'], query: string) =>
    ((await request(app).get(`/api/transfers${query}`).expect(200)).body as { id: number }[]).map(
      (transfer) => transfer.id,
    );

  it('lists everything newest first, and a tie on the date goes to the later id', async () => {
    const { app } = await listWorld();
    expect(await idsOf(app, '')).toEqual([5, 6, 4, 3, 2, 1]);
  });

  it('month: from its first day to its last, and nothing of the days beside it', async () => {
    const { app } = await listWorld();
    expect(await idsOf(app, '?month=2026-03')).toEqual([6, 4, 3, 2]);
    expect(await idsOf(app, '?month=2026-02')).toEqual([1]);
    expect(await idsOf(app, '?month=2026-04')).toEqual([5]);
    // A month with nothing in it, inside or outside the tracked range, is an empty list.
    expect(await idsOf(app, '?month=2026-05')).toEqual([]);
    expect(await idsOf(app, '?month=2025-12')).toEqual([]);
  });

  it('from and to are both inclusive', async () => {
    const { app } = await listWorld();
    expect(await idsOf(app, '?from=2026-03-01&to=2026-03-31')).toEqual([6, 4, 3, 2]);
    expect(await idsOf(app, '?from=2026-03-31')).toEqual([5, 6, 4]);
    expect(await idsOf(app, '?to=2026-02-28')).toEqual([1]);
    expect(await idsOf(app, '?to=2026-03-01')).toEqual([2, 1]);
    expect(await idsOf(app, '?from=2026-03-02&to=2026-03-30')).toEqual([3]);
    expect(await idsOf(app, '?from=2026-03-31&to=2026-03-31')).toEqual([6, 4]);
    expect(await idsOf(app, '?from=2026-03-16&to=2026-03-30')).toEqual([]);
  });

  it('budgetId keeps the transfers out of it and into it, and none for a budget there is not', async () => {
    const { app, a, b } = await listWorld();
    expect(await idsOf(app, `?budgetId=${a}`)).toEqual([6, 4, 3, 2, 1]);
    expect(await idsOf(app, `?budgetId=${b}`)).toEqual([5, 6, 2, 1]);
    expect(await idsOf(app, '?budgetId=999')).toEqual([]);
  });

  it('the filters are AND-ed', async () => {
    const { app, a, b } = await listWorld();
    expect(await idsOf(app, `?budgetId=${a}&month=2026-03`)).toEqual([6, 4, 3, 2]);
    expect(await idsOf(app, `?budgetId=${b}&month=2026-03`)).toEqual([6, 2]);
    expect(await idsOf(app, `?budgetId=${b}&from=2026-03-31`)).toEqual([5, 6]);
    expect(await idsOf(app, `?budgetId=${a}&month=2026-04`)).toEqual([]);
  });

  it.each([
    ['month together with from', '?month=2026-03&from=2026-03-01'],
    ['month together with to', '?month=2026-03&to=2026-03-31'],
    ['from after to', '?from=2026-03-31&to=2026-03-01'],
    ['a month that is not one', '?month=2026-13'],
    ['a date that is not one', '?from=2026-02-30'],
    ['a budget id of zero', '?budgetId=0'],
    ['a budget id that is not a number', '?budgetId=a'],
    ['a filter the list does not have', '?kind=transfer'],
  ])('is a 400, and no list: %s', async (_what, query) => {
    const { app } = await listWorld();
    expectApiError(await request(app).get(`/api/transfers${query}`), 'validation_error');
  });
});
