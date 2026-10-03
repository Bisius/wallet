import { SPENDING_SEARCH_MAX_LENGTH, type BudgetDto, type SpendingsPage } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { spendingTags, spendings } from '../../db/schema';
import {
  addBudget,
  addSpending,
  addTag,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

/**
 * Today is 2026-03-15 and tracking started in 2026-01. The filters q, tagId, minAmount and
 * maxAmount of GET /api/spendings, alone and combined with the older ones (docs/DOMAIN.md, "Tags
 * and search"). The tags of spendings are tested in spendings.tags.routes.test.ts.
 */
let app: Express;
let db: Db;
let groceries: BudgetDto;
let other: BudgetDto;

beforeEach(async () => {
  ({ app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01' });
  groceries = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
  other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
});

/** GET /api/spendings, which must answer 200. The query is encoded, so `%` and `&` are safe. */
const search = async (params: Record<string, string | number> = {}): Promise<SpendingsPage> =>
  (await request(app).get('/api/spendings').query(params).expect(200)).body;
const get = (params: Record<string, string | number>) =>
  request(app).get('/api/spendings').query(params);
const descriptions = (result: SpendingsPage) => result.items.map((item) => item.description);

/** Inserts spendings straight into the database (bulk setup, with notes). */
function rows(
  items: {
    date?: string;
    amount?: number;
    budgetId?: number;
    description?: string;
    notes?: string;
  }[],
) {
  for (let i = 0; i < items.length; i += 100) {
    db.insert(spendings)
      .values(
        items.slice(i, i + 100).map((item) => ({
          date: '2026-03-10',
          amount: 100,
          budgetId: groceries.id,
          description: '',
          ...item,
        })),
      )
      .run();
  }
}

/**
 * Seven spendings, three of them tagged. By id (a is 1):
 *
 * ```
 * id  date        amount  budget     description     notes                     tags
 *  a  2026-02-03    1000  Groceries  Coffee beans    -                         food
 *  b  2026-02-10    2500  Groceries  Lunch           Coffee with Sam           food, work
 *  c  2026-03-01    -500  Groceries  Refund: mug     returned the COFFEE mug   work
 *  d  2026-03-05    4000  Other      Train ticket    -                         work
 *  e  2026-03-10     300  Other      Cinema          popcorn                   -
 *  f  2026-03-12    1500  Groceries  Dinner          -                         food
 *  g  2026-03-12    -200  Other      Cashback        -                         -
 * ```
 */
async function seed() {
  const food = await addTag(app, { name: 'food' });
  const work = await addTag(app, { name: 'work' });
  const add = (
    date: string,
    amount: number,
    budget: BudgetDto,
    description: string,
    notes: string | null,
    tagIds: number[],
  ) => addSpending(app, { date, amount, budgetId: budget.id, description, notes, tagIds });
  const spendingsMade = [
    await add('2026-02-03', 1000, groceries, 'Coffee beans', null, [food.id]),
    await add('2026-02-10', 2500, groceries, 'Lunch', 'Coffee with Sam', [food.id, work.id]),
    await add('2026-03-01', -500, groceries, 'Refund: mug', 'returned the COFFEE mug', [work.id]),
    await add('2026-03-05', 4000, other, 'Train ticket', null, [work.id]),
    await add('2026-03-10', 300, other, 'Cinema', 'popcorn', []),
    await add('2026-03-12', 1500, groceries, 'Dinner', null, [food.id]),
    await add('2026-03-12', -200, other, 'Cashback', null, []),
  ];
  const [a, b, c, d, e, f, g] = spendingsMade;
  return { food, work, a: a!, b: b!, c: c!, d: d!, e: e!, f: f!, g: g! };
}

/** The ids of the items of a page, in order. */
const idsOf = (result: SpendingsPage) => result.items.map((item) => item.id);

describe('q', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    s = await seed();
  });

  it('finds the spendings whose description OR notes contain it, newest first', async () => {
    const result = await search({ q: 'coffee' });
    // a by its description, b by its notes, c by its notes (in capitals).
    expect(idsOf(result)).toEqual([s.c.id, s.b.id, s.a.id]);
    expect(result).toMatchObject({
      total: 3,
      totalAmount: -500 + 2500 + 1000,
      limit: 50,
      offset: 0,
    });
  });

  it('ignores case in the search and in the data', async () => {
    const lower = idsOf(await search({ q: 'coffee' }));
    expect(idsOf(await search({ q: 'COFFEE' }))).toEqual(lower);
    expect(idsOf(await search({ q: 'cOfFeE' }))).toEqual(lower);
    expect(idsOf(await search({ q: 'coffee beans' }))).toEqual([s.a.id]);
    expect(idsOf(await search({ q: 'COFFEE BEANS' }))).toEqual([s.a.id]);
  });

  it('matches a part of a word, anywhere in the text', async () => {
    expect(idsOf(await search({ q: 'inn' }))).toEqual([s.f.id]); // D-inn-er
    expect(idsOf(await search({ q: 'ticket' }))).toEqual([s.d.id]);
    expect(idsOf(await search({ q: 'ffee' }))).toEqual([s.c.id, s.b.id, s.a.id]);
    expect(idsOf(await search({ q: 'orn' }))).toEqual([s.e.id]); // pop-corn, in the notes
  });

  it('searches the description alone, the notes alone, and never a null note', async () => {
    expect(idsOf(await search({ q: 'cinema' }))).toEqual([s.e.id]);
    expect(idsOf(await search({ q: 'popcorn' }))).toEqual([s.e.id]);
    // The notes of a, d, f and g are NULL: the text "null" is not in them.
    expect(await search({ q: 'null' })).toMatchObject({ items: [], total: 0, totalAmount: 0 });
  });

  it('does not search the names of tags', async () => {
    expect((await search({ q: 'food' })).items).toEqual([]);
    expect((await search({ q: 'work' })).items).toEqual([]);
    // That is what tagId is for.
    expect(idsOf(await search({ tagId: s.food.id }))).toEqual([s.f.id, s.b.id, s.a.id]);
  });

  it('trims the ends and counts the spaces inside', async () => {
    expect(idsOf(await search({ q: '  coffee  ' }))).toEqual(idsOf(await search({ q: 'coffee' })));
    expect(idsOf(await search({ q: 'coffee with' }))).toEqual([s.b.id]);
    expect(await search({ q: 'coffeewith' })).toMatchObject({ total: 0 });
    expect(await search({ q: 'coffee  with' })).toMatchObject({ total: 0 }); // two spaces
    expect(idsOf(await search({ q: 'e w' }))).toEqual([s.b.id]); // "Coffe[e w]ith Sam"
  });

  it('keeps every field of the matching items, tags included', async () => {
    const result = await search({ q: 'lunch' });
    expect(result.items).toEqual([s.b]);
    expect(result.items[0]?.tagIds).toEqual([s.food.id, s.work.id]);
  });

  it('combines with the older filters by AND', async () => {
    expect(idsOf(await search({ q: 'coffee', month: '2026-02' }))).toEqual([s.b.id, s.a.id]);
    expect(idsOf(await search({ q: 'coffee', month: '2026-03' }))).toEqual([s.c.id]);
    expect(idsOf(await search({ q: 'coffee', from: '2026-02-04', to: '2026-02-28' }))).toEqual([
      s.b.id,
    ]);
    expect(idsOf(await search({ q: 'coffee', budgetId: groceries.id }))).toEqual([
      s.c.id,
      s.b.id,
      s.a.id,
    ]);
    expect(await search({ q: 'coffee', budgetId: other.id })).toMatchObject({
      items: [],
      total: 0,
    });
    expect(await search({ q: 'coffee', month: '2026-04' })).toMatchObject({ items: [], total: 0 });
  });

  it('is a case of no match, not of an error, when nothing contains it', async () => {
    expect(await search({ q: 'zzz' })).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      totalAmount: 0,
    });
  });
});

describe('% and _ are ordinary characters', () => {
  beforeEach(() => {
    rows([
      { description: '100% organic' },
      { description: '100 organic' },
      { description: 'a_b' },
      { description: 'axb' },
      { description: 'under_score' },
      { description: 'x', notes: 'save 50% today' },
      { description: 'back \\ slash' },
      { description: "it's" },
      { description: 'say "hi"' },
    ]);
  });

  it.each([
    ['%', ['100% organic', 'x']],
    ['_', ['under_score', 'a_b']],
    ['100%', ['100% organic']],
    ['50%', ['x']],
    ['a_b', ['a_b']],
    ['_b', ['a_b']],
    ['%organic', []], // "organic" without the % before it is not a wildcard match
    ['100%organic', []],
    ['\\', ['back \\ slash']],
    ["'", ["it's"]],
    ['"hi"', ['say "hi"']],
    ["'; drop table spendings; --", []],
    ['\\%', []],
  ])('searching for %j finds %j', async (q, expected) => {
    const found = descriptions(await search({ q }));
    expect(found.sort()).toEqual([...expected].sort());
  });

  it('a wildcard-looking search does not match everything', async () => {
    const all = (await search()).total;
    expect(all).toBe(9);
    expect((await search({ q: '%' })).total).toBeLessThan(all);
    expect((await search({ q: '_' })).total).toBeLessThan(all);
  });

  it('survives text that could break a query', async () => {
    // "%00" is the text; "\u0000" is a real NUL character, sent as %00 and decoded by the server.
    const texts = ["'", '"', '\\', ';', '--', '/*', '%00', '\u0000', '`', '\t x'];
    for (const q of texts) {
      const res = await get({ q });
      expect(res.status, JSON.stringify(q)).toBe(200);
    }
    expect((await search()).total).toBe(9);
  });
});

describe('q ignores case in every alphabet, and only case', () => {
  /** [what is stored, what is searched, found]. */
  const CASES: [string, string, boolean][] = [
    // Latin with accents: the accent is part of the letter
    ['CAFÉ', 'café', true],
    ['café', 'CAFÉ', true],
    ['Crème brûlée', 'CRÈME BRÛLÉE', true],
    ['NAÏVE', 'naïve', true],
    ['CAFÉ', 'cafe', false],
    ['café', 'CAFE', false],
    ['cafe', 'CAFÉ', false],
    ['NAÏVE', 'naive', false],
    ['piñata', 'PINATA', false],
    // The same text composed or decomposed
    ['Café noir', 'café noir', true],
    ['Pâtisserie', 'PÂTISSERIE', true],
    // Greek, including the final sigma
    ['ΟΔΟΣ ΑΘΗΝΩΝ', 'οδος αθηνων', true],
    ['ΟΔΟΣ ΑΘΗΝΩΝ', 'οδοσ', true],
    ['οδός Πατησίων', 'ΟΔΌΣ', true],
    ['ΣΟΦΟΣ', 'σοφος', true],
    ['σοφός', 'ΣΟΦΌΣ', true],
    ['Άλφα Βήτα', 'ΆΛΦΑ', true],
    ['ΟΣΟΥ', 'οσ', true], // a fragment ending in sigma, in the middle of a word
    ['ΟΣΟΥ', 'ΟΣ', true],
    ['οδος Αθηνών', 'ΟΔΟΣ', true],
    ['οδός Πατησίων', 'οδος', false], // the tonos is part of the letter
    ['ΑΘΗΝΑ', 'αθήνα', false],
    // Cyrillic
    ['МОСКВА', 'москва', true],
    ['москва', 'МОСКВА', true],
    ['Привет, мир', 'ПРИВЕТ', true],
    ['Ёлка', 'ёлка', true],
    ['Ёлка', 'елка', false],
    // Other alphabets and the characters that change length when the case does
    ['STRASSE', 'straße', true],
    ['Straße', 'STRASSE', true],
    ['STRA\u1E9EE', 'straße', true], // the capital sharp s, ẞ
    ['STRA\u1E9EE', 'STRASSE', true],
    ['ԵՐԵՎԱՆ', 'երեվան', true],
    ['\u{10400}\u{10401}', '\u{10428}', true],
    // No case at all
    ['Pizza 🍕 night', '🍕', true],
    ['東京タワー', '東京', true],
    ['東京タワー', '大阪', false],
    ['Order #42', '#42', true],
  ];

  beforeEach(() => {
    rows([...new Set(CASES.map(([stored]) => stored))].map((description) => ({ description })));
  });

  it.each(CASES)('%j searched as %j: found is %s', async (stored, q, found) => {
    const result = await search({ q });
    expect(descriptions(result).includes(stored)).toBe(found);
  });

  it('applies to the notes too', async () => {
    rows([
      { description: 'school run', notes: 'ÉCOLE primaire' },
      { description: 'nap', notes: 'ΟΔΟΣ' },
    ]);
    expect(descriptions(await search({ q: 'école' }))).toEqual(['school run']);
    expect(descriptions(await search({ q: 'ecole' }))).toEqual([]);
    expect(descriptions(await search({ q: 'οδοσ' }))).toContain('nap');
  });

  it('treats the three forms of the Greek sigma as one letter, anywhere in a word', async () => {
    rows([{ description: 'xxΣxx' }, { description: 'xxσxx' }, { description: 'xxςxx' }]);
    const found = descriptions(await search({ q: 'σ' }));
    // The three forms of the same letter (and the capital) are one letter.
    expect(found).toEqual(expect.arrayContaining(['xxΣxx', 'xxσxx', 'xxςxx']));
  });
});

describe('tagId', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    s = await seed();
  });

  it('keeps the spendings that carry the tag, newest first, with the total of those', async () => {
    const result = await search({ tagId: s.food.id });
    expect(idsOf(result)).toEqual([s.f.id, s.b.id, s.a.id]);
    expect(result).toMatchObject({ total: 3, totalAmount: 1500 + 2500 + 1000 });
    expect(idsOf(await search({ tagId: s.work.id }))).toEqual([s.d.id, s.c.id, s.b.id]);
  });

  it('still lists ALL the tags of each item, whichever tag selected it', async () => {
    const byWork = await search({ tagId: s.work.id });
    expect(byWork.items.find((item) => item.id === s.b.id)?.tagIds).toEqual([s.food.id, s.work.id]);
    const byFood = await search({ tagId: s.food.id });
    expect(byFood.items.find((item) => item.id === s.b.id)?.tagIds).toEqual([s.food.id, s.work.id]);
    expect(byFood.items.find((item) => item.id === s.a.id)?.tagIds).toEqual([s.food.id]);
  });

  it('an unknown tag matches nothing', async () => {
    expect(await search({ tagId: 999 })).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      totalAmount: 0,
    });
  });

  it('a tag no spending carries matches nothing, and so does a tag after it is deleted', async () => {
    const unused = await addTag(app, { name: 'unused' });
    expect(await search({ tagId: unused.id })).toMatchObject({ items: [], total: 0 });
    await request(app).delete(`/api/tags/${s.food.id}`).expect(204);
    expect(await search({ tagId: s.food.id })).toMatchObject({ items: [], total: 0 });
    // The spendings are still all there.
    expect((await search()).total).toBe(7);
  });

  it('combines with the older filters by AND', async () => {
    expect(idsOf(await search({ tagId: s.food.id, month: '2026-02' }))).toEqual([s.b.id, s.a.id]);
    expect(idsOf(await search({ tagId: s.work.id, month: '2026-03' }))).toEqual([s.d.id, s.c.id]);
    expect(idsOf(await search({ tagId: s.work.id, budgetId: other.id }))).toEqual([s.d.id]);
    expect(idsOf(await search({ tagId: s.food.id, from: '2026-02-05', to: '2026-03-12' }))).toEqual(
      [s.f.id, s.b.id],
    );
    expect(await search({ tagId: s.food.id, month: '2026-04' })).toMatchObject({ total: 0 });
  });

  it('combines with the search and the amounts', async () => {
    expect(idsOf(await search({ tagId: s.work.id, q: 'coffee' }))).toEqual([s.c.id, s.b.id]);
    expect(idsOf(await search({ tagId: s.work.id, minAmount: 0 }))).toEqual([s.d.id, s.b.id]);
    expect(idsOf(await search({ tagId: s.work.id, maxAmount: -1 }))).toEqual([s.c.id]);
    expect(
      idsOf(await search({ tagId: s.food.id, q: 'coffee', minAmount: 2000, maxAmount: 3000 })),
    ).toEqual([s.b.id]);
  });
});

describe('minAmount and maxAmount', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    s = await seed();
  });

  it('bound the signed amount, both ends included', async () => {
    // Amounts: d 4000, b 2500, f 1500, a 1000, e 300, g -200, c -500.
    expect(idsOf(await search({ minAmount: 1000 }))).toEqual([s.f.id, s.d.id, s.b.id, s.a.id]);
    expect(idsOf(await search({ minAmount: 1001 }))).toEqual([s.f.id, s.d.id, s.b.id]);
    expect(idsOf(await search({ maxAmount: 1000 }))).toEqual([s.g.id, s.e.id, s.c.id, s.a.id]);
    expect(idsOf(await search({ maxAmount: 999 }))).toEqual([s.g.id, s.e.id, s.c.id]);
    expect(idsOf(await search({ minAmount: -500, maxAmount: 300 }))).toEqual([
      s.g.id,
      s.e.id,
      s.c.id,
    ]);
    expect(idsOf(await search({ minAmount: -499, maxAmount: 299 }))).toEqual([s.g.id]);
    expect(idsOf(await search({ minAmount: 1500, maxAmount: 1500 }))).toEqual([s.f.id]);
  });

  it('minAmount 0 hides the refunds', async () => {
    const result = await search({ minAmount: 0 });
    expect(idsOf(result)).toEqual([s.f.id, s.e.id, s.d.id, s.b.id, s.a.id]);
    expect(result).toMatchObject({ total: 5, totalAmount: 1500 + 300 + 4000 + 2500 + 1000 });
  });

  it('maxAmount -1 shows only the refunds, and their total is negative', async () => {
    const result = await search({ maxAmount: -1 });
    expect(idsOf(result)).toEqual([s.g.id, s.c.id]);
    expect(result).toMatchObject({ total: 2, totalAmount: -700 });
  });

  it('a spending of exactly 0 cannot exist, so maxAmount 0 and -1 show the same refunds', async () => {
    expect(idsOf(await search({ maxAmount: 0 }))).toEqual(idsOf(await search({ maxAmount: -1 })));
    expect(idsOf(await search({ minAmount: 1 }))).toEqual(idsOf(await search({ minAmount: 0 })));
  });

  it('take a negative bound and the largest amounts', async () => {
    expect(idsOf(await search({ minAmount: -200 }))).toHaveLength(6); // everything but c
    expect(await search({ maxAmount: -500 })).toMatchObject({ total: 1, totalAmount: -500 });
    expect(await search({ minAmount: 1_000_000_000_000 })).toMatchObject({ total: 0 });
    expect((await search({ maxAmount: 1_000_000_000_000 })).total).toBe(7);
    expect((await search({ minAmount: -1_000_000_000_000 })).total).toBe(7);
  });

  it('combine with the older filters by AND', async () => {
    expect(idsOf(await search({ month: '2026-03', minAmount: 0 }))).toEqual([
      s.f.id,
      s.e.id,
      s.d.id,
    ]);
    expect(idsOf(await search({ month: '2026-03', maxAmount: -1 }))).toEqual([s.g.id, s.c.id]);
    expect(idsOf(await search({ budgetId: other.id, maxAmount: -1 }))).toEqual([s.g.id]);
    expect(
      idsOf(await search({ budgetId: groceries.id, minAmount: 1000, maxAmount: 2000 })),
    ).toEqual([s.f.id, s.a.id]);
    expect(
      idsOf(await search({ from: '2026-03-01', to: '2026-03-10', minAmount: 0, maxAmount: 1000 })),
    ).toEqual([s.e.id]);
  });
});

describe('every filter together', () => {
  it('is an AND of all of them', async () => {
    const s = await seed();
    const everything = {
      month: '2026-02',
      budgetId: groceries.id,
      tagId: s.food.id,
      q: 'COFFEE',
      minAmount: 1000,
      maxAmount: 1000,
    };
    expect(idsOf(await search(everything))).toEqual([s.a.id]);
    // Break each filter in turn: the spending is gone.
    for (const broken of [
      { month: '2026-03' },
      { budgetId: other.id },
      { tagId: s.work.id },
      { q: 'dinner' },
      { minAmount: 1001, maxAmount: 2000 },
      { minAmount: 0, maxAmount: 999 },
    ]) {
      expect((await search({ ...everything, ...broken })).total, JSON.stringify(broken)).toBe(0);
    }
  });
});

describe('total and totalAmount cover all the matches, whatever page is shown', () => {
  /**
   * 60 spendings called "bulk 1" to "bulk 60" with amounts 1 to 60 (every 10th a refund), 20 with
   * the tag, and noise that no filter below matches.
   */
  let tagId: number;
  const bulk = Array.from({ length: 60 }, (_unused, i) => {
    const n = i + 1;
    return { n, amount: n % 10 === 0 ? -n : n };
  });
  beforeEach(async () => {
    tagId = (await addTag(app, { name: 'bulk tag' })).id;
    rows([
      ...bulk.map(({ n, amount }) => ({
        date: `2026-03-${String((n % 28) + 1).padStart(2, '0')}`,
        amount,
        description: `bulk ${n}`,
      })),
      ...Array.from({ length: 15 }, () => ({ amount: 99999, description: 'noise' })),
    ]);
    // Tag every third bulk spending: ids 1, 4, 7, ...
    const tagged = bulk.filter(({ n }) => n % 3 === 1);
    db.insert(spendingTags)
      .values(tagged.map(({ n }) => ({ spendingId: n, tagId })))
      .run();
  });
  const sum = (items: { amount: number }[]) =>
    items.reduce((total, item) => total + item.amount, 0);

  it('q: a middle page reports the total of all 60', async () => {
    const result = await search({ q: 'BULK', limit: 10, offset: 20 });
    expect(result.items).toHaveLength(10);
    expect(result).toMatchObject({ total: 60, limit: 10, offset: 20, totalAmount: sum(bulk) });
    expect(sum(result.items)).not.toBe(sum(bulk));
  });

  it('q: the pages concatenate to the whole ordered set, no gap and no repeat', async () => {
    const seen = [];
    for (let offset = 0; offset < 60; offset += 25) {
      seen.push(...(await search({ q: 'bulk', limit: 25, offset })).items);
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen.map((item) => item.id)).size).toBe(60);
    expect(sum(seen)).toBe(sum(bulk));
    const newestFirst = [...seen].sort((a, b) =>
      a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
    );
    expect(seen).toEqual(newestFirst);
  });

  it('tagId: the total of the tagged ones, with a page smaller than that', async () => {
    const tagged = bulk.filter(({ n }) => n % 3 === 1);
    const result = await search({ tagId, limit: 7, offset: 14 });
    expect(result.items).toHaveLength(6); // 20 tagged: the last page holds 6
    expect(result).toMatchObject({ total: 20, offset: 14, totalAmount: sum(tagged) });
  });

  it('minAmount: the total of the positive ones', async () => {
    const positive = bulk.filter(({ amount }) => amount > 0);
    const result = await search({ q: 'bulk', minAmount: 0, limit: 5 });
    expect(result.items).toHaveLength(5);
    expect(result).toMatchObject({ total: positive.length, totalAmount: sum(positive) });
    const refunds = await search({ q: 'bulk', maxAmount: -1, limit: 2 });
    expect(refunds).toMatchObject({ total: 6, totalAmount: -(10 + 20 + 30 + 40 + 50 + 60) });
  });

  it('all of them at once', async () => {
    const matching = bulk.filter(({ n, amount }) => n % 3 === 1 && amount > 10 && amount <= 40);
    const result = await search({ q: 'bulk', tagId, minAmount: 11, maxAmount: 40, limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result).toMatchObject({ total: matching.length, totalAmount: sum(matching) });
  });

  it('an offset past the end is an empty page that still reports the totals', async () => {
    const result = await search({ q: 'bulk', offset: 500 });
    expect(result).toMatchObject({ items: [], total: 60, offset: 500, totalAmount: sum(bulk) });
  });
});

describe('validation (400)', () => {
  it.each([
    ['a q of only spaces', '?q=%20%20%20', ['q']],
    ['a q of one space', '?q=%20', ['q']],
    ['an empty q', '?q=', ['q']],
    ['a q above the maximum', `?q=${'x'.repeat(SPENDING_SEARCH_MAX_LENGTH + 1)}`, ['q']],
    ['a repeated q', '?q=a&q=b', ['q']],
    ['a zero tagId', '?tagId=0', ['tagId']],
    ['a negative tagId', '?tagId=-1', ['tagId']],
    ['a text tagId', '?tagId=food', ['tagId']],
    ['a fractional tagId', '?tagId=1.5', ['tagId']],
    ['an empty tagId', '?tagId=', ['tagId']],
    ['a repeated tagId', '?tagId=1&tagId=2', ['tagId']],
    ['a blank minAmount (not 0)', '?minAmount=', ['minAmount']],
    ['a blank maxAmount (not 0)', '?maxAmount=', ['maxAmount']],
    ['a fractional minAmount', '?minAmount=1.5', ['minAmount']],
    ['a text minAmount', '?minAmount=ten', ['minAmount']],
    ['an exponent in maxAmount', '?maxAmount=1e3', ['maxAmount']],
    ['a plus sign in minAmount', '?minAmount=%2B5', ['minAmount']],
    ['a leading zero in minAmount', '?minAmount=007', ['minAmount']],
    ['a negative zero in maxAmount', '?maxAmount=-0', ['maxAmount']],
    ['spaces around minAmount', '?minAmount=%205', ['minAmount']],
    ['a double minus in maxAmount', '?maxAmount=--5', ['maxAmount']],
    ['a minAmount above the cap', '?minAmount=1000000000001', ['minAmount']],
    ['a maxAmount below minus the cap', '?maxAmount=-1000000000001', ['maxAmount']],
    ['a repeated minAmount', '?minAmount=1&minAmount=2', ['minAmount']],
    ['minAmount above maxAmount', '?minAmount=100&maxAmount=99', ['maxAmount']],
    ['minAmount above a negative maxAmount', '?minAmount=0&maxAmount=-1', ['maxAmount']],
    ['a mistake in a new and an old filter', '?q=%20&month=2026-13', ['q', 'month']],
    ['month with a search', '?month=2026-03&from=2026-03-01&q=a', ['month']],
  ])('rejects %s', async (_label, query, paths) => {
    expectValidationPaths(await request(app).get(`/api/spendings${query}`), ...paths);
  });

  it('accepts q at its longest, also when padded with spaces that are trimmed', async () => {
    await search({ q: 'x'.repeat(SPENDING_SEARCH_MAX_LENGTH) });
    await search({ q: `  ${'x'.repeat(SPENDING_SEARCH_MAX_LENGTH)}  ` });
  });

  it('accepts equal bounds and the largest bounds', async () => {
    await search({ minAmount: 5, maxAmount: 5 });
    await search({ minAmount: -1_000_000_000_000, maxAmount: 1_000_000_000_000 });
    await search({ minAmount: 0 });
    await search({ maxAmount: 0 });
  });
});
