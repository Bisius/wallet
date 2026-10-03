/**
 * Multi-month scenarios for the CSV import, through the real API. The import must be nothing more
 * than a faster way to create the same spendings, so the strongest oracle is the plain endpoint:
 *
 *  (a) a bank file imported through `POST /api/import/commit` gives EXACTLY the same spendings,
 *      month views, savings inbox and yearly report as the same spendings created one by one with
 *      `POST /api/spendings`, over closed, current and future months, with a refund (a credit) and
 *      rows into an incremental budget of a closed month, and the figures are also worked out by
 *      hand below, to the cent;
 *  (b) `spendings.csv` exported from one database and imported with
 *      `EXPORT_SPENDINGS_IMPORT_MAPPING` into a fresh one reproduces every spending to the cent
 *      and every month view;
 *  (c) a second import of the same file imports nothing: every row is a duplicate.
 *
 * The world (start month 2026-01, salary 3000.00, a Netflix of 12.99 a month, so 1299 of fixed
 * costs every month):
 *
 *   Groceries  incremental     400.00 from 2026-01
 *   Fun        non-incremental 100.00 from 2026-01
 *   Travel     incremental     200.00 from 2026-02
 *   Old        non-incremental  50.00 from 2026-01, archived with end month 2026-02
 */
import {
  EXPORT_SPENDINGS_IMPORT_MAPPING,
  type ImportMapping,
  type ImportRejectedRow,
  type MonthSummary,
  type SavingsDto,
  type SpendingDto,
  type YearlyReportDto,
  cleanImportText,
  guardCsvText,
  parseCsv,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addBudget,
  addSpending,
  addSubscription,
  addTag,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { commitOf, commitRequest, expectRejected, previewOf } from '../../testing/import-helpers';
import { expectApiMatchesOracle } from '../../testing/scenario';
import { balances, budgetLine, getJson, monthView } from '../../testing/story';
import { createTestApp } from '../../testing/test-app';

const BUDGETS = ['Groceries', 'Fun', 'Travel', 'Old'] as const;
type BudgetName = (typeof BUDGETS)[number];

/** A fresh database with the world above, today being `today`. Budget ids follow `BUDGETS`. */
async function buildWorld(today: string) {
  const clock = mutableClock(`${today}T10:00:00Z`);
  const { app, db } = createTestApp(clock);
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
  const ids: Record<BudgetName, number> = {
    Groceries: (
      await addBudget(app, {
        name: 'Groceries',
        amount: 40000,
        incremental: true,
        startMonth: '2026-01',
      })
    ).id,
    Fun: (
      await addBudget(app, {
        name: 'Fun',
        amount: 10000,
        incremental: false,
        startMonth: '2026-01',
      })
    ).id,
    Travel: (
      await addBudget(app, {
        name: 'Travel',
        amount: 20000,
        incremental: true,
        startMonth: '2026-02',
      })
    ).id,
    Old: (
      await addBudget(app, { name: 'Old', amount: 5000, incremental: false, startMonth: '2026-01' })
    ).id,
  };
  await request(app)
    .post(`/api/budgets/${ids.Old}/archive`)
    .send({ endMonth: '2026-02' })
    .expect(200);
  await addSubscription(app, {
    name: 'Netflix',
    amount: 1299,
    anchorDate: '2026-01-20',
    startMonth: '2026-01',
  });
  return { app, db, clock, ids };
}

// -------------------------------------------------------------------------------------------------
// The bank file of scenarios (a) and (c)
// -------------------------------------------------------------------------------------------------

/** A German-style bank file: `;`, day first, a decimal comma and a minus on money that leaves. */
const BANK: ImportMapping = {
  delimiter: ';',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 2,
  descriptionColumn: 3,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  signConvention: 'expenses_negative',
};

interface BankRow {
  /** As the bank writes it. */
  date: string;
  amount: string;
  description: string;
  /** What it must become in the ledger. */
  iso: string;
  cents: number;
  budget: BudgetName | null;
}

const BANK_ROWS: readonly BankRow[] = [
  // January (closed)
  {
    date: '05/01/2026',
    amount: '-300,00',
    description: 'LIDL',
    iso: '2026-01-05',
    cents: 30000,
    budget: 'Groceries',
  },
  {
    date: '12/01/2026',
    amount: '-45,50',
    description: 'Cinema',
    iso: '2026-01-12',
    cents: 4550,
    budget: 'Fun',
  },
  {
    date: '14/01/2026',
    amount: '+12,30',
    description: 'Lidl refund',
    iso: '2026-01-14',
    cents: -1230,
    budget: 'Groceries',
  }, // a credit
  {
    date: '20/01/2026',
    amount: '-50,00',
    description: 'Old shop',
    iso: '2026-01-20',
    cents: 5000,
    budget: 'Old',
  },
  // February (closed): Travel's first month, and the last month of Old
  {
    date: '03/02/2026',
    amount: '-400,00',
    description: 'Flights',
    iso: '2026-02-03',
    cents: 40000,
    budget: 'Travel',
  },
  {
    date: '10/02/2026',
    amount: '-520,00',
    description: 'LIDL',
    iso: '2026-02-10',
    cents: 52000,
    budget: 'Groceries',
  }, // overspends an incremental budget
  {
    date: '25/02/2026',
    amount: '-70,00',
    description: 'Old shop',
    iso: '2026-02-25',
    cents: 7000,
    budget: 'Old',
  },
  // March (closed): two identical rows, both imported
  {
    date: '15/03/2026',
    amount: '-100,00',
    description: 'Cinema',
    iso: '2026-03-15',
    cents: 10000,
    budget: 'Fun',
  },
  {
    date: '15/03/2026',
    amount: '-100,00',
    description: 'Cinema',
    iso: '2026-03-15',
    cents: 10000,
    budget: 'Fun',
  },
  {
    date: '31/03/2026',
    amount: '-250,00',
    description: 'LIDL',
    iso: '2026-03-31',
    cents: 25000,
    budget: 'Groceries',
  },
  // April (the current month), with a thousands separator
  {
    date: '04/04/2026',
    amount: '-1.234,56',
    description: 'Big purchase',
    iso: '2026-04-04',
    cents: 123456,
    budget: 'Fun',
  },
  {
    date: '15/04/2026',
    amount: '-12,00',
    description: 'Coffee',
    iso: '2026-04-15',
    cents: 1200,
    budget: 'Groceries',
  },
  // May and June (the future), the last one a credit into Fun
  {
    date: '10/05/2026',
    amount: '-80,00',
    description: 'Concert',
    iso: '2026-05-10',
    cents: 8000,
    budget: 'Fun',
  },
  {
    date: '02/06/2026',
    amount: '+20,00',
    description: 'Return',
    iso: '2026-06-02',
    cents: -2000,
    budget: 'Fun',
  }, // a credit
  // A salary: a credit that is not listed, so it is not imported
  {
    date: '01/03/2026',
    amount: '+3.000,00',
    description: 'SALARY ACME',
    iso: '2026-03-01',
    cents: -300000,
    budget: null,
  },
];

const bankCsv = (rows: readonly BankRow[]): string =>
  [
    'Booking date;Ref;Amount;Details',
    ...rows.map((row, index) => `${row.date};R${index + 1};${row.amount};${row.description}`),
  ].join('\r\n') + '\r\n';

/** The listed rows: every row that has a budget, by the line it is on (line 1 is the header). */
const listedRows = (ids: Record<BudgetName, number>) =>
  BANK_ROWS.flatMap((row, index) =>
    row.budget === null ? [] : [{ line: index + 2, budgetId: ids[row.budget] }],
  );

// -------------------------------------------------------------------------------------------------
// Everything the API shows about the money of a database
// -------------------------------------------------------------------------------------------------

async function allSpendings(app: Express): Promise<SpendingDto[]> {
  const items: SpendingDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await request(app).get(`/api/spendings?limit=200&offset=${offset}`).expect(200))
      .body;
    items.push(...page.items);
    if (items.length >= page.total) return items;
  }
}

/** Spendings, the 12 month views and summaries, the savings inbox and the yearly report. */
async function figures(app: Express) {
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  return {
    spendings: await allSpendings(app),
    summaries: await getJson<MonthSummary[]>(app, '/api/months?from=2026-01&to=2026-12'),
    views: await Promise.all(months.map((month) => monthView(app, month))),
    savings: await getJson<SavingsDto>(app, '/api/savings'),
    report: await getJson<YearlyReportDto>(app, '/api/reports/yearly/2026'),
  };
}

// -------------------------------------------------------------------------------------------------

describe('import scenario (a): a bank file is the same as creating the spendings one by one', () => {
  it('gives the same spendings, month views, savings and report, over closed, current and future months', async () => {
    const imported = await buildWorld('2026-04-15');
    const manual = await buildWorld('2026-04-15');
    const csv = bankCsv(BANK_ROWS);

    // ---- The preview: nothing to suggest yet, three credits left unchecked --------------------
    const preview = await previewOf(imported.app, csv, BANK);
    expect(preview.summary).toEqual({
      total: 15,
      invalid: 0,
      duplicates: 0,
      credits: 3,
      importable: 12,
    });
    expect(preview.rows.map((row) => [row.line, row.date, row.amount])).toEqual(
      BANK_ROWS.map((row, index) => [index + 2, row.iso, row.cents]),
    );
    expect(preview.rows.filter((row) => row.credit).map((row) => row.line)).toEqual([4, 15, 16]);

    // ---- The import, and the same spendings entered by hand in the same order --------------------
    const done = await commitOf(imported.app, csv, listedRows(imported.ids), BANK);
    expect(done.created).toBe(14);
    expect(done.items.map((item) => item.line)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    for (const row of BANK_ROWS) {
      if (row.budget === null) continue;
      await addSpending(manual.app, {
        budgetId: manual.ids[row.budget],
        date: row.iso,
        amount: row.cents,
        description: row.description,
      });
    }

    const [fromImport, fromHand] = [await figures(imported.app), await figures(manual.app)];
    expect(fromImport.spendings).toHaveLength(14);
    expect(fromImport).toEqual(fromHand);

    // ---- Worked out by hand, to the cent ---------------------------------------------------------
    // Groceries (incremental, 400.00 a month), carriedIn / allocated / available / spent /
    // remaining / carriedOut / toSavings:
    //   Jan  0 + 40000, spent 30000 - 1230 (the refund) = 28770, remaining 11230, carried on
    //   Feb  11230 + 40000 = 51230, spent 52000, remaining -770: the deficit is carried on
    //   Mar  -770 + 40000 = 39230, spent 25000, remaining 14230
    //   Apr  14230 + 40000 = 54230, spent 1200, remaining 53030 (current: projected as it stands)
    const groceries = (month: string) =>
      monthView(imported.app, month).then((v) => budgetLine(v, 'Groceries'));
    expect(balances(await groceries('2026-01'))).toEqual([0, 40000, 40000, 28770, 11230, 11230, 0]);
    expect(balances(await groceries('2026-02'))).toEqual([
      11230, 40000, 51230, 52000, -770, -770, 0,
    ]);
    expect(balances(await groceries('2026-03'))).toEqual([
      -770, 40000, 39230, 25000, 14230, 14230, 0,
    ]);
    expect(balances(await groceries('2026-04'))).toEqual([
      14230, 40000, 54230, 1200, 53030, 53030, 0,
    ]);
    // May is a projection: nothing more is spent, the balance carries on.
    expect(balances(await groceries('2026-05'))).toEqual([53030, 40000, 93030, 0, 93030, 93030, 0]);

    // Travel (incremental, from February): the 400.00 flight overspends its 200.00, and March's
    // allocation brings the balance back to 0.
    const travel = (month: string) =>
      monthView(imported.app, month).then((v) => budgetLine(v, 'Travel'));
    expect(balances(await travel('2026-02'))).toEqual([0, 20000, 20000, 40000, -20000, -20000, 0]);
    expect(balances(await travel('2026-03'))).toEqual([-20000, 20000, 0, 0, 0, 0, 0]);

    // Old ends in February: its balance is released then (50.00 spent in January, 70.00 in
    // February against 50.00 allocated, so 20.00 are taken from savings).
    const old = (month: string) => monthView(imported.app, month).then((v) => budgetLine(v, 'Old'));
    expect(balances(await old('2026-01'))).toEqual([0, 5000, 5000, 5000, 0, 0, 0]);
    expect(balances(await old('2026-02'))).toEqual([0, 5000, 5000, 7000, -2000, 0, -2000]);

    // The savings due of every month: unallocated income + what the non-incremental budgets settle.
    //   Jan  300000 - 1299 - (40000 + 10000 + 5000) = 243701, plus Fun 10000 - 4550 = 5450  -> 249151
    //   Feb  300000 - 1299 - (40000 + 10000 + 20000 + 5000) = 223701, Fun +10000, Old -2000  -> 231701
    //   Mar  300000 - 1299 - (40000 + 10000 + 20000) = 228701, Fun 10000 - 20000 = -10000    -> 218701
    //   Apr  228701, Fun 10000 - 123456 = -113456                                            -> 115245
    //   May  228701, Fun 10000 - 8000 = 2000                                                 -> 230701
    expect(fromImport.summaries.slice(0, 5).map((row) => row.savingsDue)).toEqual([
      249151, 231701, 218701, 115245, 230701,
    ]);
    // The savings inbox lists the three closed months with the same amounts.
    expect(fromImport.savings.outstanding.map((entry) => [entry.month, entry.savingsDue])).toEqual([
      ['2026-01', 249151],
      ['2026-02', 231701],
      ['2026-03', 218701],
    ]);

    // The independent ledger oracle agrees with every month of the imported database.
    await expectApiMatchesOracle(imported.app, { from: '2026-01', to: '2026-12' });

    // ---- A month later the clock has moved: the same, with May closed and June current -------------
    imported.clock.set('2026-06-20T10:00:00Z');
    manual.clock.set('2026-06-20T10:00:00Z');
    const [later, laterByHand] = [await figures(imported.app), await figures(manual.app)];
    expect(later).toEqual(laterByHand);
    expect(later.savings.outstanding.map((entry) => [entry.month, entry.savingsDue])).toEqual([
      ['2026-01', 249151],
      ['2026-02', 231701],
      ['2026-03', 218701],
      ['2026-04', 115245],
      ['2026-05', 230701],
    ]);
    // June is the current month: Fun's 20.00 credit is a refund, so 100.00 + 20.00 are left.
    expect(later.summaries.at(5)).toMatchObject({
      month: '2026-06',
      status: 'current',
      savingsDue: 240701,
    });
    await expectApiMatchesOracle(imported.app, { from: '2026-01', to: '2026-12' });
  });

  it('keeps the credit that is listed a refund, and does not import the one that is not', async () => {
    const { app, ids } = await buildWorld('2026-04-15');
    await commitOf(app, bankCsv(BANK_ROWS), listedRows(ids), BANK);
    const rows = await allSpendings(app);
    expect(
      rows.filter((row) => row.amount < 0).map((row) => [row.date, row.amount, row.description]),
    ).toEqual([
      ['2026-06-02', -2000, 'Return'],
      ['2026-01-14', -1230, 'Lidl refund'],
    ]);
    expect(rows.some((row) => row.description === 'SALARY ACME')).toBe(false);
  });

  it('suggests, the next time, the budgets that this import used', async () => {
    const { app, ids } = await buildWorld('2026-04-15');
    await commitOf(app, bankCsv(BANK_ROWS), listedRows(ids), BANK);
    const next = bankCsv([
      { ...(BANK_ROWS[0] as BankRow), date: '07/04/2026', description: 'lidl  ' }, //  Groceries
      { ...(BANK_ROWS[1] as BankRow), date: '08/04/2026', description: 'CINEMA' }, //  Fun
      { ...(BANK_ROWS[3] as BankRow), date: '09/04/2026', description: 'Old shop' }, // Old ended in February
      { ...(BANK_ROWS[0] as BankRow), date: '10/04/2026', description: 'Unknown' }, //  never seen
    ]);
    const { rows } = await previewOf(app, next, BANK);
    expect(rows.map((row) => row.suggestedBudgetId)).toEqual([ids.Groceries, ids.Fun, null, null]);
  });
});

describe('import scenario (b): export and import again', () => {
  it('reproduces every spending to the cent, and every month view', async () => {
    const source = await buildWorld('2026-04-15');
    const work = await addTag(source.app, { name: 'Work' });
    const entries: {
      budget: BudgetName;
      date: string;
      amount: number;
      description: string;
      notes?: string;
      tagIds?: number[];
    }[] = [
      { budget: 'Groceries', date: '2026-01-05', amount: 1230, description: 'Plain' },
      { budget: 'Groceries', date: '2026-01-05', amount: 1230, description: 'Plain' }, // identical twice
      { budget: 'Groceries', date: '2026-01-06', amount: -500, description: 'A refund' },
      { budget: 'Fun', date: '2026-02-01', amount: 99, description: 'with, a comma' },
      { budget: 'Fun', date: '2026-02-02', amount: 1, description: 'with "quotes"' },
      { budget: 'Fun', date: '2026-02-03', amount: 100, description: 'two\nlines' },
      {
        budget: 'Fun',
        date: '2026-02-04',
        amount: 12345678,
        description: '=1+1',
        notes: 'ignored by the import',
        tagIds: [work.id],
      },
      { budget: 'Fun', date: '2026-02-05', amount: 5, description: '-minus' },
      {
        budget: 'Travel',
        date: '2026-03-01',
        amount: 1_000_000_000_000,
        description: 'The most that fits',
      },
      { budget: 'Travel', date: '2026-03-02', amount: -1_000_000_000_000, description: 'And back' },
      { budget: 'Travel', date: '2026-03-03', amount: 7, description: 'Ünïcode ☕ 日本語 Straße' },
      { budget: 'Old', date: '2026-02-28', amount: 3333, description: 'Last day of the month' },
      { budget: 'Groceries', date: '2026-05-31', amount: 4242, description: 'In the future' },
      { budget: 'Groceries', date: '2026-04-15', amount: 100, description: 'x'.repeat(200) },
    ];
    for (const entry of entries) {
      await addSpending(source.app, {
        budgetId: source.ids[entry.budget],
        date: entry.date,
        amount: entry.amount,
        description: entry.description,
        notes: entry.notes,
        tagIds: entry.tagIds,
      });
    }

    // ---- Export, then import into a fresh database with the mapping of the contract --------------
    const file = (await request(source.app).get('/api/export/spendings.csv').expect(200)).text;
    const target = await buildWorld('2026-04-15');
    const budgetOfName = new Map(BUDGETS.map((name) => [name, target.ids[name]]));
    const records = parseCsv(file, ',');
    const preview = await previewOf(target.app, file, EXPORT_SPENDINGS_IMPORT_MAPPING);
    expect(preview.summary).toMatchObject({ total: entries.length, invalid: 0, duplicates: 0 });
    expect(preview.summary.credits).toBe(2);

    const listed = preview.rows.map((row) => {
      const budgetCell = records.find((record) => record.line === row.line)?.cells[3] ?? '';
      const budgetId = budgetOfName.get(budgetCell as BudgetName);
      if (budgetId === undefined) throw new Error(`no budget "${budgetCell}"`);
      return { line: row.line, budgetId };
    });
    const done = await commitOf(target.app, file, listed, EXPORT_SPENDINGS_IMPORT_MAPPING);
    expect(done.created).toBe(entries.length);

    // ---- Every date and amount comes back exactly; the description as the file spells it -----------
    const expected = (await allSpendings(source.app)).map((s) => ({
      date: s.date,
      amount: s.amount,
      budgetId: s.budgetId,
      // The export guards a leading "=", "+", "-" or "@" with an apostrophe (accepted: it reads
      // back that way), and the import collapses whitespace, as it does for any bank file.
      description: cleanImportText(guardCsvText(s.description)),
    }));
    const imported = (await allSpendings(target.app)).map((s) => ({
      date: s.date,
      amount: s.amount,
      budgetId: s.budgetId,
      description: s.description,
    }));
    const byDate = (
      a: { date: string; description: string },
      b: { date: string; description: string },
    ) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description);
    expect([...imported].sort(byDate)).toEqual([...expected].sort(byDate));
    expect(imported.map((s) => s.amount).reduce((a, b) => a + b, 0)).toBe(
      entries.reduce((total, entry) => total + entry.amount, 0),
    );
    expect(imported.map((s) => s.description)).toContain("'=1+1");
    expect(imported.map((s) => s.description)).toContain("'-minus");
    expect(imported.map((s) => s.description)).toContain('two lines');

    // ---- ...and so does every month ------------------------------------------------------------------
    const [fromSource, fromTarget] = [await figures(source.app), await figures(target.app)];
    expect(fromTarget.views).toEqual(fromSource.views);
    expect(fromTarget.summaries).toEqual(fromSource.summaries);
    expect(fromTarget.report).toEqual(fromSource.report);
    expect(fromTarget.savings.outstanding).toEqual(fromSource.savings.outstanding);
    await expectApiMatchesOracle(target.app, { from: '2026-01', to: '2026-12' });
  });

  it('does not recognise the spendings it was exported from: those entered by hand have no hash', async () => {
    const { app, ids } = await buildWorld('2026-04-15');
    await addSpending(app, {
      budgetId: ids.Groceries,
      date: '2026-03-01',
      amount: 1000,
      description: 'By hand',
    });
    const file = (await request(app).get('/api/export/spendings.csv').expect(200)).text;

    const first = await previewOf(app, file, EXPORT_SPENDINGS_IMPORT_MAPPING);
    expect(first.rows.map((row) => row.duplicate)).toEqual([false]);
    expect(first.rows[0]?.suggestedBudgetId).toBe(ids.Groceries); // but the description is known
    await commitOf(
      app,
      file,
      [{ line: 2, budgetId: ids.Groceries }],
      EXPORT_SPENDINGS_IMPORT_MAPPING,
    );
    expect(await allSpendings(app)).toHaveLength(2); // a second copy, as DOMAIN says

    // The copy has a hash now: importing the same file again is refused.
    expect((await previewOf(app, file, EXPORT_SPENDINGS_IMPORT_MAPPING)).rows[0]?.duplicate).toBe(
      true,
    );
  });

  it('cannot bring back a spending that has no description: the importer wants a text', async () => {
    const { app, ids } = await buildWorld('2026-04-15');
    await addSpending(app, {
      budgetId: ids.Groceries,
      date: '2026-03-01',
      amount: 1000,
      description: '',
    });
    const file = (await request(app).get('/api/export/spendings.csv').expect(200)).text;
    const { rows } = await previewOf(app, file, EXPORT_SPENDINGS_IMPORT_MAPPING);
    expect(rows[0]).toMatchObject({
      date: '2026-03-01',
      amount: 1000,
      errors: ['empty_description'],
    });
  });
});

describe('import scenario (c): the same file twice', () => {
  it('imports nothing the second time: every row is a duplicate, and no figure moves', async () => {
    const { app, db, ids } = await buildWorld('2026-04-15');
    const csv = bankCsv(BANK_ROWS);
    await commitOf(app, csv, listedRows(ids), BANK);
    const before = await figures(app);
    const listed = listedRows(ids);

    // The preview flags every row that was imported, and not the salary, which never was.
    const again = await previewOf(app, csv, BANK);
    expect(again.rows.filter((row) => row.duplicate).map((row) => row.line)).toEqual(
      listed.map((row) => row.line),
    );
    expect(again.summary).toEqual({
      total: 15,
      invalid: 0,
      duplicates: 14,
      credits: 3,
      importable: 0,
    });
    // The identical cinemas of March (occurrences 0 and 1) are both flagged, and the one of January.
    expect(
      again.rows.filter((row) => row.description === 'Cinema').map((row) => row.duplicate),
    ).toEqual([true, true, true]);

    // The commit refuses all of them together, and stores nothing.
    expectRejected(
      await commitRequest(app, csv, listed, BANK),
      listed.map((row): ImportRejectedRow => ({ line: row.line, errors: ['duplicate'] })),
    );
    expect(await figures(app)).toEqual(before);
    expect(db.$client.prepare('select count(*) as n from spendings').get()).toEqual({ n: 14 });

    // The salary row was never imported, so it can still be (it is not a duplicate).
    const salary = BANK_ROWS.findIndex((row) => row.budget === null) + 2;
    const done = await commitOf(app, csv, [{ line: salary, budgetId: ids.Groceries }], BANK);
    expect(done.created).toBe(1);
  });

  it('imports an overlapping file once: only the rows that are new', async () => {
    const { app, ids } = await buildWorld('2026-04-15');
    const march = BANK_ROWS.filter((row) => row.iso.startsWith('2026-03') && row.budget !== null);
    await commitOf(
      app,
      bankCsv(march),
      march.map((row, index) => ({ line: index + 2, budgetId: ids[row.budget as BudgetName] })),
      BANK,
    );

    // A bigger statement that holds the same three rows of March and the rest of the quarter.
    const quarter = BANK_ROWS.filter((row) => row.iso < '2026-04' && row.budget !== null);
    const preview = await previewOf(app, bankCsv(quarter), BANK);
    const fresh = preview.rows.filter((row) => !row.duplicate);
    expect(preview.summary.duplicates).toBe(march.length);
    const done = await commitOf(
      app,
      bankCsv(quarter),
      fresh.map((row) => ({
        line: row.line,
        budgetId: ids[quarter[row.line - 2]?.budget as BudgetName],
      })),
      BANK,
    );
    expect(done.created).toBe(quarter.length - march.length);
    expect(await allSpendings(app)).toHaveLength(quarter.length);
  });
});
