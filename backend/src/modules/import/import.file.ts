import {
  CsvSyntaxError,
  IMPORT_MAX_ROWS,
  type ImportFileRow,
  type ImportMapping,
  cleanImportText,
  parseCsv,
  readImportRows,
} from '@wallet/shared';
import { createHash } from 'node:crypto';
import { apiError } from '../../lib/errors';
import { foldText } from '../../lib/fold';

/**
 * The one normalization of docs/DOMAIN.md ("The description, the hash and duplicates"): the case
 * fold of the spendings search (`foldText`). `readImportRows` cleans a description (whitespace
 * collapsed, trimmed) before it calls this, so the normalized description of a row is
 * `foldText(cleanImportText(cell))`, and it is idempotent. The suggestions, the hash and the header
 * signature of a profile all use it.
 */
export const normalizeImportText = (cleaned: string): string => foldText(cleaned);

/** A text as the importer compares it: cleaned, then normalized. */
export const normalizeText = (text: string): string => normalizeImportText(cleanImportText(text));

/** The `importHash` of a row: the lower-case hex SHA-256 of its `hashPreimage` (shared/src/csv.ts). */
export const importHashOf = (preimage: string): string =>
  createHash('sha256').update(preimage, 'utf8').digest('hex');

/** 400 `validation_error` at `csv`: the file itself is not acceptable. */
export const invalidFile = (message: string) =>
  apiError('validation_error', 'Invalid request', [{ path: 'csv', message }]);

/**
 * The data rows of the file under the mapping, in file order: THE reader of an import, used by
 * `preview` and `commit` alike so a `line` means the same row in both (`readImportRows`). Nothing is
 * decided that needs the database here. A 400 at `csv` for an unterminated quoted field (the message
 * names its line) and for more than `IMPORT_MAX_ROWS` data rows. The rows are counted first, reading
 * only as far as the limit, so that a file of millions of tiny records is refused before it is
 * turned into rows.
 */
export function readFileRows(csv: string, mapping: ImportMapping): ImportFileRow[] {
  const header = mapping.hasHeader ? 1 : 0;
  try {
    const records = parseCsv(csv, mapping.delimiter, {
      skipBlank: true,
      maxRecords: IMPORT_MAX_ROWS + header + 1,
    });
    if (records.length - header > IMPORT_MAX_ROWS) {
      throw invalidFile(`The file has more than ${IMPORT_MAX_ROWS} data rows`);
    }
    return readImportRows(csv, mapping, normalizeImportText);
  } catch (error) {
    if (error instanceof CsvSyntaxError) throw invalidFile(error.message);
    throw error;
  }
}
