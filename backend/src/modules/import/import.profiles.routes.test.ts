import {
  IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH,
  IMPORT_PROFILE_MAX_HEADER_CELLS,
  type ImportProfileDto,
  NAME_MAX_LENGTH,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { importProfiles } from '../../db/schema';
import { dumpDb } from '../../testing/db-dump';
import {
  addBudget,
  addSpending,
  expectApiError,
  expectNotFound,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { BANK_MAPPING, addProfile } from '../../testing/import-helpers';
import { createTestApp } from '../../testing/test-app';

let app: Express;
let db: Db;
let clock: ReturnType<typeof mutableClock>;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
});

const list = async (): Promise<ImportProfileDto[]> =>
  (await request(app).get('/api/import/profiles').expect(200)).body;
const names = async () => (await list()).map((profile) => profile.name);
const post = (payload: object) => request(app).post('/api/import/profiles').send(payload);
const put = (id: number | string, payload: object) =>
  request(app).put(`/api/import/profiles/${id}`).send(payload);
const body = (over: object = {}) => ({
  name: 'My bank',
  mapping: BANK_MAPPING,
  header: ['Date', 'Amount', 'Text'],
  ...over,
});

describe('POST /api/import/profiles', () => {
  it('creates a profile and answers 201 with the DTO: the mapping and the normalized header', async () => {
    const res = await post(body({ header: ['  Booking   DATE ', 'AMOUNT', 'Text'] })).expect(201);
    expect(res.body).toEqual({
      id: 1,
      name: 'My bank',
      mapping: BANK_MAPPING,
      header: ['booking date', 'amount', 'text'],
    });
    expect(await list()).toEqual([res.body]);
  });

  it('stores the timestamps from the injected clock', async () => {
    clock.set('2026-03-15T10:20:30.456Z');
    await post(body()).expect(201);
    const [row] = db.select().from(importProfiles).all();
    expect(row?.createdAt).toBe('2026-03-15T10:20:30.456Z');
    expect(row?.updatedAt).toBe('2026-03-15T10:20:30.456Z');
  });

  it('trims the name and keeps the spaces inside it', async () => {
    expect((await post(body({ name: '  My   bank ' })).expect(201)).body.name).toBe('My   bank');
  });

  it('numbers the profiles one after another and never reuses an id', async () => {
    const a = await addProfile(app, { name: 'a' });
    const b = await addProfile(app, { name: 'b' });
    await request(app).delete(`/api/import/profiles/${b.id}`).expect(204);
    const c = await addProfile(app, { name: 'c' });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  });

  describe('the header signature', () => {
    it.each([
      ['omitted', undefined],
      ['null', null],
    ])('is none when the header is %s', async (_label, header) => {
      const res = await post({
        name: 'x',
        mapping: BANK_MAPPING,
        ...(header === undefined ? {} : { header }),
      }).expect(201);
      expect(res.body.header).toBeNull();
      expect(db.select().from(importProfiles).all()[0]?.headerSignature).toBeNull();
    });

    it('is none when the mapping says there is no header row, even if one is sent', async () => {
      const res = await post(body({ mapping: { ...BANK_MAPPING, hasHeader: false } })).expect(201);
      expect(res.body.header).toBeNull();
    });

    it('keeps an empty header as an empty signature that reaches nothing (400 for a mapping that needs more)', async () => {
      expectValidationPaths(await post(body({ header: [] })), 'header');
    });

    it('must reach the highest of the three mapped columns (400 at header)', async () => {
      const mapping = { ...BANK_MAPPING, dateColumn: 0, amountColumn: 1, descriptionColumn: 4 };
      expectValidationPaths(await post(body({ mapping, header: ['a', 'b', 'c', 'd'] })), 'header');
      const ok = await post(body({ mapping, header: ['a', 'b', 'c', 'd', 'e'] })).expect(201);
      expect(ok.body.header).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('does not need to reach anything when the mapping has no header row', async () => {
      await post(body({ mapping: { ...BANK_MAPPING, hasHeader: false }, header: ['a'] })).expect(
        201,
      );
    });

    it('allows up to 100 cells of up to 200 characters, and no more', async () => {
      const long = 'x'.repeat(IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH);
      const cells = Array.from({ length: IMPORT_PROFILE_MAX_HEADER_CELLS }, () => long);
      await post(body({ header: cells })).expect(201);
      expectValidationPaths(
        await post(body({ name: 'b', header: [...cells, 'one more'] })),
        'header',
      );
      expectValidationPaths(
        await post(body({ name: 'c', header: ['a', 'b', long + 'y'] })),
        'header.2',
      );
    });
  });

  describe('a name that is taken (409 import_profile_name_taken)', () => {
    it.each([
      ['the same name', 'My bank'],
      ['another capitalization', 'my BANK'],
      ['spaces around it (they are trimmed)', '  MY BANK  '],
    ])('%s', async (_label, name) => {
      await addProfile(app, { name: 'My bank' });
      expectApiError(await post(body({ name })), 'import_profile_name_taken');
      expect(await names()).toEqual(['My bank']);
    });

    it('compares like tag names: every alphabet, Unicode forms, not accents', async () => {
      await addProfile(app, { name: 'Café' });
      expectApiError(await post(body({ name: 'CAFÉ' })), 'import_profile_name_taken');
      await post(body({ name: 'Cafe' })).expect(201); // "Café" and "Cafe" are two names
      await addProfile(app, { name: 'Москва' });
      expectApiError(await post(body({ name: 'МОСКВА' })), 'import_profile_name_taken');
      expect(await names()).toEqual(['Cafe', 'Café', 'Москва']);
    });

    it('does not clash with a tag of the same name: they are two lists', async () => {
      await request(app).post('/api/tags').send({ name: 'My bank' }).expect(201);
      await post(body()).expect(201);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['no body', undefined, ['']],
      ['no name', { mapping: BANK_MAPPING }, ['name']],
      ['a blank name', body({ name: '   ' }), ['name']],
      ['a name that is not text', body({ name: 5 }), ['name']],
      ['a name that is too long', body({ name: 'x'.repeat(NAME_MAX_LENGTH + 1) }), ['name']],
      ['no mapping', { name: 'x' }, ['mapping']],
      [
        'a mapping with an unknown format',
        body({ mapping: { ...BANK_MAPPING, dateFormat: 'YY-MM-DD' } }),
        ['mapping.dateFormat'],
      ],
      [
        'a mapping with the same column twice',
        body({ mapping: { ...BANK_MAPPING, descriptionColumn: 0 } }),
        ['mapping.descriptionColumn'],
      ],
      [
        'a mapping with a column past 99',
        body({ mapping: { ...BANK_MAPPING, descriptionColumn: 100 }, header: null }),
        ['mapping.descriptionColumn'],
      ],
      [
        'a mapping with an unknown key',
        body({ mapping: { ...BANK_MAPPING, extra: 1 } }),
        ['mapping'],
      ],
      ['a header that is not a list', body({ header: 'date' }), ['header']],
      ['a header cell that is not text', body({ header: ['a', 5, 'c'] }), ['header.1']],
      ['an unknown key', body({ extra: 1 }), ['']],
    ])('is a 400 at the field for %s', async (_label, payload, paths) => {
      expectValidationPaths(await post(payload as object), ...paths);
      expect(await list()).toEqual([]);
    });

    it.each([
      ['a zero-width space', '​'],
      ['zero-width spaces and spaces', '​ ​'],
      ['a variation selector', '️'],
    ])(
      'refuses a name made only of invisible characters: %s (400 at name)',
      async (_label, name) => {
        expectValidationPaths(await post(body({ name })), 'name');
      },
    );

    it('accepts a name that has an invisible character next to real ones', async () => {
      await post(body({ name: 'A​B' })).expect(201);
    });

    it('is a 400 before a 409: an invisible name is never a name that is taken', async () => {
      await addProfile(app, { name: 'x' });
      expectValidationPaths(await post(body({ name: '​' })), 'name');
    });
  });

  it('answers 409 not_onboarded until the settings exist', async () => {
    const fresh = createTestApp(clock).app;
    expectApiError(await request(fresh).post('/api/import/profiles').send(body()), 'not_onboarded');
    expectApiError(await request(fresh).get('/api/import/profiles'), 'not_onboarded');
    expectApiError(
      await request(fresh).put('/api/import/profiles/1').send(body()),
      'not_onboarded',
    );
    expectApiError(await request(fresh).delete('/api/import/profiles/1'), 'not_onboarded');
  });
});

describe('GET /api/import/profiles', () => {
  it('is an empty list before any profile exists', async () => {
    expect(await list()).toEqual([]);
  });

  it('lists the profiles ascending by name, ignoring case, then by id', async () => {
    for (const name of ['banana', 'Cherry', 'apple', 'Banana2', 'ÄPFEL'])
      await addProfile(app, { name });
    // "ÄPFEL" sorts before "apple" (f before p): the accent only decides between equal letters.
    expect(await names()).toEqual(['ÄPFEL', 'apple', 'banana', 'Banana2', 'Cherry']);
  });

  it('reads back the mapping and the header exactly as they were saved', async () => {
    const mapping = {
      delimiter: ';',
      hasHeader: true,
      dateColumn: 3,
      amountColumn: 5,
      descriptionColumn: 1,
      dateFormat: 'DD.MM.YYYY',
      decimalSeparator: ',',
      signConvention: 'expenses_positive',
    } as const;
    await post(body({ mapping, header: ['a', 'B', 'c', 'D', 'e', 'F'] })).expect(201);
    expect(await list()).toEqual([
      { id: 1, name: 'My bank', mapping, header: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ]);
  });

  it('is a server error, not bad data, when a stored mapping does not fit the contract', async () => {
    await addProfile(app, { name: 'Good' });
    db.insert(importProfiles)
      .values({ name: 'Corrupt', mapping: { delimiter: 'x' } as never, headerSignature: null })
      .run();
    const res = await request(app).get('/api/import/profiles');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });
});

describe('PUT /api/import/profiles/:id', () => {
  it('replaces the whole profile, the signature included', async () => {
    const created = await addProfile(app, {
      name: 'Old name',
      header: ['date', 'amount', 'description'],
    });
    clock.set('2026-03-16T08:00:00.000Z');
    const mapping = {
      ...BANK_MAPPING,
      delimiter: ';',
      dateColumn: 2,
      amountColumn: 1,
      descriptionColumn: 0,
    };
    const res = await put(created.id, {
      name: 'New name',
      mapping,
      header: ['Text', 'Amount', 'Date'],
    }).expect(200);
    expect(res.body).toEqual({
      id: created.id,
      name: 'New name',
      mapping,
      header: ['text', 'amount', 'date'],
    });
    expect(await list()).toEqual([res.body]);

    const [row] = db.select().from(importProfiles).all();
    expect(row?.createdAt).toBe('2026-03-15T10:00:00.000Z');
    expect(row?.updatedAt).toBe('2026-03-16T08:00:00.000Z');
  });

  it('clears the signature when the header is left out or null, and keeps it when it is sent back', async () => {
    const created = await addProfile(app, { header: ['Date', 'Amount', 'Text'] });
    // Sending the DTO's (normalized) header back keeps the signature as it is.
    const kept = await put(created.id, {
      name: created.name,
      mapping: created.mapping,
      header: created.header,
    }).expect(200);
    expect(kept.body.header).toEqual(['date', 'amount', 'text']);
    expect(
      (await put(created.id, { name: 'x', mapping: BANK_MAPPING }).expect(200)).body.header,
    ).toBeNull();
    await put(created.id, { name: 'x', mapping: BANK_MAPPING, header: ['a', 'b', 'c'] }).expect(
      200,
    );
    expect(
      (await put(created.id, { name: 'x', mapping: BANK_MAPPING, header: null }).expect(200)).body
        .header,
    ).toBeNull();
  });

  it('never clashes with itself: its own name, or another capitalization of it, is fine', async () => {
    const created = await addProfile(app, { name: 'My bank' });
    await put(created.id, body({ name: 'My bank' })).expect(200);
    expect((await put(created.id, body({ name: 'MY BANK' })).expect(200)).body.name).toBe(
      'MY BANK',
    );
  });

  it('answers 409 for the name of another profile, and changes nothing', async () => {
    await addProfile(app, { name: 'First' });
    const second = await addProfile(app, { name: 'Second' });
    const before = dumpDb(db);
    expectApiError(await put(second.id, body({ name: 'first' })), 'import_profile_name_taken');
    expect(dumpDb(db)).toBe(before);
  });

  it('checks 400, then 404, then 409', async () => {
    await addProfile(app, { name: 'First' });
    // An invalid body for an unknown id is a 400, not a 404.
    expectValidationPaths(await put(99, body({ name: '   ' })), 'name');
    expectValidationPaths(await put(99, { name: 'x' }), 'mapping');
    // A valid body with a taken name for an unknown id is a 404, not a 409.
    expectNotFound(await put(99, body({ name: 'First' })));
  });

  it('answers 404 for an unknown id, and 400 for an id that is not a number', async () => {
    expectNotFound(await put(99, body()));
    expectValidationPaths(await put('abc', body()), 'id');
    expectValidationPaths(await put(0, body()), 'id');
  });

  it('refuses the same bodies as a create (400 at the field)', async () => {
    const created = await addProfile(app);
    expectValidationPaths(
      await put(created.id, body({ mapping: { ...BANK_MAPPING, amountColumn: 0 } })),
      'mapping.amountColumn',
    );
    expectValidationPaths(await put(created.id, body({ name: '​' })), 'name');
    expectValidationPaths(await put(created.id, body({ header: ['a'] })), 'header');
  });
});

describe('DELETE /api/import/profiles/:id', () => {
  it('deletes the profile with a 204 and touches nothing else', async () => {
    const budget = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
    await addSpending(app, { budgetId: budget.id });
    const keep = await addProfile(app, { name: 'Keep' });
    const gone = await addProfile(app, { name: 'Gone' });

    const withoutProfile = dumpDbWithout(db, 'import_profiles');
    await request(app).delete(`/api/import/profiles/${gone.id}`).expect(204);
    expect(await list()).toEqual([keep]);
    expect(dumpDbWithout(db, 'import_profiles')).toBe(withoutProfile);
  });

  it('frees the name for another profile', async () => {
    const gone = await addProfile(app, { name: 'Same' });
    await request(app).delete(`/api/import/profiles/${gone.id}`).expect(204);
    await addProfile(app, { name: 'same' });
  });

  it('answers 404 for an unknown id, also for one that was deleted, and 400 for a bad id', async () => {
    expectNotFound(await request(app).delete('/api/import/profiles/99'));
    const created = await addProfile(app);
    await request(app).delete(`/api/import/profiles/${created.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/import/profiles/${created.id}`));
    expectValidationPaths(await request(app).delete('/api/import/profiles/abc'), 'id');
  });
});

/** The dump of every table but one. */
function dumpDbWithout(db: Db, table: string): string {
  const all = JSON.parse(dumpDb(db)) as [string, unknown][];
  return JSON.stringify(all.filter(([name]) => name !== table));
}
