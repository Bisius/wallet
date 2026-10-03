import { describe, expect, it } from 'vitest';
import { MAX_CENTS } from './limits';
import { chars, parseCases, schemaCases } from './test-utils';
import { type TransferDto, transferCreateSchema, transferListQuerySchema } from './transfers';

const budgetToBudget = { date: '2026-10-02', fromBudgetId: 1, toBudgetId: 2, amount: 2500 };
const poolToBudget = { ...budgetToBudget, fromBudgetId: null };
const budgetToPool = { ...budgetToBudget, toBudgetId: null };

describe('transferCreateSchema (POST /api/transfers)', () => {
  schemaCases(
    'body',
    transferCreateSchema,
    [
      ['a transfer between two budgets', budgetToBudget],
      ['a transfer from the pool to a budget', poolToBudget],
      ['a transfer from a budget to the pool', budgetToPool],
      ['a note', { ...budgetToBudget, note: 'Birthday dinner went over' }],
      ['a null note', { ...budgetToBudget, note: null }],
      ['the longest note', { ...budgetToBudget, note: chars(1000) }],
      ['one cent', { ...budgetToBudget, amount: 1 }],
      ['the largest amount', { ...budgetToBudget, amount: MAX_CENTS }],
      ['the first of a month', { ...budgetToBudget, date: '2026-10-01' }],
      ['the last day of February', { ...budgetToBudget, date: '2028-02-29' }],
      // The schema cannot know the clock, the start month or the budgets' ranges: a date in the
      // past or the future is the server's business (422), not a 400.
      ['a date long ago (a closed month)', { ...budgetToBudget, date: '2001-01-31' }],
      ['a date far ahead (a future month)', { ...budgetToBudget, date: '2099-12-31' }],
      [
        'ids of budgets that do not exist (a 422 unknown_budget, not a 400)',
        { ...budgetToBudget, fromBudgetId: 999_999, toBudgetId: 1_000_000 },
      ],
    ],
    [
      ['an empty body', {}, 'date'],
      ['a missing date (it is not defaulted)', { ...budgetToBudget, date: undefined }, 'date'],
      ['a null date', { ...budgetToBudget, date: null }, 'date'],
      ['a date that does not exist', { ...budgetToBudget, date: '2026-02-30' }, 'date'],
      ['a month as date', { ...budgetToBudget, date: '2026-10' }, 'date'],
      ['a text date', { ...budgetToBudget, date: 'today' }, 'date'],
      [
        'a missing source (an omitted side is not the pool)',
        { ...budgetToBudget, fromBudgetId: undefined },
        'fromBudgetId',
      ],
      [
        'a missing destination (an omitted side is not the pool)',
        { ...budgetToBudget, toBudgetId: undefined },
        'toBudgetId',
      ],
      ['a source that is 0', { ...budgetToBudget, fromBudgetId: 0 }, 'fromBudgetId'],
      ['a negative source', { ...budgetToBudget, fromBudgetId: -1 }, 'fromBudgetId'],
      ['a fractional source', { ...budgetToBudget, fromBudgetId: 1.5 }, 'fromBudgetId'],
      ['a string source', { ...budgetToBudget, fromBudgetId: '1' }, 'fromBudgetId'],
      ['a boolean source', { ...budgetToBudget, fromBudgetId: false }, 'fromBudgetId'],
      ['a destination that is 0', { ...budgetToBudget, toBudgetId: 0 }, 'toBudgetId'],
      ['a string destination', { ...budgetToBudget, toBudgetId: '2' }, 'toBudgetId'],
      ['a boolean destination', { ...budgetToBudget, toBudgetId: true }, 'toBudgetId'],
      [
        'the pool on both sides (no budget at all)',
        { ...budgetToBudget, fromBudgetId: null, toBudgetId: null },
        'toBudgetId',
      ],
      ['the same budget on both sides', { ...budgetToBudget, toBudgetId: 1 }, 'toBudgetId'],
      ['a missing amount', { ...budgetToBudget, amount: undefined }, 'amount'],
      ['a zero amount', { ...budgetToBudget, amount: 0 }, 'amount'],
      [
        'a negative amount (the direction is the sides)',
        { ...budgetToBudget, amount: -2500 },
        'amount',
      ],
      ['a fractional amount', { ...budgetToBudget, amount: 12.5 }, 'amount'],
      ['a string amount', { ...budgetToBudget, amount: '25.00' }, 'amount'],
      ['a null amount', { ...budgetToBudget, amount: null }, 'amount'],
      ['an amount above the cap', { ...budgetToBudget, amount: MAX_CENTS + 1 }, 'amount'],
      ['a too long note', { ...budgetToBudget, note: chars(1001) }, 'note'],
      ['a numeric note', { ...budgetToBudget, note: 5 }, 'note'],
      ['an unknown key', { ...budgetToBudget, kind: 'transfer' }, ''],
      ['a month in the body', { ...budgetToBudget, month: '2026-10' }, ''],
      ['an id in the body', { ...budgetToBudget, id: 7 }, ''],
      [
        'a budget id under another name',
        { date: '2026-10-02', amount: 5, budgetId: 1 },
        'fromBudgetId',
      ],
    ],
  );

  parseCases('output', transferCreateSchema, [
    [
      'keeps a transfer between two budgets as sent (an omitted note stays out)',
      budgetToBudget,
      budgetToBudget,
    ],
    ['keeps the pool side as null', poolToBudget, poolToBudget],
    ['keeps the pool side as null (destination)', budgetToPool, budgetToPool],
    [
      'trims the note and turns a blank one into null',
      { ...budgetToBudget, note: ' ' },
      { ...budgetToBudget, note: null },
    ],
    ['trims a note', { ...budgetToBudget, note: ' Rent ' }, { ...budgetToBudget, note: 'Rent' }],
  ]);

  it('puts the cross-field issues on the destination, whichever kind of mistake it is', () => {
    const paths = (input: unknown) =>
      transferCreateSchema.safeParse(input).error?.issues.map((issue) => issue.path.join('.'));
    expect(paths({ ...budgetToBudget, fromBudgetId: null, toBudgetId: null })).toEqual([
      'toBudgetId',
    ]);
    expect(paths({ ...budgetToBudget, fromBudgetId: 4, toBudgetId: 4 })).toEqual(['toBudgetId']);
  });
});

describe('transferListQuerySchema (GET /api/transfers)', () => {
  schemaCases(
    'query',
    transferListQuerySchema,
    [
      ['no filter', {}],
      ['a month', { month: '2026-10' }],
      ['a date range', { from: '2026-10-01', to: '2026-10-31' }],
      ['a one-day range', { from: '2026-10-02', to: '2026-10-02' }],
      ['only from', { from: '2026-10-01' }],
      ['only to', { to: '2026-10-31' }],
      ['a budget (as in a query string)', { budgetId: '3' }],
      ['a numeric budget', { budgetId: 3 }],
      ['a month and a budget', { month: '2026-10', budgetId: '3' }],
      ['a range and a budget', { from: '2026-01-01', to: '2026-12-31', budgetId: '2' }],
    ],
    [
      ['a bad month', { month: '2026-13' }, 'month'],
      ['month together with from', { month: '2026-10', from: '2026-10-01' }, 'month'],
      ['month together with to', { month: '2026-10', to: '2026-10-31' }, 'month'],
      ['from after to', { from: '2026-10-31', to: '2026-10-01' }, 'to'],
      ['a bad from', { from: '2026-10' }, 'from'],
      ['a bad to', { to: 'today' }, 'to'],
      ['a zero budgetId', { budgetId: '0' }, 'budgetId'],
      ['a negative budgetId', { budgetId: '-1' }, 'budgetId'],
      ['a text budgetId', { budgetId: 'food' }, 'budgetId'],
      ['a fractional budgetId', { budgetId: '1.5' }, 'budgetId'],
      ['an empty budgetId', { budgetId: '' }, 'budgetId'],
      ['no paging (the list is not paged)', { limit: '10' }, ''],
      ['no offset (the list is not paged)', { offset: '0' }, ''],
      ['no search (it is a spendings filter)', { q: 'rent' }, ''],
      ['an unknown filter', { fromBudgetId: '1' }, ''],
    ],
  );
  parseCases('output', transferListQuerySchema, [
    ['applies no default', {}, {}],
    [
      'coerces the budget to a number',
      { month: '2026-10', budgetId: '3' },
      { month: '2026-10', budgetId: 3 },
    ],
  ]);
});

// ---------------------------------------------------------------------------------------------
// A worked example of the three kinds of transfer in one month. It type-checks the DTOs and
// asserts invariant 8 of docs/DOMAIN.md on small numbers, so it doubles as documentation for the
// frontend and as a template for the backend tests.
//
// October 2026. Budgets 1 (Groceries) and 2 (Fun). Three transfers:
//  - 25.00 from Groceries to Fun (between two budgets),
//  - 40.00 from the pool to Groceries,
//  - 10.00 from Fun back to the pool.
// ---------------------------------------------------------------------------------------------

const october: TransferDto[] = [
  { id: 1, date: '2026-10-02', fromBudgetId: 1, toBudgetId: 2, amount: 2500, note: null },
  { id: 2, date: '2026-10-05', fromBudgetId: null, toBudgetId: 1, amount: 4000, note: 'Party' },
  { id: 3, date: '2026-10-09', fromBudgetId: 2, toBudgetId: null, amount: 1000, note: null },
];

/**
 * What a month's transfers do to each budget (`transfersNet`) and to the pool (the change in
 * `unallocated`).
 */
function effectOf(transfers: readonly TransferDto[]) {
  const transfersNet = new Map<number, number>();
  let unallocatedChange = 0;
  const add = (budgetId: number, cents: number) =>
    transfersNet.set(budgetId, (transfersNet.get(budgetId) ?? 0) + cents);
  for (const { fromBudgetId, toBudgetId, amount } of transfers) {
    if (fromBudgetId === null) unallocatedChange -= amount;
    else add(fromBudgetId, -amount);
    if (toBudgetId === null) unallocatedChange += amount;
    else add(toBudgetId, amount);
  }
  const totalsTransfersNet = [...transfersNet.values()].reduce((sum, cents) => sum + cents, 0);
  return { transfersNet, unallocatedChange, totalsTransfersNet };
}

describe('TransferDto worked example (2026-10)', () => {
  it('moves each budget by what came in minus what went out', () => {
    const { transfersNet } = effectOf(october);
    expect(transfersNet.get(1)).toBe(-2500 + 4000);
    expect(transfersNet.get(2)).toBe(2500 - 1000);
  });

  it('invariant 8: the budgets net to the pool-to-budget minus the budget-to-pool transfers', () => {
    const { totalsTransfersNet, unallocatedChange } = effectOf(october);
    const poolToBudgets = 4000;
    const budgetsToPool = 1000;
    expect(totalsTransfersNet).toBe(poolToBudgets - budgetsToPool);
    // MonthView: unallocated = income - fixedCosts - allocated - totals.transfersNet.
    expect(unallocatedChange).toBe(-totalsTransfersNet);
  });

  it('a transfer between two budgets changes no total of the month', () => {
    const { totalsTransfersNet, unallocatedChange } = effectOf([october[0]!]);
    expect(totalsTransfersNet).toBe(0);
    expect(unallocatedChange).toBe(0);
  });

  it('is listed newest first: date, then id, descending', () => {
    const newestFirst = [...october].sort((a, b) =>
      a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
    );
    expect(newestFirst.map((transfer) => transfer.id)).toEqual([3, 2, 1]);
  });

  it('never has two pool sides or the same budget on both sides', () => {
    for (const { fromBudgetId, toBudgetId, amount } of october) {
      expect(fromBudgetId === null && toBudgetId === null).toBe(false);
      expect(fromBudgetId !== null && fromBudgetId === toBudgetId).toBe(false);
      expect(amount).toBeGreaterThan(0);
    }
  });
});
