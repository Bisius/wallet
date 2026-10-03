import {
  MAX_TAGS_PER_SPENDING,
  type BudgetDto,
  type SpendingDto,
  type SpendingsPage,
  type TagDto,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { spendingTags, spendings } from '../../db/schema';
import {
  type MutableClock,
  addBudget,
  addSpending,
  addTag,
  expectApiError,
  expectNotFound,
  expectRuleViolation,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

/**
 * Today is 2026-03-15 and tracking started in 2026-01. Groceries runs since January; three tags
 * exist: food (1), work (2) and travel (3).
 */
let app: Express;
let db: Db;
let clock: MutableClock;
let groceries: BudgetDto;
let food: TagDto;
let work: TagDto;
let travel: TagDto;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
  groceries = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
  food = await addTag(app, { name: 'food' });
  work = await addTag(app, { name: 'work' });
  travel = await addTag(app, { name: 'travel' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const page = async (query = ''): Promise<SpendingsPage> =>
  (await request(app).get(`/api/spendings${query}`).expect(200)).body;
const post = (payload: object) => request(app).post('/api/spendings').send(payload);
const patch = (id: number, payload: object) =>
  request(app).patch(`/api/spendings/${id}`).send(payload);

/** A valid create body with `over` applied on top. */
const body = (over: object = {}) => ({
  date: '2026-03-10',
  amount: 1250,
  budgetId: 1,
  description: 'Lunch',
  ...over,
});

/** Everything stored for spendings and their tags, as the database holds it. */
const stored = () => ({
  spendings: db.select().from(spendings).orderBy(spendings.id).all(),
  joins: db.select().from(spendingTags).orderBy(spendingTags.spendingId, spendingTags.tagId).all(),
});

/** Makes the next insert into `spending_tags` fail, after the statements before it have run. */
function failTagInserts() {
  db.$client.exec(`
    create trigger fail_tag_inserts before insert on spending_tags
    begin select raise(abort, 'tag insert failed on purpose'); end;
  `);
  // The error handler logs what it did not expect; the test expects it.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('POST /api/spendings with tagIds', () => {
  it('stores the tags with the spending and answers with them, ascending by id', async () => {
    const res = await post(body({ tagIds: [travel.id, food.id, work.id] })).expect(201);
    expect(res.body).toEqual({
      id: 1,
      date: '2026-03-10',
      amount: 1250,
      budgetId: groceries.id,
      description: 'Lunch',
      notes: null,
      tagIds: [food.id, work.id, travel.id],
    });
    expect((await page()).items).toEqual([res.body]);
    expect(stored().joins).toEqual([
      { spendingId: 1, tagId: food.id },
      { spendingId: 1, tagId: work.id },
      { spendingId: 1, tagId: travel.id },
    ]);
  });

  it('a spending without tagIds, or with an empty list, has no tags', async () => {
    expect((await post(body()).expect(201)).body.tagIds).toEqual([]);
    expect((await post(body({ tagIds: [] })).expect(201)).body.tagIds).toEqual([]);
    expect(stored().joins).toEqual([]);
  });

  it('one tag, and the most a spending may carry', async () => {
    expect((await post(body({ tagIds: [work.id] })).expect(201)).body.tagIds).toEqual([work.id]);

    const more: number[] = [food.id, work.id, travel.id];
    for (let i = more.length; i < MAX_TAGS_PER_SPENDING; i++) {
      more.push((await addTag(app, { name: `extra ${i}` })).id);
    }
    const res = await post(body({ tagIds: [...more].reverse() })).expect(201);
    expect(res.body.tagIds).toEqual(more);
    expect(res.body.tagIds).toHaveLength(MAX_TAGS_PER_SPENDING);
  });

  it('the same tag on many spendings', async () => {
    for (let i = 0; i < 3; i++) await post(body({ tagIds: [food.id] })).expect(201);
    expect(stored().joins.map((join) => join.tagId)).toEqual([food.id, food.id, food.id]);
  });

  describe('validation (400)', () => {
    const more = (n: number) => Array.from({ length: n }, (_unused, i) => i + 1);
    it.each([
      ['too many tags', { tagIds: more(MAX_TAGS_PER_SPENDING + 1) }, ['tagIds']],
      ['the same tag twice', { tagIds: [3, 3] }, ['tagIds.1']],
      ['a tag repeated after another one', { tagIds: [1, 2, 1] }, ['tagIds.2']],
      ['null tagIds (an empty list clears)', { tagIds: null }, ['tagIds']],
      ['a number as tagIds', { tagIds: 4 }, ['tagIds']],
      ['an object as tagIds', { tagIds: { 0: 4 } }, ['tagIds']],
      ['a string tag id', { tagIds: ['1'] }, ['tagIds.0']],
      ['a zero tag id', { tagIds: [1, 0] }, ['tagIds.1']],
      ['a negative tag id', { tagIds: [-1] }, ['tagIds.0']],
      ['a fractional tag id', { tagIds: [1.5] }, ['tagIds.0']],
      ['a null tag id', { tagIds: [null] }, ['tagIds.0']],
      ['a boolean tag id', { tagIds: [true] }, ['tagIds.0']],
      ['tags under their old name', { tags: [1] }, ['']],
      ['a tag id under another name', { tagId: 1 }, ['']],
    ])('rejects %s', async (_label, over, paths) => {
      expectValidationPaths(await post(body(over)), ...paths);
      expect((await page()).total).toBe(0);
      expect(stored().joins).toEqual([]);
    });
  });

  describe('unknown_tag (422): the first offending id in the order sent', () => {
    it.each([
      ['the only id', [999], 'tagIds.0'],
      ['the first id', [998, 1], 'tagIds.0'],
      ['the second id', [1, 999, 998], 'tagIds.1'],
      ['the last id', [1, 2, 3, 999], 'tagIds.3'],
      ['an id just above the last tag', [2, 4], 'tagIds.1'],
    ])('%s', async (_label, tagIds, field) => {
      expectRuleViolation(await post(body({ tagIds })), 'unknown_tag', field);
    });

    it('a tag that was deleted is unknown', async () => {
      await request(app).delete(`/api/tags/${travel.id}`).expect(204);
      expectRuleViolation(
        await post(body({ tagIds: [food.id, travel.id] })),
        'unknown_tag',
        'tagIds.1',
      );
    });

    it('stores nothing: neither the spending nor the tags that do exist', async () => {
      expectRuleViolation(
        await post(body({ tagIds: [food.id, work.id, 999] })),
        'unknown_tag',
        'tagIds.2',
      );
      expect((await page()).total).toBe(0);
      expect(stored()).toEqual({ spendings: [], joins: [] });
    });

    it('is checked after the budget and date rules', async () => {
      const late = await addBudget(app, { name: 'From April', startMonth: '2026-04' });
      expectRuleViolation(
        await post(body({ budgetId: 999, tagIds: [999] })),
        'unknown_budget',
        'budgetId',
      );
      expectRuleViolation(
        await post(body({ date: '2025-12-31', tagIds: [999] })),
        'before_start_month',
        'date',
      );
      expectRuleViolation(
        await post(body({ budgetId: late.id, date: '2026-03-31', tagIds: [999] })),
        'outside_active_months',
        'date',
      );
      expectRuleViolation(
        await post(body({ budgetId: late.id, date: '2026-04-01', tagIds: [999] })),
        'unknown_tag',
        'tagIds.0',
      );
    });

    it('comes after validation too: a bad body is a 400 even with an unknown tag', async () => {
      expectValidationPaths(await post(body({ amount: 0, tagIds: [999] })), 'amount');
    });
  });

  describe('one transaction', () => {
    it('stores the spending and its tags together: a failure on the tags leaves no spending', async () => {
      failTagInserts();
      const res = await post(body({ tagIds: [food.id] }));
      expectApiError(res, 'internal_error');
      expect(stored()).toEqual({ spendings: [], joins: [] });
      expect((await page()).total).toBe(0);
    });

    it('is only the tags that fail: a spending without tags is stored as usual', async () => {
      failTagInserts();
      await post(body()).expect(201);
      expect(stored().spendings).toHaveLength(1);
    });
  });
});

describe('PATCH /api/spendings/:id with tagIds', () => {
  let spending: SpendingDto;
  beforeEach(async () => {
    spending = await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-03-10',
      amount: 1250,
      description: 'Lunch',
      notes: 'with Sam',
      tagIds: [food.id, work.id],
    });
    clock.set('2026-03-20T08:00:00Z');
  });

  const tagsOf = async (id = spending.id) =>
    (await page()).items.find((item) => item.id === id)?.tagIds;

  it('replaces the whole set of tags', async () => {
    const res = await patch(spending.id, { tagIds: [travel.id] }).expect(200);
    expect(res.body).toEqual({ ...spending, tagIds: [travel.id] });
    expect(await tagsOf()).toEqual([travel.id]);
    expect(stored().joins).toEqual([{ spendingId: spending.id, tagId: travel.id }]);
  });

  it('adds and removes tags in one go, answering in ascending order whatever the order sent', async () => {
    const res = await patch(spending.id, { tagIds: [travel.id, work.id] }).expect(200);
    expect(res.body.tagIds).toEqual([work.id, travel.id]);
    expect(await tagsOf()).toEqual([work.id, travel.id]);
  });

  it('removes every tag with an empty list', async () => {
    const res = await patch(spending.id, { tagIds: [] }).expect(200);
    expect(res.body).toEqual({ ...spending, tagIds: [] });
    expect(stored().joins).toEqual([]);
  });

  it('keeps the tags when tagIds is left out, whatever else changes', async () => {
    const res = await patch(spending.id, {
      amount: 99,
      description: 'Dinner',
      date: '2026-02-01',
      notes: null,
    }).expect(200);
    expect(res.body).toEqual({
      ...spending,
      amount: 99,
      description: 'Dinner',
      date: '2026-02-01',
      notes: null,
    });
    expect(await tagsOf()).toEqual(spending.tagIds);
    expect(stored().joins).toHaveLength(2);
  });

  it('accepts the set it already has', async () => {
    const res = await patch(spending.id, { tagIds: [work.id, food.id] }).expect(200);
    expect(res.body).toEqual(spending);
    expect(stored().joins).toHaveLength(2);
  });

  it('changes the tags together with the other fields', async () => {
    const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
    const res = await patch(spending.id, {
      budgetId: other.id,
      amount: -300,
      tagIds: [travel.id],
    }).expect(200);
    expect(res.body).toMatchObject({ budgetId: other.id, amount: -300, tagIds: [travel.id] });
  });

  it('leaves the other spendings and their tags alone', async () => {
    const neighbour = await addSpending(app, { budgetId: groceries.id, tagIds: [food.id] });
    await patch(spending.id, { tagIds: [] }).expect(200);
    expect(await tagsOf(neighbour.id)).toEqual([food.id]);
  });

  it('stamps updatedAt even when only the tags change, and leaves createdAt', async () => {
    await patch(spending.id, { tagIds: [travel.id] }).expect(200);
    expect(db.select().from(spendings).get()).toMatchObject({
      createdAt: '2026-03-15T10:00:00.000Z',
      updatedAt: '2026-03-20T08:00:00.000Z',
    });
  });

  it('stamps updatedAt for a request that leaves the tags out too', async () => {
    await patch(spending.id, { amount: 1 }).expect(200);
    expect(db.select().from(spendings).get()?.updatedAt).toBe('2026-03-20T08:00:00.000Z');
  });

  describe('validation (400)', () => {
    it.each([
      ['too many tags', { tagIds: Array.from({ length: 11 }, (_u, i) => i + 1) }, ['tagIds']],
      ['the same tag twice', { tagIds: [2, 1, 2] }, ['tagIds.2']],
      ['null tagIds', { tagIds: null }, ['tagIds']],
      ['a string tag id', { tagIds: ['1'] }, ['tagIds.0']],
      ['a zero tag id', { tagIds: [0] }, ['tagIds.0']],
      ['an unknown key next to tagIds', { tagIds: [1], tagId: 1 }, ['']],
    ])('rejects %s and changes nothing', async (_label, payload, paths) => {
      const before = stored();
      expectValidationPaths(await patch(spending.id, payload), ...paths);
      expect(stored()).toEqual(before);
    });
  });

  describe('unknown_tag (422): the first offending id in the order sent', () => {
    it.each([
      ['the only id', [999], 'tagIds.0'],
      ['the second id', [1, 999, 998], 'tagIds.1'],
      ['the first id', [998, 1], 'tagIds.0'],
    ])('%s', async (_label, tagIds, field) => {
      expectRuleViolation(await patch(spending.id, { tagIds }), 'unknown_tag', field);
    });

    it('a tag that was deleted is unknown, and the spending keeps the tags it has', async () => {
      await request(app).delete(`/api/tags/${travel.id}`).expect(204);
      expectRuleViolation(
        await patch(spending.id, { tagIds: [travel.id] }),
        'unknown_tag',
        'tagIds.0',
      );
      expect(await tagsOf()).toEqual([food.id, work.id]);
    });
  });

  describe('the order of the errors: 404, the budget and date rules, then unknown_tag', () => {
    it('404 first, even for a body that would break every rule', async () => {
      expectNotFound(await patch(4242, { budgetId: 999, date: '2025-01-01', tagIds: [999] }));
    });

    it('unknown_budget comes before unknown_tag', async () => {
      expectRuleViolation(
        await patch(spending.id, { budgetId: 999, tagIds: [999] }),
        'unknown_budget',
        'budgetId',
      );
    });

    it('before_start_month comes before unknown_tag', async () => {
      expectRuleViolation(
        await patch(spending.id, { date: '2025-12-31', tagIds: [999] }),
        'before_start_month',
        'date',
      );
    });

    it('outside_active_months comes before unknown_tag', async () => {
      const late = await addBudget(app, { name: 'From April', startMonth: '2026-04' });
      expectRuleViolation(
        await patch(spending.id, { budgetId: late.id, tagIds: [999] }),
        'outside_active_months',
        'date',
      );
    });
  });

  describe('a request that fails leaves the spending and its tags completely unchanged', () => {
    const late = () => addBudget(app, { name: 'From April', startMonth: '2026-04' });

    it('404: no spending is created or touched', async () => {
      const before = stored();
      expectNotFound(await patch(4242, { amount: 5, tagIds: [travel.id] }));
      expect(stored()).toEqual(before);
    });

    it('unknown_tag next to changes that are valid', async () => {
      const before = stored();
      expectRuleViolation(
        await patch(spending.id, {
          amount: 999,
          description: 'x',
          notes: null,
          tagIds: [travel.id, 999],
        }),
        'unknown_tag',
        'tagIds.1',
      );
      expect(stored()).toEqual(before);
      expect(await tagsOf()).toEqual([food.id, work.id]);
    });

    it('unknown_budget next to tags that are valid', async () => {
      const before = stored();
      expectRuleViolation(
        await patch(spending.id, { budgetId: 999, tagIds: [travel.id] }),
        'unknown_budget',
        'budgetId',
      );
      expect(stored()).toEqual(before);
    });

    it('before_start_month next to tags that are valid', async () => {
      const before = stored();
      expectRuleViolation(
        await patch(spending.id, { date: '2025-12-31', tagIds: [] }),
        'before_start_month',
        'date',
      );
      expect(stored()).toEqual(before);
    });

    it('outside_active_months next to tags that are valid', async () => {
      const budget = await late();
      const before = stored();
      expectRuleViolation(
        await patch(spending.id, { budgetId: budget.id, tagIds: [travel.id] }),
        'outside_active_months',
        'date',
      );
      expect(stored()).toEqual(before);
    });

    it('a failure while the tags are written: the update and the removed tags come back', async () => {
      const before = stored();
      failTagInserts();
      const res = await patch(spending.id, { amount: 999, tagIds: [travel.id] });
      expectApiError(res, 'internal_error');
      expect(stored()).toEqual(before);
      expect(await tagsOf()).toEqual([food.id, work.id]);
    });
  });
});

describe('GET /api/spendings with tags', () => {
  it('lists the tags of each item ascending by id, however they were stored', async () => {
    const a = await addSpending(app, { budgetId: groceries.id, description: 'a' });
    const b = await addSpending(app, { budgetId: groceries.id, description: 'b' });
    // Rows written in descending order: the list must not depend on it.
    db.insert(spendingTags)
      .values([
        { spendingId: a.id, tagId: travel.id },
        { spendingId: a.id, tagId: food.id },
        { spendingId: b.id, tagId: work.id },
      ])
      .run();
    const result = await page();
    expect(result.items.map((item) => [item.description, item.tagIds])).toEqual([
      ['b', [work.id]],
      ['a', [food.id, travel.id]],
    ]);
  });

  it('an item without tags has an empty list, never a missing field', async () => {
    await addSpending(app, { budgetId: groceries.id });
    const [item] = (await page()).items;
    expect(item?.tagIds).toEqual([]);
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'amount',
      'budgetId',
      'date',
      'description',
      'id',
      'notes',
      'tagIds',
    ]);
  });

  it('loads the tags of a page with one query, however many items it has', async () => {
    for (let i = 0; i < 30; i++) {
      await addSpending(app, {
        budgetId: groceries.id,
        tagIds: i % 2 ? [food.id, work.id] : [travel.id],
      });
    }
    const statements = async (query: string) => {
      const prepare = vi.spyOn(db.$client, 'prepare');
      const result = await page(query);
      const sql = prepare.mock.calls.map(([text]) => String(text));
      prepare.mockRestore();
      return { result, sql };
    };

    const small = await statements('?limit=3');
    const large = await statements('?limit=30');
    expect(small.result.items).toHaveLength(3);
    expect(large.result.items).toHaveLength(30);
    // Exactly one statement reads spending_tags, for 3 items and for 30; and the number of
    // statements does not grow with the page.
    expect(small.sql.filter((text) => text.includes('spending_tags'))).toHaveLength(1);
    expect(large.sql.filter((text) => text.includes('spending_tags'))).toHaveLength(1);
    expect(large.sql).toHaveLength(small.sql.length);
  });

  it('an empty page needs no query for tags', async () => {
    const prepare = vi.spyOn(db.$client, 'prepare');
    await page('?month=2026-02');
    expect(prepare.mock.calls.filter(([text]) => String(text).includes('spending_tags'))).toEqual(
      [],
    );
  });
});

describe('DELETE /api/spendings/:id with tags', () => {
  it('takes the tags of the spending with it and leaves the tags and the other spendings', async () => {
    const gone = await addSpending(app, { budgetId: groceries.id, tagIds: [food.id, work.id] });
    const keep = await addSpending(app, { budgetId: groceries.id, tagIds: [food.id] });
    await request(app).delete(`/api/spendings/${gone.id}`).expect(204);

    expect(stored().joins).toEqual([{ spendingId: keep.id, tagId: food.id }]);
    const tagsNow = (await request(app).get('/api/tags').expect(200)).body as TagDto[];
    expect(tagsNow.map((tag) => [tag.name, tag.usageCount])).toEqual([
      ['food', 1],
      ['travel', 0],
      ['work', 0],
    ]);
  });
});
