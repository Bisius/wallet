import { IMPORT_MAX_ROWS } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { dumpDb } from '../../testing/db-dump';
import {
  addBudget,
  addSpending,
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
  previewOf,
  previewRequest,
} from '../../testing/import-helpers';
import { createTestApp } from '../../testing/test-app';

/** Today is 2026-03-15, tracking started in 2026-01, and there are two budgets to import into. */
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

const spend = (budgetId: number, date: string, description: string, amount = 1000) =>
  addSpending(app, { budgetId, date, description, amount });

describe('POST /api/import/preview: judging the rows', () => {
  it('answers one row per data row, in file order, with the amount in spending sign', async () => {
    const csv = bankFile([
      '2026-03-02,-12.30,Coffee Shop',
      '2026-03-03,-5,   Bakery   ',
      '2026-03-04,+1500.00,Salary ACME',
    ]);
    const preview = await previewOf(app, csv);

    expect(preview.rows).toEqual([
      {
        line: 2,
        date: '2026-03-02',
        amount: 1230,
        raw: { date: '2026-03-02', amount: '-12.30' },
        description: 'Coffee Shop',
        suggestedBudgetId: null,
        duplicate: false,
        credit: false,
        errors: [],
      },
      {
        line: 3,
        date: '2026-03-03',
        amount: 500,
        raw: { date: '2026-03-03', amount: '-5' },
        description: 'Bakery',
        suggestedBudgetId: null,
        duplicate: false,
        credit: false,
        errors: [],
      },
      {
        // Money in: on the wrong side of the convention, so it is a credit (a refund, if imported).
        line: 4,
        date: '2026-03-04',
        amount: -150000,
        raw: { date: '2026-03-04', amount: '+1500.00' },
        description: 'Salary ACME',
        suggestedBudgetId: null,
        duplicate: false,
        credit: true,
        errors: [],
      },
    ]);
    expect(preview.summary).toEqual({
      total: 3,
      invalid: 0,
      duplicates: 0,
      credits: 1,
      importable: 2,
    });
  });

  it('reads the other sign convention, semicolons, a decimal comma and day-first dates', async () => {
    const csv =
      'Date;Amount;Text\r\n05/03/2026;"1.234,50";Card payment\r\n06/03/2026;-3,20;Refund\r\n';
    const preview = await previewOf(app, csv, {
      delimiter: ';',
      dateFormat: 'DD/MM/YYYY',
      decimalSeparator: ',',
      signConvention: 'expenses_positive',
    });
    expect(preview.rows.map((row) => [row.line, row.date, row.amount, row.credit])).toEqual([
      [2, '2026-03-05', 123450, false],
      [3, '2026-03-06', -320, true],
    ]);
  });

  it('lists every error that applies, in the canonical order, with no date or amount to show', async () => {
    const csv = bankFile([
      'not a date,abc,', //                 invalid_date, invalid_amount, empty_description
      '2025-12-31,0.00,Rent', //            zero_amount, before_start_month
      '2026-03-01,10000000000.01,Yacht', // amount_too_large
      '2025-06-01,0,', //                   zero_amount, empty_description, before_start_month
      '2026-03-01,-4.00,Fine', //           none
    ]);
    const { rows, summary } = await previewOf(app, csv);

    expect(rows.map((row) => [row.line, row.errors])).toEqual([
      [2, ['invalid_date', 'invalid_amount', 'empty_description']],
      [3, ['zero_amount', 'before_start_month']],
      [4, ['amount_too_large']],
      [5, ['zero_amount', 'empty_description', 'before_start_month']],
      [6, []],
    ]);
    expect(rows[0]).toMatchObject({
      date: null,
      amount: null,
      raw: { date: 'not a date', amount: 'abc' },
      description: '',
    });
    expect(rows[1]).toMatchObject({ date: '2025-12-31', amount: 0 }); // zero is 0, not null
    expect(rows[2]).toMatchObject({ amount: null }); // too large is unreadable
    expect(summary).toEqual({ total: 5, invalid: 4, duplicates: 0, credits: 0, importable: 1 });
  });

  it('refuses a date before the start month, to the day', async () => {
    const csv = bankFile(['2025-12-31,-1,Before', '2026-01-01,-1,On the first day']);
    const { rows } = await previewOf(app, csv);
    expect(rows.map((row) => row.errors)).toEqual([['before_start_month'], []]);
  });

  it('cleans the description, cuts it to 200 characters and leaves the date and amount cells trimmed', async () => {
    const long = `${'word '.repeat(60)}end`;
    const csv = bankFile([
      `  2026-03-02 ,  -1.00 ,"  Line one\n\tline  two  "`,
      `2026-03-03,-1,${long}`,
    ]);
    const { rows } = await previewOf(app, csv);
    expect(rows[0]).toMatchObject({
      raw: { date: '2026-03-02', amount: '-1.00' },
      description: 'Line one line two',
    });
    expect(rows[1]?.description).toBe(long.slice(0, 200).trimEnd());
    expect(rows[1]?.description.length).toBeLessThanOrEqual(200);
  });

  it('numbers lines as an editor does: blank lines and multi-line fields count', async () => {
    const csv = 'date,amount,description\n\n2026-03-02,-1,"two\nlines"\n2026-03-03,-2,Next\n';
    const { rows } = await previewOf(app, csv);
    expect(rows.map((row) => [row.line, row.description])).toEqual([
      [3, 'two lines'],
      [5, 'Next'],
    ]);
  });

  it('treats the first record as data when the file has no header', async () => {
    const csv = '2026-03-02,-1,A\n2026-03-03,-2,B\n';
    const withoutHeader = await previewOf(app, csv, { hasHeader: false });
    expect(withoutHeader.rows.map((row) => row.line)).toEqual([1, 2]);
    const withHeader = await previewOf(app, csv);
    expect(withHeader.rows.map((row) => row.line)).toEqual([2]);
  });

  it('answers an empty list for a file that is only a header (or nothing at all)', async () => {
    for (const csv of ['date,amount,description\n', '']) {
      const preview = await previewOf(app, csv);
      expect(preview).toEqual({
        rows: [],
        summary: { total: 0, invalid: 0, duplicates: 0, credits: 0, importable: 0 },
      });
    }
  });

  it('writes nothing, however often it is repeated', async () => {
    await spend(groceries, '2026-03-01', 'Lidl');
    const before = dumpDb(db);
    const csv = bankFile(['2026-03-02,-12.30,Lidl', '2026-03-02,-12.30,Lidl', 'x,y,z']);
    const first = await previewOf(app, csv);
    expect(await previewOf(app, csv)).toEqual(first);
    expect(dumpDb(db)).toBe(before);
  });

  it('accepts the most rows a file may have and refuses one more (400 at csv)', async () => {
    const row = '2026-03-01,-1.00,A';
    const ok = await previewOf(app, bankFile(Array(IMPORT_MAX_ROWS).fill(row)));
    expect(ok.summary.total).toBe(IMPORT_MAX_ROWS);

    const tooMany = bankFile(Array(IMPORT_MAX_ROWS + 1).fill(row));
    expectValidationPaths(await previewRequest(app, tooMany), 'csv');
    // Blank lines are not rows: they do not count against the limit.
    const blanks = bankFile(Array(IMPORT_MAX_ROWS).fill(row)) + '\n\n\n';
    expect((await previewOf(app, blanks)).summary.total).toBe(IMPORT_MAX_ROWS);
    // Without a header the first record is a row too.
    expectValidationPaths(
      await previewRequest(app, bankFile(Array(IMPORT_MAX_ROWS).fill(row)), { hasHeader: false }),
      'csv',
    );
  });

  it('refuses a file with a quoted field that is never closed, and names its line', async () => {
    const csv = 'date,amount,description\n2026-03-02,-1,A\n2026-03-03,-1,"never closed\n';
    const res = await previewRequest(app, csv);
    expectValidationPaths(res, 'csv');
    expect(res.body.error.details[0].message).toContain('line 3');
  });

  describe('the body', () => {
    it.each([
      ['no body', undefined, ['']],
      ['a missing mapping', { csv: 'a' }, ['mapping']],
      ['a missing csv', { mapping: BANK_MAPPING }, ['csv']],
      ['a csv that is not text', { csv: 5, mapping: BANK_MAPPING }, ['csv']],
      ['an unknown key', { csv: 'a', mapping: BANK_MAPPING, extra: 1 }, ['']],
      [
        'an unknown date format',
        { csv: 'a', mapping: { ...BANK_MAPPING, dateFormat: 'DD/MM/YY' } },
        ['mapping.dateFormat'],
      ],
      [
        'a delimiter that is not one of the four',
        { csv: 'a', mapping: { ...BANK_MAPPING, delimiter: ':' } },
        ['mapping.delimiter'],
      ],
      [
        'the same column twice',
        { csv: 'a', mapping: { ...BANK_MAPPING, amountColumn: 0 } },
        ['mapping.amountColumn'],
      ],
      [
        'a negative column',
        { csv: 'a', mapping: { ...BANK_MAPPING, dateColumn: -1 } },
        ['mapping.dateColumn'],
      ],
      [
        'a mapping with a field left out',
        { csv: 'a', mapping: { ...BANK_MAPPING, signConvention: undefined } },
        ['mapping.signConvention'],
      ],
    ])('is a 400 at the field for %s', async (_label, body, paths) => {
      const res = await request(app).post('/api/import/preview').send(body);
      expectValidationPaths(res, ...paths);
    });
  });

  it('answers 409 not_onboarded until the settings exist', async () => {
    const fresh = createTestApp(mutableClock('2026-03-15T10:00:00Z')).app;
    // Before the 400 of a bad body, too: the guard comes first.
    expectApiError(await request(fresh).post('/api/import/preview').send({}), 'not_onboarded');
    expectApiError(await previewRequest(fresh, bankFile([])), 'not_onboarded');
  });
});

describe('POST /api/import/preview: duplicates', () => {
  const coffee = '2026-03-02,-3.50,Coffee';
  const file = bankFile([coffee, coffee, '2026-03-03,-9.99,Lunch']);

  it('imports two identical rows of one file, and flags both once they are imported', async () => {
    const first = await previewOf(app, file);
    expect(first.rows.map((row) => row.duplicate)).toEqual([false, false, false]);
    expect(first.summary.importable).toBe(3);

    const done = await commitOf(app, file, allToBudget([2, 3, 4], groceries));
    expect(done.created).toBe(3);

    const again = await previewOf(app, file);
    expect(again.rows.map((row) => row.duplicate)).toEqual([true, true, true]);
    expect(again.summary).toMatchObject({ duplicates: 3, importable: 0, invalid: 0 });
  });

  it('numbers identical rows by their place in the file: a third one is new', async () => {
    await commitOf(app, file, allToBudget([2, 3, 4], groceries));
    const longer = bankFile([coffee, coffee, coffee, '2026-03-03,-9.99,Lunch']);
    const { rows } = await previewOf(app, longer);
    expect(rows.map((row) => row.duplicate)).toEqual([true, true, false, true]);
  });

  it('does not mind the case or the spaces of the description, but the date and the amount count', async () => {
    await commitOf(app, bankFile([coffee]), allToBudget([2], groceries));
    const variants = bankFile([
      '2026-03-02,-3.50,  COFFEE ', // same normalized text
      '2026-03-02,-3.51,Coffee', //    another amount
      '2026-03-03,-3.50,Coffee', //    another date
      '2026-03-02,3.50,Coffee', //     the other side of the sign convention: a refund
    ]);
    const { rows } = await previewOf(app, variants);
    expect(rows.map((row) => row.duplicate)).toEqual([true, false, false, false]);
  });

  it('does not count a spending that was entered by hand', async () => {
    await spend(groceries, '2026-03-02', 'Coffee', 350);
    const { rows } = await previewOf(app, bankFile([coffee]));
    expect(rows[0]?.duplicate).toBe(false);
  });

  it('keeps flagging a row whose imported spending was edited, and frees it when it is deleted', async () => {
    const done = await commitOf(app, bankFile([coffee]), allToBudget([2], groceries));
    const id = done.items[0]?.id;

    // Edit everything an edit may change: the row still counts as imported.
    await request(app)
      .patch(`/api/spendings/${id}`)
      .send({ amount: 999, date: '2026-03-09', description: 'Something else', budgetId: fun })
      .expect(200);
    expect((await previewOf(app, bankFile([coffee]))).rows[0]?.duplicate).toBe(true);

    await request(app).delete(`/api/spendings/${id}`).expect(204);
    expect((await previewOf(app, bankFile([coffee]))).rows[0]?.duplicate).toBe(false);
    // ...and it can be imported again.
    expect((await commitOf(app, bankFile([coffee]), allToBudget([2], groceries))).created).toBe(1);
  });

  it('gives a row that has errors no duplicate flag', async () => {
    const { rows } = await previewOf(
      app,
      bankFile(['not a date,-3.50,Coffee', '2026-03-02,0,Coffee']),
    );
    expect(rows.map((row) => row.duplicate)).toEqual([false, false]);
  });

  it('counts the whole file for the occurrence, whatever is selected or wrong in it', async () => {
    // The second row has an error of its own (before the start month), and still counts.
    const withError = bankFile(['2025-12-01,-1,Old', '2025-12-01,-1,Old', '2026-03-05,-2,New']);
    const clean = bankFile(['2026-03-05,-2,New']);
    await commitOf(app, clean, allToBudget([2], groceries));
    const { rows } = await previewOf(app, withError);
    expect(rows.map((row) => row.duplicate)).toEqual([false, false, true]);
  });
});

describe('POST /api/import/preview: the suggested budget', () => {
  const suggestionOf = async (description: string, date = '2026-03-05') =>
    (await previewOf(app, bankFile([`${date},-1,${description}`]))).rows[0]?.suggestedBudgetId;

  it('is the budget used most often by spendings with the same description', async () => {
    await spend(groceries, '2026-01-05', 'Aldi');
    await spend(groceries, '2026-01-06', 'Aldi');
    await spend(fun, '2026-03-01', 'Aldi'); // the most recent, but only one use
    expect(await suggestionOf('Aldi')).toBe(groceries);
    expect(await suggestionOf('Something new')).toBeNull();
  });

  it('breaks a tie by the most recent use: the latest date', async () => {
    await spend(groceries, '2026-02-10', 'Cinema');
    await spend(fun, '2026-02-20', 'Cinema');
    await spend(fun, '2026-02-10', 'Pharmacy');
    await spend(groceries, '2026-02-20', 'Pharmacy');
    expect(await suggestionOf('Cinema')).toBe(fun);
    expect(await suggestionOf('Pharmacy')).toBe(groceries);
  });

  it('breaks a tie on the same date by the highest id, whatever the order of the budgets', async () => {
    await spend(fun, '2026-02-20', 'Kiosk');
    await spend(groceries, '2026-02-20', 'Kiosk');
    await spend(groceries, '2026-02-20', 'Newsagent');
    await spend(fun, '2026-02-20', 'Newsagent');
    expect(await suggestionOf('Kiosk')).toBe(groceries);
    expect(await suggestionOf('Newsagent')).toBe(fun);
  });

  it('reads "the latest use" as the latest by date, then id: a later entry of an older date does not win', async () => {
    // Both budgets have two uses and the same latest date (2026-02-10). Their spendings of that
    // date have ids 1 (Groceries) and 3 (Fun), so Fun's is the later use. Groceries also holds the
    // highest id of all (4), but on an older date, and that is not a more recent use.
    await spend(groceries, '2026-02-10', 'Tram');
    await spend(fun, '2026-01-01', 'Tram');
    await spend(fun, '2026-02-10', 'Tram');
    await spend(groceries, '2026-01-01', 'Tram');
    expect(await suggestionOf('Tram')).toBe(fun);
  });

  it('counts every stored spending: entered by hand or imported, of any date', async () => {
    await spend(fun, '2026-01-02', 'Netflix');
    await commitOf(
      app,
      bankFile(['2026-02-03,-9,Netflix', '2026-03-03,-9,Netflix']),
      allToBudget([2, 3], groceries),
    );
    expect(await suggestionOf('Netflix')).toBe(groceries); // 2 imported against 1 by hand
    await spend(fun, '2026-12-01', 'Netflix'); // a future date counts too
    await spend(fun, '2026-12-02', 'Netflix');
    expect(await suggestionOf('Netflix')).toBe(fun);
  });

  it('compares the descriptions as the search folds them: case, spaces and Unicode form, not accents', async () => {
    await spend(groceries, '2026-01-05', 'CAFÉ   Latte');
    expect(await suggestionOf('café latte')).toBe(groceries);
    expect(await suggestionOf('Café LATTE')).toBe(groceries); // e + combining accent
    expect(await suggestionOf('cafe latte')).toBeNull(); // accents are never stripped
    await spend(fun, '2026-01-05', 'Straße');
    expect(await suggestionOf('STRASSE')).toBe(fun);
  });

  it('is null when that budget is not active in the month of the row, with no second choice', async () => {
    await spend(fun, '2026-01-05', 'Gym');
    await spend(fun, '2026-01-06', 'Gym');
    await spend(fun, '2026-02-06', 'Gym');
    await spend(groceries, '2026-02-07', 'Gym'); // the runner-up
    await request(app)
      .post(`/api/budgets/${fun}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);

    expect(await suggestionOf('Gym', '2026-02-20')).toBe(fun); // still active in its last month
    expect(await suggestionOf('Gym', '2026-03-05')).toBeNull(); // ended: not the runner-up either
  });

  it('is null in the months before the budget starts', async () => {
    const boat = (await addBudget(app, { name: 'Boat', startMonth: '2026-06' })).id;
    await spend(boat, '2026-06-10', 'Marina');
    expect(await suggestionOf('Marina', '2026-03-05')).toBeNull();
    expect(await suggestionOf('Marina', '2026-06-20')).toBe(boat);
  });

  it('is the same wherever a description is, and unaffected by the rest of the file', async () => {
    await spend(groceries, '2026-01-05', 'Lidl');
    const csv = bankFile([
      '2026-03-01,-1,Lidl',
      '2026-03-02,-1,Lidl',
      '2026-03-03,-1,Brand new shop',
      '2026-03-04,-1,Brand new shop',
    ]);
    const { rows } = await previewOf(app, csv);
    expect(rows.map((row) => row.suggestedBudgetId)).toEqual([groceries, groceries, null, null]);
  });

  it('has none for a row without a valid date or without a description', async () => {
    await spend(groceries, '2026-01-05', 'Rent');
    const { rows } = await previewOf(app, bankFile(['soon,-1,Rent', '2026-03-01,-1,']));
    expect(rows.map((row) => row.suggestedBudgetId)).toEqual([null, null]);
    // A bad amount does not take it away: only the date and the description matter.
    expect(
      (await previewOf(app, bankFile(['2026-03-01,oops,Rent']))).rows[0]?.suggestedBudgetId,
    ).toBe(groceries);
  });

  it('finds a description longer than 200 characters, which a stored spending holds cut', async () => {
    const long = `${'A'.repeat(150)} ${'B'.repeat(80)}`; // 231 characters
    const stored = long.slice(0, 200);
    expect(stored).toHaveLength(200);

    // Imported once, it is stored cut, and the same text in a later file finds its budget...
    await commitOf(app, bankFile([`2026-03-01,-2.00,${long}`]), allToBudget([2], groceries));
    expect(await suggestionOf(long, '2026-03-10')).toBe(groceries);
    // ...as does a different tail past the cut, and a spending entered by hand with the cut text.
    expect(await suggestionOf(`${stored}${'C'.repeat(20)}`, '2026-03-10')).toBe(groceries);
    const byHand = `${'X'.repeat(198)} Y`;
    expect(byHand).toHaveLength(200);
    await spend(fun, '2026-02-01', byHand);
    expect(await suggestionOf(`${byHand} and more text`, '2026-03-10')).toBe(fun);
    // The hash still reads the whole text: the two long rows are different rows.
    const { rows } = await previewOf(
      app,
      bankFile([`2026-03-01,-2.00,${long}`, `2026-03-01,-2.00,${stored}${'C'.repeat(20)}`]),
    );
    expect(rows.map((row) => row.duplicate)).toEqual([true, false]);
  });

  it('reads the description of the spendings, not their notes', async () => {
    await addSpending(app, {
      budgetId: fun,
      description: 'Pizza',
      notes: 'Lidl',
      date: '2026-02-01',
    });
    expect(await suggestionOf('Lidl')).toBeNull();
    expect(await suggestionOf('Pizza')).toBe(fun);
  });
});

it('is the same reader as the commit: the line of a preview row is the line to commit', async () => {
  const csv = 'date,amount,description\n\n2026-03-02,-1,"a\nb"\n2026-03-03,-2,C\n';
  const { rows } = await previewOf(app, csv);
  const done = await commitOf(
    app,
    csv,
    rows.map((row) => ({ line: row.line, budgetId: groceries })),
  );
  expect(done.items.map((item) => item.line)).toEqual([3, 5]);
  expect(
    await request(app)
      .get('/api/spendings?limit=10')
      .expect(200)
      .then((r) => r.body.items.map((s: { description: string }) => s.description)),
  ).toEqual(['C', 'a b']);
});
