import { describe, expect, it } from 'vitest';
import {
  CSV_DELIMITERS,
  DEFAULT_BODY_LIMIT_BYTES,
  IMPORT_DATE_FORMATS,
  IMPORT_DECIMAL_SEPARATORS,
  IMPORT_MAX_BODY_BYTES,
  IMPORT_MAX_COLUMN_INDEX,
  IMPORT_MAX_ROWS,
  IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH,
  IMPORT_PROFILE_MAX_HEADER_CELLS,
  IMPORT_REJECTION_CODES,
  IMPORT_ROW_ERROR_CODES,
  IMPORT_SAMPLE_ROWS,
  IMPORT_SIGN_CONVENTIONS,
  importCommitSchema,
  importMappingSchema,
  importParseSchema,
  importPreviewSchema,
  importProfileSchema,
} from './import';
import { NAME_MAX_LENGTH } from './limits';
import { chars, parseCases, schemaCases } from './test-utils';

const mapping = {
  delimiter: ';',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 1,
  descriptionColumn: 2,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  signConvention: 'expenses_negative',
} as const;

const csv = 'Date;Amount;Description\n05/03/2026;-12,30;Coffee';

describe('the closed sets of the contract', () => {
  it('list the delimiters, date formats, separators and sign conventions', () => {
    expect([...CSV_DELIMITERS]).toEqual([',', ';', '\t', '|']);
    expect([...IMPORT_DATE_FORMATS]).toEqual([
      'YYYY-MM-DD',
      'YYYY/MM/DD',
      'YYYYMMDD',
      'DD/MM/YYYY',
      'MM/DD/YYYY',
      'DD.MM.YYYY',
      'DD-MM-YYYY',
      'MM-DD-YYYY',
    ]);
    expect([...IMPORT_DECIMAL_SEPARATORS]).toEqual(['.', ',']);
    expect([...IMPORT_SIGN_CONVENTIONS]).toEqual(['expenses_negative', 'expenses_positive']);
  });

  it('have no two-digit-year format', () => {
    for (const format of IMPORT_DATE_FORMATS) expect(format.match(/Y+/g)).toEqual(['YYYY']);
  });

  it('list the row error codes in the canonical order, as a subset of the rejection codes', () => {
    expect([...IMPORT_ROW_ERROR_CODES]).toEqual([
      'invalid_date',
      'invalid_amount',
      'zero_amount',
      'amount_too_large',
      'empty_description',
      'before_start_month',
    ]);
    expect([...IMPORT_REJECTION_CODES]).toEqual([
      'unknown_line',
      'invalid_date',
      'invalid_amount',
      'zero_amount',
      'amount_too_large',
      'empty_description',
      'unknown_budget',
      'before_start_month',
      'outside_active_months',
      'duplicate',
    ]);
    // Every preview code is a rejection code, in the same relative order.
    const rejections = [...IMPORT_REJECTION_CODES] as string[];
    const positions = IMPORT_ROW_ERROR_CODES.map((code) => rejections.indexOf(code));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('are the limits docs/DOMAIN.md names', () => {
    expect(IMPORT_SAMPLE_ROWS).toBe(5);
    expect(IMPORT_MAX_ROWS).toBe(10_000);
    expect(IMPORT_MAX_COLUMN_INDEX).toBe(99);
    expect(IMPORT_MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(100 * 1024);
    expect(IMPORT_MAX_BODY_BYTES).toBeGreaterThan(DEFAULT_BODY_LIMIT_BYTES);
  });
});

describe('importMappingSchema', () => {
  schemaCases(
    'mapping',
    importMappingSchema,
    [
      ['a semicolon bank file', mapping],
      [
        'a comma file with dots',
        { ...mapping, delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD' },
      ],
      ['a tab file', { ...mapping, delimiter: '\t' }],
      ['a pipe file', { ...mapping, delimiter: '|' }],
      ['no header', { ...mapping, hasHeader: false }],
      ['expenses positive', { ...mapping, signConvention: 'expenses_positive' }],
      [
        'columns in any order',
        { ...mapping, dateColumn: 5, amountColumn: 2, descriptionColumn: 0 },
      ],
      [
        'the highest columns',
        { ...mapping, dateColumn: 99, amountColumn: 98, descriptionColumn: 97 },
      ],
      ...IMPORT_DATE_FORMATS.map((dateFormat): [string, unknown] => [
        `the date format ${dateFormat}`,
        { ...mapping, dateFormat },
      ]),
    ],
    [
      ['an empty body', {}, 'delimiter'],
      ['a missing delimiter', { ...mapping, delimiter: undefined }, 'delimiter'],
      ['a missing hasHeader', { ...mapping, hasHeader: undefined }, 'hasHeader'],
      ['a missing dateColumn', { ...mapping, dateColumn: undefined }, 'dateColumn'],
      ['a missing amountColumn', { ...mapping, amountColumn: undefined }, 'amountColumn'],
      [
        'a missing descriptionColumn',
        { ...mapping, descriptionColumn: undefined },
        'descriptionColumn',
      ],
      ['a missing dateFormat', { ...mapping, dateFormat: undefined }, 'dateFormat'],
      [
        'a missing decimalSeparator',
        { ...mapping, decimalSeparator: undefined },
        'decimalSeparator',
      ],
      ['a missing signConvention', { ...mapping, signConvention: undefined }, 'signConvention'],
      ['a delimiter that is not supported', { ...mapping, delimiter: ':' }, 'delimiter'],
      ['a two-character delimiter', { ...mapping, delimiter: ',,' }, 'delimiter'],
      ['an empty delimiter', { ...mapping, delimiter: '' }, 'delimiter'],
      ['the word tab for the tab delimiter', { ...mapping, delimiter: 'tab' }, 'delimiter'],
      ['a string hasHeader', { ...mapping, hasHeader: 'true' }, 'hasHeader'],
      ['a negative column', { ...mapping, dateColumn: -1 }, 'dateColumn'],
      ['a fractional column', { ...mapping, dateColumn: 1.5 }, 'dateColumn'],
      ['a column by name', { ...mapping, dateColumn: 'Date' }, 'dateColumn'],
      ['a column index of 100 (the highest is 99)', { ...mapping, dateColumn: 100 }, 'dateColumn'],
      ['an unknown date format', { ...mapping, dateFormat: 'YYYY.MM.DD' }, 'dateFormat'],
      ['a two-digit year format', { ...mapping, dateFormat: 'DD/MM/YY' }, 'dateFormat'],
      ['a lower-case date format', { ...mapping, dateFormat: 'dd/mm/yyyy' }, 'dateFormat'],
      [
        'a decimal separator that is not . or ,',
        { ...mapping, decimalSeparator: ';' },
        'decimalSeparator',
      ],
      ['a space as decimal separator', { ...mapping, decimalSeparator: ' ' }, 'decimalSeparator'],
      [
        'an unknown sign convention',
        { ...mapping, signConvention: 'debit_credit' },
        'signConvention',
      ],
      ['the amount column of the date column', { ...mapping, amountColumn: 0 }, 'amountColumn'],
      [
        'the description column of the date column',
        { ...mapping, descriptionColumn: 0 },
        'descriptionColumn',
      ],
      [
        'the description column of the amount column',
        { ...mapping, descriptionColumn: 1 },
        'descriptionColumn',
      ],
      [
        'all three columns the same',
        { ...mapping, amountColumn: 0, descriptionColumn: 0 },
        'amountColumn',
      ],
      [
        'a debit and a credit column (not supported)',
        { ...mapping, debitColumn: 3, creditColumn: 4 },
        '',
      ],
      ['an unknown key', { ...mapping, skipRows: 2 }, ''],
      ['null', null, ''],
    ],
  );

  parseCases('output', importMappingSchema, [['keeps every field as given', mapping, mapping]]);
});

describe('importParseSchema (POST /api/import/parse)', () => {
  schemaCases(
    'body',
    importParseSchema,
    [
      ['a file', { csv }],
      ['an empty file', { csv: '' }],
      ['a file with a BOM', { csv: `﻿${csv}` }],
      ['a file and a delimiter', { csv, delimiter: ';' }],
      ['a tab delimiter', { csv, delimiter: '\t' }],
      ['a very long file', { csv: chars(200_000) }],
    ],
    [
      ['an empty body', {}, 'csv'],
      ['a missing csv', { delimiter: ';' }, 'csv'],
      ['a null csv', { csv: null }, 'csv'],
      ['a number as csv', { csv: 5 }, 'csv'],
      ['an array of lines', { csv: ['a', 'b'] }, 'csv'],
      ['a delimiter that is not supported', { csv, delimiter: ':' }, 'delimiter'],
      ['a null delimiter (leave it out to detect)', { csv, delimiter: null }, 'delimiter'],
      ['an empty delimiter', { csv, delimiter: '' }, 'delimiter'],
      ['a mapping (that is for preview)', { csv, mapping }, ''],
      ['an unknown key', { csv, hasHeader: true }, ''],
    ],
  );

  parseCases('output', importParseSchema, [
    ['leaves the csv exactly as it is (no trim)', { csv: '  a;b \n' }, { csv: '  a;b \n' }],
    ['leaves an omitted delimiter out', { csv }, { csv }],
  ]);
});

describe('importPreviewSchema (POST /api/import/preview)', () => {
  schemaCases(
    'body',
    importPreviewSchema,
    [
      ['a file and a mapping', { csv, mapping }],
      ['an empty file', { csv: '', mapping }],
    ],
    [
      ['an empty body', {}, 'csv'],
      ['a missing csv', { mapping }, 'csv'],
      ['a missing mapping', { csv }, 'mapping'],
      ['a null mapping', { csv, mapping: null }, 'mapping'],
      [
        'a mapping with a bad field',
        { csv, mapping: { ...mapping, dateFormat: 'x' } },
        'mapping.dateFormat',
      ],
      [
        'a mapping with a missing field',
        { csv, mapping: { ...mapping, hasHeader: undefined } },
        'mapping.hasHeader',
      ],
      [
        'a mapping with equal columns',
        { csv, mapping: { ...mapping, amountColumn: 0 } },
        'mapping.amountColumn',
      ],
      ['a delimiter next to the mapping', { csv, mapping, delimiter: ';' }, ''],
      ['rows (that is for commit)', { csv, mapping, rows: [] }, ''],
    ],
  );
});

describe('importCommitSchema (POST /api/import/commit)', () => {
  const body = { csv, mapping, rows: [{ line: 2, budgetId: 4 }] };

  /** `n` distinct rows, lines 2 to n + 1. */
  const rowsOf = (n: number) =>
    Array.from({ length: n }, (_unused, i) => ({ line: i + 2, budgetId: 1 }));

  schemaCases(
    'body',
    importCommitSchema,
    [
      ['one row', body],
      [
        'several rows, in any order',
        {
          ...body,
          rows: [
            { line: 9, budgetId: 1 },
            { line: 2, budgetId: 4 },
            { line: 5, budgetId: 4 },
          ],
        },
      ],
      [
        'the same budget for every row',
        {
          ...body,
          rows: [
            { line: 2, budgetId: 4 },
            { line: 3, budgetId: 4 },
          ],
        },
      ],
      ['line 1 (a file without a header)', { ...body, rows: [{ line: 1, budgetId: 4 }] }],
      ['the most rows', { ...body, rows: rowsOf(IMPORT_MAX_ROWS) }],
    ],
    [
      ['an empty body', {}, 'csv'],
      ['a missing csv', { mapping, rows: body.rows }, 'csv'],
      ['a missing mapping', { csv, rows: body.rows }, 'mapping'],
      ['missing rows', { csv, mapping }, 'rows'],
      ['no rows (list at least one)', { ...body, rows: [] }, 'rows'],
      ['too many rows', { ...body, rows: rowsOf(IMPORT_MAX_ROWS + 1) }, 'rows'],
      ['null rows', { ...body, rows: null }, 'rows'],
      ['a row that is a number (a line)', { ...body, rows: [2] }, 'rows.0'],
      ['a row without a line', { ...body, rows: [{ budgetId: 4 }] }, 'rows.0.line'],
      ['a row without a budget', { ...body, rows: [{ line: 2 }] }, 'rows.0.budgetId'],
      [
        'a null budget (the row must go somewhere)',
        { ...body, rows: [{ line: 2, budgetId: null }] },
        'rows.0.budgetId',
      ],
      ['line 0', { ...body, rows: [{ line: 0, budgetId: 4 }] }, 'rows.0.line'],
      ['a negative line', { ...body, rows: [{ line: -2, budgetId: 4 }] }, 'rows.0.line'],
      ['a fractional line', { ...body, rows: [{ line: 2.5, budgetId: 4 }] }, 'rows.0.line'],
      ['a string line', { ...body, rows: [{ line: '2', budgetId: 4 }] }, 'rows.0.line'],
      ['budget 0', { ...body, rows: [{ line: 2, budgetId: 0 }] }, 'rows.0.budgetId'],
      ['a string budget', { ...body, rows: [{ line: 2, budgetId: '4' }] }, 'rows.0.budgetId'],
      [
        'the same line twice',
        {
          ...body,
          rows: [
            { line: 2, budgetId: 4 },
            { line: 2, budgetId: 4 },
          ],
        },
        'rows.1.line',
      ],
      [
        'the same line twice with different budgets',
        {
          ...body,
          rows: [
            { line: 2, budgetId: 4 },
            { line: 3, budgetId: 1 },
            { line: 2, budgetId: 1 },
          ],
        },
        'rows.2.line',
      ],
      [
        'an amount in a row (the server reads it from the file)',
        { ...body, rows: [{ line: 2, budgetId: 4, amount: 1230 }] },
        'rows.0',
      ],
      [
        'a date in a row',
        { ...body, rows: [{ line: 2, budgetId: 4, date: '2026-03-05' }] },
        'rows.0',
      ],
      [
        'a description in a row',
        { ...body, rows: [{ line: 2, budgetId: 4, description: 'x' }] },
        'rows.0',
      ],
      ['an unknown key', { ...body, dryRun: true }, ''],
      [
        'a bad mapping',
        { ...body, mapping: { ...mapping, signConvention: '' } },
        'mapping.signConvention',
      ],
    ],
  );
});

describe('importProfileSchema (POST and PUT /api/import/profiles)', () => {
  const profile = { name: 'My bank', mapping, header: ['Date', 'Amount', 'Description'] };

  schemaCases(
    'body',
    importProfileSchema,
    [
      ['a name, a mapping and the header', profile],
      ['without a header', { name: 'My bank', mapping }],
      ['a null header', { ...profile, header: null }],
      [
        'an empty header (no signature)',
        { ...profile, header: [], mapping: { ...mapping, hasHeader: false } },
      ],
      [
        'a header with extra cells',
        { ...profile, header: ['Date', 'Amount', 'Description', 'Balance', 'Ref'] },
      ],
      [
        'a header that reaches the highest mapped column exactly',
        {
          ...profile,
          mapping: { ...mapping, descriptionColumn: 4 },
          header: Array.from({ length: 5 }, (_unused, i) => `c${i}`),
        },
      ],
      [
        'a header of a file with no header row (ignored)',
        { name: 'x', mapping: { ...mapping, hasHeader: false }, header: ['a'] },
      ],
      ['empty header cells', { ...profile, header: ['', '', ''] }],
      ['the longest name', { name: chars(NAME_MAX_LENGTH), mapping }],
      [
        'the most header cells',
        { ...profile, header: Array.from({ length: IMPORT_PROFILE_MAX_HEADER_CELLS }, () => 'h') },
      ],
      [
        'the longest header cell',
        { ...profile, header: [chars(IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH), 'b', 'c'] },
      ],
    ],
    [
      ['an empty body', {}, 'name'],
      ['a missing name', { mapping }, 'name'],
      ['an empty name', { name: '', mapping }, 'name'],
      ['a blank name', { name: '   ', mapping }, 'name'],
      ['a too long name', { name: chars(NAME_MAX_LENGTH + 1), mapping }, 'name'],
      ['a null name', { name: null, mapping }, 'name'],
      ['a missing mapping', { name: 'x' }, 'mapping'],
      ['a null mapping', { name: 'x', mapping: null }, 'mapping'],
      [
        'a mapping with a bad field',
        { name: 'x', mapping: { ...mapping, delimiter: ':' } },
        'mapping.delimiter',
      ],
      [
        'a header too short for the mapped columns',
        { ...profile, header: ['Date', 'Amount'] },
        'header',
      ],
      ['an empty header for a file that has a header row', { ...profile, header: [] }, 'header'],
      [
        'a header that stops before the highest mapped column',
        { ...profile, mapping: { ...mapping, dateColumn: 7 }, header: ['a', 'b', 'c'] },
        'header',
      ],
      [
        'too many header cells',
        {
          ...profile,
          header: Array.from({ length: IMPORT_PROFILE_MAX_HEADER_CELLS + 1 }, () => 'h'),
        },
        'header',
      ],
      [
        'a too long header cell',
        { ...profile, header: [chars(IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH + 1), 'b', 'c'] },
        'header.0',
      ],
      [
        'a header cell that is not text',
        { ...profile, header: ['Date', 5, 'Description'] },
        'header.1',
      ],
      ['a header that is a string', { ...profile, header: 'Date;Amount;Description' }, 'header'],
      ['an id in the body', { id: 3, ...profile }, ''],
      ['an unknown key', { ...profile, bank: 'x' }, ''],
    ],
  );

  parseCases('output', importProfileSchema, [
    ['trims the name', { name: '  My bank ', mapping }, { name: 'My bank', mapping }],
    ['keeps the header as sent (the server normalizes it)', profile, profile],
  ]);
});
