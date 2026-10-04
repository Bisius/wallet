import type { ImportMapping } from '@wallet/shared';

/*
 * Bank files for the import specs, built in code (nothing is committed as a data file): the text of
 * the file is written out in the spec next to the figures it must produce, so a reader sees the row
 * and the arithmetic together.
 */

/** What `locator.setInputFiles` takes for a file that is not on disk. */
export interface Upload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** The bytes windows-1252 gives to characters that are not in Latin-1 (0x80 to 0x9F). The rest of it is Latin-1. */
const WINDOWS_1252_EXTRA = new Map<string, number>([
  ['€', 0x80],
  ['‚', 0x82],
  ['„', 0x84],
  ['…', 0x85],
  ['‘', 0x91],
  ['’', 0x92],
  ['“', 0x93],
  ['”', 0x94],
  ['•', 0x95],
  ['–', 0x96],
  ['—', 0x97],
]);

/**
 * The bytes of `text` in windows-1252, which is what the exports of most banks use. A character it
 * cannot write throws, so a test never silently builds a different file than it meant to.
 */
export function encodeWindows1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const character of text) {
    const extra = WINDOWS_1252_EXTRA.get(character);
    const code = character.codePointAt(0) ?? 0;
    if (extra !== undefined) bytes.push(extra);
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else throw new Error(`"${character}" (U+${code.toString(16)}) is not in windows-1252`);
  }
  return Buffer.from(bytes);
}

/** A file in windows-1252. Its bytes are not valid UTF-8, so the app has to take its fallback path. */
export function windows1252Upload(name: string, text: string): Upload {
  return { name, mimeType: 'text/csv', buffer: encodeWindows1252(text) };
}

/** A file in UTF-8, with a byte order mark if asked for (Excel writes one). */
export function utf8Upload(name: string, text: string, { bom = false } = {}): Upload {
  const body = Buffer.from(text, 'utf8');
  return {
    name,
    mimeType: 'text/csv',
    buffer: bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body,
  };
}

/** The text of a file: the records, each ended by `eol` (the last one too). */
export function csvText(records: readonly string[], eol = '\r\n'): string {
  return records.map((record) => record + eol).join('');
}

// ---------------------------------------------------------------------------------------------
// A German bank's file: semicolons, dd/mm/yyyy, a decimal comma and a dot for thousands, the
// debit as a negative amount, a booking date and a value date, a running balance, windows-1252.
// ---------------------------------------------------------------------------------------------

export const SPARKASSE_HEADER = 'Buchungstag;Wertstellung;Betrag;Verwendungszweck;Saldo';

/** The same layout with English titles: not the header of a saved Sparkasse profile. */
export const SPARKASSE_ENGLISH_HEADER = 'Date;Value date;Amount;Purpose;Balance';

/**
 * `POST /api/import/preview` and `/commit` read the file with this mapping: the UI sends the same
 * one after the person chose the columns, and a saved profile stores it.
 */
export const SPARKASSE_MAPPING: ImportMapping = {
  delimiter: ';',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 2,
  descriptionColumn: 3,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  signConvention: 'expenses_negative',
};

/** A statement as the bank's file writes it: the header, then one record per row. */
export function sparkasseFile(
  name: string,
  rows: readonly string[],
  header: string = SPARKASSE_HEADER,
): Upload {
  return windows1252Upload(name, csvText([header, ...rows]));
}

/** The same text a client reads out of the file, for the calls that go straight to the API. */
export function sparkasseText(rows: readonly string[], header: string = SPARKASSE_HEADER): string {
  return csvText([header, ...rows]);
}

/**
 * The records of the main statement (March 2026, lines 2 to 11 of the file). The comment of each
 * says what the app must do with it, and the specs work their figures out from these.
 */
export const MARCH_ROWS = {
  // 45.90 out. A description with quotes (the whole cell is quoted, the quotes doubled) and ß, ü.
  rewe: '02/03/2026;02/03/2026;-45,90;"REWE Markt ""Süd"" Straße";2.954,10',
  // 1,049.00 out. The dot is a thousands separator, the comma the decimal one.
  moebel: '03/03/2026;03/03/2026;-1.049,00;Möbel Weiß GmbH Küche;1.905,10',
  // 12.50 out. A cell that a spreadsheet would run as a formula.
  formula: '04/03/2026;04/03/2026;-12,50;=1+1;1.892,60',
  // 9.80 out. Uppercase, with É: the stored 'Café de Flore' is the same text once case is folded.
  cafe: '05/03/2026;05/03/2026;-9,80;CAFÉ DE FLORE;1.882,80',
  // 2.80 out, twice on one day: two identical rows are two spendings, not one and a duplicate.
  tramFirst: '06/03/2026;06/03/2026;-2,80;"Straßenbahn ""Ticket"" Zone 1";1.880,00',
  tramSecond: '06/03/2026;06/03/2026;-2,80;"Straßenbahn ""Ticket"" Zone 1";1.877,20',
  // 19.99 IN (positive in a file where debits are negative): a credit, here a refund.
  refund: '09/03/2026;09/03/2026;+19,99;Rückerstattung REWE;1.897,19',
  // 31 February does not exist: the date cannot be read.
  badDate: '31/02/2026;31/02/2026;-5,00;Bäckerei Müller;1.892,19',
  // 7.40 out. An en dash and a euro sign, which windows-1252 has at 0x96 and 0x80 (Latin-1 has neither).
  mensa: '10/03/2026;10/03/2026;-7,40;Mensa Café – Tagesmenü 7,40 €;1.884,79',
  // "abc" is not an amount.
  badAmount: '11/03/2026;11/03/2026;-abc;Tankstelle Aral;1.884,79',
} as const;

/** The ten rows in file order: lines 2 to 11. */
export const MARCH_FILE_ROWS: readonly string[] = [
  MARCH_ROWS.rewe,
  MARCH_ROWS.moebel,
  MARCH_ROWS.formula,
  MARCH_ROWS.cafe,
  MARCH_ROWS.tramFirst,
  MARCH_ROWS.tramSecond,
  MARCH_ROWS.refund,
  MARCH_ROWS.badDate,
  MARCH_ROWS.mensa,
  MARCH_ROWS.badAmount,
];

// ---------------------------------------------------------------------------------------------
// A plain file: commas, ISO dates, a dot, debits negative, UTF-8. Its defaults are the wizard's own.
// ---------------------------------------------------------------------------------------------

export const SIMPLE_HEADER = 'Date,Amount,Description';

/** What the wizard sends for `SIMPLE_HEADER` once the three columns are chosen and nothing else is changed. */
export const SIMPLE_MAPPING: ImportMapping = {
  delimiter: ',',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 1,
  descriptionColumn: 2,
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  signConvention: 'expenses_negative',
};

export function simpleFile(name: string, rows: readonly string[]): Upload {
  return utf8Upload(name, simpleText(rows));
}

export function simpleText(rows: readonly string[]): string {
  return csvText([SIMPLE_HEADER, ...rows]);
}

/**
 * `count` rows for `SIMPLE_HEADER` (no header row included), all different, dated in April 2026
 * and about 150 characters each: expenses of 1.00 to 97.99. A big file for specs that need a
 * database of some size.
 */
export function ballastRows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, '0');
    const euros = 1 + (index % 97);
    const cents = String(index % 100).padStart(2, '0');
    return `2026-04-${day},-${euros}.${cents},Ballast row ${index} ${'x'.repeat(120)}`;
  });
}
