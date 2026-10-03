import { describe, expect, it } from 'vitest';
import { MAX_CENTS } from './limits';
import {
  MAX_TAGS_PER_SPENDING,
  SPENDINGS_DEFAULT_LIMIT,
  SPENDINGS_MAX_LIMIT,
  SPENDING_SEARCH_MAX_LENGTH,
  spendingCreateSchema,
  spendingListQuerySchema,
  spendingUpdateSchema,
} from './spendings';
import { chars, parseCases, schemaCases } from './test-utils';

const lunch = { date: '2026-10-02', amount: 1250, budgetId: 3, description: 'Lunch' };

/** `[1, 2, ..., n]`: n distinct tag ids. */
const tagIds = (n: number): number[] => Array.from({ length: n }, (_unused, index) => index + 1);

describe('spending schemas', () => {
  schemaCases(
    'spendingCreateSchema (POST /api/spendings)',
    spendingCreateSchema,
    [
      ['a full body', { ...lunch, notes: 'with Sam', tagIds: [2, 5] }],
      ['without a description', { date: '2026-10-02', amount: 1250, budgetId: 3 }],
      ['an empty description', { ...lunch, description: '' }],
      ['a refund', { ...lunch, amount: -1250 }],
      ['null notes', { ...lunch, notes: null }],
      ['the longest description', { ...lunch, description: chars(200) }],
      ['no tags (omitted)', lunch],
      ['no tags (empty list)', { ...lunch, tagIds: [] }],
      ['one tag', { ...lunch, tagIds: [4] }],
      ['tags in any order', { ...lunch, tagIds: [9, 2, 5] }],
      ['the most tags', { ...lunch, tagIds: tagIds(MAX_TAGS_PER_SPENDING) }],
    ],
    [
      ['an empty body', {}, 'date'],
      ['a missing date', { ...lunch, date: undefined }, 'date'],
      ['a bad date', { ...lunch, date: '2026-04-31' }, 'date'],
      ['a missing amount', { ...lunch, amount: undefined }, 'amount'],
      ['a zero amount', { ...lunch, amount: 0 }, 'amount'],
      ['a fractional amount', { ...lunch, amount: 12.5 }, 'amount'],
      ['a string amount', { ...lunch, amount: '12.50' }, 'amount'],
      ['a missing budgetId', { ...lunch, budgetId: undefined }, 'budgetId'],
      ['a zero budgetId', { ...lunch, budgetId: 0 }, 'budgetId'],
      ['a string budgetId', { ...lunch, budgetId: '3' }, 'budgetId'],
      ['a boolean budgetId', { ...lunch, budgetId: true }, 'budgetId'],
      ['a too long description', { ...lunch, description: chars(201) }, 'description'],
      ['too long notes', { ...lunch, notes: chars(1001) }, 'notes'],
      ['an unknown key', { ...lunch, tags: [1] }, ''],
      ['too many tags', { ...lunch, tagIds: tagIds(MAX_TAGS_PER_SPENDING + 1) }, 'tagIds'],
      ['the same tag twice', { ...lunch, tagIds: [3, 3] }, 'tagIds.1'],
      ['a tag repeated after another one', { ...lunch, tagIds: [1, 2, 1] }, 'tagIds.2'],
      ['null tagIds (an empty list clears)', { ...lunch, tagIds: null }, 'tagIds'],
      ['a number as tagIds', { ...lunch, tagIds: 4 }, 'tagIds'],
      ['an object as tagIds', { ...lunch, tagIds: { 0: 4 } }, 'tagIds'],
      ['a string tag id', { ...lunch, tagIds: ['4'] }, 'tagIds.0'],
      ['a zero tag id', { ...lunch, tagIds: [2, 0] }, 'tagIds.1'],
      ['a negative tag id', { ...lunch, tagIds: [-1] }, 'tagIds.0'],
      ['a fractional tag id', { ...lunch, tagIds: [1.5] }, 'tagIds.0'],
      ['a null tag id', { ...lunch, tagIds: [null] }, 'tagIds.0'],
    ],
  );
  parseCases('spendingCreateSchema output', spendingCreateSchema, [
    [
      'trims text and nulls blank notes',
      { ...lunch, description: ' Lunch ', notes: ' ' },
      { ...lunch, notes: null },
    ],
    [
      'leaves the description out when omitted',
      { date: '2026-10-02', amount: 5, budgetId: 1 },
      { date: '2026-10-02', amount: 5, budgetId: 1 },
    ],
    ['leaves the tags out when omitted (the server defaults them to none)', lunch, lunch],
    [
      'keeps the tags in the order sent (the response is ascending)',
      { ...lunch, tagIds: [9, 2, 5] },
      { ...lunch, tagIds: [9, 2, 5] },
    ],
  ]);

  schemaCases(
    'spendingUpdateSchema (PATCH /api/spendings/:id)',
    spendingUpdateSchema,
    [
      ['only the date', { date: '2026-10-03' }],
      ['only the amount', { amount: -500 }],
      ['only the budget', { budgetId: 4 }],
      ['only the description', { description: '' }],
      ['clearing the notes', { notes: null }],
      ['every field', { ...lunch, notes: 'x', tagIds: [1] }],
      ['only the tags', { tagIds: [4, 2] }],
      ['clearing every tag', { tagIds: [] }],
      ['the most tags', { tagIds: tagIds(MAX_TAGS_PER_SPENDING) }],
    ],
    [
      ['an empty body', {}, ''],
      ['a bad date', { date: '2026-10' }, 'date'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['a bad budgetId', { budgetId: -1 }, 'budgetId'],
      ['null description', { description: null }, 'description'],
      ['an unknown key', { id: 5 }, ''],
      ['too many tags', { tagIds: tagIds(MAX_TAGS_PER_SPENDING + 1) }, 'tagIds'],
      ['the same tag twice', { tagIds: [7, 1, 7] }, 'tagIds.2'],
      ['null tagIds', { tagIds: null }, 'tagIds'],
      ['a string tag id', { tagIds: ['1'] }, 'tagIds.0'],
      ['a zero tag id', { tagIds: [0] }, 'tagIds.0'],
      ['an unknown key next to tagIds', { tagIds: [1], tagId: 1 }, ''],
    ],
  );
  parseCases('spendingUpdateSchema output', spendingUpdateSchema, [
    ['keeps an empty tag list (it clears the tags)', { tagIds: [] }, { tagIds: [] }],
    ['leaves the tags out when omitted (they stay as they are)', { amount: 5 }, { amount: 5 }],
  ]);

  schemaCases(
    'spendingListQuerySchema (GET /api/spendings)',
    spendingListQuerySchema,
    [
      ['no filter', {}],
      ['a month', { month: '2026-10' }],
      ['a date range', { from: '2026-10-01', to: '2026-10-31' }],
      ['a one-day range', { from: '2026-10-02', to: '2026-10-02' }],
      ['only from', { from: '2026-10-01' }],
      ['only to', { to: '2026-10-31' }],
      ['a budget (as in a query string)', { budgetId: '3' }],
      ['the largest page', { limit: String(SPENDINGS_MAX_LIMIT) }],
      ['the smallest page', { limit: '1' }],
      ['a numeric limit and offset', { limit: 20, offset: 40 }],
      [
        'every filter but month',
        { from: '2026-01-01', to: '2026-12-31', budgetId: '2', limit: '10', offset: '0' },
      ],
      ['a tag (as in a query string)', { tagId: '7' }],
      ['a numeric tag', { tagId: 7 }],
      ['a search', { q: 'coffee' }],
      ['a search with spaces inside', { q: 'coffee shop' }],
      ['a search with the LIKE wildcards (they are plain characters)', { q: '50%_off' }],
      ['a search with non-ASCII letters', { q: 'caffè' }],
      ['a one-character search', { q: 'a' }],
      ['the longest search', { q: chars(SPENDING_SEARCH_MAX_LENGTH) }],
      ['the longest search with spaces around it', { q: ` ${chars(SPENDING_SEARCH_MAX_LENGTH)} ` }],
      ['a minimum amount', { minAmount: '1000' }],
      ['a maximum amount', { maxAmount: '5000' }],
      ['a negative minimum (refunds up to a size)', { minAmount: '-5000' }],
      ['only refunds', { maxAmount: '-1' }],
      ['no refunds', { minAmount: '0' }],
      ['an amount range', { minAmount: '1000', maxAmount: '5000' }],
      ['a range of one amount', { minAmount: '1250', maxAmount: '1250' }],
      ['a range of refunds', { minAmount: '-5000', maxAmount: '-1000' }],
      ['a range around zero', { minAmount: '-500', maxAmount: '500' }],
      ['numeric amounts', { minAmount: -500, maxAmount: 500 }],
      ['the largest amounts', { minAmount: String(-MAX_CENTS), maxAmount: String(MAX_CENTS) }],
      [
        'every filter together',
        {
          from: '2026-01-01',
          to: '2026-12-31',
          budgetId: '2',
          tagId: '3',
          q: 'lunch',
          minAmount: '100',
          maxAmount: '9900',
          limit: '10',
          offset: '20',
        },
      ],
    ],
    [
      ['a bad month', { month: '2026-13' }, 'month'],
      ['month together with from', { month: '2026-10', from: '2026-10-01' }, 'month'],
      ['month together with to', { month: '2026-10', to: '2026-10-31' }, 'month'],
      ['from after to', { from: '2026-10-31', to: '2026-10-01' }, 'to'],
      ['a bad from', { from: '2026-10' }, 'from'],
      ['a bad to', { to: 'today' }, 'to'],
      ['a zero budgetId', { budgetId: '0' }, 'budgetId'],
      ['a text budgetId', { budgetId: 'food' }, 'budgetId'],
      ['a zero limit', { limit: '0' }, 'limit'],
      ['a limit above the maximum', { limit: String(SPENDINGS_MAX_LIMIT + 1) }, 'limit'],
      ['a text limit', { limit: 'many' }, 'limit'],
      ['an empty limit', { limit: '' }, 'limit'],
      ['a fractional limit', { limit: '1.5' }, 'limit'],
      ['a negative offset', { offset: '-1' }, 'offset'],
      ['a text offset', { offset: 'x' }, 'offset'],
      ['an unknown filter', { search: 'coffee' }, ''],
      ['an unknown filter next to a real one', { month: '2026-10', tag: '3' }, ''],
      ['a zero tagId', { tagId: '0' }, 'tagId'],
      ['a negative tagId', { tagId: '-2' }, 'tagId'],
      ['a text tagId', { tagId: 'food' }, 'tagId'],
      ['a fractional tagId', { tagId: '1.5' }, 'tagId'],
      ['an empty tagId', { tagId: '' }, 'tagId'],
      ['an empty search', { q: '' }, 'q'],
      ['a blank search', { q: '   ' }, 'q'],
      ['a search above the maximum', { q: chars(SPENDING_SEARCH_MAX_LENGTH + 1) }, 'q'],
      ['a search repeated in the query string', { q: ['coffee', 'tea'] }, 'q'],
      ['a numeric search', { q: 5 }, 'q'],
      ['an empty minAmount (not 0)', { minAmount: '' }, 'minAmount'],
      ['a blank minAmount (not 0)', { minAmount: ' ' }, 'minAmount'],
      ['an empty maxAmount (not 0)', { maxAmount: '' }, 'maxAmount'],
      ['a text minAmount', { minAmount: 'cheap' }, 'minAmount'],
      ['a decimal minAmount (whole cents only)', { minAmount: '12.50' }, 'minAmount'],
      ['a fractional numeric minAmount', { minAmount: 12.5 }, 'minAmount'],
      ['an exponent minAmount', { minAmount: '1e3' }, 'minAmount'],
      ['a hex minAmount', { minAmount: '0x10' }, 'minAmount'],
      ['a minAmount with a plus sign', { minAmount: '+5' }, 'minAmount'],
      ['a minAmount with leading zeros', { minAmount: '007' }, 'minAmount'],
      ['a minAmount with spaces around it', { minAmount: ' 5 ' }, 'minAmount'],
      ['a negative zero minAmount', { minAmount: '-0' }, 'minAmount'],
      ['a null minAmount', { minAmount: null }, 'minAmount'],
      ['a boolean maxAmount', { maxAmount: true }, 'maxAmount'],
      ['a minAmount repeated in the query string', { minAmount: ['1', '2'] }, 'minAmount'],
      ['a minAmount above the cap', { minAmount: String(MAX_CENTS + 1) }, 'minAmount'],
      ['a maxAmount below the cap', { maxAmount: String(-MAX_CENTS - 1) }, 'maxAmount'],
      ['minAmount above maxAmount', { minAmount: '5000', maxAmount: '1000' }, 'maxAmount'],
      ['minAmount just above maxAmount', { minAmount: '0', maxAmount: '-1' }, 'maxAmount'],
      [
        'a refund range the wrong way round',
        { minAmount: '-1000', maxAmount: '-5000' },
        'maxAmount',
      ],
    ],
  );
  parseCases('spendingListQuerySchema output', spendingListQuerySchema, [
    ['applies the defaults', {}, { limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 }],
    [
      'coerces query strings to numbers',
      { budgetId: '3', limit: '10', offset: '20', month: '2026-10' },
      { budgetId: 3, limit: 10, offset: 20, month: '2026-10' },
    ],
    [
      'reads the tag and the signed amounts as numbers',
      { tagId: '7', minAmount: '-500', maxAmount: '1250' },
      { tagId: 7, minAmount: -500, maxAmount: 1250, limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 },
    ],
    [
      'reads 0 as a bound, so it can be told from no bound',
      { minAmount: '0', maxAmount: '0' },
      { minAmount: 0, maxAmount: 0, limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 },
    ],
    [
      'keeps numbers as they are',
      { minAmount: -500, maxAmount: 500 },
      { minAmount: -500, maxAmount: 500, limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 },
    ],
    [
      'trims the search and keeps the wildcards and the inner spaces as they are',
      { q: '  50%_off  deal ' },
      { q: '50%_off  deal', limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 },
    ],
    [
      'leaves a filter out when it is omitted',
      { month: '2026-10' },
      { month: '2026-10', limit: SPENDINGS_DEFAULT_LIMIT, offset: 0 },
    ],
  ]);

  it('has the documented limits', () => {
    expect(SPENDINGS_DEFAULT_LIMIT).toBe(50);
    expect(SPENDINGS_MAX_LIMIT).toBe(200);
    expect(MAX_TAGS_PER_SPENDING).toBe(10);
    expect(SPENDING_SEARCH_MAX_LENGTH).toBe(100);
  });
});
