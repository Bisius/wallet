/**
 * Pins the naive search reference (`search-model.ts`) to a handful of hand-made cases, each answer
 * read off docs/DOMAIN.md ("Tags and search"), so that a disagreement between the reference and the
 * API in the model-based test can be read as the API's.
 *
 *   id  date        amount  budget  description    notes       tags
 *    1  2026-01-31    -500       1  Refund: Mug    -           1
 *    2  2026-02-01    1000       1  Coffee         with Sam    1, 2
 *    3  2026-02-01    2500       2  coffee beans   -           -
 *    4  2026-02-15     100       1  100% juice     a_b         2
 *    5  2026-03-01       7       2  (empty)        COFFEE      1
 *
 * Newest first is date, then id, descending: 5, 4, 3, 2, 1.
 */
import { describe, expect, it } from 'vitest';
import {
  type RefSpending,
  type RefTag,
  isValidQuery,
  queryString,
  recase,
  searchReference,
  tagListReference,
} from './search-model';

const spendings: RefSpending[] = [
  {
    id: 1,
    date: '2026-01-31',
    amount: -500,
    budgetId: 1,
    description: 'Refund: Mug',
    notes: null,
    tagIds: [1],
  },
  {
    id: 2,
    date: '2026-02-01',
    amount: 1000,
    budgetId: 1,
    description: 'Coffee',
    notes: 'with Sam',
    tagIds: [1, 2],
  },
  {
    id: 3,
    date: '2026-02-01',
    amount: 2500,
    budgetId: 2,
    description: 'coffee beans',
    notes: null,
    tagIds: [],
  },
  {
    id: 4,
    date: '2026-02-15',
    amount: 100,
    budgetId: 1,
    description: '100% juice',
    notes: 'a_b',
    tagIds: [2],
  },
  {
    id: 5,
    date: '2026-03-01',
    amount: 7,
    budgetId: 2,
    description: '',
    notes: 'COFFEE',
    tagIds: [1],
  },
];

const ids = (query: Parameters<typeof searchReference>[1]) =>
  searchReference(spendings, query).items.map((item) => item.id);

describe('the search reference', () => {
  it('with no filter lists everything newest first, and sums every amount', () => {
    expect(searchReference(spendings, {})).toMatchObject({
      total: 5,
      limit: 50,
      offset: 0,
      totalAmount: 3107, // -500 + 1000 + 2500 + 100 + 7
    });
    expect(ids({})).toEqual([5, 4, 3, 2, 1]);
  });

  it('q looks at the description or the notes, ignoring case', () => {
    expect(ids({ q: 'COFFEE' })).toEqual([5, 3, 2]); // 5 by its notes, 3 and 2 by their descriptions
    expect(searchReference(spendings, { q: 'coffee' }).totalAmount).toBe(3507); // 7 + 2500 + 1000
    expect(ids({ q: '  cOfFeE  ' })).toEqual([5, 3, 2]); // trimmed
    expect(ids({ q: 'with sam' })).toEqual([2]);
    expect(ids({ q: 'withsam' })).toEqual([]); // the spaces inside count
    expect(ids({ q: 'mug' })).toEqual([1]);
  });

  it('% and _ are ordinary characters', () => {
    expect(ids({ q: '%' })).toEqual([4]);
    expect(ids({ q: '_' })).toEqual([4]);
    expect(ids({ q: 'a_b' })).toEqual([4]);
    expect(ids({ q: '100%' })).toEqual([4]);
    expect(ids({ q: 'a%b' })).toEqual([]);
  });

  it('tagId keeps the spendings that carry the tag, and each still lists all its tags', () => {
    const page = searchReference(spendings, { tagId: 1 });
    expect(page.items.map((item) => [item.id, item.tagIds])).toEqual([
      [5, [1]],
      [2, [1, 2]],
      [1, [1]],
    ]);
    expect(searchReference(spendings, { tagId: 99 })).toMatchObject({
      items: [],
      total: 0,
      totalAmount: 0,
    });
  });

  it('the amount bounds are signed and inclusive', () => {
    expect(ids({ minAmount: 0 })).toEqual([5, 4, 3, 2]); // the refund is hidden
    expect(ids({ maxAmount: -1 })).toEqual([1]); // only the refund
    expect(ids({ minAmount: 7, maxAmount: 1000 })).toEqual([5, 4, 2]);
    expect(ids({ minAmount: 1001, maxAmount: 1001 })).toEqual([]);
    expect(ids({ minAmount: 1000, maxAmount: 1000 })).toEqual([2]);
  });

  it('month, from and to, and the budget', () => {
    expect(ids({ month: '2026-02' })).toEqual([4, 3, 2]);
    expect(ids({ from: '2026-02-01', to: '2026-02-01' })).toEqual([3, 2]);
    expect(ids({ from: '2026-02-02' })).toEqual([5, 4]);
    expect(ids({ to: '2026-01-31' })).toEqual([1]);
    expect(ids({ budgetId: 2 })).toEqual([5, 3]);
    expect(ids({ budgetId: 99 })).toEqual([]);
  });

  it('every filter is AND-ed', () => {
    expect(ids({ q: 'coffee', budgetId: 1 })).toEqual([2]);
    expect(ids({ q: 'coffee', tagId: 2 })).toEqual([2]);
    expect(ids({ q: 'coffee', minAmount: 2000 })).toEqual([3]);
    expect(ids({ q: 'coffee', month: '2026-02', tagId: 1, maxAmount: 1000 })).toEqual([2]);
    expect(ids({ q: 'coffee', month: '2026-03', budgetId: 1 })).toEqual([]);
  });

  it('a page cuts the list but the totals cover all the matches', () => {
    expect(searchReference(spendings, { limit: 2, offset: 1 })).toMatchObject({
      items: [{ id: 4 }, { id: 3 }],
      total: 5,
      limit: 2,
      offset: 1,
      totalAmount: 3107,
    });
    expect(searchReference(spendings, { limit: 2, offset: 4 }).items.map((i) => i.id)).toEqual([1]);
    expect(searchReference(spendings, { offset: 9 })).toMatchObject({
      items: [],
      total: 5,
      totalAmount: 3107,
    });
  });

  it('knows which queries are a 400', () => {
    for (const bad of [
      { month: '2026-02', from: '2026-02-01' },
      { month: '2026-02', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-02-01' },
      { minAmount: 5, maxAmount: 4 },
      { q: '   ' },
      { q: 'x'.repeat(101) },
      { limit: 0 },
      { limit: 201 },
      { offset: -1 },
    ]) {
      expect(isValidQuery(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of [
      {},
      { from: '2026-02-01', to: '2026-02-01' },
      { minAmount: 4, maxAmount: 4 },
      { q: ` ${'x'.repeat(100)} ` }, // 100 once trimmed
      { limit: 200, offset: 0 },
    ]) {
      expect(isValidQuery(good), JSON.stringify(good)).toBe(true);
    }
  });

  it('encodes a query so that % and spaces survive', () => {
    expect(queryString({})).toBe('');
    expect(queryString({ q: '50% off', limit: 5 })).toBe('?q=50%25+off&limit=5');
  });

  it('recases letter by letter', () => {
    expect(recase('abc', 0b101)).toBe('AbC');
    expect(recase('ÉCOLE', 0)).toBe('école');
  });
});

describe('the tag list reference', () => {
  const tags: RefTag[] = [
    { id: 1, name: 'b', color: null },
    { id: 2, name: 'B', color: '#ff0000' },
    { id: 3, name: 'a', color: null },
    { id: 4, name: 'é', color: null },
    { id: 5, name: 'e', color: null },
  ];

  it('is ascending by name ignoring case, then by id, with how many spendings carry each tag', () => {
    expect(
      tagListReference(tags, spendings).map((tag) => [tag.id, tag.name, tag.usageCount]),
    ).toEqual([
      [3, 'a', 0],
      [1, 'b', 3], // spendings 1, 2 and 5
      [2, 'B', 2], // 'b' and 'B' are the same name: the order is the id's
      [5, 'e', 0],
      [4, 'é', 0], // an accent comes after the plain letter, and before the next letter
    ]);
  });
});
