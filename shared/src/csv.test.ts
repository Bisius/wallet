import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  CsvSyntaxError,
  cleanImportText,
  detectDelimiter,
  encodeCsv,
  encodeCsvCell,
  encodeCsvRow,
  formatCentsPlain,
  guardCsvText,
  importHashPreimage,
  isBlankRecord,
  limitImportDescription,
  parseCsv,
  parseImportAmount,
  parseImportDate,
  readImportRows,
} from './csv';
import type { ImportMapping } from './import';
import { IMPORT_DATE_FORMATS, MAX_CENTS, type ImportDateFormat } from './limits';

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

describe('formatCentsPlain', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [5, '0.05'],
    [99, '0.99'],
    [100, '1.00'],
    [101, '1.01'],
    [1230, '12.30'],
    [1250, '12.50'],
    [100000, '1000.00'],
    [123456789, '1234567.89'],
    [-1, '-0.01'],
    [-5, '-0.05'],
    [-100, '-1.00'],
    [-1230, '-12.30'],
    [MAX_CENTS, '10000000000.00'],
    [-MAX_CENTS, '-10000000000.00'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
    [-Number.MAX_SAFE_INTEGER, '-90071992547409.91'],
  ])('%i is %s', (cents, text) => {
    expect(formatCentsPlain(cents)).toBe(text);
  });

  it('never writes a negative zero', () => {
    expect(formatCentsPlain(-0)).toBe('0.00');
    expect(formatCentsPlain(0)).toBe('0.00');
  });

  it('writes no thousands separator and always two decimals', () => {
    expect(formatCentsPlain(123456789012)).toBe('1234567890.12');
    expect(formatCentsPlain(700)).toBe('7.00');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)])(
    'refuses %s, which is not a safe integer',
    (value) => {
      expect(() => formatCentsPlain(value)).toThrow(RangeError);
    },
  );
});

describe('guardCsvText', () => {
  it.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+1', "'+1"],
    ['-5', "'-5"],
    ['- refund', "'- refund"],
    ['@user', "'@user"],
    ['\tTabbed', "'\tTabbed"],
    ['\rReturn', "'\rReturn"],
    ['=HYPERLINK("http://x")', `'=HYPERLINK("http://x")`],
  ])('prefixes %j', (text, guarded) => {
    expect(guardCsvText(text)).toBe(guarded);
  });

  // A spreadsheet whose list separator is ";" starts a new cell after every ";" of the text.
  it.each([
    ["Shop;=cmd|' /C calc'!A0;", "Shop;'=cmd|' /C calc'!A0;"],
    ['a;+1;-2;@x', "a;'+1;'-2;'@x"],
    ['=a;=b', "'=a;'=b"],
    ['a;\tb', "a;'\tb"],
    ['a;\rb', "a;'\rb"],
    ['a;;=b', "a;;'=b"],
    [';=b', ";'=b"],
    ['"quoted;=b"', '"quoted;\'=b"'],
  ])('prefixes what follows a ";" in %j', (text, guarded) => {
    expect(guardCsvText(text)).toBe(guarded);
  });

  it.each([
    [''],
    ['Coffee'],
    ['a=b'],
    ['5 - 3'],
    ['name@example.com'],
    [' =leading space'],
    ['\nnewline first'],
    ["'=already text"],
    ['Café'],
    ['#hash'],
    ['_underscore'],
    ['a;b'],
    ['a; =b'],
    ['a;b=c'],
    ['5;3-2'],
    ["a;'=already text"],
    ['a;\nnewline first'],
  ])('leaves %j as it is', (text) => {
    expect(guardCsvText(text)).toBe(text);
  });

  it('is idempotent', () => {
    for (const text of ['=1', '-x', '@y', 'ok', '', 'a;=b', '=a;-b;;@c']) {
      expect(guardCsvText(guardCsvText(text))).toBe(guardCsvText(text));
    }
  });
});

describe('encodeCsvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['', ''],
    ['with space', 'with space'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['"', '""""'],
    ['line\nbreak', '"line\nbreak"'],
    ['line\r\nbreak', '"line\r\nbreak"'],
    ['cr\rcr', '"cr\rcr"'],
    ['semi;colon', 'semi;colon'],
    ['tab\there', 'tab\there'],
    ['pipe|bar', 'pipe|bar'],
  ])('%j becomes %j with a comma delimiter', (cell, encoded) => {
    expect(encodeCsvCell(cell)).toBe(encoded);
  });

  it('quotes a cell that holds the delimiter in use, and only that one', () => {
    expect(encodeCsvCell('a;b', ';')).toBe('"a;b"');
    expect(encodeCsvCell('a,b', ';')).toBe('a,b');
    expect(encodeCsvCell('a\tb', '\t')).toBe('"a\tb"');
    expect(encodeCsvCell('a|b', '|')).toBe('"a|b"');
  });
});

describe('encodeCsv', () => {
  it('writes the BOM, CRLF after every record (the last too), and RFC 4180 quoting', () => {
    const text = encodeCsv([
      ['id', 'amount', 'description'],
      ['1', '12.30', 'Coffee, large'],
      ['2', '-5.00', 'He said "hi"'],
      ['3', '0.05', ''],
    ]);
    expect(text).toBe(
      `${CSV_BOM}id,amount,description\r\n1,12.30,"Coffee, large"\r\n2,-5.00,"He said ""hi"""\r\n3,0.05,\r\n`,
    );
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    // Every line end is a CRLF: no bare LF outside a quoted cell.
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('can leave the BOM out and change the delimiter', () => {
    expect(encodeCsv([['a', 'b;c']], { bom: false, delimiter: ';' })).toBe('a;"b;c"\r\n');
  });

  it('is only the BOM for no rows (an export with no header is never written)', () => {
    expect(encodeCsv([])).toBe(CSV_BOM);
  });

  it('keeps a multi-line cell inside quotes, so the line ends outside stay CRLF', () => {
    expect(encodeCsv([['a', 'x\ny']], { bom: false })).toBe('a,"x\ny"\r\n');
  });

  it('encodes a row on its own without a line end', () => {
    expect(encodeCsvRow(['a', 'b,c'])).toBe('a,"b,c"');
  });

  it('is read back as the same cells', () => {
    const rows = [
      ['id', 'text'],
      ['1', 'a "quoted", multi\nline\r\ncell'],
      ['2', ''],
      ['3', '=1+1'],
    ];
    expect(parseCsv(encodeCsv(rows), ',').map((record) => record.cells)).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const cellsOf = (text: string, delimiter: ',' | ';' | '\t' | '|' = ','): string[][] =>
  parseCsv(text, delimiter).map((record) => record.cells);

describe('parseCsv', () => {
  it('reads records and cells', () => {
    expect(cellsOf('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it.each([
    ['LF', 'a,b\nc,d'],
    ['CRLF', 'a,b\r\nc,d'],
    ['CR', 'a,b\rc,d'],
  ])('ends a record at %s', (_name, text) => {
    expect(cellsOf(text)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops a leading BOM, and only one', () => {
    expect(cellsOf('﻿a,b')).toEqual([['a', 'b']]);
    expect(cellsOf('﻿﻿a')).toEqual([['﻿a']]);
  });

  it('reads a quoted first field after the BOM as quoted', () => {
    expect(cellsOf('\uFEFF"a,b",c')).toEqual([['a,b', 'c']]);
  });

  it('reads no record from an empty text, and none after a final line end', () => {
    expect(cellsOf('')).toEqual([]);
    expect(cellsOf('﻿')).toEqual([]);
    expect(cellsOf('a,b\n')).toEqual([['a', 'b']]);
    expect(cellsOf('a,b\r\n')).toEqual([['a', 'b']]);
  });

  it('reads an empty line anywhere else as a record with one empty cell', () => {
    expect(parseCsv('a,b\n\nc,d\n', ',')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: [''] },
      { line: 3, cells: ['c', 'd'] },
    ]);
    expect(cellsOf('\n')).toEqual([['']]);
    expect(cellsOf('\na')).toEqual([[''], ['a']]);
  });

  it('keeps empty cells, also at the ends of a record', () => {
    expect(cellsOf(',a,,b,')).toEqual([['', 'a', '', 'b', '']]);
    expect(cellsOf('a,')).toEqual([['a', '']]);
    expect(cellsOf(',')).toEqual([['', '']]);
  });

  it('does not trim cells', () => {
    expect(cellsOf(' a , b ')).toEqual([[' a ', ' b ']]);
  });

  describe('quoted fields', () => {
    it('hold delimiters, line breaks and escaped quotes', () => {
      expect(cellsOf('"a,b","c\nd","e ""f"" g",h')).toEqual([['a,b', 'c\nd', 'e "f" g', 'h']]);
    });

    it('keep CRLF and CR inside the cell as they are', () => {
      expect(cellsOf('"a\r\nb","c\rd"')).toEqual([['a\r\nb', 'c\rd']]);
    });

    it('can be empty, or hold only a quote', () => {
      expect(cellsOf('"",a')).toEqual([['', 'a']]);
      expect(cellsOf('"""",a')).toEqual([['"', 'a']]);
      expect(cellsOf('"""a"""')).toEqual([['"a"']]);
    });

    it('end the record at the line end after the closing quote', () => {
      expect(cellsOf('"a"\n"b"')).toEqual([['a'], ['b']]);
    });

    it('take the characters after a closing quote as they are (lenient)', () => {
      expect(cellsOf('"ab"c,d')).toEqual([['abc', 'd']]);
      expect(cellsOf('"ab" ,d')).toEqual([['ab ', 'd']]);
    });

    it('open only at the first character: a quote elsewhere is an ordinary character', () => {
      expect(cellsOf('ab"c,d')).toEqual([['ab"c', 'd']]);
      expect(cellsOf('5" pipe,d')).toEqual([['5" pipe', 'd']]);
      // A space before the quote makes the field unquoted, so the comma inside splits it.
      expect(cellsOf(' "a,b"')).toEqual([[' "a', 'b"']]);
    });

    it('use the delimiter in force: a comma is text in a semicolon file', () => {
      expect(cellsOf('a,b;c', ';')).toEqual([['a,b', 'c']]);
      expect(cellsOf('"a;b";c', ';')).toEqual([['a;b', 'c']]);
    });

    it('throw for one that is never closed, naming the line it starts on', () => {
      expect(() => parseCsv('a,b\nc,"never closed\nd', ',')).toThrow(CsvSyntaxError);
      try {
        parseCsv('a,b\nc,"never closed\nd', ',');
      } catch (error) {
        expect((error as CsvSyntaxError).line).toBe(2);
        expect((error as CsvSyntaxError).message).toContain('line 2');
      }
      expect(() => parseCsv('"', ',')).toThrow(CsvSyntaxError);
      expect(() => parseCsv('"a""', ',')).toThrow(CsvSyntaxError);
    });

    it('end at the end of the text when lenient', () => {
      expect(parseCsv('a,"open\nstill', ',', { lenient: true })).toEqual([
        { line: 1, cells: ['a', 'open\nstill'] },
      ]);
    });
  });

  describe('delimiters', () => {
    it.each([
      [';', 'a;b;c'],
      ['\t', 'a\tb\tc'],
      ['|', 'a|b|c'],
      [',', 'a,b,c'],
    ] as const)('splits on %j', (delimiter, text) => {
      expect(cellsOf(text, delimiter)).toEqual([['a', 'b', 'c']]);
    });

    it('does not split on the other delimiters', () => {
      expect(cellsOf('a;b,c|d\te', ',')).toEqual([['a;b', 'c|d\te']]);
    });
  });

  describe('line numbers', () => {
    it('count from 1, one per CRLF, LF or CR', () => {
      expect(parseCsv('a\nb\r\nc\rd', ',').map((r) => r.line)).toEqual([1, 2, 3, 4]);
    });

    it('count the line breaks inside a quoted field, so a record is where an editor shows it', () => {
      const text = 'h1,h2\r\n1,"two\nlines"\r\n\r\n3,"a\r\nb\rc"\r\n4,x';
      expect(parseCsv(text, ',').map((r) => r.line)).toEqual([1, 2, 4, 5, 8]);
    });

    it('do not count the BOM', () => {
      expect(parseCsv('﻿a\nb', ',').map((r) => r.line)).toEqual([1, 2]);
    });
  });

  it('stops after maxRecords', () => {
    expect(parseCsv('a\nb\nc\nd', ',', { maxRecords: 2 })).toHaveLength(2);
    expect(parseCsv('a\nb', ',', { maxRecords: 0 })).toEqual([]);
  });

  it('can leave the blank records out, and the lines of the others stay true', () => {
    const text = 'a,b\n\n , \r\n"x\ny",z\n,\n\nlast';
    expect(parseCsv(text, ',', { skipBlank: true })).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 4, cells: ['x\ny', 'z'] },
      { line: 8, cells: ['last'] },
    ]);
    // The same records, with the blank ones in between, when they are not left out.
    expect(
      parseCsv(text, ',')
        .filter((record) => !isBlankRecord(record))
        .map((record) => record.line),
    ).toEqual([1, 4, 8]);
  });

  it('counts only the records it returns against maxRecords when skipping blanks', () => {
    expect(parseCsv('\n\na\n\nb\nc', ',', { skipBlank: true, maxRecords: 2 })).toEqual([
      { line: 3, cells: ['a'] },
      { line: 5, cells: ['b'] },
    ]);
  });
});

describe('isBlankRecord', () => {
  it.each([
    [[''], true],
    [['', ' ', '\t'], true],
    [['', 'a'], false],
    [['0'], false],
  ])('%j is blank: %s', (cells, blank) => {
    expect(isBlankRecord({ line: 1, cells })).toBe(blank);
  });
});

describe('detectDelimiter', () => {
  it.each([
    [
      'a comma file',
      'Date,Amount,Description\n2026-03-05,-12.30,Coffee\n2026-03-06,-3.00,Tea',
      ',',
    ],
    [
      'a semicolon file with decimal commas',
      'Date;Amount;Description\n05/03/2026;-12,30;Coffee\n06/03/2026;-3,00;Tea',
      ';',
    ],
    ['a tab file', 'Date\tAmount\tDescription\n05/03/2026\t-12.30\tCoffee', '\t'],
    ['a pipe file', 'Date|Amount|Description\n05/03/2026|-12.30|Coffee', '|'],
    [
      'a header with a quoted delimiter',
      '"Date, booked";"Amount";"Description"\n05/03/2026;-12,30;Coffee',
      ';',
    ],
    [
      'a header holding a comma, where both split every row (more columns win)',
      'Date;Amount (EUR, net);Description\n05/03/2026;-12,30;Coffee\n06/03/2026;-3,00;Tea',
      ';',
    ],
    ['leading blank lines', '\n\n  \nA;B\n1;2', ';'],
    ['a file with only a header', 'a;b;c', ';'],
    ['no delimiter at all', 'just one column\nanother', ','],
    ['an empty file', '', ','],
    ['a BOM', '﻿Date;Amount\n1;2', ';'],
    ['ragged rows: the first record decides the width', 'a;b;c\n1;2\n3;4;5\n6;7;8', ';'],
  ])('%s', (_name, text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });

  it('prefers the delimiter whose rows are consistent', () => {
    // Both split the first two records into two cells, only the tab does so for every row.
    const text = 'x,y\tz\n1,2\t3\n4\t5\n6\t7';
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('breaks a tie by the order , ; tab |', () => {
    expect(detectDelimiter('a,b;c')).toBe(','); // 2 cells with a comma, 2 with a semicolon
    expect(detectDelimiter('a;b|c')).toBe(';');
  });

  it('copes with an unterminated quote in the part it looks at', () => {
    expect(detectDelimiter('a;b\n1;"never closed')).toBe(';');
  });
});

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

describe('parseImportDate', () => {
  const valid: [ImportDateFormat, string, string][] = [
    ['YYYY-MM-DD', '2026-03-05', '2026-03-05'],
    ['YYYY-MM-DD', '2026-3-5', '2026-03-05'],
    ['YYYY/MM/DD', '2026/03/05', '2026-03-05'],
    ['YYYY/MM/DD', '2026/3/5', '2026-03-05'],
    ['YYYYMMDD', '20260305', '2026-03-05'],
    ['DD/MM/YYYY', '05/03/2026', '2026-03-05'],
    ['DD/MM/YYYY', '5/3/2026', '2026-03-05'],
    ['DD/MM/YYYY', '31/12/2026', '2026-12-31'],
    ['MM/DD/YYYY', '03/05/2026', '2026-03-05'],
    ['MM/DD/YYYY', '3/5/2026', '2026-03-05'],
    ['MM/DD/YYYY', '12/31/2026', '2026-12-31'],
    ['DD.MM.YYYY', '05.03.2026', '2026-03-05'],
    ['DD.MM.YYYY', '5.3.2026', '2026-03-05'],
    ['DD-MM-YYYY', '05-03-2026', '2026-03-05'],
    ['DD-MM-YYYY', '5-3-2026', '2026-03-05'],
    ['MM-DD-YYYY', '03-05-2026', '2026-03-05'],
    ['MM-DD-YYYY', '3-5-2026', '2026-03-05'],
  ];
  it.each(valid)('%s reads %j as %s', (format, text, iso) => {
    expect(parseImportDate(text, format)).toBe(iso);
  });

  it('reads day and month in the order of the format name', () => {
    expect(parseImportDate('05/03/2026', 'DD/MM/YYYY')).toBe('2026-03-05');
    expect(parseImportDate('05/03/2026', 'MM/DD/YYYY')).toBe('2026-05-03');
    expect(parseImportDate('05-03-2026', 'DD-MM-YYYY')).toBe('2026-03-05');
    expect(parseImportDate('05-03-2026', 'MM-DD-YYYY')).toBe('2026-05-03');
  });

  it('trims the cell', () => {
    expect(parseImportDate('  2026-03-05\t', 'YYYY-MM-DD')).toBe('2026-03-05');
    expect(parseImportDate(' 5/3/2026 ', 'DD/MM/YYYY')).toBe('2026-03-05');
  });

  it('ignores a time of day after the date, and does not convert a time zone', () => {
    for (const suffix of [
      ' 14:22',
      ' 14:22:10',
      'T14:22:10',
      'T14:22:10Z',
      'T23:59:59.123Z',
      ' 9:05',
      'T14:22:10+02:00',
      'T14:22:10+0200',
      'T14:22:10-05',
      ' 14:22:10 +02:00',
    ]) {
      expect(parseImportDate(`2026-03-05${suffix}`, 'YYYY-MM-DD')).toBe('2026-03-05');
    }
    expect(parseImportDate('05/03/2026 23:30', 'DD/MM/YYYY')).toBe('2026-03-05');
    expect(parseImportDate('20260305T000000', 'YYYYMMDD')).toBeNull(); // compact times are not read
  });

  it.each([
    ['a two-digit year', '5/3/26', 'DD/MM/YYYY'],
    ['a two-digit year with dots', '05.03.26', 'DD.MM.YYYY'],
    ['a three-digit year', '05/03/202', 'DD/MM/YYYY'],
    ['a five-digit year', '05/03/20266', 'DD/MM/YYYY'],
    ['a two-digit year in an ISO date', '26-03-05', 'YYYY-MM-DD'],
    ['year 0000', '0000-01-01', 'YYYY-MM-DD'],
    ['month 13', '2026-13-01', 'YYYY-MM-DD'],
    ['month 0', '2026-00-10', 'YYYY-MM-DD'],
    ['day 0', '2026-03-00', 'YYYY-MM-DD'],
    ['day 32', '2026-03-32', 'YYYY-MM-DD'],
    ['31 April', '31/04/2026', 'DD/MM/YYYY'],
    ['29 February in a common year', '29/02/2026', 'DD/MM/YYYY'],
    ['29 February 1900 (not a leap year)', '29/02/1900', 'DD/MM/YYYY'],
    ['day and month swapped into nonsense (13th month)', '03/13/2026', 'DD/MM/YYYY'],
    ['a date in another format', '2026-03-05', 'DD-MM-YYYY'],
    ['another separator', '2026.03.05', 'YYYY-MM-DD'],
    ['no separators for a separated format', '20260305', 'YYYY-MM-DD'],
    ['separators for the compact format', '2026-03-05', 'YYYYMMDD'],
    ['a one-digit month in the compact format', '2026035', 'YYYYMMDD'],
    ['nine digits in the compact format', '202603051', 'YYYYMMDD'],
    ['an impossible compact date', '20261340', 'YYYYMMDD'],
    ['month names', '5 Mar 2026', 'DD/MM/YYYY'],
    ['an empty cell', '', 'YYYY-MM-DD'],
    ['a blank cell', '   ', 'YYYY-MM-DD'],
    ['text after the date that is not a time', '2026-03-05 booked', 'YYYY-MM-DD'],
    ['a dangling T', '2026-03-05T', 'YYYY-MM-DD'],
    ['a time with no date', '14:22', 'YYYY-MM-DD'],
    ['a signed number', '-2026-03-05', 'YYYY-MM-DD'],
    ['a number with a decimal point', '5.3.2026.1', 'DD.MM.YYYY'],
  ])('rejects %s (%j as %s)', (_name, text, format) => {
    expect(parseImportDate(text, format as ImportDateFormat)).toBeNull();
  });

  it('accepts 29 February in a leap year, including 2000 and not 1900 or 2100', () => {
    expect(parseImportDate('29/02/2028', 'DD/MM/YYYY')).toBe('2028-02-29');
    expect(parseImportDate('29/02/2000', 'DD/MM/YYYY')).toBe('2000-02-29');
    expect(parseImportDate('29/02/2100', 'DD/MM/YYYY')).toBeNull();
  });

  it('has a reader for every format of the closed set', () => {
    for (const format of IMPORT_DATE_FORMATS) {
      expect(() => parseImportDate('', format)).not.toThrow();
    }
    expect(IMPORT_DATE_FORMATS).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------------------------

describe('parseImportAmount', () => {
  const dot = (text: string) => parseImportAmount(text, '.');
  const comma = (text: string) => parseImportAmount(text, ',');
  const ok = (cents: number) => ({ ok: true, cents });
  const invalid = { ok: false, reason: 'invalid_amount' };
  const tooLarge = { ok: false, reason: 'amount_too_large' };

  it.each([
    ['12.30', 1230],
    ['12', 1200],
    ['12.5', 1250],
    ['0.5', 50],
    ['0.05', 5],
    ['0.01', 1],
    ['-12.30', -1230],
    ['+12.30', 1230],
    ['+5', 500],
    ['007.50', 750],
    ['1234567.89', 123456789],
    ['1,234.56', 123456],
    ['1,234,567.89', 123456789],
    ['1 234.56', 123456],
    ['1 234 567', 123456700],
    ["1'234.56", 123456],
    ['1’234.56', 123456],
    ['1 234.56', 123456],
    ['1 234.56', 123456],
    ['1 234.56', 123456],
    ['999,999.99', 99999999],
    ['−12.30', -1230],
    ['  -12.30  ', -1230],
    ['12.300', 1230],
    ['12.3000', 1230],
    ['12.00', 1200],
    ['10000000000.00', MAX_CENTS],
    ['-10000000000.00', -MAX_CENTS],
    ['000000000012.00', 1200],
  ])('with "." reads %j as %i cents', (text, cents) => {
    expect(dot(text)).toEqual(ok(cents));
  });

  it.each([
    ['12,30', 1230],
    ['12', 1200],
    ['1,5', 150],
    ['-0,05', -5],
    ['1.234,56', 123456],
    ['1.234.567,89', 123456789],
    ['1 234,56', 123456],
    ["1'234,56", 123456],
    ['1 234 567', 123456700],
    ['1.234', 123400],
    ['12,300', 1230],
    ['−1.234,50', -123450],
  ])('with "," reads %j as %i cents', (text, cents) => {
    expect(comma(text)).toEqual(ok(cents));
  });

  it('lets the chosen decimal separator decide an ambiguous cell', () => {
    expect(dot('1.234')).toEqual(invalid); // three decimals that are not zeros
    expect(comma('1.234')).toEqual(ok(123400)); // a thousands separator
    expect(dot('1,234')).toEqual(ok(123400));
    expect(comma('1,234')).toEqual(invalid);
    expect(dot('1.000')).toEqual(ok(100)); // 1.000 is one, with trailing zeros
    expect(comma('1.000')).toEqual(ok(100000));
  });

  it('reads zero as 0, never -0', () => {
    for (const text of ['0', '0.00', '-0', '-0.00', '+0']) {
      const result = dot(text);
      expect(result).toEqual(ok(0));
      expect(Object.is((result as { cents: number }).cents, -0)).toBe(false);
    }
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['-'],
    ['+'],
    ['.'],
    ['.5'],
    ['-.5'],
    ['12.'],
    ['12.3.4'],
    ['12,30'], // a comma that is no thousands separator here: "30" is not three digits
    ['1,23'],
    ['1,2345'],
    ['12,345,6'],
    ['1,234.5.6'],
    ['1.234,56'], // a comma after the decimal point
    ['12.345'],
    ['12.301'],
    ['12.3001'],
    ['€12.30'],
    ['12.30 EUR'],
    ['EUR 12.30'],
    ['$5'],
    ['(12.30)'],
    ['12.30-'],
    ['- 12.30'],
    ['+ 12.30'],
    ['--5'],
    ['+-5'],
    ['1 2 3'],
    ['12 34'],
    ['1 23'],
    ['1,234 567'], // two different group characters
    ["1 234'567"],
    ['1e3'],
    ['0x10'],
    ['NaN'],
    ['Infinity'],
    ['١٢'], // Arabic-Indic digits are not digits here
    ['1_000'],
    ['12.3 0'],
    ['12 .30'],
    ['1,,234'],
    [',234'],
    ['1,234,'],
  ])('with "." rejects %j as invalid', (text) => {
    expect(dot(text)).toEqual(invalid);
  });

  it.each([['12.30'], ['1,234.56'], ['12,'], [',5'], ['1.234,56,7'], ['1 234.5,6']])(
    'with "," rejects %j as invalid',
    (text) => {
      expect(comma(text)).toEqual(invalid);
    },
  );

  it('flags what is above MAX_CENTS as too large, not invalid', () => {
    expect(dot('10000000000.01')).toEqual(tooLarge);
    expect(dot('-10000000000.01')).toEqual(tooLarge);
    expect(dot('99999999999')).toEqual(tooLarge);
    expect(dot('123456789012.5')).toEqual(tooLarge); // 12 digits of whole units
    expect(dot('99999999999999999999999999')).toEqual(tooLarge);
    expect(dot(`${'9'.repeat(5000)}.00`)).toEqual(tooLarge);
    expect(comma('10.000.000.000,01')).toEqual(tooLarge);
    expect(dot('9007199254740993')).toEqual(tooLarge);
  });

  it('judges syntax before size', () => {
    expect(dot('99999999999999999999 EUR')).toEqual(invalid);
  });
});

// ---------------------------------------------------------------------------------------------
// Descriptions and the hash
// ---------------------------------------------------------------------------------------------

describe('cleanImportText', () => {
  it.each([
    ['  Coffee   Shop  ', 'Coffee Shop'],
    ['a\tb\nc\r\nd', 'a b c d'],
    ['a  b', 'a b'],
    ['﻿a', 'a'],
    ['', ''],
    ['   ', ''],
    ['already clean', 'already clean'],
  ])('%j becomes %j', (text, cleaned) => {
    expect(cleanImportText(text)).toBe(cleaned);
  });
});

describe('limitImportDescription', () => {
  it('keeps up to 200 characters as they are', () => {
    const text = 'x'.repeat(200);
    expect(limitImportDescription(text)).toBe(text);
    expect(limitImportDescription('short')).toBe('short');
  });

  it('cuts at 200 characters and trims the new end', () => {
    expect(limitImportDescription('x'.repeat(250))).toBe('x'.repeat(200));
    expect(limitImportDescription(`${'x'.repeat(199)} y`)).toBe('x'.repeat(199));
  });

  it('never cuts inside a surrogate pair', () => {
    const text = `${'a'.repeat(199)}😀b`; // the emoji is two code units, at 199 and 200
    expect(text.length).toBe(202);
    expect(limitImportDescription(text)).toBe('a'.repeat(199));
    const fits = `${'a'.repeat(198)}😀b`; // the emoji ends exactly at 200
    expect(limitImportDescription(fits)).toBe(`${'a'.repeat(198)}😀`);
  });
});

describe('importHashPreimage', () => {
  it('is the version, date, amount, description and occurrence, one per line', () => {
    expect(importHashPreimage('2026-03-05', 1230, 'coffee shop', 0)).toBe(
      'wallet-import-v1\n2026-03-05\n1230\ncoffee shop\n0',
    );
    expect(importHashPreimage('2026-03-05', -500, 'refund', 2)).toBe(
      'wallet-import-v1\n2026-03-05\n-500\nrefund\n2',
    );
  });

  it('tells apart inputs that would run together without separators', () => {
    expect(importHashPreimage('2026-03-05', 12, '30x', 0)).not.toBe(
      importHashPreimage('2026-03-05', 123, '0x', 0),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The importer's parser
// ---------------------------------------------------------------------------------------------

const bank: ImportMapping = {
  delimiter: ';',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 1,
  descriptionColumn: 2,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  signConvention: 'expenses_negative',
};
const lower = (text: string): string => text.toLowerCase();
const rowsOf = (csv: string, mapping: Partial<ImportMapping> = {}) =>
  readImportRows(csv, { ...bank, ...mapping }, lower);

describe('readImportRows', () => {
  const file = [
    'Date;Amount;Description',
    '05/03/2026;-12,30;Coffee Shop',
    '06/03/2026;+1.500,00;SALARY   ACME',
    '07/03/2026;0,00;Nothing',
    '31/02/2026;-5,00;Bad date',
    '08/03/2026;abc;Bad amount',
    '09/03/2026;-5,00;',
    '10/03/2026;-99999999999,00;Huge',
    '',
  ].join('\r\n');

  it('reads every data row, with its line, in file order', () => {
    expect(rowsOf(file).map((row) => row.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('turns an expense of the bank into a positive spending, with the sign convention', () => {
    const [coffee] = rowsOf(file);
    expect(coffee).toMatchObject({
      line: 2,
      raw: { date: '05/03/2026', amount: '-12,30' },
      date: '2026-03-05',
      amount: 1230,
      description: 'Coffee Shop',
      normalizedDescription: 'coffee shop',
      credit: false,
      errors: [],
      hashPreimage: 'wallet-import-v1\n2026-03-05\n1230\ncoffee shop\n0',
    });
  });

  it('marks a row on the other side of the convention as a credit, without an error', () => {
    const salary = rowsOf(file)[1];
    expect(salary).toMatchObject({
      date: '2026-03-06',
      amount: -150000,
      description: 'SALARY ACME',
      normalizedDescription: 'salary acme',
      credit: true,
      errors: [],
    });
    expect(salary?.hashPreimage).not.toBeNull();
  });

  it('flags the rows whose text is wrong, with the codes of the contract', () => {
    const rows = rowsOf(file);
    expect(rows.map((row) => row.errors)).toEqual([
      [],
      [],
      ['zero_amount'],
      ['invalid_date'],
      ['invalid_amount'],
      ['empty_description'],
      ['amount_too_large'],
    ]);
  });

  it('gives a zero amount 0 and an unreadable or oversized amount null, and neither is a credit', () => {
    const rows = rowsOf(file);
    expect(rows[2]).toMatchObject({ amount: 0, credit: false });
    expect(Object.is(rows[2]?.amount, -0)).toBe(false);
    expect(rows[4]).toMatchObject({ amount: null, credit: false });
    expect(rows[6]).toMatchObject({ amount: null, credit: false });
    expect(rows[3]).toMatchObject({ date: null, amount: 500, credit: false });
  });

  it('gives a row with no valid date, amount or description no hash', () => {
    const rows = rowsOf(file);
    expect(rows.slice(2).map((row) => row.hashPreimage)).toEqual([null, null, null, null, null]);
  });

  it('lists every code that applies, in the order of the contract', () => {
    expect(rowsOf('h\n;;')).toEqual([]); // a record of blank cells is skipped
    expect(rowsOf('h\nx;y;')[0]?.errors).toEqual([
      'invalid_date',
      'invalid_amount',
      'empty_description',
    ]);
    expect(rowsOf('h\nx;0;')[0]?.errors).toEqual([
      'invalid_date',
      'zero_amount',
      'empty_description',
    ]);
    expect(rowsOf('h\n05/03/2026;1e9;ok')[0]?.errors).toEqual(['invalid_amount']);
  });

  describe('records that are not data rows', () => {
    it('skips blank lines and records of blank cells, and keeps the line numbers true', () => {
      const text = [
        'Date;Amount;Description',
        '',
        '05/03/2026;-1,00;A',
        ';;',
        ' ; ; ',
        '06/03/2026;-2,00;B',
        '',
      ].join('\n');
      expect(rowsOf(text).map((row) => [row.line, row.description])).toEqual([
        [3, 'A'],
        [6, 'B'],
      ]);
    });

    it('takes the first non-blank record as the header, not the first line', () => {
      const text = '\n\nDate;Amount;Description\n05/03/2026;-1,00;A';
      expect(rowsOf(text).map((row) => row.line)).toEqual([4]);
    });

    it('reads the first record as data when there is no header', () => {
      const text = '05/03/2026;-1,00;A\n06/03/2026;-2,00;B';
      expect(rowsOf(text, { hasHeader: false }).map((row) => row.line)).toEqual([1, 2]);
      expect(rowsOf(text)).toHaveLength(1); // with a header the first one is skipped
    });

    it('returns no row for an empty file or a header only', () => {
      expect(rowsOf('')).toEqual([]);
      expect(rowsOf('Date;Amount;Description')).toEqual([]);
      expect(rowsOf('Date;Amount;Description\r\n')).toEqual([]);
      expect(rowsOf('﻿')).toEqual([]);
    });
  });

  describe('line numbers', () => {
    it('are the line a record starts on, also after a quoted field with line breaks', () => {
      const text =
        'Date;Amount;Description\r\n05/03/2026;-1,00;"multi\nline"\r\n\r\n06/03/2026;-2,00;next\r\n';
      const rows = rowsOf(text);
      expect(rows.map((row) => row.line)).toEqual([2, 5]);
      expect(rows[0]?.description).toBe('multi line');
    });

    it('count CR line ends too', () => {
      const text = 'h\r05/03/2026;-1,00;A\r06/03/2026;-2,00;B';
      expect(rowsOf(text).map((row) => row.line)).toEqual([2, 3]);
    });

    it('ignore the BOM', () => {
      expect(rowsOf('﻿h\n05/03/2026;-1,00;A').map((row) => row.line)).toEqual([2]);
    });
  });

  describe('cells', () => {
    it('reads a cell that the record does not have as empty', () => {
      const rows = rowsOf('h\n05/03/2026;-1,00\n05/03/2026');
      expect(rows[0]?.errors).toEqual(['empty_description']);
      expect(rows[1]?.errors).toEqual(['invalid_amount', 'empty_description']);
      expect(rows[1]?.raw).toEqual({ date: '05/03/2026', amount: '' });
    });

    it('reads the columns the mapping names, in any order', () => {
      const rows = rowsOf('h\nCoffee;05/03/2026;-1,00', {
        dateColumn: 1,
        amountColumn: 2,
        descriptionColumn: 0,
      });
      expect(rows[0]).toMatchObject({ date: '2026-03-05', amount: 100, description: 'Coffee' });
    });

    it('flags every row when the mapping points past the columns of the file', () => {
      const rows = rowsOf('h\n05/03/2026;-1,00;A', { dateColumn: 9 });
      expect(rows[0]?.errors).toEqual(['invalid_date']);
    });

    it('uses the delimiter of the mapping', () => {
      const rows = rowsOf('h\n05/03/2026,-1.00,A', { delimiter: ',', decimalSeparator: '.' });
      expect(rows[0]).toMatchObject({ amount: 100, description: 'A', errors: [] });
    });

    it('cleans a description and cuts it at 200 characters, hashing the full one', () => {
      const long = `${'word '.repeat(60)}end`; // 303 characters
      const row = rowsOf(`h\n05/03/2026;-1,00;"  ${long}  "`)[0];
      expect(row?.description).toBe(long.slice(0, 200).trimEnd());
      expect(row?.description.length).toBeLessThanOrEqual(200);
      expect(row?.normalizedDescription).toBe(long);
      expect(row?.hashPreimage).toContain(`\n${long}\n`);
    });

    it('passes the cleaned description to normalize', () => {
      const seen: string[] = [];
      readImportRows('h\n05/03/2026;-1,00;"  A   B "', bank, (text) => {
        seen.push(text);
        return text;
      });
      expect(seen).toEqual(['A B']);
    });

    it('trims the raw cells it reports', () => {
      expect(rowsOf('h\n 05/03/2026 ; -1,00 ;A')[0]?.raw).toEqual({
        date: '05/03/2026',
        amount: '-1,00',
      });
    });
  });

  describe('sign convention', () => {
    const text = 'h\n05/03/2026;-12,30;Out\n06/03/2026;12,30;In';

    it('expenses_negative: a negative bank amount is an expense, a positive one a credit', () => {
      const rows = rowsOf(text);
      expect(rows.map((row) => [row.amount, row.credit])).toEqual([
        [1230, false],
        [-1230, true],
      ]);
    });

    it('expenses_positive keeps the sign: a negative bank amount is a credit', () => {
      const rows = rowsOf(text, { signConvention: 'expenses_positive' });
      expect(rows.map((row) => [row.amount, row.credit])).toEqual([
        [-1230, true],
        [1230, false],
      ]);
    });
  });

  describe('the occurrence index', () => {
    it('numbers identical rows 0, 1, 2 in file order, so two real coffees both import', () => {
      const text = [
        'h',
        '05/03/2026;-3,00;Coffee',
        '05/03/2026;-3,00;Coffee',
        '05/03/2026;-3,00;Coffee',
        '06/03/2026;-3,00;Coffee',
      ].join('\n');
      const rows = rowsOf(text);
      expect(rows.map((row) => row.hashPreimage?.split('\n').at(-1))).toEqual(['0', '1', '2', '0']);
      expect(new Set(rows.map((row) => row.hashPreimage)).size).toBe(4);
    });

    it('treats rows as identical by date, amount and the NORMALIZED description', () => {
      const text =
        'h\n05/03/2026;-3,00;Coffee\n05/03/2026;-3,00;  COFFEE \n05/03/2026;-3,01;Coffee';
      const rows = rowsOf(text);
      expect(rows.map((row) => row.hashPreimage?.split('\n').at(-1))).toEqual(['0', '1', '0']);
    });

    it('is the same whatever the date format, so the same rows give the same hashes', () => {
      const dotted = rowsOf('h\n05.03.2026;-3,00;Coffee', { dateFormat: 'DD.MM.YYYY' });
      const slashed = rowsOf('h\n05/03/2026;-3,00;Coffee');
      expect(dotted[0]?.hashPreimage).toBe(slashed[0]?.hashPreimage);
    });

    it('does not depend on the sign convention only through the amount it gives', () => {
      const negative = rowsOf('h\n05/03/2026;-3,00;Coffee');
      const positive = rowsOf('h\n05/03/2026;3,00;Coffee', { signConvention: 'expenses_positive' });
      expect(negative[0]?.hashPreimage).toBe(positive[0]?.hashPreimage);
    });

    it('counts a credit and a row with another error that still has a hash', () => {
      const text = 'h\n05/03/2026;3,00;Refund\n05/03/2026;3,00;Refund';
      const rows = rowsOf(text);
      expect(rows.map((row) => [row.credit, row.hashPreimage?.split('\n').at(-1)])).toEqual([
        [true, '0'],
        [true, '1'],
      ]);
    });

    it('does not count rows without a hash', () => {
      const text = 'h\n05/03/2026;0,00;Zero\n05/03/2026;-3,00;Coffee\n31/02/2026;-3,00;Coffee';
      const rows = rowsOf(text);
      expect(rows[1]?.hashPreimage?.endsWith('\n0')).toBe(true);
      expect(rows[2]?.hashPreimage).toBeNull();
    });

    it('counts over the whole file, so a line has one hash whatever is selected later', () => {
      const text = 'h\n05/03/2026;-3,00;Coffee\n05/03/2026;-3,00;Coffee';
      expect(rowsOf(text)[1]?.hashPreimage?.endsWith('\n1')).toBe(true);
    });
  });

  it('is deterministic', () => {
    expect(rowsOf(file)).toEqual(rowsOf(file));
  });

  it('throws a CsvSyntaxError for a quoted field that is never closed', () => {
    expect(() => rowsOf('h\n05/03/2026;-1,00;"open')).toThrow(CsvSyntaxError);
  });
});
