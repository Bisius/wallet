/**
 * Pure CSV helpers behind the export and the import of docs/DOMAIN.md ("CSV export", "CSV
 * import"): no dependencies, no Node APIs, no zod, so the backend and the UI can both use them.
 *
 * Writing: `formatCentsPlain` (cents as a decimal string), `guardCsvText` (formula injection) and
 * `encodeCsv` (RFC 4180, CRLF, BOM). Reading: `parseCsv`, `detectDelimiter`, and the cell parsers
 * `parseImportDate` and `parseImportAmount`. `readImportRows` is the ONE parser of an import: it
 * turns a file and a mapping into rows, so `preview` and `commit` cannot disagree about a row.
 */
import {
  CSV_DELIMITERS,
  DESCRIPTION_MAX_LENGTH,
  MAX_CENTS,
  type CsvDelimiter,
  type ImportDateFormat,
  type ImportDecimalSeparator,
  type ImportRowErrorCode,
} from './limits';
import type { ImportMapping } from './import';
import type { Cents } from './money';
import { type IsoDate, daysInMonth, toMonthKey } from './month';

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** UTF-8 byte order mark. An export starts with it so that Excel reads the file as UTF-8. */
export const CSV_BOM = '﻿';
/** The line end of an export: CRLF after every record, the last one included (RFC 4180). */
export const CSV_EOL = '\r\n';

/**
 * Cents as a plain decimal string for a CSV cell: an optional "-", the whole units with no
 * thousands separator, ".", and always two digits of cents. `1230` is "12.30", `-5` is "-0.05",
 * `0` is "0.00" (never "-0.00"), `100` is "1.00". Exact for every safe integer: only `%`,
 * subtraction and an exact division are used, never a float quotient or `toFixed`. It is the
 * inverse of `parseCents`, and of `parseImportAmount` with the "." separator. Throws a
 * `RangeError` for anything that is not a safe integer.
 */
export function formatCentsPlain(cents: Cents): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatCentsPlain: cents must be a safe integer, got ${cents}`);
  }
  const absolute = Math.abs(cents);
  const fraction = absolute % 100;
  // `absolute - fraction` is a multiple of 100, so this division is exact.
  const whole = (absolute - fraction) / 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Where a spreadsheet may start a cell with a character that makes it read the cell as a formula
 * (OWASP, CSV injection: `=`, `+`, `-`, `@`, a tab, a carriage return): at the start of the text,
 * and right after a `;`, because a spreadsheet whose list separator is `;` (most euro locales)
 * splits a double-clicked file there, and quoting does not help (the quote is then not at the
 * start of the field).
 */
const FORMULA_START = /(^|;)(?=[=+\-@\t\r])/g;

/**
 * The injection guard of docs/DOMAIN.md ("CSV export"): every place of the text where a cell may
 * start with `=`, `+`, `-`, `@`, a tab or a carriage return (the start, and after each `;`) gets a
 * `'` in front of that character, which a spreadsheet shows as nothing and which turns the cell
 * into text. Any other text is returned as it is. Apply it to TEXT cells only (descriptions,
 * notes, names), never to an amount: an amount may begin with "-" legitimately. It is idempotent:
 * a guarded character follows a `'`, which is no trigger.
 */
export function guardCsvText(text: string): string {
  return text.replace(FORMULA_START, "$1'");
}

/**
 * One cell, quoted when RFC 4180 needs it: when it holds a double quote, the delimiter, a CR or an
 * LF. A quote inside is doubled. Nothing else is quoted (an empty cell is empty).
 */
export function encodeCsvCell(value: string, delimiter: CsvDelimiter = ','): string {
  const needsQuotes =
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\r') ||
    value.includes('\n');
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One record, without its line end. */
export function encodeCsvRow(cells: readonly string[], delimiter: CsvDelimiter = ','): string {
  return cells.map((cell) => encodeCsvCell(cell, delimiter)).join(delimiter);
}

export interface EncodeCsvOptions {
  /** Default ",". */
  delimiter?: CsvDelimiter;
  /** Start the text with the UTF-8 BOM. Default true. */
  bom?: boolean;
}

/**
 * A whole file: the BOM (unless `bom: false`), then every row followed by CRLF. An export is
 * `encodeCsv([header, ...rows])`. Reading it back with `parseCsv` gives the same cells.
 */
export function encodeCsv(
  rows: readonly (readonly string[])[],
  { delimiter = ',', bom = true }: EncodeCsvOptions = {},
): string {
  return (bom ? CSV_BOM : '') + rows.map((row) => encodeCsvRow(row, delimiter) + CSV_EOL).join('');
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** One record of a file: the 1-based file line it STARTS on, and its cells as written. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/** A quoted field that is never closed. `line` is the line the field starts on. */
export class CsvSyntaxError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'CsvSyntaxError';
    this.line = line;
  }
}

export interface ParseCsvOptions {
  /** Stop after this many records (the blank ones left out by `skipBlank` do not count). */
  maxRecords?: number;
  /**
   * Leave out the blank records (see `isBlankRecord`) instead of returning them. The lines are
   * still counted, so the `line` of a record is the same either way, but a file of a million
   * empty lines costs no memory.
   */
  skipBlank?: boolean;
  /**
   * An unterminated quoted field ends at the end of the text instead of throwing. For looking at a
   * piece of a file (`detectDelimiter`).
   */
  lenient?: boolean;
}

/**
 * Reads CSV text into records (docs/DOMAIN.md, "CSV import"):
 *  - A leading BOM is dropped.
 *  - A record ends at CRLF, LF or CR. A line end at the very end of the text does not start another
 *    record, but an empty line anywhere else is a record with one empty cell. Lines are counted
 *    from 1, each of CRLF, LF and CR counting once, also inside a quoted field, so `line` is where
 *    a record starts in the file as an editor shows it.
 *  - A field is quoted only when its FIRST character is a double quote. Inside, `""` is a quote and
 *    delimiters and line breaks are text. After the closing quote any characters up to the next
 *    delimiter or line end are appended as they are (a lenient reading of `"ab"c`). A quote in the
 *    middle of an unquoted field is an ordinary character. A space before an opening quote makes
 *    the field unquoted.
 *  - A quoted field that is never closed throws a `CsvSyntaxError` (unless `lenient`).
 *  - Cells are returned as written: nothing is trimmed here.
 */
export function parseCsv(
  text: string,
  delimiter: CsvDelimiter,
  {
    maxRecords = Number.POSITIVE_INFINITY,
    skipBlank = false,
    lenient = false,
  }: ParseCsvOptions = {},
): CsvRecord[] {
  const records: CsvRecord[] = [];
  const length = text.length;
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  /** Position of the next delimiter or line break at or after `from` (or the end of the text). */
  const endOfField = (from: number): number => {
    let at = from;
    while (at < length) {
      const char = text[at];
      if (char === delimiter || char === '\r' || char === '\n') break;
      at++;
    }
    return at;
  };

  while (position < length && records.length < maxRecords) {
    const startLine = line;
    const cells: string[] = [];

    for (;;) {
      let cell = '';
      if (text[position] === '"') {
        const fieldLine = line;
        position++;
        let closed = false;
        while (!closed) {
          const quote = text.indexOf('"', position);
          if (quote === -1) {
            if (!lenient) {
              throw new CsvSyntaxError(
                `Unterminated quoted field starting on line ${fieldLine}`,
                fieldLine,
              );
            }
            cell += text.slice(position);
            position = length;
            break;
          }
          const chunk = text.slice(position, quote);
          line += countLineBreaks(chunk);
          cell += chunk;
          if (text[quote + 1] === '"') {
            cell += '"';
            position = quote + 2;
          } else {
            position = quote + 1;
            closed = true;
          }
        }
        if (closed) {
          const end = endOfField(position);
          cell += text.slice(position, end);
          position = end;
        }
      } else {
        const end = endOfField(position);
        cell = text.slice(position, end);
        position = end;
      }
      cells.push(cell);
      if (text[position] === delimiter) {
        position++;
        continue;
      }
      break;
    }

    if (!(skipBlank && cells.every(isBlankCell))) records.push({ line: startLine, cells });

    // The record's own line end (there is none at the end of the text).
    if (text[position] === '\r') {
      position += text[position + 1] === '\n' ? 2 : 1;
      line++;
    } else if (text[position] === '\n') {
      position++;
      line++;
    }
  }
  return records;
}

/** CRLF, LF and CR each count as one line break. */
function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') count++;
    else if (char === '\r') {
      count++;
      if (text[index + 1] === '\n') index++;
    }
  }
  return count;
}

const isBlankCell = (cell: string): boolean => cell.trim() === '';

/** A record whose every cell is empty or blank. Importers skip these (they are not data rows). */
export function isBlankRecord(record: CsvRecord): boolean {
  return record.cells.every(isBlankCell);
}

/** How many non-blank records `detectDelimiter` looks at. */
const DETECT_RECORDS = 20;

/**
 * Guesses the delimiter of a file. Each of `,` `;` tab `|` reads the first 20 non-blank records;
 * its score is how many of them have as many cells as the FIRST one, provided that is 2 or more.
 * The highest score wins, then the delimiter that gives the first record more cells, then the
 * order `,` `;` tab `|`. When no delimiter splits the first record, the answer is `,`.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  let bestColumns = 0;
  for (const candidate of CSV_DELIMITERS) {
    const records = parseCsv(text, candidate, {
      maxRecords: DETECT_RECORDS,
      skipBlank: true,
      lenient: true,
    });
    const columns = records[0]?.cells.length ?? 0;
    if (columns < 2) continue;
    const score = records.filter((record) => record.cells.length === columns).length;
    if (score > bestScore || (score === bestScore && columns > bestColumns)) {
      best = candidate;
      bestScore = score;
      bestColumns = columns;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Cells: dates
// ---------------------------------------------------------------------------------------------

/**
 * An optional time of day after the date, which is ignored (the date is the date as written, with
 * no time zone conversion): a space or "T", then `H:MM`, optionally `:SS` and a fraction, and
 * optionally "Z" or an offset (`+02`, `+02:00`, `+0200`).
 */
const TIME_SUFFIX = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?: ?(?:Z|[+-]\d{2}(?::?\d{2})?))?)?`;

type DateOrder = 'ymd' | 'dmy' | 'mdy';

const DATE_SHAPES: Record<ImportDateFormat, { pattern: RegExp; order: DateOrder }> = {
  'YYYY-MM-DD': {
    pattern: new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME_SUFFIX}$`),
    order: 'ymd',
  },
  'YYYY/MM/DD': {
    pattern: new RegExp(String.raw`^(\d{4})/(\d{1,2})/(\d{1,2})${TIME_SUFFIX}$`),
    order: 'ymd',
  },
  YYYYMMDD: {
    pattern: new RegExp(String.raw`^(\d{4})(\d{2})(\d{2})${TIME_SUFFIX}$`),
    order: 'ymd',
  },
  'DD/MM/YYYY': {
    pattern: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME_SUFFIX}$`),
    order: 'dmy',
  },
  'MM/DD/YYYY': {
    pattern: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME_SUFFIX}$`),
    order: 'mdy',
  },
  'DD.MM.YYYY': {
    pattern: new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{4})${TIME_SUFFIX}$`),
    order: 'dmy',
  },
  'DD-MM-YYYY': {
    pattern: new RegExp(String.raw`^(\d{1,2})-(\d{1,2})-(\d{4})${TIME_SUFFIX}$`),
    order: 'dmy',
  },
  'MM-DD-YYYY': {
    pattern: new RegExp(String.raw`^(\d{1,2})-(\d{1,2})-(\d{4})${TIME_SUFFIX}$`),
    order: 'mdy',
  },
};

/**
 * Reads a date cell in one of the `IMPORT_DATE_FORMATS` and returns it as `YYYY-MM-DD`, or null
 * when it is not a real date in that format (docs/DOMAIN.md, "CSV import"):
 *  - The cell is trimmed first. The separators are exactly those of the format name.
 *  - `YYYY` is exactly four digits and at least 0001, so a two-digit year ("5/3/26") is never
 *    read. `DD` and `MM` are one or two digits, except in `YYYYMMDD`, where they are two.
 *  - The date must exist (no 31 April, no 29 February in a common year).
 *  - A time of day after the date is ignored (see `TIME_SUFFIX`).
 */
export function parseImportDate(text: string, format: ImportDateFormat): IsoDate | null {
  const { pattern, order } = DATE_SHAPES[format];
  const match = pattern.exec(text.trim());
  if (!match) return null;
  const [first, second, third] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [year, month, day] =
    order === 'ymd'
      ? [first, second, third]
      : order === 'dmy'
        ? [third, second, first]
        : [third, first, second];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  if (day > daysInMonth(toMonthKey(year, month))) return null;
  return `${toMonthKey(year, month)}-${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Cells: amounts
// ---------------------------------------------------------------------------------------------

export type ImportAmountResult =
  { ok: true; cents: Cents } | { ok: false; reason: 'invalid_amount' | 'amount_too_large' };

/** The most digits of whole units that can still be within MAX_CENTS (1e12 cents = 1e10 units). */
const MAX_WHOLE_DIGITS = 11;

/**
 * Reads an amount cell into signed cents, exactly (docs/DOMAIN.md, "CSV import"). The grammar,
 * after trimming and after writing a no-break, narrow no-break and thin space as a space, a
 * typographic apostrophe (U+2019) as `'` and the minus sign U+2212 as "-":
 *
 *     amount   = [ "+" | "-" ] whole [ DECIMAL digits ]
 *     whole    = digits | group           (at least one digit, so ".50" is invalid)
 *     group    = 1-3 digits, then one or more of ( SEP 3 digits ), the SAME SEP each time
 *     SEP      = space, "'", or the character that is NOT `decimalSeparator`
 *
 * so with "," as the decimal separator `1.234,50`, `1 234,50` and `1'234,50` are 1234.50 and with
 * "." `1,234.50` is. Which character is the decimal separator is the caller's choice and decides
 * ambiguous cells: `1.234` is 1234.00 with "," and invalid with ".". At most two fraction digits
 * count: more are accepted only when every digit after the second is 0 (`12.300` is 12.30), and a
 * value is never rounded. No currency symbol or code, no exponent, no parentheses and no trailing
 * sign. Whitespace is allowed only as a thousands separator.
 *
 * Returns `reason: 'invalid_amount'` for anything outside the grammar and `'amount_too_large'`
 * when the value is above MAX_CENTS (1e12 cents) in absolute terms. "0.00" and "-0" parse to 0
 * (never -0); rejecting a zero amount is the caller's rule (`zero_amount`).
 */
export function parseImportAmount(
  text: string,
  decimalSeparator: ImportDecimalSeparator,
): ImportAmountResult {
  const invalid = { ok: false, reason: 'invalid_amount' } as const;
  const normalized = text.trim().replace(/[   ]/g, ' ').replace(/’/g, "'").replace(/−/g, '-');
  const match = /^([+-]?)(\d[\s\S]*)$/.exec(normalized);
  if (!match) return invalid;
  const negative = match[1] === '-';
  const pieces = (match[2] as string).split(decimalSeparator);
  if (pieces.length > 2) return invalid;
  const [integerPart = '', fractionPart] = pieces;

  let wholeDigits: string;
  if (/^\d+$/.test(integerPart)) {
    wholeDigits = integerPart;
  } else {
    const grouped =
      decimalSeparator === '.'
        ? /^\d{1,3}(?:([ ',])\d{3}(?:\1\d{3})*)$/
        : /^\d{1,3}(?:([ '.])\d{3}(?:\1\d{3})*)$/;
    if (!grouped.test(integerPart)) return invalid;
    wholeDigits = integerPart.replace(/[ ',.]/g, '');
  }

  let fraction = '00';
  if (fractionPart !== undefined) {
    if (!/^\d+$/.test(fractionPart)) return invalid;
    if (!/^0*$/.test(fractionPart.slice(2))) return invalid;
    fraction = fractionPart.slice(0, 2).padEnd(2, '0');
  }

  const whole = wholeDigits.replace(/^0+(?=\d)/, '');
  if (whole.length > MAX_WHOLE_DIGITS) return { ok: false, reason: 'amount_too_large' };
  const cents = Number(whole) * 100 + Number(fraction);
  if (cents > MAX_CENTS) return { ok: false, reason: 'amount_too_large' };
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

// ---------------------------------------------------------------------------------------------
// Cells: descriptions and the import hash
// ---------------------------------------------------------------------------------------------

/**
 * The cleaned form of a text cell: every run of whitespace (spaces, tabs, line breaks, no-break
 * spaces) becomes one space, and the ends are trimmed. A description is stored in this form, and
 * the "normalized description" of docs/DOMAIN.md is this text run through the backend's
 * case fold.
 */
export function cleanImportText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The description that is stored: the cleaned text cut to DESCRIPTION_MAX_LENGTH (200) UTF-16 code
 * units, never inside a surrogate pair, with the new end trimmed.
 */
export function limitImportDescription(cleaned: string): string {
  if (cleaned.length <= DESCRIPTION_MAX_LENGTH) return cleaned;
  let end = DESCRIPTION_MAX_LENGTH;
  const last = cleaned.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return cleaned.slice(0, end).trimEnd();
}

/**
 * What the `importHash` of a row is the SHA-256 (lower-case hex, UTF-8) of: a version tag, the
 * date, the amount in cents with its sign (spending sign), the normalized description and the
 * occurrence index, one per line. The description never holds a line break (it is cleaned), so
 * the parts cannot run into each other. The hash itself is the backend's (`node:crypto`).
 */
export function importHashPreimage(
  date: IsoDate,
  amount: Cents,
  normalizedDescription: string,
  occurrence: number,
): string {
  return ['wallet-import-v1', date, String(amount), normalizedDescription, String(occurrence)].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------------------------
// The importer's parser
// ---------------------------------------------------------------------------------------------

/**
 * One data row of an import file as `readImportRows` reads it. The rules that need the database
 * (`before_start_month`, `duplicate`, the budget) are not decided here.
 */
export interface ImportFileRow {
  /** 1-based file line the record starts on. */
  line: number;
  /** The trimmed text of the date and amount cells ("" for a cell the record does not have). */
  raw: { date: string; amount: string };
  /** The date, or null when it is not valid in the mapping's format. */
  date: IsoDate | null;
  /**
   * Cents in SPENDING sign (positive is an expense, negative a refund). null when the cell is not
   * a valid amount or is too large, 0 for a zero amount.
   */
  amount: Cents | null;
  /** The cleaned description cut to 200 characters; "" when the cell is empty. */
  description: string;
  /** The cleaned description run through `normalize`; "" when it is empty. */
  normalizedDescription: string;
  /** The amount is negative: the row is on the other side of the sign convention (a credit). */
  credit: boolean;
  /**
   * The codes of the row's own text, in the order of `IMPORT_ROW_ERROR_CODES`: `invalid_date`,
   * then one of `invalid_amount`, `zero_amount` and `amount_too_large`, then `empty_description`.
   */
  errors: ImportRowErrorCode[];
  /**
   * `importHashPreimage` of the row, or null when the row has no valid date, no non-zero amount in
   * range, or no description (such a row has no hash).
   */
  hashPreimage: string | null;
}

/**
 * Reads a file with a mapping into its data rows, in file order (docs/DOMAIN.md, "CSV import").
 * The same call is made by `preview` and `commit`, so a line means the same row in both.
 *
 *  - The file is read with `mapping.delimiter`. Records whose cells are all blank are skipped
 *    everywhere, and they are not data rows. With `hasHeader` the first remaining record is the
 *    header and is not a data row either.
 *  - A cell the record does not have is read as empty.
 *  - The amount is read with `mapping.decimalSeparator`, then the sign convention turns it into
 *    spending sign: `expenses_negative` flips it, `expenses_positive` keeps it. A row with a
 *    negative spending amount is a `credit`.
 *  - `normalize` maps a cleaned description to its normalized form (the backend passes its case
 *    fold). It must give the same text for the same input every time.
 *  - The occurrence index counts, for each row that has a hash, the rows before it in the file with
 *    the same date, amount and normalized description. It is counted over the whole file, whatever
 *    is selected later, and every row that has a hash counts, whatever its other errors.
 *
 * Throws `CsvSyntaxError` for an unterminated quoted field.
 */
export function readImportRows(
  csv: string,
  mapping: ImportMapping,
  normalize: (cleaned: string) => string,
): ImportFileRow[] {
  const records = parseCsv(csv, mapping.delimiter, { skipBlank: true });
  const dataRecords = mapping.hasHeader ? records.slice(1) : records;
  const occurrences = new Map<string, number>();

  return dataRecords.map((record): ImportFileRow => {
    const cell = (index: number): string => (record.cells[index] ?? '').trim();
    const raw = { date: cell(mapping.dateColumn), amount: cell(mapping.amountColumn) };
    const errors: ImportRowErrorCode[] = [];

    const date = parseImportDate(raw.date, mapping.dateFormat);
    if (date === null) errors.push('invalid_date');

    let amount: Cents | null = null;
    const parsed = parseImportAmount(raw.amount, mapping.decimalSeparator);
    if (!parsed.ok) {
      errors.push(parsed.reason);
    } else {
      const signed = mapping.signConvention === 'expenses_negative' ? -parsed.cents : parsed.cents;
      amount = signed === 0 ? 0 : signed; // never -0
      if (amount === 0) errors.push('zero_amount');
    }

    const cleaned = cleanImportText(record.cells[mapping.descriptionColumn] ?? '');
    if (cleaned === '') errors.push('empty_description');
    const normalizedDescription = cleaned === '' ? '' : normalize(cleaned);

    let hashPreimage: string | null = null;
    if (date !== null && amount !== null && amount !== 0 && cleaned !== '') {
      const key = `${date}\n${amount}\n${normalizedDescription}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      hashPreimage = importHashPreimage(date, amount, normalizedDescription, occurrence);
    }

    return {
      line: record.line,
      raw,
      date,
      amount,
      description: limitImportDescription(cleaned),
      normalizedDescription,
      credit: amount !== null && amount < 0,
      errors,
      hashPreimage,
    };
  });
}
