import {
  CsvSyntaxError,
  IMPORT_SAMPLE_ROWS,
  type ImportCommitInput,
  type ImportCommitResponse,
  type ImportFileRow,
  type ImportParseInput,
  type ImportParseResponse,
  type ImportPreviewInput,
  type ImportPreviewResponse,
  type ImportPreviewRow,
  type ImportRejectedRow,
  type ImportRejectionCode,
  type ImportRowErrorCode,
  type ImportRowsRejectedDetails,
  detectDelimiter,
  parseCsv,
} from '@wallet/shared';
import { spendings } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { apiError } from '../../lib/errors';
import { monthOfDate, timestampOf } from '../../lib/today';
import { requireSettings } from '../settings/settings.service';
import {
  type SpendingRule,
  isBeforeStartMonth,
  spendingRuleBreaks,
} from '../spendings/spendings.rules';
import { loadBudgets, loadStoredHashes, loadSuggester } from './import.context';
import { importHashOf, invalidFile, normalizeText, readFileRows } from './import.file';
import { suggestProfileId } from './import.profiles.service';

// -------------------------------------------------------------------------------------------------
// parse
// -------------------------------------------------------------------------------------------------

/**
 * POST /api/import/parse: looks at the file without a mapping. The delimiter is the request's or
 * the detected one. The cells of the FIRST non-blank record are the `header` (the header row of a
 * file that has one), up to `IMPORT_SAMPLE_ROWS` records after it are the `sample`, and the counts
 * cover every non-blank record. Writes nothing.
 */
export function parseImportFile({ db }: Deps, input: ImportParseInput): ImportParseResponse {
  const delimiter = input.delimiter ?? detectDelimiter(input.csv);
  let records;
  try {
    records = parseCsv(input.csv, delimiter, { skipBlank: true });
  } catch (error) {
    if (error instanceof CsvSyntaxError) throw invalidFile(error.message);
    throw error;
  }

  const header = records[0]?.cells ?? [];
  return {
    delimiter,
    header,
    sample: records.slice(1, 1 + IMPORT_SAMPLE_ROWS).map(({ line, cells }) => ({ line, cells })),
    recordCount: records.length,
    columnCount: records.reduce((widest, record) => Math.max(widest, record.cells.length), 0),
    suggestedProfileId: suggestProfileId(db, header),
  };
}

// -------------------------------------------------------------------------------------------------
// preview
// -------------------------------------------------------------------------------------------------

/**
 * POST /api/import/preview: every data row of the file judged under the mapping, in file order, and
 * the counts. The reader is the shared `readImportRows`; the server adds `before_start_month`, the
 * duplicate flag and the suggested budget, from what is stored (read once for the whole file).
 * Writes nothing.
 */
export function previewImport({ db }: Deps, input: ImportPreviewInput): ImportPreviewResponse {
  const fileRows = readFileRows(input.csv, input.mapping);
  const { startMonth } = requireSettings(db);
  const storedHashes = loadStoredHashes(db);
  const suggester = loadSuggester(db, loadBudgets(db));

  const rows = fileRows.map((row): ImportPreviewRow => {
    const errors: ImportRowErrorCode[] = [...row.errors];
    if (row.date !== null && isBeforeStartMonth(row.date, startMonth)) {
      errors.push('before_start_month');
    }
    return {
      line: row.line,
      date: row.date,
      amount: row.amount,
      raw: row.raw,
      description: row.description,
      // A row with no valid date or no description has no suggestion. A stored spending holds the
      // description cut to 200 characters, so the lookup uses the cut text too (the hash keeps the
      // uncut one): otherwise a long description would never find itself.
      suggestedBudgetId:
        row.date !== null && row.normalizedDescription !== ''
          ? suggester.suggest(normalizeText(row.description), monthOfDate(row.date))
          : null,
      duplicate: isStored(row, storedHashes),
      credit: row.credit,
      errors,
    };
  });

  return {
    rows,
    summary: {
      total: rows.length,
      invalid: rows.filter((row) => row.errors.length > 0).length,
      duplicates: rows.filter((row) => row.duplicate).length,
      credits: rows.filter((row) => row.credit).length,
      importable: rows.filter((row) => row.errors.length === 0 && !row.duplicate && !row.credit)
        .length,
    },
  };
}

/** A spending with the row's `importHash` is stored already. Only a row that has a hash can be. */
const isStored = (row: ImportFileRow, storedHashes: ReadonlySet<string>): boolean =>
  row.hashPreimage !== null && storedHashes.has(importHashOf(row.hashPreimage));

// -------------------------------------------------------------------------------------------------
// commit
// -------------------------------------------------------------------------------------------------

/**
 * The codes of a rejected row that `readImportRows` decides from the text of the row (the one
 * reader of preview and commit). Listed here in the canonical order, so that a commit reports them
 * in that order whatever order the reader pushes them in.
 */
const READER_CODES = [
  'invalid_date',
  'invalid_amount',
  'zero_amount',
  'amount_too_large',
  'empty_description',
] as const satisfies readonly ImportRejectionCode[];

/**
 * The rules of `POST /api/spendings` as the codes of a rejected row. They are the very same check
 * (`spendingRuleBreaks`), so the importer cannot disagree with the spendings endpoint, and each
 * rule is reported under its own name.
 */
const REJECTION_OF_RULE = {
  unknown_budget: 'unknown_budget',
  before_start_month: 'before_start_month',
  outside_active_months: 'outside_active_months',
} as const satisfies Record<SpendingRule, ImportRejectionCode>;

/**
 * Every code of the contract has a producer here: the reader (`READER_CODES`), the rules of a
 * spending (`REJECTION_OF_RULE`), the line that is no row, or the hash. A code added to
 * `IMPORT_REJECTION_CODES` makes this fail to compile until the importer raises it.
 */
type UnraisedCode = Exclude<
  ImportRejectionCode,
  | (typeof READER_CODES)[number]
  | (typeof REJECTION_OF_RULE)[SpendingRule]
  | 'unknown_line'
  | 'duplicate'
>;
const everyCodeIsRaised: [UnraisedCode] extends [never] ? true : never = true;
void everyCodeIsRaised;

/** Rows are written in batches of this many (8 bound values each, far below SQLite's limit). */
const INSERT_BATCH_SIZE = 500;

interface AcceptedRow {
  line: number;
  budgetId: number;
  date: string;
  amount: number;
  description: string;
  importHash: string;
}

/**
 * POST /api/import/commit: stores the listed rows, all or nothing. The file is read again with the
 * same reader as the preview (400 at `csv` for an unterminated quote and for too many rows, before
 * anything else), then, inside ONE transaction, every listed row is checked (so the duplicate check
 * and the writes see the same stored data) and all the failing rows are reported together in a 422
 * `import_rows_rejected`, ascending by line, each with every code that applies in the canonical
 * order. Only when none fails are the rows stored, ascending by line, with their `importHash`, no
 * notes and no tags. A credit is stored as it is: a refund (a negative amount). The transaction is
 * rolled back by any failure, so nothing is stored.
 */
export function commitImport(deps: Deps, input: ImportCommitInput): ImportCommitResponse {
  const fileRows = readFileRows(input.csv, input.mapping);
  const rowsByLine = new Map(fileRows.map((row) => [row.line, row]));
  const listed = [...input.rows].sort((a, b) => a.line - b.line);

  return inTransaction(deps, ({ db, clock }) => {
    const { startMonth } = requireSettings(db);
    const budgetsById = loadBudgets(db);
    const storedHashes = loadStoredHashes(db);

    const rejected: ImportRejectedRow[] = [];
    const accepted: AcceptedRow[] = [];
    for (const { line, budgetId } of listed) {
      const row = rowsByLine.get(line);
      if (!row) {
        rejected.push({ line, errors: ['unknown_line'] });
        continue;
      }

      // In the canonical order: the text of the row, then the budget and the date, then the hash.
      const errors: ImportRejectionCode[] = READER_CODES.filter((code) =>
        row.errors.includes(code),
      );
      for (const found of spendingRuleBreaks(
        { date: row.date, budgetId },
        budgetsById.get(budgetId),
        startMonth,
      )) {
        errors.push(REJECTION_OF_RULE[found.rule]);
      }
      const duplicate = isStored(row, storedHashes);
      if (duplicate) errors.push('duplicate');

      if (errors.length > 0) {
        rejected.push({ line, errors });
        continue;
      }
      // A row without a code has a date, a non-zero amount and a description, hence a hash.
      if (row.hashPreimage === null || row.date === null || row.amount === null) {
        throw new Error(`Import row on line ${line} has no error and no hash`);
      }
      accepted.push({
        line,
        budgetId,
        date: row.date,
        amount: row.amount,
        description: row.description,
        importHash: importHashOf(row.hashPreimage),
      });
    }

    if (rejected.length > 0) {
      const details: ImportRowsRejectedDetails = { rows: rejected };
      throw apiError(
        'import_rows_rejected',
        `${rejected.length} of the ${listed.length} listed rows cannot be imported: nothing was imported`,
        details,
      );
    }

    // `accepted` is ascending by line, and ids are handed out in the order of the values.
    const now = timestampOf(clock);
    const idsByHash = new Map<string, number>();
    for (let start = 0; start < accepted.length; start += INSERT_BATCH_SIZE) {
      const batch = accepted.slice(start, start + INSERT_BATCH_SIZE);
      const stored = db
        .insert(spendings)
        .values(
          batch.map((row) => ({
            date: row.date,
            amount: row.amount,
            budgetId: row.budgetId,
            description: row.description,
            notes: null,
            importHash: row.importHash,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .returning({ id: spendings.id, importHash: spendings.importHash })
        .all();
      for (const { id, importHash } of stored) {
        if (importHash !== null) idsByHash.set(importHash, id);
      }
    }

    const items = accepted.map((row) => {
      const id = idsByHash.get(row.importHash);
      if (id === undefined) throw new Error(`Import row on line ${row.line} was not stored`);
      return { line: row.line, id };
    });
    return { created: items.length, items };
  });
}
