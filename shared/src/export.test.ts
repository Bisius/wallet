import { describe, expect, it } from 'vitest';
import { CSV_BOM, encodeCsv, formatCentsPlain, guardCsvText, readImportRows } from './csv';
import {
  EXPORT_COLUMNS,
  EXPORT_CONTENT_TYPE,
  EXPORT_INCOMES_COLUMNS,
  EXPORT_SAVINGS_COLUMNS,
  EXPORT_SPENDINGS_COLUMNS,
  EXPORT_SPENDINGS_IMPORT_MAPPING,
  EXPORT_TAG_SEPARATOR,
  EXPORT_TEXT_COLUMNS,
  exportFilename,
  exportPath,
  exportQuerySchema,
} from './export';
import { importMappingSchema } from './import';
import { EXPORT_KINDS, SAVINGS_TRANSACTION_KINDS } from './limits';
import { parseCases, schemaCases } from './test-utils';

describe('exportQuerySchema (GET /api/export/<kind>.csv)', () => {
  schemaCases(
    'query',
    exportQuerySchema,
    [
      ['no bound at all', {}],
      ['only from', { from: '2026-01-01' }],
      ['only to', { to: '2026-03-31' }],
      ['both bounds', { from: '2026-01-01', to: '2026-03-31' }],
      ['one day', { from: '2026-03-15', to: '2026-03-15' }],
      ['a leap day', { from: '2028-02-29', to: '2028-02-29' }],
      ['a range across years', { from: '2025-12-31', to: '2026-01-01' }],
    ],
    [
      ['from after to', { from: '2026-04-01', to: '2026-03-31' }, 'to'],
      ['from one day after to', { from: '2026-03-16', to: '2026-03-15' }, 'to'],
      ['a month instead of a date', { from: '2026-01' }, 'from'],
      ['a date that does not exist', { to: '2026-02-30' }, 'to'],
      ['a date written with slashes', { from: '2026/01/01' }, 'from'],
      ['a one-digit month', { from: '2026-1-1' }, 'from'],
      ['an empty from', { from: '' }, 'from'],
      ['a number', { from: 20260101 }, 'from'],
      ['a null bound (leave it out)', { to: null }, 'to'],
      ['an unknown key', { month: '2026-03' }, ''],
      ['a limit (the exports are not paged)', { limit: 10 }, ''],
    ],
  );

  parseCases('output', exportQuerySchema, [
    [
      'keeps the dates as written',
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-01-01', to: '2026-03-31' },
    ],
    ['leaves an omitted bound out', {}, {}],
  ]);
});

describe('the columns', () => {
  it('are fixed, in this order, one header row per export', () => {
    expect(EXPORT_SPENDINGS_COLUMNS).toEqual([
      'id',
      'date',
      'amount',
      'budget',
      'description',
      'notes',
      'tags',
    ]);
    expect(EXPORT_INCOMES_COLUMNS).toEqual(['id', 'date', 'amount', 'description']);
    expect(EXPORT_SAVINGS_COLUMNS).toEqual([
      'id',
      'date',
      'kind',
      'amount',
      'goal_id',
      'goal',
      'settles_month',
      'note',
      'group_id',
    ]);
    expect(Object.keys(EXPORT_COLUMNS)).toEqual([...EXPORT_KINDS]);
  });

  it('do not export the import hash, and the salary has no file', () => {
    expect(EXPORT_SPENDINGS_COLUMNS).not.toContain('import_hash');
    expect(EXPORT_KINDS).toEqual(['spendings', 'incomes', 'savings']);
  });

  it('have no duplicates and use lower snake case', () => {
    for (const columns of Object.values(EXPORT_COLUMNS)) {
      expect(new Set(columns).size).toBe(columns.length);
      for (const column of columns) expect(column).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it('name the text cells that get the injection guard, all of which are columns', () => {
    for (const kind of EXPORT_KINDS) {
      for (const column of EXPORT_TEXT_COLUMNS[kind]) {
        expect(EXPORT_COLUMNS[kind] as readonly string[]).toContain(column);
      }
    }
    expect(EXPORT_TEXT_COLUMNS.spendings).toEqual(['budget', 'description', 'notes', 'tags']);
    expect(EXPORT_TEXT_COLUMNS.incomes).toEqual(['description']);
    expect(EXPORT_TEXT_COLUMNS.savings).toEqual(['goal', 'note']);
  });

  it('never guard an amount, an id, a date or a kind', () => {
    for (const kind of EXPORT_KINDS) {
      for (const column of [
        'id',
        'date',
        'amount',
        'kind',
        'settles_month',
        'group_id',
        'goal_id',
      ]) {
        expect(EXPORT_TEXT_COLUMNS[kind] as readonly string[]).not.toContain(column);
      }
    }
  });

  it('use a separator that the quoting never needs for a list of tag names', () => {
    expect(EXPORT_TAG_SEPARATOR).toBe('|');
  });
});

describe('exportFilename', () => {
  it.each([
    ['spendings', {}, 'wallet-spendings-all.csv'],
    ['spendings', { from: '2026-01-01' }, 'wallet-spendings-from-2026-01-01.csv'],
    ['spendings', { to: '2026-03-31' }, 'wallet-spendings-until-2026-03-31.csv'],
    [
      'spendings',
      { from: '2026-01-01', to: '2026-03-31' },
      'wallet-spendings-2026-01-01_to_2026-03-31.csv',
    ],
    [
      'incomes',
      { from: '2026-03-15', to: '2026-03-15' },
      'wallet-incomes-2026-03-15_to_2026-03-15.csv',
    ],
    ['savings', {}, 'wallet-savings-all.csv'],
  ] as const)('%s with %j is %s', (kind, range, filename) => {
    expect(exportFilename(kind, range)).toBe(filename);
  });

  it('is plain ASCII with no characters a header or a file system dislikes', () => {
    for (const kind of EXPORT_KINDS) {
      for (const range of [
        {},
        { from: '2026-01-01' },
        { to: '2026-12-31' },
        { from: '2026-01-01', to: '2026-12-31' },
      ]) {
        expect(exportFilename(kind, range)).toMatch(/^[a-z0-9_.-]+$/);
      }
    }
  });

  it('has a path and a content type', () => {
    expect(exportPath('spendings')).toBe('/api/export/spendings.csv');
    expect(exportPath('incomes')).toBe('/api/export/incomes.csv');
    expect(exportPath('savings')).toBe('/api/export/savings.csv');
    expect(EXPORT_CONTENT_TYPE).toBe('text/csv; charset=utf-8');
  });
});

describe('the spendings export, imported again', () => {
  it('has a mapping that is a valid ImportMapping pointing at the right columns', () => {
    expect(importMappingSchema.safeParse(EXPORT_SPENDINGS_IMPORT_MAPPING).success).toBe(true);
    expect(EXPORT_SPENDINGS_IMPORT_MAPPING).toMatchObject({
      dateColumn: 1,
      amountColumn: 2,
      descriptionColumn: 4,
    });
  });

  /** What the export service does to a spending, written out with the shared helpers. */
  const exportRow = (spending: {
    id: number;
    date: string;
    amount: number;
    budget: string;
    description: string;
    notes: string | null;
    tags: string[];
  }): string[] => [
    String(spending.id),
    spending.date,
    formatCentsPlain(spending.amount),
    guardCsvText(spending.budget),
    guardCsvText(spending.description),
    guardCsvText(spending.notes ?? ''),
    guardCsvText(spending.tags.join(EXPORT_TAG_SEPARATOR)),
  ];

  const spendings = [
    {
      id: 1,
      date: '2026-03-05',
      amount: 1230,
      budget: 'Food',
      description: 'Coffee, large',
      notes: null,
      tags: ['Work', 'Café'],
    },
    {
      id: 2,
      date: '2026-03-05',
      amount: -500,
      budget: 'Food',
      description: 'Refund "oops"',
      notes: 'line\nbreak',
      tags: [],
    },
    {
      id: 3,
      date: '2026-03-06',
      amount: 100000000000,
      budget: 'Rent',
      description: '=SUM(A1)',
      notes: null,
      tags: ['-x'],
    },
    {
      id: 4,
      date: '2026-03-07',
      amount: 1,
      budget: 'Rent',
      description: '-',
      notes: '@home',
      tags: [],
    },
    {
      id: 5,
      date: '2026-03-08',
      amount: 5,
      budget: 'Fun',
      description: 'Ünïcode 😀',
      notes: null,
      tags: [],
    },
  ];
  const file = encodeCsv([[...EXPORT_SPENDINGS_COLUMNS], ...spendings.map(exportRow)]);

  it('is a UTF-8 file with a BOM, CRLF line ends and the header row first', () => {
    expect(file.startsWith(`${CSV_BOM}id,date,amount,budget,description,notes,tags\r\n`)).toBe(
      true,
    );
    expect(file.endsWith('\r\n')).toBe(true);
  });

  it('writes every amount as a plain decimal, and never guards it', () => {
    expect(file).toContain('1,2026-03-05,12.30,');
    expect(file).toContain('2,2026-03-05,-5.00,');
    expect(file).toContain('3,2026-03-06,1000000000.00,');
  });

  it('guards the text cells that start with a trigger, and only those', () => {
    expect(file).toContain(",'=SUM(A1),");
    expect(file).toContain(",'-,'@home,");
    expect(file).toContain(",'-x\r\n");
    expect(file).toContain(',Work|Café\r\n');
    expect(file).toContain('"Coffee, large"');
    expect(file).toContain('"Refund ""oops"""');
  });

  it('reads back with the exact dates and amounts, row by row', () => {
    const rows = readImportRows(file, EXPORT_SPENDINGS_IMPORT_MAPPING, (text) =>
      text.toLowerCase(),
    );
    expect(rows.map((row) => [row.date, row.amount])).toEqual(
      spendings.map((spending) => [spending.date, spending.amount]),
    );
    // The refund comes back as a credit, an expense does not.
    expect(rows.map((row) => row.credit)).toEqual([false, true, false, false, false]);
    expect(rows[0]?.description).toBe('Coffee, large');
    expect(rows[2]?.description).toBe("'=SUM(A1)");
    // Lines count from the header (line 1), and the multi-line note shifts the lines after it.
    expect(rows.map((row) => row.line)).toEqual([2, 3, 5, 6, 7]);
  });
});
