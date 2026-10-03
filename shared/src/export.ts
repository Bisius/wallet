import { z } from 'zod';
import type { ImportMapping } from './import';
import type { ExportKind } from './limits';
import type { IsoDate } from './month';
import { isoDateSchema } from './schemas';

// The constants live in './limits' (no zod); they are re-exported so import paths stay uniform.
export { EXPORT_KINDS, type ExportKind } from './limits';

// Three read-only downloads, `GET /api/export/spendings.csv`, `incomes.csv` and `savings.csv`.
// They answer 409 `not_onboarded` until the settings exist, write nothing and have no 422 rule.
// The rules are in docs/DOMAIN.md, "CSV export". The response of each is:
//
//   200
//   Content-Type: text/csv; charset=utf-8
//   Content-Disposition: attachment; filename="<exportFilename(kind, query)>"
//   Cache-Control: no-store
//
// and the body is `encodeCsv([EXPORT_*_COLUMNS, ...rows])` (csv.ts): a UTF-8 byte order mark, then
// RFC 4180 records, comma separated and CRLF terminated (the last one too), the header row first.
// A range that holds no row is still a file: the BOM and the header row.

/**
 * Query of GET /api/export/spendings.csv, /incomes.csv and /savings.csv → 200 (a CSV file, see the
 * notes at the top of this file). `from` and `to` are dates (`YYYY-MM-DD`), both inclusive,
 * and both optional (an omitted bound is open); a row is in range by its own `date`. `from` after
 * `to` is a 400 `validation_error` at `to`, an unknown key is a 400 too.
 */
export const exportQuerySchema = z
  .strictObject({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['to'],
  });
export type ExportQuery = z.infer<typeof exportQuerySchema>;

/** The `Content-Type` of every export. */
export const EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * The columns of `GET /api/export/spendings.csv`, in order, as the header row. One row per
 * spending in range, ascending by date then id. Amounts are in spending sign (an expense is
 * positive, a refund negative), so the file can be imported again with `signConvention`
 * `expenses_positive`, `dateFormat` `YYYY-MM-DD`, `decimalSeparator` ".", a header row, and the
 * `date`, `amount` and `description` columns. The `importHash` is not exported.
 *
 *  - `id`: the spending id.
 *  - `date`: `YYYY-MM-DD`.
 *  - `amount`: `formatCentsPlain`, e.g. "12.30" or "-5.00".
 *  - `budget`: the name of its budget (text, guarded).
 *  - `description`: text, guarded, may be empty.
 *  - `notes`: text, guarded, empty when there are none.
 *  - `tags`: the names of its tags, ascending under the tag-name comparison then by id, joined by
 *    `EXPORT_TAG_SEPARATOR` ("|") with nothing around it (a name that holds "|" is not escaped:
 *    the cell is for reading in a spreadsheet, the backup is the lossless copy). Guarded as one
 *    text. Empty when there are none.
 */
export const EXPORT_SPENDINGS_COLUMNS = [
  'id',
  'date',
  'amount',
  'budget',
  'description',
  'notes',
  'tags',
] as const;

/**
 * The columns of `GET /api/export/incomes.csv`. One row per row of the `incomes` table in range
 * (the extra, one-off incomes of `GET /api/incomes`), ascending by date then id. The SALARY is not
 * in this file: it is a monthly value with an effective-from month and no dated rows of its own,
 * and there are no recurring extra incomes in Wallet. `amount` is positive. `description` is text
 * (guarded).
 */
export const EXPORT_INCOMES_COLUMNS = ['id', 'date', 'amount', 'description'] as const;

/**
 * The columns of `GET /api/export/savings.csv`. One row per savings transaction in range, of every
 * kind (`opening`, `settlement`, `deposit`, `withdrawal`, `reallocation`), by the `date` the money
 * moved, ascending by date then id. `amount` is SIGNED as stored (a withdrawal and the first row
 * of a reallocation are negative).
 *
 *  - `kind`: one of the five kinds.
 *  - `goal_id`, `goal`: the goal the row belongs to and its name (guarded); both empty for
 *    unassigned savings.
 *  - `settles_month`: `YYYY-MM` for a settlement, else empty.
 *  - `note`: text, guarded, empty when there is none.
 *  - `group_id`: the number the two rows of a reallocation share, else empty.
 */
export const EXPORT_SAVINGS_COLUMNS = [
  'id',
  'date',
  'kind',
  'amount',
  'goal_id',
  'goal',
  'settles_month',
  'note',
  'group_id',
] as const;

/**
 * The import mapping that reads `spendings.csv` back (`POST /api/import/preview`): the export's
 * amounts are in spending sign with a "." and its dates are ISO, so an exported file imports
 * again with the exact dates and amounts it was exported with (the descriptions come back as
 * guarded text, with a leading `'` where the guard added one). The importer's `duplicate` flag
 * only knows rows that were themselves imported: a spending entered by hand has no `importHash`,
 * so importing an export back into the same database creates a second copy of those.
 */
export const EXPORT_SPENDINGS_IMPORT_MAPPING: ImportMapping = {
  delimiter: ',',
  hasHeader: true,
  dateColumn: EXPORT_SPENDINGS_COLUMNS.indexOf('date'),
  amountColumn: EXPORT_SPENDINGS_COLUMNS.indexOf('amount'),
  descriptionColumn: EXPORT_SPENDINGS_COLUMNS.indexOf('description'),
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  signConvention: 'expenses_positive',
};

/** The header row of each export. */
export const EXPORT_COLUMNS = {
  spendings: EXPORT_SPENDINGS_COLUMNS,
  incomes: EXPORT_INCOMES_COLUMNS,
  savings: EXPORT_SAVINGS_COLUMNS,
} as const satisfies Record<ExportKind, readonly string[]>;

/**
 * Which cells of each export are TEXT, that is, are run through `guardCsvText`. Every other
 * column (ids, dates, months, amounts, the kind) is written as it is: an amount may begin with
 * "-" and must stay a number.
 */
export const EXPORT_TEXT_COLUMNS = {
  spendings: ['budget', 'description', 'notes', 'tags'],
  incomes: ['description'],
  savings: ['goal', 'note'],
} as const satisfies Record<ExportKind, readonly string[]>;

/** Separates the tag names inside the `tags` cell of the spendings export. */
export const EXPORT_TAG_SEPARATOR = '|';

/**
 * The file name of an export, for `Content-Disposition`. It is ASCII only, so no `filename*` is
 * needed, and it holds the range:
 *
 *     wallet-spendings-all.csv                              (no bound)
 *     wallet-spendings-from-2026-01-01.csv                  (`from` only)
 *     wallet-spendings-until-2026-03-31.csv                 (`to` only)
 *     wallet-spendings-2026-01-01_to_2026-03-31.csv         (both)
 */
export function exportFilename(kind: ExportKind, range: { from?: IsoDate; to?: IsoDate }): string {
  const { from, to } = range;
  const span =
    from !== undefined && to !== undefined
      ? `${from}_to_${to}`
      : from !== undefined
        ? `from-${from}`
        : to !== undefined
          ? `until-${to}`
          : 'all';
  return `wallet-${kind}-${span}.csv`;
}

/** The path of an export: `GET /api/export/<kind>.csv`. */
export function exportPath(kind: ExportKind): string {
  return `/api/export/${kind}.csv`;
}
