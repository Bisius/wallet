/**
 * Property-based tests (fast-check) of the CSV helpers: the cents <-> decimal text round trip and
 * the injection guard of the export, and the reader of the import. Fixed seed, so CI is stable; a
 * deeper sweep is `FC_RUNS_FACTOR=20 npx vitest run src/csv.property.test.ts` (another seed:
 * `FC_SEED=123`). A failure prints the seed, the path and the shrunk counterexample.
 *
 * The references are exact BigInt arithmetic, the mathematical definition, or a second, simpler
 * way of counting, never the code under test.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  detectDelimiter,
  encodeCsv,
  formatCentsPlain,
  guardCsvText,
  parseCsv,
  parseImportAmount,
  parseImportDate,
  readImportRows,
} from './csv';
import type { ImportMapping } from './import';
import {
  CSV_DELIMITERS,
  IMPORT_DATE_FORMATS,
  MAX_CENTS,
  type CsvDelimiter,
  type ImportDateFormat,
} from './limits';
import { parseCents } from './money';
import { daysInMonth, toMonthKey } from './month';

// `process` is not typed in this package (no @types/node), hence the cast.
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env['FC_SEED'] ?? 20261003);
const FACTOR = Number(env['FC_RUNS_FACTOR'] ?? 1);
/** Per-test timeout (ms), generous because a loaded machine runs several packages at once. */
const SLOW = { timeout: 60_000 };
const params = (runs: number) => ({ seed: SEED, numRuns: Math.max(1, Math.round(runs * FACTOR)) });

const MAX = Number.MAX_SAFE_INTEGER;

/** Any safe integer: money-sized, anywhere in the safe range, and the awkward edges. */
const anySafeInteger: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }) },
  { weight: 2, arbitrary: fc.integer({ min: -MAX, max: MAX }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, -1, 99, 100, 101, MAX, -MAX, MAX - 1, 2 ** 52) },
);

/** An amount an import accepts: any cents with |value| <= MAX_CENTS. */
const importableCents = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000, max: 1_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, -1, MAX_CENTS, -MAX_CENTS) },
);

/** The reference formatter: BigInt, no float anywhere. */
function referenceFormat(cents: number): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${value < 0n ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

describe('formatCentsPlain', () => {
  it('equals the BigInt reference, for any safe integer', SLOW, () => {
    fc.assert(
      fc.property(anySafeInteger, (cents) => {
        expect(formatCentsPlain(cents)).toBe(referenceFormat(cents));
      }),
      params(500),
    );
  });

  it('is -?digits.dd, and never a negative zero', SLOW, () => {
    fc.assert(
      fc.property(anySafeInteger, (cents) => {
        const text = formatCentsPlain(cents);
        expect(text).toMatch(/^-?\d+\.\d{2}$/);
        expect(text).not.toBe('-0.00');
        expect(text.startsWith('-')).toBe(cents < 0);
      }),
      params(300),
    );
  });

  it('round-trips through parseCents for every safe integer', SLOW, () => {
    fc.assert(
      fc.property(anySafeInteger, (cents) => {
        expect(parseCents(formatCentsPlain(cents))).toBe(cents);
      }),
      params(500),
    );
  });

  it(
    'round-trips through parseImportAmount, with a "." and, after swapping it, a ","',
    SLOW,
    () => {
      fc.assert(
        fc.property(importableCents, (cents) => {
          const text = formatCentsPlain(cents);
          expect(parseImportAmount(text, '.')).toEqual({ ok: true, cents });
          expect(parseImportAmount(text.replace('.', ','), ',')).toEqual({ ok: true, cents });
        }),
        params(500),
      );
    },
  );

  it('is order preserving: a larger amount never writes a smaller number', SLOW, () => {
    fc.assert(
      fc.property(anySafeInteger, anySafeInteger, (a, b) => {
        const text = (cents: number): bigint => BigInt(formatCentsPlain(cents).replace('.', ''));
        expect(a < b).toBe(text(a) < text(b));
      }),
      params(300),
    );
  });
});

describe('parseImportAmount', () => {
  /** Writes cents the way a bank might: a grouping character, a decimal separator, a sign. */
  const bankText = fc
    .record({
      cents: importableCents,
      decimal: fc.constantFrom('.', ','),
      group: fc.constantFrom('', ' ', "'", ' ', 'other'),
      plus: fc.boolean(),
      extraZeros: fc.integer({ min: 0, max: 3 }),
    })
    .map(({ cents, decimal, group, plus, extraZeros }) => {
      const absolute = Math.abs(cents);
      const whole = String(Math.floor(absolute / 100));
      const fraction = String(absolute % 100).padStart(2, '0') + '0'.repeat(extraZeros);
      const separator = group === 'other' ? (decimal === '.' ? ',' : '.') : group;
      let grouped = whole;
      if (separator !== '') {
        grouped = '';
        for (let end = whole.length; end > 0; end -= 3) {
          grouped = whole.slice(Math.max(0, end - 3), end) + (grouped ? separator + grouped : '');
        }
      }
      const sign = cents < 0 ? '-' : plus ? '+' : '';
      return { text: `${sign}${grouped}${decimal}${fraction}`, decimal, cents };
    });

  it('reads any such spelling back to the same cents', SLOW, () => {
    fc.assert(
      fc.property(bankText, ({ text, decimal, cents }) => {
        expect(parseImportAmount(text, decimal as '.' | ',')).toEqual({ ok: true, cents });
      }),
      params(600),
    );
  });

  it('never accepts a third non-zero decimal (no rounding), whatever the digits', SLOW, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 9 }),
        (whole, cents, extra) => {
          const text = `${whole}.${String(cents).padStart(2, '0')}${extra}`;
          expect(parseImportAmount(text, '.')).toEqual({ ok: false, reason: 'invalid_amount' });
        },
      ),
      params(200),
    );
  });

  it(
    'returns a safe integer with |value| <= MAX_CENTS, or a refusal, for any digit string',
    SLOW,
    () => {
      fc.assert(
        fc.property(
          fc.string({ unit: fc.constantFrom(..."0123456789.,- +'e€".split('')), maxLength: 30 }),
          fc.constantFrom('.', ','),
          (text, decimal) => {
            const result = parseImportAmount(text, decimal as '.' | ',');
            if (result.ok) {
              expect(Number.isSafeInteger(result.cents)).toBe(true);
              expect(Math.abs(result.cents)).toBeLessThanOrEqual(MAX_CENTS);
              expect(Object.is(result.cents, -0)).toBe(false);
            }
          },
        ),
        params(500),
      );
    },
  );
});

describe('guardCsvText', () => {
  const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];
  const piece = fc.tuple(fc.constantFrom(...TRIGGERS, "'", ' ', '\n', 'a', ''), fc.string({ maxLength: 4 }));
  const text = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc
      .tuple(
        fc.constantFrom('=', '+', '-', '@', '\t', '\r', "'", ' ', '\n', 'a'),
        fc.string({ maxLength: 8 }),
      )
      .map(([first, rest]) => first + rest),
    // Several pieces joined by ";", each starting with a trigger or not: the cells a spreadsheet
    // with ";" as its list separator makes of the text.
    fc.array(piece, { maxLength: 5 }).map((pieces) => pieces.map(([a, b]) => a + b).join(';')),
  );

  it('never lets a trigger character start a cell, whether split on nothing or on ";"', SLOW, () => {
    fc.assert(
      fc.property(text, (value) => {
        const guarded = guardCsvText(value);
        for (const cell of guarded.split(';')) expect(TRIGGERS).not.toContain(cell[0]);
      }),
      params(500),
    );
  });

  it('only inserts apostrophes', SLOW, () => {
    fc.assert(
      fc.property(text, (value) => {
        const guarded = guardCsvText(value);
        expect(guarded.length).toBeGreaterThanOrEqual(value.length);
        expect(guarded.replaceAll("'", '')).toBe(value.replaceAll("'", ''));
      }),
      params(500),
    );
  });

  it('is idempotent', SLOW, () => {
    fc.assert(
      fc.property(text, (value) => {
        expect(guardCsvText(guardCsvText(value))).toBe(guardCsvText(value));
      }),
      params(300),
    );
  });

  it('changes exactly the texts with a trigger at the start or after a ";"', SLOW, () => {
    fc.assert(
      fc.property(text, (value) => {
        const triggers = value.split(';').some((cell) => TRIGGERS.includes(cell[0] as string));
        expect(guardCsvText(value) !== value).toBe(triggers);
      }),
      params(300),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Writing and reading a file
// ---------------------------------------------------------------------------------------------

/** Cells dense in what CSV makes hard: quotes, every delimiter, every line end, BOM, non-ASCII. */
const nastyCell = fc
  .array(
    fc.constantFrom('a', 'b', ' ', '"', ',', ';', '\t', '|', '\r', '\n', 'é', '😀', '=', '-', '﻿'),
    { maxLength: 8 },
  )
  .map((chars) => chars.join(''));

const table = fc.array(fc.array(nastyCell, { minLength: 1, maxLength: 5 }), { maxLength: 8 });
const delimiter = fc.constantFrom<CsvDelimiter>(...CSV_DELIMITERS);

/** How many line breaks a text holds, CRLF counting once: a regex, not the reader's own loop. */
const lineBreaks = (text: string): number => (text.match(/\r\n|\r|\n/g) ?? []).length;

describe('encodeCsv and parseCsv', () => {
  it('read back the same cells, for every delimiter', SLOW, () => {
    fc.assert(
      fc.property(table, delimiter, (rows, d) => {
        const text = encodeCsv(rows, { delimiter: d });
        expect(text.startsWith(CSV_BOM)).toBe(true);
        expect(parseCsv(text, d).map((record) => record.cells)).toEqual(rows);
      }),
      params(500),
    );
  });

  it('put every record on the line where an editor would show it', SLOW, () => {
    fc.assert(
      fc.property(table, delimiter, (rows, d) => {
        const records = parseCsv(encodeCsv(rows, { delimiter: d }), d);
        let line = 1;
        rows.forEach((row, index) => {
          expect(records[index]?.line).toBe(line);
          // The record's own line end, plus the breaks inside its cells.
          line += 1 + row.reduce((total, cell) => total + lineBreaks(cell), 0);
        });
      }),
      params(300),
    );
  });

  it('end every record with CRLF outside the quoted cells', SLOW, () => {
    fc.assert(
      fc.property(table, (rows) => {
        const text = encodeCsv(rows);
        // Remove the quoted cells (a quote, anything but a lone quote, a quote), then the CRLFs: no
        // line end of any other kind may be left over.
        const outside = text.replace(/"(?:[^"]|"")*"/g, '').replace(/\r\n/g, '');
        expect(outside.includes('\n') || outside.includes('\r')).toBe(false);
        expect(rows.length === 0 || text.endsWith('\r\n')).toBe(true);
      }),
      params(300),
    );
  });
});

describe('detectDelimiter', () => {
  /** A rectangular table of 2 to 5 columns whose cells hold no delimiter but the one it is written with. */
  const tableOf = delimiter.chain((d) => {
    const alphabet = [...'abc XYZ09.-"\r\n', d];
    const cell = fc
      .array(fc.constantFrom(...alphabet), { maxLength: 5 })
      .map((chars) => chars.join(''));
    return (
      fc
        .tuple(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 1, max: 30 }))
        .chain(([width, height]) =>
          fc.array(fc.array(cell, { minLength: width, maxLength: width }), {
            minLength: height,
            maxLength: height,
          }),
        )
        // A table of blank cells has no record to look at (blank records are skipped).
        .filter((rows) => rows.some((row) => row.some((cell) => cell.trim() !== '')))
        .map((rows) => ({ d, rows }))
    );
  });

  it('finds the delimiter of a rectangular table that holds no other one', SLOW, () => {
    fc.assert(
      fc.property(tableOf, ({ d, rows }) => {
        expect(detectDelimiter(encodeCsv(rows, { delimiter: d, bom: false }))).toBe(d);
      }),
      params(300),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

describe('parseImportDate', () => {
  const realDate = fc
    .record({
      year: fc.integer({ min: 1, max: 9999 }),
      month: fc.integer({ min: 1, max: 12 }),
      pick: fc.integer({ min: 0, max: 30 }),
    })
    .map(({ year, month, pick }) => ({
      year,
      month,
      day: 1 + (pick % daysInMonth(toMonthKey(year, month))),
    }));
  const two = (n: number): string => String(n).padStart(2, '0');
  const four = (n: number): string => String(n).padStart(4, '0');

  /** Writes a date in a format, optionally without the leading zeros of day and month. */
  const write = (
    { year, month, day }: { year: number; month: number; day: number },
    format: ImportDateFormat,
    short: boolean,
  ): string => {
    const m = short ? String(month) : two(month);
    const d = short ? String(day) : two(day);
    switch (format) {
      case 'YYYY-MM-DD':
        return `${four(year)}-${m}-${d}`;
      case 'YYYY/MM/DD':
        return `${four(year)}/${m}/${d}`;
      case 'YYYYMMDD':
        return `${four(year)}${two(month)}${two(day)}`;
      case 'DD/MM/YYYY':
        return `${d}/${m}/${four(year)}`;
      case 'MM/DD/YYYY':
        return `${m}/${d}/${four(year)}`;
      case 'DD.MM.YYYY':
        return `${d}.${m}.${four(year)}`;
      case 'DD-MM-YYYY':
        return `${d}-${m}-${four(year)}`;
      case 'MM-DD-YYYY':
        return `${m}-${d}-${four(year)}`;
    }
  };

  it('reads back any real date written in any of the formats', SLOW, () => {
    fc.assert(
      fc.property(
        realDate,
        fc.constantFrom(...IMPORT_DATE_FORMATS),
        fc.boolean(),
        (date, format, short) => {
          const text = write(date, format, short && format !== 'YYYYMMDD');
          expect(parseImportDate(text, format)).toBe(
            `${four(date.year)}-${two(date.month)}-${two(date.day)}`,
          );
        },
      ),
      params(600),
    );
  });

  it('refuses a day beyond the end of its month, in every format', SLOW, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom(...IMPORT_DATE_FORMATS),
        (year, month, beyond, format) => {
          const day = daysInMonth(toMonthKey(year, month)) + beyond;
          if (day > 99) return;
          expect(parseImportDate(write({ year, month, day }, format, false), format)).toBeNull();
        },
      ),
      params(300),
    );
  });

  it('refuses a two-digit year in every format', SLOW, () => {
    fc.assert(
      fc.property(realDate, fc.constantFrom(...IMPORT_DATE_FORMATS), (date, format) => {
        if (format === 'YYYYMMDD') return;
        const text = write(date, format, false).replace(four(date.year), two(date.year % 100));
        expect(parseImportDate(text, format)).toBeNull();
      }),
      params(300),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The importer's parser
// ---------------------------------------------------------------------------------------------

describe('readImportRows', () => {
  const mapping: ImportMapping = {
    delimiter: ',',
    hasHeader: true,
    dateColumn: 1,
    amountColumn: 2,
    descriptionColumn: 4,
    dateFormat: 'YYYY-MM-DD',
    decimalSeparator: '.',
    signConvention: 'expenses_positive',
  };
  const lower = (text: string): string => text.toLowerCase();

  const day = fc
    .integer({ min: 0, max: 40 })
    .map((offset) => `2026-03-${String(1 + (offset % 28)).padStart(2, '0')}`);
  const entry = fc.record({
    date: day,
    cents: fc.oneof(
      fc.integer({ min: -5_000, max: 5_000 }),
      fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }),
    ),
    description: fc.constantFrom(
      'Coffee',
      'coffee ',
      'Rent',
      'Cafe, "Luna"',
      'Two\nlines',
      '=1+1',
      '',
    ),
  });
  const entries = fc.array(entry, { maxLength: 25 });

  const fileOf = (list: { date: string; cents: number; description: string }[]): string =>
    encodeCsv([
      ['id', 'date', 'amount', 'budget', 'description'],
      ...list.map((item, index) => [
        String(index + 1),
        item.date,
        formatCentsPlain(item.cents),
        'Food',
        guardCsvText(item.description),
      ]),
    ]);

  it(
    'reads back the dates and the amounts of a file written by the export, to the cent',
    SLOW,
    () => {
      fc.assert(
        fc.property(entries, (list) => {
          const rows = readImportRows(fileOf(list), mapping, lower);
          expect(rows).toHaveLength(list.length);
          rows.forEach((row, index) => {
            const item = list[index]!;
            expect(row.date).toBe(item.date);
            expect(row.amount).toBe(item.cents);
            expect(row.credit).toBe(item.cents < 0);
            expect(row.errors.includes('zero_amount')).toBe(item.cents === 0);
          });
        }),
        params(300),
      );
    },
  );

  it('flips every amount with the other sign convention', SLOW, () => {
    fc.assert(
      fc.property(entries, (list) => {
        const file = fileOf(list);
        const positive = readImportRows(file, mapping, lower);
        const negative = readImportRows(
          file,
          { ...mapping, signConvention: 'expenses_negative' },
          lower,
        );
        positive.forEach((row, index) => {
          const other = negative[index]?.amount;
          if (row.amount === null) expect(other).toBeNull();
          else expect(row.amount + (other as number)).toBe(0);
        });
      }),
      params(200),
    );
  });

  it(
    'gives every row that has a hash a different one, and counts identical rows 0, 1, 2...',
    SLOW,
    () => {
      fc.assert(
        fc.property(entries, (list) => {
          const rows = readImportRows(fileOf(list), mapping, lower);
          const hashed = rows.filter((row) => row.hashPreimage !== null);
          expect(new Set(hashed.map((row) => row.hashPreimage)).size).toBe(hashed.length);

          // Independent count: for each hashed row, how many hashed rows before it are identical.
          const same = (a: (typeof rows)[number], b: (typeof rows)[number]): boolean =>
            a.date === b.date &&
            a.amount === b.amount &&
            a.normalizedDescription === b.normalizedDescription;
          hashed.forEach((row, index) => {
            const before = hashed.slice(0, index).filter((other) => same(other, row)).length;
            expect(row.hashPreimage?.split('\n').at(-1)).toBe(String(before));
          });
        }),
        params(300),
      );
    },
  );

  it('is deterministic and does not depend on what happens elsewhere in the file', SLOW, () => {
    fc.assert(
      fc.property(entries, entries, (list, extra) => {
        const first = readImportRows(fileOf(list), mapping, lower);
        expect(readImportRows(fileOf(list), mapping, lower)).toEqual(first);
        // Rows added AFTER a row never change its hash: the occurrence only looks backwards.
        const longer = readImportRows(fileOf([...list, ...extra]), mapping, lower);
        first.forEach((row, index) => {
          expect(longer[index]?.hashPreimage).toBe(row.hashPreimage);
        });
      }),
      params(200),
    );
  });
});
