import {
  IMPORT_MAX_ROWS,
  type ImportCommitResponse,
  type RuleViolationRule,
  type SpendingDto,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { spendingTags, spendings } from '../../db/schema';
import { dumpDb } from '../../testing/db-dump';
import {
  addBudget,
  addSpending,
  addTag,
  expectApiError,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import {
  BANK_MAPPING,
  allToBudget,
  bankFile,
  commitOf,
  commitRequest,
  expectRejected,
  previewOf,
} from '../../testing/import-helpers';
import { createTestApp } from '../../testing/test-app';

/** Today is 2026-03-15 (10:00 UTC), tracking started in 2026-01, and there are two budgets. */
let app: Express;
let db: Db;
let groceries: number;
let fun: number;

beforeEach(async () => {
  ({ app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01' });
  groceries = (await addBudget(app, { name: 'Groceries', startMonth: '2026-01' })).id;
  fun = (await addBudget(app, { name: 'Fun', startMonth: '2026-01' })).id;
});

const stored = () => db.select().from(spendings).all();
const listAll = async (): Promise<SpendingDto[]> =>
  (await request(app).get('/api/spendings?limit=200').expect(200)).body.items;

describe('POST /api/import/commit: storing the rows', () => {
  const csv = bankFile([
    '2026-03-02,-12.30,  Coffee   Shop ', // line 2
    '2026-03-03,-5,Bakery', //               line 3
    '2026-03-04,+1500.00,Salary ACME', //    line 4, a credit
    '2026-03-05,-7.00,Not listed', //        line 5
  ]);

  it('stores the listed rows as ordinary spendings and answers 201 with their ids, ascending by line', async () => {
    const res = await commitRequest(app, csv, [
      { line: 3, budgetId: fun },
      { line: 2, budgetId: groceries },
    ]).expect(201);
    expect(res.body).toEqual({
      created: 2,
      items: [
        { line: 2, id: 1 },
        { line: 3, id: 2 },
      ],
    } satisfies ImportCommitResponse);

    const rows = await listAll();
    expect(
      rows.map(({ id, date, amount, budgetId, description, notes, tagIds }) => ({
        id,
        date,
        amount,
        budgetId,
        description,
        notes,
        tagIds,
      })),
    ).toEqual([
      {
        id: 2,
        date: '2026-03-03',
        amount: 500,
        budgetId: fun,
        description: 'Bakery',
        notes: null,
        tagIds: [],
      },
      {
        id: 1,
        date: '2026-03-02',
        amount: 1230,
        budgetId: groceries,
        description: 'Coffee Shop',
        notes: null,
        tagIds: [],
      },
    ]);
  });

  it('stores the hash, a null note, no tags, and the timestamps of the injected clock', async () => {
    const clock = mutableClock('2026-03-15T10:00:00Z');
    ({ app, db } = createTestApp(clock));
    await onboard(app, { startMonth: '2026-01' });
    const budget = (await addBudget(app, { name: 'Groceries', startMonth: '2026-01' })).id;

    clock.set('2026-03-15T10:20:30.456Z');
    await commitOf(app, csv, allToBudget([2, 3], budget));

    const rows = stored();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.importHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.notes).toBeNull();
      expect(row.createdAt).toBe('2026-03-15T10:20:30.456Z');
      expect(row.updatedAt).toBe('2026-03-15T10:20:30.456Z');
    }
    expect(new Set(rows.map((row) => row.importHash)).size).toBe(2);
    expect(db.select().from(spendingTags).all()).toEqual([]);
  });

  it('hashes the preimage of the contract with SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    await commitOf(app, bankFile(['2026-03-02,-12.30,Café  Crème']), allToBudget([2], groceries));
    const preimage = ['wallet-import-v1', '2026-03-02', '1230', 'café crème', '0'].join('\n');
    expect(stored()[0]?.importHash).toBe(createHash('sha256').update(preimage).digest('hex'));
  });

  it("stores a listed credit as a refund (a negative amount) that lowers the budget's spending, and nothing that is not listed", async () => {
    const done = await commitOf(app, csv, [
      { line: 2, budgetId: groceries },
      { line: 4, budgetId: groceries },
    ]);
    expect(done.created).toBe(2);
    expect((await listAll()).map((s) => [s.description, s.amount])).toEqual([
      ['Salary ACME', -150000],
      ['Coffee Shop', 1230],
    ]);
    const view = (await request(app).get('/api/months/2026-03').expect(200)).body;
    const line = view.budgets.find((b: { name: string }) => b.name === 'Groceries');
    expect(line.spent).toBe(1230 - 150000);
  });

  it('cuts a long description to 200 characters but hashes the whole text', async () => {
    const long = 'x'.repeat(260);
    await commitOf(app, bankFile([`2026-03-02,-1,${long}`]), allToBudget([2], groceries));
    expect(stored()[0]?.description).toBe('x'.repeat(200));
    // The row is a duplicate of itself: the hash is of the same (uncut) text.
    const { rows } = await previewOf(app, bankFile([`2026-03-02,-1,${long}`]));
    expect(rows[0]?.duplicate).toBe(true);
  });

  it("imports two identical rows of one file (occurrences 0 and 1), and reads the file in the mapping's format", async () => {
    const file = 'Date;Amount;Text\r\n05/03/2026;3,50;Coffee\r\n05/03/2026;3,50;Coffee\r\n';
    const done = await commitOf(app, file, allToBudget([2, 3], groceries), {
      delimiter: ';',
      dateFormat: 'DD/MM/YYYY',
      decimalSeparator: ',',
      signConvention: 'expenses_positive',
    });
    expect(done.created).toBe(2);
    expect((await listAll()).map((s) => [s.date, s.amount])).toEqual([
      ['2026-03-05', 350],
      ['2026-03-05', 350],
    ]);
    const hashes = stored().map((row) => row.importHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('leaves the other spendings, the budgets and the settings as they are', async () => {
    const mine = await addSpending(app, {
      budgetId: groceries,
      description: 'By hand',
      date: '2026-03-01',
    });
    await commitOf(app, csv, allToBudget([2], groceries));
    expect(stored().find((row) => row.id === mine.id)).toMatchObject({
      description: 'By hand',
      importHash: null,
    });
  });

  it('imports into the current, a closed and a future month alike', async () => {
    const file = bankFile([
      '2026-01-31,-1,Closed',
      '2026-03-15,-2,Current',
      '2026-09-01,-3,Future',
    ]);
    await commitOf(app, file, allToBudget([2, 3, 4], groceries));
    expect((await listAll()).map((s) => s.date).sort()).toEqual([
      '2026-01-31',
      '2026-03-15',
      '2026-09-01',
    ]);
  });

  it('answers ids that ascend with the lines, also for a big commit stored in several batches', async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => `2026-03-02,-${i + 1}.00,Row ${i}`);
    const done = await commitOf(
      app,
      bankFile(rows),
      allToBudget(
        rows.map((_, i) => i + 2),
        groceries,
      ),
    );
    expect(done.created).toBe(1234);
    expect(done.items.map((item) => item.line)).toEqual(rows.map((_, i) => i + 2));
    const ids = done.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const byId = new Map(stored().map((row) => [row.id, row.description]));
    done.items.forEach((item) => expect(byId.get(item.id)).toBe(`Row ${item.line - 2}`));
  });
});

describe('POST /api/import/commit: the body (400)', () => {
  const csv = bankFile(['2026-03-02,-1,A', '2026-03-03,-2,B']);
  const rows = allToBudget([2, 3], 1);

  it.each([
    ['no body', undefined, ['']],
    ['no rows listed', { csv, mapping: BANK_MAPPING, rows: [] }, ['rows']],
    ['rows left out', { csv, mapping: BANK_MAPPING }, ['rows']],
    ['a mapping left out', { csv, rows }, ['mapping']],
    [
      'a line that is 0',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 0, budgetId: 1 }] },
      ['rows.0.line'],
    ],
    [
      'a line that is not whole',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 1.5, budgetId: 1 }] },
      ['rows.0.line'],
    ],
    [
      'a line that is text',
      { csv, mapping: BANK_MAPPING, rows: [{ line: '2', budgetId: 1 }] },
      ['rows.0.line'],
    ],
    [
      'a budget that is text',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 2, budgetId: '1' }] },
      ['rows.0.budgetId'],
    ],
    [
      'a budget that is 0',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 2, budgetId: 0 }] },
      ['rows.0.budgetId'],
    ],
    [
      'a row with no budget',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 2 }] },
      ['rows.0.budgetId'],
    ],
    [
      'an amount, a date or a description sent along (the server reads them from the file)',
      { csv, mapping: BANK_MAPPING, rows: [{ line: 2, budgetId: 1, amount: 5 }] },
      ['rows.0'],
    ],
    ['an unknown key', { csv, mapping: BANK_MAPPING, rows, extra: true }, ['']],
    [
      'the same line twice, at the second one',
      { csv, mapping: BANK_MAPPING, rows: [...rows, { line: 2, budgetId: 1 }] },
      ['rows.2.line'],
    ],
    [
      'a mapping that is not valid',
      { csv, mapping: { ...BANK_MAPPING, descriptionColumn: 1 }, rows },
      ['mapping.descriptionColumn'],
    ],
  ])('is a 400 at the field for %s', async (_label, body, paths) => {
    const res = await request(app).post('/api/import/commit').send(body);
    expectValidationPaths(res, ...paths);
    expect(stored()).toEqual([]);
  });

  it('refuses more rows than the limit at rows, before it reads the file', async () => {
    const tooMany = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({
      line: i + 2,
      budgetId: groceries,
    }));
    const res = await commitRequest(app, csv, tooMany);
    expectValidationPaths(res, 'rows');
  });

  it('checks the shape before the file: a bad body with a broken file is one error at the body', async () => {
    const broken = 'date,amount,description\n2026-03-02,-1,"never closed\n';
    expectValidationPaths(await commitRequest(app, broken, []), 'rows');
  });

  it('refuses a file with an unterminated quote at csv, and names the line', async () => {
    const broken = 'date,amount,description\n2026-03-02,-1,A\n2026-03-03,-1,"never closed\n';
    const res = await commitRequest(app, broken, allToBudget([2], groceries));
    expectValidationPaths(res, 'csv');
    expect(res.body.error.details[0].message).toContain('line 3');
    expect(stored()).toEqual([]);
  });

  it('refuses a file with more data rows than the limit at csv, before the rows are judged', async () => {
    const big = bankFile(Array(IMPORT_MAX_ROWS + 1).fill('2026-03-01,-1,A'));
    // Line 2 is fine, line 999999 is not a row: the 400 for the file comes first, not the 422.
    const res = await commitRequest(app, big, [
      { line: 2, budgetId: groceries },
      { line: 999999, budgetId: groceries },
    ]);
    expectValidationPaths(res, 'csv');
    expect(stored()).toEqual([]);
  });

  it('accepts a file of exactly the most rows, all listed', async () => {
    const big = bankFile(
      Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `2026-03-01,-1,Row ${i}`),
    );
    const lines = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => i + 2);
    const done = await commitOf(app, big, allToBudget(lines, groceries));
    expect(done.created).toBe(IMPORT_MAX_ROWS);
  });

  it('answers 409 not_onboarded until the settings exist', async () => {
    const fresh = createTestApp(mutableClock('2026-03-15T10:00:00Z')).app;
    expectApiError(await request(fresh).post('/api/import/commit').send({}), 'not_onboarded');
    expectApiError(await commitRequest(fresh, csv, rows), 'not_onboarded');
  });
});

describe('POST /api/import/commit: the rows that cannot be imported (422 import_rows_rejected)', () => {
  it.each([
    ['the header', 1],
    ['a line past the end of the file', 99],
    ['a blank line', 3],
    ['the continuation of a record that spans lines', 5],
  ])('rejects %s as unknown_line, alone', async (_label, line) => {
    const csv = 'date,amount,description\n2026-03-02,-1,A\n\n2026-03-03,-1,"two\nlines"\n';
    expectRejected(await commitRequest(app, csv, [{ line, budgetId: groceries }]), [
      { line, errors: ['unknown_line'] },
    ]);
    expect(stored()).toEqual([]);
  });

  it('is unknown_line alone even when the line is listed with a budget that does not exist', async () => {
    expectRejected(
      await commitRequest(app, bankFile(['2026-03-02,-1,A']), [{ line: 1, budgetId: 999 }]),
      [{ line: 1, errors: ['unknown_line'] }],
    );
  });

  it('rejects the text codes of a row, each with every code that applies, in order', async () => {
    const csv = bankFile([
      'not a date,abc,', //                  2: invalid_date, invalid_amount, empty_description
      '2026-03-01,0.00,Rent', //             3: zero_amount
      '2026-03-01,10000000000.01,Yacht', //  4: amount_too_large
      '2026-03-01,-1,', //                   5: empty_description
      '2026-03-01,-1,Fine', //               6: fine
    ]);
    const res = await commitRequest(app, csv, allToBudget([6, 5, 4, 3, 2], groceries));
    expectRejected(res, [
      { line: 2, errors: ['invalid_date', 'invalid_amount', 'empty_description'] },
      { line: 3, errors: ['zero_amount'] },
      { line: 4, errors: ['amount_too_large'] },
      { line: 5, errors: ['empty_description'] },
    ]);
    expect(stored()).toEqual([]);
  });

  it('adds the budget and date rules, each under its own name, in the canonical order', async () => {
    await request(app)
      .post(`/api/budgets/${fun}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    const csv = bankFile([
      '2026-03-01,-1,A', //    2: Fun ended in February: outside_active_months
      '2025-12-31,-1,B', //    3: before_start_month (and so not outside_active_months)
      '2026-03-01,-1,C', //    4: unknown budget
      '2025-12-31,-1,D', //    5: unknown budget and before the start month
      'bad date,0,', //        6: text codes, then unknown_budget (the date rules need a date)
      '2026-03-01,-1,E', //    7: fine
    ]);
    const res = await commitRequest(app, csv, [
      { line: 7, budgetId: groceries },
      { line: 2, budgetId: fun },
      { line: 3, budgetId: groceries },
      { line: 4, budgetId: 999 },
      { line: 5, budgetId: 999 },
      { line: 6, budgetId: 999 },
    ]);
    expectRejected(res, [
      { line: 2, errors: ['outside_active_months'] },
      { line: 3, errors: ['before_start_month'] },
      { line: 4, errors: ['unknown_budget'] },
      { line: 5, errors: ['unknown_budget', 'before_start_month'] },
      { line: 6, errors: ['invalid_date', 'zero_amount', 'empty_description', 'unknown_budget'] },
    ]);
  });

  it('rejects a row dated before the budget starts, and one dated after it ended', async () => {
    const boat = (await addBudget(app, { name: 'Boat', startMonth: '2026-06', amount: 1000 })).id;
    const csv = bankFile(['2026-05-31,-1,Early', '2026-06-01,-1,On time']);
    expectRejected(await commitRequest(app, csv, allToBudget([2, 3], boat)), [
      { line: 2, errors: ['outside_active_months'] },
    ]);
  });

  it('rejects a duplicate, also together with other codes of the row', async () => {
    const csv = bankFile(['2026-03-02,-1,A', '2026-03-03,-2,B']);
    await commitOf(app, csv, allToBudget([2], groceries));
    expectRejected(await commitRequest(app, csv, [...allToBudget([2, 3], groceries)]), [
      { line: 2, errors: ['duplicate'] },
    ]);
    // A duplicate in a budget that has ended: the budget rule comes first, then the duplicate.
    await request(app)
      .post(`/api/budgets/${fun}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    expectRejected(await commitRequest(app, csv, [{ line: 2, budgetId: fun }]), [
      { line: 2, errors: ['outside_active_months', 'duplicate'] },
    ]);
  });

  it('imports nothing when one listed row fails, however many are fine', async () => {
    const csv = bankFile(['2026-03-02,-1,A', '2026-03-03,-2,B', '2026-03-04,-3,C', 'oops,-4,D']);
    const before = dumpDb(db);
    const res = await commitRequest(app, csv, allToBudget([2, 3, 4, 5], groceries));
    expectRejected(res, [{ line: 5, errors: ['invalid_date'] }]);
    expect(dumpDb(db)).toBe(before);
  });

  it('does not judge the rows that are not listed', async () => {
    const csv = bankFile(['2026-03-02,-1,A', 'oops,-4,Broken', '2026-03-04,0,Zero']);
    const done = await commitOf(app, csv, allToBudget([2], groceries));
    expect(done.created).toBe(1);
  });

  it('reports every failing row together, ascending by line whatever order they were listed in', async () => {
    const csv = bankFile(['a,-1,A', 'b,-1,B', 'c,-1,C']);
    const res = await commitRequest(app, csv, [
      { line: 4, budgetId: groceries },
      { line: 2, budgetId: groceries },
      { line: 3, budgetId: groceries },
      { line: 77, budgetId: groceries },
    ]);
    expectRejected(res, [
      { line: 2, errors: ['invalid_date'] },
      { line: 3, errors: ['invalid_date'] },
      { line: 4, errors: ['invalid_date'] },
      { line: 77, errors: ['unknown_line'] },
    ]);
  });

  it('is a 422 and not a 400: the response has the ApiError shape and a message', async () => {
    const res = await commitRequest(app, bankFile(['oops,-4,D']), allToBudget([2], groceries));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('import_rows_rejected');
    expect(typeof res.body.error.message).toBe('string');
  });
});

/**
 * The importer calls the very check of `POST /api/spendings` (`spendingRuleBreaks`), so on every
 * combination of date and budget the first code a commit reports is the rule the spendings endpoint
 * answers with, and a row is accepted exactly when the spending is.
 */
describe('POST /api/import/commit: the rules of POST /api/spendings', () => {
  it('reports the same rule as the spendings endpoint for every date and budget', async () => {
    const ended = (await addBudget(app, { name: 'Ended', startMonth: '2026-01' })).id;
    await request(app)
      .post(`/api/budgets/${ended}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);
    const later = (await addBudget(app, { name: 'Later', startMonth: '2026-06' })).id;

    const dates = [
      '2025-12-31',
      '2026-01-01',
      '2026-02-28',
      '2026-03-01',
      '2026-05-31',
      '2026-06-01',
      '2030-01-01',
    ];
    const budgetIds = [groceries, ended, later, 424242];
    let compared = 0;
    for (const date of dates) {
      for (const budgetId of budgetIds) {
        const csv = bankFile([`${date},-1.00,Probe ${date} ${budgetId}`]);
        const commit = await commitRequest(app, csv, [{ line: 2, budgetId }]);
        const spending = await request(app)
          .post('/api/spendings')
          .send({ date, amount: 100, budgetId, description: 'Probe' });

        if (spending.status === 201) {
          expect(commit.status, `${date} ${budgetId}`).toBe(201);
          await request(app).delete(`/api/spendings/${spending.body.id}`).expect(204);
          await request(app).delete(`/api/spendings/${commit.body.items[0].id}`).expect(204);
        } else {
          const rule = spending.body.error.details.rule as RuleViolationRule;
          expect(commit.status, `${date} ${budgetId}`).toBe(422);
          expect(commit.body.error.details.rows[0].errors[0], `${date} ${budgetId}`).toBe(rule);
        }
        compared++;
      }
    }
    expect(compared).toBe(28);
  });
});

describe('POST /api/import/commit: all or nothing', () => {
  it('stores nothing when the write fails halfway through a big commit', async () => {
    // A row far into the file (the second batch of inserts) that the database itself refuses.
    db.$client.exec(`
      CREATE TRIGGER refuse_boom BEFORE INSERT ON spendings
      WHEN NEW.description = 'BOOM'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    const rows = Array.from(
      { length: 700 },
      (_, i) => `2026-03-02,-1.00,${i === 650 ? 'BOOM' : `Row ${i}`}`,
    );
    const before = dumpDb(db);
    const res = await commitRequest(
      app,
      bankFile(rows),
      allToBudget(
        rows.map((_, i) => i + 2),
        groceries,
      ),
    );
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(dumpDb(db)).toBe(before);

    // And the same file imports in full once the obstacle is gone.
    db.$client.exec('DROP TRIGGER refuse_boom');
    const done = await commitOf(
      app,
      bankFile(rows),
      allToBudget(
        rows.map((_, i) => i + 2),
        groceries,
      ),
    );
    expect(done.created).toBe(700);
  });

  it('is safe to send twice: the second one is all duplicates and stores nothing more', async () => {
    const csv = bankFile(['2026-03-02,-1,A', '2026-03-03,-2,B']);
    await commitOf(app, csv, allToBudget([2, 3], groceries));
    const before = dumpDb(db);
    expectRejected(await commitRequest(app, csv, allToBudget([2, 3], groceries)), [
      { line: 2, errors: ['duplicate'] },
      { line: 3, errors: ['duplicate'] },
    ]);
    expect(dumpDb(db)).toBe(before);
  });

  it('can import again the rows of an imported spending that was deleted', async () => {
    const csv = bankFile(['2026-03-02,-1,A', '2026-03-03,-2,B']);
    const first = await commitOf(app, csv, allToBudget([2, 3], groceries));
    await request(app).delete(`/api/spendings/${first.items[0]?.id}`).expect(204);
    expectRejected(await commitRequest(app, csv, allToBudget([2, 3], groceries)), [
      { line: 3, errors: ['duplicate'] },
    ]);
    const again = await commitOf(app, csv, allToBudget([2], groceries));
    expect(again.created).toBe(1);
    expect(stored()).toHaveLength(2);
  });

  it('leaves the tags alone: an imported spending can be tagged afterwards like any other', async () => {
    const tag = await addTag(app, { name: 'Imported' });
    const done = await commitOf(app, bankFile(['2026-03-02,-1,A']), allToBudget([2], groceries));
    const res = await request(app)
      .patch(`/api/spendings/${done.items[0]?.id}`)
      .send({ tagIds: [tag.id] })
      .expect(200);
    expect(res.body.tagIds).toEqual([tag.id]);
  });
});
