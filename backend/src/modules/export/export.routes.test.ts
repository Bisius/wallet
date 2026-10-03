import {
  CSV_BOM,
  EXPORT_COLUMNS,
  EXPORT_INCOMES_COLUMNS,
  EXPORT_KINDS,
  EXPORT_SAVINGS_COLUMNS,
  EXPORT_SPENDINGS_COLUMNS,
  type ExportKind,
  encodeCsv,
  exportFilename,
  exportPath,
  parseCsv,
} from '@wallet/shared';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { spendings } from '../../db/schema';
import { dumpDb } from '../../testing/db-dump';
import {
  addBudget,
  addIncome,
  addSpending,
  addTag,
  expectApiError,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { addGoal, addTransaction, getSavings, settleOk } from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

/** Today is 2026-03-15, tracking started in 2026-01 with 500.00 saved. */
let app: Express;
let db: Db;
let groceries: number;
let cash: number;

beforeEach(async () => {
  ({ app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
  groceries = (await addBudget(app, { name: 'Groceries', startMonth: '2026-01' })).id;
  cash = (await addBudget(app, { name: '=Cash', startMonth: '2026-01', amount: 10000 })).id;
});

const get = (kind: ExportKind, query = '') => request(app).get(`${exportPath(kind)}${query}`);

/** The body as text, which is exactly what the file holds after its BOM. */
const bodyOf = (res: Response): string => res.text;

/** The rows of the file as cells, the header row first (read back with the shared reader). */
const cellsOf = (res: Response): string[][] =>
  parseCsv(bodyOf(res), ',').map((record) => record.cells);

/** The raw bytes of the response, not decoded: for the BOM and the line ends. */
const rawBytes = async (path: string): Promise<Buffer> => {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((stream: Response, callback: (error: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  return res.body as Buffer;
};

describe('every export', () => {
  it.each(EXPORT_KINDS)(
    '%s: the headers of the contract, and the header row for an empty range',
    async (kind) => {
      const res = await get(kind, '?from=2030-01-01&to=2030-12-31').expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${exportFilename(kind, { from: '2030-01-01', to: '2030-12-31' })}"`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      // A range with no row is still a file: the byte order mark and the header row.
      expect(bodyOf(res)).toBe(encodeCsv([EXPORT_COLUMNS[kind]]));
      expect(bodyOf(res)).toBe(`${CSV_BOM}${EXPORT_COLUMNS[kind].join(',')}\r\n`);
    },
  );

  it.each(EXPORT_KINDS)('%s: names the file after the range', async (kind) => {
    const disposition = async (query: string) =>
      (await get(kind, query).expect(200)).headers['content-disposition'];
    expect(await disposition('')).toBe(`attachment; filename="wallet-${kind}-all.csv"`);
    expect(await disposition('?from=2026-01-01')).toBe(
      `attachment; filename="wallet-${kind}-from-2026-01-01.csv"`,
    );
    expect(await disposition('?to=2026-03-31')).toBe(
      `attachment; filename="wallet-${kind}-until-2026-03-31.csv"`,
    );
    expect(await disposition('?from=2026-01-01&to=2026-03-31')).toBe(
      `attachment; filename="wallet-${kind}-2026-01-01_to_2026-03-31.csv"`,
    );
  });

  it.each(EXPORT_KINDS)(
    '%s: is UTF-8 with a byte order mark and CRLF after every record, the last one too',
    async (kind) => {
      await addSpending(app, { budgetId: groceries, description: 'Café ☕', date: '2026-03-01' });
      const bytes = await rawBytes(exportPath(kind));
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = bytes.toString('utf8');
      expect(text.startsWith(CSV_BOM)).toBe(true);
      expect(text.endsWith('\r\n')).toBe(true);
      // No bare LF: every line end of the file is CRLF (the data here has no line breaks).
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    },
  );

  it.each(EXPORT_KINDS)('%s: writes nothing', async (kind) => {
    await addSpending(app, { budgetId: groceries });
    const before = dumpDb(db);
    await get(kind).expect(200);
    await get(kind, '?from=2026-01-01&to=2026-12-31').expect(200);
    expect(dumpDb(db)).toBe(before);
  });

  it.each(EXPORT_KINDS)('%s: validates the range (400 at the field)', async (kind) => {
    expectValidationPaths(await get(kind, '?from=2026-13-01'), 'from');
    expectValidationPaths(await get(kind, '?to=2026-02-30'), 'to');
    expectValidationPaths(await get(kind, '?from=yesterday'), 'from');
    expectValidationPaths(await get(kind, '?from=2026-1-1'), 'from');
    expectValidationPaths(await get(kind, '?from='), 'from');
    // `from` after `to` is a 400 at `to`; the same day is a one-day range.
    expectValidationPaths(await get(kind, '?from=2026-03-02&to=2026-03-01'), 'to');
    await get(kind, '?from=2026-03-01&to=2026-03-01').expect(200);
    // An unknown key is a 400 too.
    expectValidationPaths(await get(kind, '?month=2026-03'), '');
  });

  it.each(EXPORT_KINDS)(
    '%s: answers 409 not_onboarded until the settings exist, before it looks at the query',
    async (kind) => {
      const fresh = createTestApp(mutableClock('2026-03-15T10:00:00Z')).app;
      expectApiError(await request(fresh).get(exportPath(kind)), 'not_onboarded');
      expectApiError(await request(fresh).get(`${exportPath(kind)}?from=garbage`), 'not_onboarded');
    },
  );

  it('only answers GET: a POST is a plain 404', async () => {
    const res = await request(app).post('/api/export/spendings.csv').send({});
    expect(res.status).toBe(404);
  });

  it('has the columns of the contract, in the order of the contract', () => {
    expect(EXPORT_SPENDINGS_COLUMNS.join(',')).toBe('id,date,amount,budget,description,notes,tags');
    expect(EXPORT_INCOMES_COLUMNS.join(',')).toBe('id,date,amount,description');
    expect(EXPORT_SAVINGS_COLUMNS.join(',')).toBe(
      'id,date,kind,amount,goal_id,goal,settles_month,note,group_id',
    );
  });
});

describe('GET /api/export/spendings.csv', () => {
  it('lists every spending ascending by date, then id, with the name of its budget and its tags', async () => {
    const work = await addTag(app, { name: 'Work' });
    const food = await addTag(app, { name: 'Food' });
    const later = await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-01',
      amount: 99999,
      description: 'Rent',
    });
    const second = await addSpending(app, {
      budgetId: cash,
      date: '2026-02-10',
      amount: 1230,
      description: 'Lidl',
      notes: 'weekly',
      tagIds: [work.id, food.id],
    });
    const first = await addSpending(app, {
      budgetId: groceries,
      date: '2026-02-10',
      amount: 5,
      description: 'Gum',
    });
    const oldest = await addSpending(app, {
      budgetId: groceries,
      date: '2026-01-05',
      amount: -500,
      description: 'Refund',
    });

    const res = await get('spendings').expect(200);
    expect(cellsOf(res)).toEqual([
      ['id', 'date', 'amount', 'budget', 'description', 'notes', 'tags'],
      [String(oldest.id), '2026-01-05', '-5.00', 'Groceries', 'Refund', '', ''],
      // The same date: by id. The budget "=Cash" is guarded, the tags are sorted and joined by "|".
      [String(second.id), '2026-02-10', '12.30', "'=Cash", 'Lidl', 'weekly', 'Food|Work'],
      [String(first.id), '2026-02-10', '0.05', 'Groceries', 'Gum', '', ''],
      [String(later.id), '2026-03-01', '999.99', 'Groceries', 'Rent', '', ''],
    ]);
  });

  it('writes amounts as plain decimals built from cents, with the sign that is stored', async () => {
    const cents = [
      1, 5, 99, 100, 1230, 100000, 123456789, 1_000_000_000_000, -1, -5, -100, -123456789,
    ];
    for (const [index, amount] of cents.entries()) {
      await addSpending(app, {
        budgetId: groceries,
        date: '2026-03-01',
        amount,
        description: `n${index}`,
      });
    }
    const rows = cellsOf(await get('spendings').expect(200)).slice(1);
    expect(rows.map((row) => row[2])).toEqual([
      '0.01',
      '0.05',
      '0.99',
      '1.00',
      '12.30',
      '1000.00',
      '1234567.89',
      '10000000000.00',
      '-0.01',
      '-0.05',
      '-1.00',
      '-1234567.89',
    ]);
  });

  it('guards what follows a ";" too: a spreadsheet with ";" as its list separator starts a cell there', async () => {
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-01',
      amount: 100,
      description: "Shop;=cmd|' /C calc'!A0;",
    });
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-02',
      amount: 100,
      description: 'Pizza;-5% off;+tip',
      notes: 'a;@b',
    });

    const res = await get('spendings').expect(200);
    const rows = cellsOf(res).slice(1);
    expect(rows.map((row) => [row[4], row[5]])).toEqual([
      ["Shop;'=cmd|' /C calc'!A0;", ''],
      ["Pizza;'-5% off;'+tip", "a;'@b"],
    ]);

    // What a spreadsheet makes of the file when it splits on ";": no cell starts like a formula.
    const cells = parseCsv(bodyOf(res), ';').flatMap((record) => record.cells);
    expect(cells.filter((cell) => /^[=+\-@\t\r]/.test(cell))).toEqual([]);
  });

  it('guards the text cells that start like a formula, as a whole, and never an amount', async () => {
    const tag = await addTag(app, { name: '-urgent' });
    const plain = await addTag(app, { name: 'plain' });
    const triggers = ['=SUM(A1:A9)', '+1', '-1', '@cmd'];
    for (const description of triggers) {
      await addSpending(app, {
        budgetId: groceries,
        date: '2026-03-01',
        amount: -250,
        description,
      });
    }
    // A description is trimmed when it is stored, so these two (the other characters that make a
    // spreadsheet read a formula) can only be in the table from an older version or by hand.
    for (const description of ['\tTabbed', '\rReturn']) {
      db.insert(spendings)
        .values({ date: '2026-03-01', amount: -250, budgetId: groceries, description })
        .run();
    }
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-02',
      amount: 1,
      description: 'Safe = text',
      notes: '=1+1',
      tagIds: [tag.id, plain.id],
    });

    const rows = cellsOf(await get('spendings').expect(200)).slice(1);
    // Descriptions that begin with a trigger gain a leading apostrophe (the cell is read as text)...
    expect(rows.slice(0, 6).map((row) => row[4])).toEqual(
      [...triggers, '\tTabbed', '\rReturn'].map((text) => `'${text}`),
    );
    // ...an amount never does: a refund of 2.50 is "-2.50" and stays a number.
    expect(rows.slice(0, 6).map((row) => row[2])).toEqual(Array(6).fill('-2.50'));
    // A trigger inside the text is nothing, the notes and the joined tags are guarded as a whole,
    // and ids and dates are not guarded at all.
    expect(rows[6]).toEqual([
      expect.stringMatching(/^\d+$/),
      '2026-03-02',
      '0.01',
      'Groceries',
      'Safe = text',
      "'=1+1",
      "'-urgent|plain",
    ]);
    expect(
      rows.flatMap((row) => [row[0], row[1], row[2]]).some((cell) => cell?.startsWith("'")),
    ).toBe(false);
  });

  it('quotes a field per RFC 4180 only when it needs it, and a round trip gives the same cells', async () => {
    const texts = [
      'plain',
      'with, comma',
      'with "quotes"',
      'two\nlines',
      'cr\r\nlf',
      'ünïcode ☕ 日本語',
      ' padded ',
    ];
    for (const description of texts) {
      await addSpending(app, { budgetId: groceries, date: '2026-03-01', description });
    }
    const res = await get('spendings').expect(200);
    const text = bodyOf(res);
    expect(text).toContain(',plain,');
    expect(text).toContain(',"with, comma",');
    expect(text).toContain(',"with ""quotes""",');
    expect(text).toContain(',"two\nlines",');
    expect(text).toContain(',"cr\r\nlf",');
    expect(text).toContain(',ünïcode ☕ 日本語,');
    // (A description is trimmed when it is stored, so the spaces around the last one are gone.)
    expect(
      cellsOf(res)
        .slice(1)
        .map((row) => row[4]),
    ).toEqual(texts.map((text) => text.trim()));
  });

  it('exports a range by the date of the spending, both ends inclusive and each end optional', async () => {
    for (const date of [
      '2026-01-01',
      '2026-01-31',
      '2026-02-01',
      '2026-02-28',
      '2026-03-01',
      '2026-03-31',
    ]) {
      await addSpending(app, { budgetId: groceries, date, description: date });
    }
    const dates = async (query: string) =>
      cellsOf(await get('spendings', query).expect(200))
        .slice(1)
        .map((row) => row[1]);

    expect(await dates('')).toEqual([
      '2026-01-01',
      '2026-01-31',
      '2026-02-01',
      '2026-02-28',
      '2026-03-01',
      '2026-03-31',
    ]);
    expect(await dates('?from=2026-02-01')).toEqual([
      '2026-02-01',
      '2026-02-28',
      '2026-03-01',
      '2026-03-31',
    ]);
    expect(await dates('?to=2026-02-01')).toEqual(['2026-01-01', '2026-01-31', '2026-02-01']);
    expect(await dates('?from=2026-01-31&to=2026-02-28')).toEqual([
      '2026-01-31',
      '2026-02-01',
      '2026-02-28',
    ]);
    expect(await dates('?from=2026-02-02&to=2026-02-27')).toEqual([]);
    expect(await dates('?from=2026-03-01&to=2026-03-01')).toEqual(['2026-03-01']);
  });

  it('repeats the tags of a spending in range only, however many other spendings carry them', async () => {
    const tag = await addTag(app, { name: 'Shared' });
    const other = await addTag(app, { name: 'Other' });
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-01-10',
      description: 'In',
      tagIds: [tag.id],
    });
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-10',
      description: 'Out',
      tagIds: [tag.id, other.id],
    });
    const rows = cellsOf(await get('spendings', '?to=2026-02-01').expect(200)).slice(1);
    expect(rows.map((row) => [row[4], row[6]])).toEqual([['In', 'Shared']]);
  });

  it('sorts the tag names like the tag list does: ignoring case, then by id', async () => {
    const names = ['banana', 'Cherry', 'apple', 'Apple2'];
    const tags = [];
    for (const name of names) tags.push(await addTag(app, { name }));
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-01',
      tagIds: tags.map((t) => t.id).reverse(),
    });
    const [, row] = cellsOf(await get('spendings').expect(200));
    expect(row?.[6]).toBe('apple|Apple2|banana|Cherry');
  });

  it('exports an empty description and a name with a pipe as they are', async () => {
    const odd = await addTag(app, { name: 'a|b' });
    await addSpending(app, {
      budgetId: groceries,
      date: '2026-03-01',
      description: '',
      tagIds: [odd.id],
    });
    const [, row] = cellsOf(await get('spendings').expect(200));
    expect(row?.slice(4)).toEqual(['', '', 'a|b']);
  });

  it('does not export the import hash or the timestamps, nor the salary', async () => {
    db.insert(spendings)
      .values({
        date: '2026-03-01',
        amount: 100,
        budgetId: groceries,
        description: 'X',
        importHash: 'f'.repeat(64),
      })
      .run();
    const res = await get('spendings').expect(200);
    expect(bodyOf(res)).not.toContain('ffffffff');
    expect(bodyOf(res)).not.toContain('2026-03-15T');
    expect(cellsOf(res)[0]).toEqual([...EXPORT_SPENDINGS_COLUMNS]);
  });
});

describe('GET /api/export/incomes.csv', () => {
  it('lists the extra incomes ascending by date, then id, with the description guarded', async () => {
    const late = await addIncome(app, { date: '2026-03-05', amount: 50000, description: 'Bonus' });
    const same1 = await addIncome(app, { date: '2026-01-20', amount: 12345, description: '@home' });
    const same2 = await addIncome(app, { date: '2026-01-20', amount: 5, description: '=1+1' });
    const res = await get('incomes').expect(200);
    expect(cellsOf(res)).toEqual([
      ['id', 'date', 'amount', 'description'],
      [String(same1.id), '2026-01-20', '123.45', "'@home"],
      [String(same2.id), '2026-01-20', '0.05', "'=1+1"],
      [String(late.id), '2026-03-05', '500.00', 'Bonus'],
    ]);
  });

  it('does not hold the salary, which is not a dated row', async () => {
    const res = await get('incomes').expect(200);
    expect(cellsOf(res)).toEqual([['id', 'date', 'amount', 'description']]);
  });

  it('exports a range by date', async () => {
    for (const date of ['2026-01-10', '2026-02-10', '2026-03-10']) await addIncome(app, { date });
    const dates = async (query: string) =>
      cellsOf(await get('incomes', query).expect(200))
        .slice(1)
        .map((r) => r[1]);
    expect(await dates('?from=2026-02-10')).toEqual(['2026-02-10', '2026-03-10']);
    expect(await dates('?to=2026-02-09')).toEqual(['2026-01-10']);
    expect(await dates('?from=2026-02-10&to=2026-02-10')).toEqual(['2026-02-10']);
  });
});

describe('GET /api/export/savings.csv', () => {
  it('lists every kind of transaction, signed as stored, with the goal and the group', async () => {
    const holiday = await addGoal(app, { name: '+Trip' });
    const car = await addGoal(app, { name: 'Car' });
    await addTransaction(app, {
      kind: 'deposit',
      amount: 10000,
      goalId: holiday.id,
      date: '2026-02-05',
      note: 'first',
    });
    await addTransaction(app, {
      kind: 'withdrawal',
      amount: 2500,
      goalId: holiday.id,
      date: '2026-02-20',
      note: '-urgent',
    });
    const [from, to] = await addTransaction(app, {
      kind: 'reallocation',
      amount: 1000,
      fromGoalId: holiday.id,
      toGoalId: car.id,
      date: '2026-03-01',
    });
    const savings = await getSavings(app);
    const january = savings.outstanding.find((entry) => entry.month === '2026-01');
    // 3000.00 salary, nothing spent: the unallocated 2500.00 and the two budgets' 400.00 and 100.00.
    expect(january?.outstanding).toBe(300000);
    const [settlement] = await settleOk(app, '2026-01', { amount: 300000 });

    const rows = cellsOf(await get('savings').expect(200));
    expect(rows[0]).toEqual([...EXPORT_SAVINGS_COLUMNS]);
    const byKind = (kind: string) => rows.filter((row) => row[2] === kind);

    expect(byKind('opening')).toEqual([
      [expect.stringMatching(/^\d+$/), '2026-01-01', 'opening', '500.00', '', '', '', '', ''],
    ]);
    expect(byKind('deposit')).toEqual([
      [
        expect.stringMatching(/^\d+$/),
        '2026-02-05',
        'deposit',
        '100.00',
        String(holiday.id),
        "'+Trip",
        '',
        'first',
        '',
      ],
    ]);
    expect(byKind('withdrawal')).toEqual([
      [
        expect.stringMatching(/^\d+$/),
        '2026-02-20',
        'withdrawal',
        '-25.00',
        String(holiday.id),
        "'+Trip",
        '',
        "'-urgent",
        '',
      ],
    ]);
    // Both rows of a reallocation, with the group they share.
    expect(byKind('reallocation')).toEqual([
      [
        String(from?.id),
        '2026-03-01',
        'reallocation',
        '-10.00',
        String(holiday.id),
        "'+Trip",
        '',
        '',
        String(from?.groupId),
      ],
      [
        String(to?.id),
        '2026-03-01',
        'reallocation',
        '10.00',
        String(car.id),
        'Car',
        '',
        '',
        String(from?.groupId),
      ],
    ]);
    // A settlement: dated today, and the month it settles.
    expect(byKind('settlement')).toEqual([
      [String(settlement?.id), '2026-03-15', 'settlement', '3000.00', '', '', '2026-01', '', ''],
    ]);
    // Ascending by date, then id.
    const order = rows.slice(1).map((row) => [row[1] ?? '', Number(row[0])] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]));
  });

  it('exports a range by the date the money moved (a settlement by the day it was made)', async () => {
    await addTransaction(app, { kind: 'deposit', amount: 100, date: '2026-02-05' });
    await addTransaction(app, { kind: 'deposit', amount: 200, date: '2026-03-05' });
    const kinds = async (query: string) =>
      cellsOf(await get('savings', query).expect(200))
        .slice(1)
        .map((r) => [r[1], r[2], r[3]]);
    expect(await kinds('?from=2026-02-01&to=2026-02-28')).toEqual([
      ['2026-02-05', 'deposit', '1.00'],
    ]);
    expect(await kinds('?to=2026-01-01')).toEqual([['2026-01-01', 'opening', '500.00']]);
    expect(await kinds('?from=2026-03-01')).toEqual([['2026-03-05', 'deposit', '2.00']]);
  });

  it('keeps a goal that was deleted (its rows now have no goal) as empty cells', async () => {
    const goal = await addGoal(app, { name: 'Gone' });
    await addTransaction(app, {
      kind: 'deposit',
      amount: 100,
      goalId: goal.id,
      date: '2026-02-05',
    });
    await request(app).delete(`/api/goals/${goal.id}`).expect(204);
    const rows = cellsOf(await get('savings').expect(200));
    const deposit = rows.find((row) => row[2] === 'deposit');
    expect(deposit?.slice(4, 6)).toEqual(['', '']);
  });
});
