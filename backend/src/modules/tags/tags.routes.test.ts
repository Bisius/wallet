import { TAG_NAME_MAX_LENGTH, type SpendingDto, type TagDto } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { spendingTags, spendings, tags } from '../../db/schema';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  addTag,
  addTransfer,
  expectApiError,
  expectNotFound,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { getJson, monthView } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

/** Today is 2026-03-15 and tracking started in 2026-01, with one budget to spend from. */
let app: Express;
let db: Db;
let groceriesId: number;

beforeEach(async () => {
  ({ app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01' });
  groceriesId = (await addBudget(app, { name: 'Groceries', startMonth: '2026-01' })).id;
});

const list = async (): Promise<TagDto[]> => (await request(app).get('/api/tags').expect(200)).body;
const names = async () => (await list()).map((tag) => tag.name);
const post = (payload: object) => request(app).post('/api/tags').send(payload);
const patch = (id: number | string, payload: object) =>
  request(app).patch(`/api/tags/${id}`).send(payload);
const spend = (tagIds?: number[], over: object = {}) =>
  addSpending(app, { budgetId: groceriesId, tagIds, ...over });
const usage = async () =>
  Object.fromEntries((await list()).map((tag) => [tag.name, tag.usageCount]));

describe('POST /api/tags', () => {
  it('creates a tag and answers 201 with the DTO: no color, used by nothing', async () => {
    const res = await post({ name: 'Groceries' }).expect(201);
    expect(res.body).toEqual({ id: 1, name: 'Groceries', color: null, usageCount: 0 });
    expect(await list()).toEqual([res.body]);
  });

  it('keeps a color, stored in lower case, and accepts null for none', async () => {
    expect((await post({ name: 'Work', color: '#3B82F6' }).expect(201)).body.color).toBe('#3b82f6');
    expect((await post({ name: 'Home', color: null }).expect(201)).body.color).toBeNull();
  });

  it('trims the name and keeps the spaces inside it', async () => {
    const res = await post({ name: '  eating  out ' }).expect(201);
    expect(res.body.name).toBe('eating  out');
  });

  it.each([
    ['one character', 'a'],
    ['the longest name', 'x'.repeat(TAG_NAME_MAX_LENGTH)],
    ['the longest name with spaces around it', ` ${'y'.repeat(TAG_NAME_MAX_LENGTH)} `],
    ['accented letters', 'Café'],
    ['Cyrillic', 'Москва'],
    ['Greek', 'ΟΔΟΣ'],
    ['an emoji', '🍕'],
    ['punctuation and digits', '100% #1'],
  ])('accepts %s as a name', async (_label, name) => {
    const res = await post({ name }).expect(201);
    expect(res.body.name).toBe(name.trim());
  });

  it('numbers the tags one after another and never reuses an id', async () => {
    const a = await addTag(app, { name: 'a' });
    const b = await addTag(app, { name: 'b' });
    await request(app).delete(`/api/tags/${b.id}`).expect(204);
    const c = await addTag(app, { name: 'c' });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  });

  describe('a name that is taken (409 tag_name_taken)', () => {
    it.each([
      ['the same name', 'Groceries'],
      ['another capitalization', 'groceries'],
      ['all capitals', 'GROCERIES'],
      ['spaces around it (they are trimmed)', '  GROCERIES  '],
      ['mixed case', 'gROCERIES'],
    ])('%s', async (_label, name) => {
      await addTag(app, { name: 'Groceries' });
      expectApiError(await post({ name }), 'tag_name_taken');
      expect(await names()).toEqual(['Groceries']);
    });

    it('compares every alphabet ignoring case', async () => {
      await addTag(app, { name: 'Москва' });
      expectApiError(await post({ name: 'МОСКВА' }), 'tag_name_taken');
      await addTag(app, { name: 'ΟΔΟΣ' });
      expectApiError(await post({ name: 'οδος' }), 'tag_name_taken');
      expectApiError(await post({ name: 'οδοσ' }), 'tag_name_taken');
      // Greek sorts before Cyrillic.
      expect(await names()).toEqual(['ΟΔΟΣ', 'Москва']);
    });

    it('is the same name whether an accent is typed as one character or as two', async () => {
      await addTag(app, { name: 'Caf\u00E9' }); // é as one character
      expectApiError(await post({ name: 'Cafe\u0301' }), 'tag_name_taken'); // e + combining acute
      expectApiError(await post({ name: 'CAFE\u0301' }), 'tag_name_taken');
      expect(await names()).toEqual(['Caf\u00E9']);
    });

    it('does not ignore accents: "Café" and "Cafe" are two names', async () => {
      await addTag(app, { name: 'Café' });
      await addTag(app, { name: 'Cafe' });
      expect(await names()).toEqual(['Cafe', 'Café']);
      // ...and each still clashes with its own capitalizations.
      expectApiError(await post({ name: 'CAFE' }), 'tag_name_taken');
      expectApiError(await post({ name: 'CAFÉ' }), 'tag_name_taken');
    });

    it('clashes with a tag the database holds in another case (its unique index is case-sensitive)', async () => {
      // The service is what enforces the rule; the index is only a backstop for exact duplicates.
      db.insert(tags).values({ name: 'Rent' }).run();
      expectApiError(await post({ name: 'rent' }), 'tag_name_taken');
      expect(await names()).toEqual(['Rent']);
    });

    it('the message names the tag in the way', async () => {
      await addTag(app, { name: 'Groceries' });
      const res = await post({ name: 'GROCERIES' });
      expect(res.body.error.message).toContain('Groceries');
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ['name']],
      ['a body that is a list', [], ['']],
      ['a missing name', { color: '#22c55e' }, ['name']],
      ['an empty name', { name: '' }, ['name']],
      ['a blank name', { name: '   ' }, ['name']],
      ['a too long name', { name: 'x'.repeat(TAG_NAME_MAX_LENGTH + 1) }, ['name']],
      ['a null name', { name: null }, ['name']],
      ['a numeric name', { name: 7 }, ['name']],
      ['a color that is not hex', { name: 'a', color: 'green' }, ['color']],
      ['a short hex color', { name: 'a', color: '#2c5' }, ['color']],
      ['a hex color without the hash', { name: 'a', color: '22c55e' }, ['color']],
      ['an empty color (send null for none)', { name: 'a', color: '' }, ['color']],
      ['a numeric color', { name: 'a', color: 5 }, ['color']],
      ['an unknown key', { name: 'a', usageCount: 0 }, ['']],
      ['an id in the body', { id: 3, name: 'a' }, ['']],
    ])('rejects %s', async (_label, payload, paths) => {
      expectValidationPaths(await post(payload), ...paths);
      expect(await list()).toEqual([]);
    });

    it('validates before it looks at the other names: a bad body is a 400 even if the name is taken', async () => {
      await addTag(app, { name: 'Groceries' });
      expectValidationPaths(await post({ name: 'Groceries', color: 'bad' }), 'color');
      expectValidationPaths(await post({ name: 'Groceries', extra: 1 }), '');
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .post('/api/tags')
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      expectApiError(res, 'invalid_json');
    });
  });
});

describe('GET /api/tags', () => {
  it('is an empty list when there are none', async () => {
    expect(await list()).toEqual([]);
  });

  it('is ascending by name ignoring case, with accents after the plain letter', async () => {
    for (const name of ['zebra', 'Éclair', 'apple', 'Banana', 'eclair'])
      await addTag(app, { name });
    // A plain code-unit sort would put "Banana" and "Éclair" before "apple".
    expect(await names()).toEqual(['apple', 'Banana', 'eclair', 'Éclair', 'zebra']);
  });

  it('breaks ties by id: names the comparison cannot tell apart', async () => {
    // The API never stores two such names, but the database allows them (exact-case unique index).
    db.insert(tags)
      .values([{ name: 'rent' }, { name: 'Rent' }, { name: 'RENT' }, { name: 'a' }])
      .run();
    const result = await list();
    expect(result.map((tag) => [tag.id, tag.name])).toEqual([
      [4, 'a'],
      [1, 'rent'],
      [2, 'Rent'],
      [3, 'RENT'],
    ]);
  });

  it('lists every field of the DTO and nothing else', async () => {
    await addTag(app, { name: 'Work', color: '#3b82f6' });
    const [tag] = await list();
    expect(Object.keys(tag ?? {}).sort()).toEqual(['color', 'id', 'name', 'usageCount']);
    expect(tag).toEqual({ id: 1, name: 'Work', color: '#3b82f6', usageCount: 0 });
  });

  it('reports how many spendings carry each tag', async () => {
    const food = await addTag(app, { name: 'food' });
    const work = await addTag(app, { name: 'work' });
    await addTag(app, { name: 'unused' });
    await spend([food.id]);
    await spend([food.id, work.id]);
    await spend([]);
    await spend();
    expect(await usage()).toEqual({ food: 2, unused: 0, work: 1 });
  });
});

describe('PATCH /api/tags/:id', () => {
  let food: TagDto;
  beforeEach(async () => {
    food = await addTag(app, { name: 'food', color: '#22c55e' });
  });

  it('renames the tag (200) and keeps its color', async () => {
    const res = await patch(food.id, { name: 'Eating out' }).expect(200);
    expect(res.body).toEqual({ id: food.id, name: 'Eating out', color: '#22c55e', usageCount: 0 });
    expect(await list()).toEqual([res.body]);
  });

  it('changes the color only, lower-casing it', async () => {
    const res = await patch(food.id, { color: '#3B82F6' }).expect(200);
    expect(res.body).toMatchObject({ name: 'food', color: '#3b82f6' });
  });

  it('clears the color with null', async () => {
    const res = await patch(food.id, { color: null }).expect(200);
    expect(res.body).toMatchObject({ name: 'food', color: null });
    // ...and a later rename leaves it cleared.
    expect((await patch(food.id, { name: 'meals' }).expect(200)).body.color).toBeNull();
  });

  it('sets the color on a tag that has none', async () => {
    const plain = await addTag(app, { name: 'plain' });
    expect((await patch(plain.id, { color: '#000000' }).expect(200)).body.color).toBe('#000000');
  });

  it('changes the name and the color together, and trims the name', async () => {
    const res = await patch(food.id, { name: '  Meals ', color: null }).expect(200);
    expect(res.body).toMatchObject({ name: 'Meals', color: null });
  });

  it('reports the real usageCount', async () => {
    await spend([food.id]);
    await spend([food.id]);
    expect((await patch(food.id, { name: 'meals' }).expect(200)).body.usageCount).toBe(2);
  });

  it('a rename shows on the spendings that carry the tag, which refer to it by id', async () => {
    const spending = await spend([food.id]);
    await patch(food.id, { name: 'meals' }).expect(200);
    const page = (await request(app).get('/api/spendings').expect(200)).body;
    expect(page.items).toEqual([spending]);
    expect(await names()).toEqual(['meals']);
  });

  describe('the name must still be free, the tag itself excepted', () => {
    it.each([
      ['another capitalization of its own name', 'Food'],
      ['all capitals', 'FOOD'],
      ['its own name, unchanged', 'food'],
      ['its own name with spaces around it', '  food '],
    ])('allows %s', async (_label, name) => {
      const res = await patch(food.id, { name }).expect(200);
      expect(res.body.name).toBe(name.trim());
    });

    it('allows a name that differs only by an accent from a name that is free', async () => {
      const cafe = await addTag(app, { name: 'Cafe' });
      expect((await patch(cafe.id, { name: 'Café' }).expect(200)).body.name).toBe('Café');
    });

    it.each([
      ['the same name', 'Work'],
      ['another capitalization', 'WORK'],
      ['spaces around it', ' work '],
    ])(
      'refuses %s of another tag (409 tag_name_taken) and changes nothing',
      async (_label, name) => {
        await addTag(app, { name: 'Work' });
        const before = await list();
        expectApiError(await patch(food.id, { name }), 'tag_name_taken');
        expect(await list()).toEqual(before);
      },
    );

    it('counts the accent as part of the name: "Cafe" cannot become "CAFÉ" while "Café" exists', async () => {
      await addTag(app, { name: 'Café' });
      const cafe = await addTag(app, { name: 'Cafe' });
      // "CAFÉ" is "Café" in capitals; "Cafe" is the tag's own name in another case.
      expectApiError(await patch(cafe.id, { name: 'CAFÉ' }), 'tag_name_taken');
      await patch(cafe.id, { name: 'CAFE' }).expect(200);
    });

    it('does not look at the name when only the color changes, even if two names clash already', async () => {
      db.insert(tags)
        .values([{ name: 'rent' }, { name: 'Rent' }])
        .run();
      await patch(2, { color: '#111111' }).expect(200);
    });
  });

  describe('errors, in order: 400, 404, 409', () => {
    it('is a 404 for an unknown id', async () => {
      expectNotFound(await patch(99, { name: 'x' }));
    });

    it('is a 404, not a 409, when the id is unknown and the name is also taken', async () => {
      expectNotFound(await patch(99, { name: 'food' }));
    });

    it('is a 400, not a 404, when the id is unknown and the body is also invalid', async () => {
      expectValidationPaths(await patch(99, { name: '' }), 'name');
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ['']],
      ['an empty name', { name: '' }, ['name']],
      ['a blank name', { name: '  ' }, ['name']],
      ['a too long name', { name: 'x'.repeat(TAG_NAME_MAX_LENGTH + 1) }, ['name']],
      ['a null name (a name cannot be cleared)', { name: null }, ['name']],
      ['a numeric name', { name: 5 }, ['name']],
      ['a color that is not hex', { color: 'blue' }, ['color']],
      ['an empty color', { color: '' }, ['color']],
      ['an unknown key', { usageCount: 3 }, ['']],
      ['an unknown key next to a name', { name: 'a', id: 3 }, ['']],
    ])('rejects %s', async (_label, payload, paths) => {
      const before = await list();
      expectValidationPaths(await patch(food.id, payload), ...paths);
      expect(await list()).toEqual(before);
    });

    it.each(['abc', '0', '-1', '2.5', '99999999999999999999999'])(
      'rejects the id %j',
      async (id) => {
        expectValidationPaths(await patch(id, { name: 'x' }), 'id');
      },
    );
  });
});

describe('a name made only of invisible characters (400)', () => {
  /** What `trim()` and the schema let through and the name comparison takes for the empty name. */
  const INVISIBLE: [string, string][] = [
    ['a zero-width space', '​'],
    ['two zero-width spaces', '​​'],
    ['a variation selector', '️'],
    ['a supplementary variation selector', '\u{E0100}'],
    ['a right-to-left override', '‮'],
    ['a NUL character', '\u0000'],
    ['a zero-width joiner', '‍'],
    ['a word joiner', '⁠'],
    ['a soft hyphen', '­'],
    ['a mix of them', '​️‮\u0000‍'],
    ['invisible characters around a space', '​ ​'],
    ['invisible characters with spaces around them', '  ​​  '],
  ];
  /** The body of the 400: the same issue the schema gives an empty name. */
  const REQUIRED = {
    code: 'validation_error',
    message: 'Invalid request',
    details: [{ path: 'name', message: 'Name is required' }],
  };

  describe('POST /api/tags', () => {
    it.each(INVISIBLE)('refuses %s and stores nothing', async (_label, name) => {
      const res = await post({ name });
      expectValidationPaths(res, 'name');
      expect(res.body.error).toEqual(REQUIRED);
      expect(await list()).toEqual([]);
      expect(db.select().from(tags).all()).toEqual([]);
    });

    it('refuses it whatever else is in the body, and stores nothing', async () => {
      expectValidationPaths(await post({ name: '​', color: '#ff0000' }), 'name');
      expect(db.select().from(tags).all()).toEqual([]);
    });

    it('answers a bad body with the issues of the schema, as it always did', async () => {
      // The check is the service's, after the schema's: the schema's issues come alone.
      expectValidationPaths(await post({ name: '​', color: 'bad' }), 'color');
      expectValidationPaths(await post({ name: '   ' }), 'name');
    });
  });

  describe('PATCH /api/tags/:id', () => {
    let food: TagDto;
    beforeEach(async () => {
      food = await addTag(app, { name: 'food', color: '#22c55e' });
    });

    it.each(INVISIBLE)('refuses %s and changes nothing', async (_label, name) => {
      // The color is valid, and is not applied either: the request fails as a whole.
      const res = await patch(food.id, { name, color: '#ff0000' });
      expectValidationPaths(res, 'name');
      expect(res.body.error).toEqual(REQUIRED);
      expect(await list()).toEqual([food]);
    });

    it('is a 400 before the 404: an unknown id with such a name', async () => {
      const res = await patch(99, { name: '​' });
      expectValidationPaths(res, 'name');
      expect(res.body.error).toEqual(REQUIRED);
      expect(await list()).toEqual([food]);
    });

    it('an unknown id with a good name is still a 404', async () => {
      expectNotFound(await patch(99, { name: 'x' }));
    });

    it('is a 400, not a 409, when a tag with such a name exists already', async () => {
      db.insert(tags).values({ name: '​​' }).run();
      expectValidationPaths(await patch(food.id, { name: '​' }), 'name');
    });
  });

  describe('a name with an invisible character next to real ones is valid', () => {
    it.each([
      ['inside a word', 'gro​ceries'],
      ['before a word', '​groceries'],
      ['after a word', 'groceries​'],
      ['around a word', '​​groceries​'],
      ['a variation selector after an emoji', '❤️'],
      ['an emoji joined with a zero-width joiner', '\u{1F468}‍\u{1F469}‍\u{1F467}'],
    ])('POST accepts %s, stored as sent', async (_label, name) => {
      const res = await post({ name }).expect(201);
      expect(res.body.name).toBe(name);
      expect((await list()).map((tag) => tag.name)).toEqual([name]);
    });

    it('PATCH accepts it, stored as sent', async () => {
      const food = await addTag(app, { name: 'food' });
      const res = await patch(food.id, { name: 'gro​ceries' }).expect(200);
      expect(res.body.name).toBe('gro​ceries');
    });

    it('it is still the same name as the text without the invisible character (409)', async () => {
      // The comparison ignores the character, so "gro<ZWSP>ceries" is "groceries".
      await addTag(app, { name: 'groceries' });
      expectApiError(await post({ name: 'gro​ceries' }), 'tag_name_taken');
      const food = await addTag(app, { name: 'food' });
      expectApiError(await patch(food.id, { name: 'GRO​CERIES' }), 'tag_name_taken');
    });
  });

  describe('a tag that already has such a name (an older row)', () => {
    beforeEach(() => {
      db.insert(tags).values({ name: '​' }).run();
    });

    it('is listed like any other', async () => {
      expect(await list()).toEqual([{ id: 1, name: '​', color: null, usageCount: 0 }]);
    });

    it('can still be recolored, as the name is not given', async () => {
      const res = await patch(1, { color: '#112233' }).expect(200);
      expect(res.body).toMatchObject({ name: '​', color: '#112233' });
    });

    it('can be renamed to a real name, and deleted', async () => {
      expect((await patch(1, { name: 'Fixed' }).expect(200)).body.name).toBe('Fixed');
      await request(app).delete('/api/tags/1').expect(204);
    });

    it('cannot be renamed to another blank name, and creating one is a 400, not a 409', async () => {
      expectValidationPaths(await patch(1, { name: '​​' }), 'name');
      expectValidationPaths(await post({ name: '​​' }), 'name');
      expect(await names()).toEqual(['​']);
    });
  });
});

describe('DELETE /api/tags/:id', () => {
  it('removes the tag (204, no body) and only that one', async () => {
    const keep = await addTag(app, { name: 'keep' });
    const gone = await addTag(app, { name: 'gone' });
    const res = await request(app).delete(`/api/tags/${gone.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await list()).toEqual([keep]);
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const tag = await addTag(app);
    expectNotFound(await request(app).delete('/api/tags/99'));
    await request(app).delete(`/api/tags/${tag.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/tags/${tag.id}`));
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects the id %j (400)', async (id) => {
    expectValidationPaths(await request(app).delete(`/api/tags/${id}`), 'id');
  });

  it('lets the name be used again, by a new tag with a new id', async () => {
    const old = await addTag(app, { name: 'Groceries' });
    await request(app).delete(`/api/tags/${old.id}`).expect(204);
    const again = await addTag(app, { name: 'groceries' });
    expect(again.id).toBeGreaterThan(old.id);
  });

  describe('the tag leaves every spending that carries it, and the spendings stay', () => {
    let food: TagDto;
    let work: TagDto;
    let a: SpendingDto;
    let b: SpendingDto;
    let c: SpendingDto;
    beforeEach(async () => {
      food = await addTag(app, { name: 'food' });
      work = await addTag(app, { name: 'work' });
      a = await spend([food.id, work.id], { amount: 100 });
      b = await spend([food.id], { amount: 200 });
      c = await spend([work.id], { amount: 400 });
    });
    const page = async () => (await request(app).get('/api/spendings').expect(200)).body;

    it('removes the tag from the spendings and leaves them and their totals as they are', async () => {
      const before = await page();
      await request(app).delete(`/api/tags/${food.id}`).expect(204);

      const after = await page();
      expect(after.total).toBe(3);
      expect(after.totalAmount).toBe(before.totalAmount);
      const byId = Object.fromEntries(after.items.map((s: SpendingDto) => [s.id, s]));
      expect(byId[a.id]).toEqual({ ...a, tagIds: [work.id] });
      expect(byId[b.id]).toEqual({ ...b, tagIds: [] });
      expect(byId[c.id]).toEqual({ ...c, tagIds: [work.id] });
    });

    it('proves the cascade in the database: no row of the tag is left in spending_tags', async () => {
      // The cascade only exists while foreign keys are enforced on the connection.
      expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.select().from(spendingTags).all()).toHaveLength(4);

      await request(app).delete(`/api/tags/${food.id}`).expect(204);

      const rows = db.select().from(spendingTags).all();
      expect(rows.filter((row) => row.tagId === food.id)).toEqual([]);
      expect(rows.map((row) => [row.spendingId, row.tagId]).sort()).toEqual(
        [
          [a.id, work.id],
          [c.id, work.id],
        ].sort(),
      );
      expect(db.select().from(spendings).all()).toHaveLength(3);
    });

    it('leaves the other tags alone, usageCount included', async () => {
      await request(app).delete(`/api/tags/${food.id}`).expect(204);
      expect(await list()).toEqual([{ ...work, usageCount: 2 }]);
    });

    it('a new tag with the old name starts with no spendings', async () => {
      await request(app).delete(`/api/tags/${food.id}`).expect(204);
      const fresh = await addTag(app, { name: 'food' });
      expect(fresh.usageCount).toBe(0);
      expect((await page()).items.every((s: SpendingDto) => !s.tagIds.includes(fresh.id))).toBe(
        true,
      );
    });

    it('is not blocked by being in use: a tag in use is deleted the same way', async () => {
      await request(app).delete(`/api/tags/${work.id}`).expect(204);
      await request(app).delete(`/api/tags/${food.id}`).expect(204);
      expect((await page()).items.map((s: SpendingDto) => s.tagIds)).toEqual([[], [], []]);
      expect(db.select().from(spendingTags).all()).toEqual([]);
    });
  });
});

describe('usageCount follows the spendings', () => {
  it('goes up and down as spendings are created, retagged and deleted', async () => {
    const food = await addTag(app, { name: 'food' });
    const work = await addTag(app, { name: 'work' });
    expect(await usage()).toEqual({ food: 0, work: 0 });

    const first = await spend([food.id]);
    expect(await usage()).toEqual({ food: 1, work: 0 });
    const second = await spend([food.id, work.id]);
    expect(await usage()).toEqual({ food: 2, work: 1 });

    // Replace the first spending's tags: food -> work.
    await request(app)
      .patch(`/api/spendings/${first.id}`)
      .send({ tagIds: [work.id] })
      .expect(200);
    expect(await usage()).toEqual({ food: 1, work: 2 });

    // A change that leaves tagIds out keeps the tags and the counts.
    await request(app).patch(`/api/spendings/${first.id}`).send({ amount: 5 }).expect(200);
    expect(await usage()).toEqual({ food: 1, work: 2 });

    // Clearing and re-giving the same tag.
    await request(app).patch(`/api/spendings/${first.id}`).send({ tagIds: [] }).expect(200);
    expect(await usage()).toEqual({ food: 1, work: 1 });
    await request(app)
      .patch(`/api/spendings/${first.id}`)
      .send({ tagIds: [work.id, food.id] })
      .expect(200);
    expect(await usage()).toEqual({ food: 2, work: 2 });

    // Deleting a spending takes its tags with it, and a spending counts once for each tag.
    await request(app).delete(`/api/spendings/${second.id}`).expect(204);
    expect(await usage()).toEqual({ food: 1, work: 1 });
    await request(app).delete(`/api/spendings/${first.id}`).expect(204);
    expect(await usage()).toEqual({ food: 0, work: 0 });
    expect(db.select().from(spendingTags).all()).toEqual([]);
  });

  it('is the same in the create, PATCH and list responses of the tag', async () => {
    const food = await addTag(app, { name: 'food' });
    await spend([food.id]);
    await spend([food.id]);
    expect((await patch(food.id, { color: '#000000' }).expect(200)).body.usageCount).toBe(2);
    expect((await list())[0]?.usageCount).toBe(2);
  });
});

describe('a tag never changes a number', () => {
  /**
   * The same facts in a fresh app, with or without tags on the spendings. They cover an
   * incremental and a plain budget, a subscription, an income, a refund, a transfer and a closed,
   * the current and a future month.
   */
  async function buildWorld(tagged: boolean) {
    const { app: world } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(world, { startMonth: '2026-01', salary: 300000, openingSavings: 10000 });
    const g = await addBudget(world, {
      name: 'Groceries',
      amount: 40000,
      incremental: true,
      startMonth: '2026-01',
    });
    const f = await addBudget(world, {
      name: 'Fun',
      amount: 10000,
      incremental: false,
      startMonth: '2026-01',
    });
    await addSubscription(world, { name: 'Netflix', amount: 1299, startMonth: '2026-01' });
    await addIncome(world, { date: '2026-02-05', amount: 50000 });
    const food = tagged ? await addTag(world, { name: 'food', color: '#22c55e' }) : undefined;
    const fun = tagged ? await addTag(world, { name: 'fun' }) : undefined;
    const ids = (...tagIds: (number | undefined)[]) =>
      tagged ? tagIds.filter((id): id is number => id !== undefined) : undefined;

    await addSpending(world, {
      budgetId: g.id,
      date: '2026-01-10',
      amount: 12000,
      tagIds: ids(food?.id),
    });
    await addSpending(world, {
      budgetId: g.id,
      date: '2026-02-11',
      amount: 45000,
      tagIds: ids(food?.id, fun?.id),
    });
    await addSpending(world, {
      budgetId: f.id,
      date: '2026-03-02',
      amount: -1500,
      tagIds: ids(fun?.id),
    });
    await addSpending(world, {
      budgetId: f.id,
      date: '2026-04-20',
      amount: 700,
      tagIds: ids(fun?.id),
    });
    await addTransfer(world, {
      date: '2026-02-10',
      fromBudgetId: g.id,
      toBudgetId: f.id,
      amount: 3000,
    });
    return { world, tags: [food, fun] };
  }

  /** Every read model that derives numbers: the months, their summaries, the budgets, the savings. */
  async function figures(world: Express) {
    const views = [];
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      views.push(await monthView(world, month));
    }
    return {
      views,
      summaries: await getJson(world, '/api/months?from=2026-01&to=2026-06'),
      budgets: await getJson(world, '/api/budgets'),
      savings: await getJson(world, '/api/savings'),
      incomes: await getJson(world, '/api/incomes'),
    };
  }

  it('gives the same months, budgets and savings with and without tags on the spendings', async () => {
    const plain = await buildWorld(false);
    const tagged = await buildWorld(true);
    expect(await figures(tagged.world)).toEqual(await figures(plain.world));

    // The spendings differ only by their tags.
    const spendingsOf = async (world: Express) =>
      (await getJson<{ items: SpendingDto[]; totalAmount: number }>(world, '/api/spendings')).items;
    const stripped = (await spendingsOf(tagged.world)).map((s) => ({ ...s, tagIds: [] }));
    expect(stripped).toEqual(await spendingsOf(plain.world));
  });

  it('is unchanged by creating, renaming, recoloring, retagging and deleting tags', async () => {
    const { world, tags: made } = await buildWorld(true);
    const before = await figures(world);
    const [food, fun] = made;
    const spendingIds = (
      await getJson<{ items: SpendingDto[] }>(world, '/api/spendings')
    ).items.map((s) => s.id);

    const extra = await addTag(world, { name: 'extra', color: '#ff0000' });
    expect(await figures(world)).toEqual(before);

    await request(world)
      .patch(`/api/tags/${food?.id}`)
      .send({ name: 'Meals', color: null })
      .expect(200);
    await request(world).patch(`/api/tags/${fun?.id}`).send({ color: '#123456' }).expect(200);
    expect(await figures(world)).toEqual(before);

    for (const id of spendingIds) {
      await request(world)
        .patch(`/api/spendings/${id}`)
        .send({ tagIds: [extra.id] })
        .expect(200);
    }
    expect(await figures(world)).toEqual(before);

    await request(world).delete(`/api/tags/${extra.id}`).expect(204);
    await request(world).delete(`/api/tags/${food?.id}`).expect(204);
    expect(await figures(world)).toEqual(before);
  });
});
