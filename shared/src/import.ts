import { z } from 'zod';
import {
  CSV_DELIMITERS,
  IMPORT_DATE_FORMATS,
  IMPORT_DECIMAL_SEPARATORS,
  IMPORT_MAX_COLUMN_INDEX,
  IMPORT_MAX_ROWS,
  IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH,
  IMPORT_PROFILE_MAX_HEADER_CELLS,
  IMPORT_SIGN_CONVENTIONS,
  type CsvDelimiter,
  type ImportRejectionCode,
  type ImportRowErrorCode,
} from './limits';
import type { Cents } from './money';
import type { IsoDate } from './month';
import { idRefSchema, nameSchema } from './schemas';

// The constants live in './limits' (no zod); they are re-exported so import paths stay uniform.
export {
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
  type CsvDelimiter,
  type ImportDateFormat,
  type ImportDecimalSeparator,
  type ImportRejectionCode,
  type ImportRowErrorCode,
  type ImportSignConvention,
} from './limits';

// The importer is STATELESS: the server keeps no uploaded file. The client holds the text of the
// file and sends it with every call (`parse`, `preview`, `commit`), and the server reads it again
// each time with `readImportRows` (csv.ts), so there is one parser and a line means the same row in
// the preview and in the commit. The server only sees TEXT: the client decodes the bytes of the
// file (UTF-8, and windows-1252 when the file is not valid UTF-8). The rules are in
// docs/DOMAIN.md, "CSV import". Every `/api/import` body may be up to IMPORT_MAX_BODY_BYTES (10
// MiB, a larger one is 413 `payload_too_large`); the other endpoints keep express's 100 kB. Every
// endpoint here answers 409 `not_onboarded` until the settings exist.

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** A column of the file, by 0-based position (the first column is 0), so header-less files work. */
const columnIndexSchema = z.number().int().min(0).max(IMPORT_MAX_COLUMN_INDEX);

/**
 * How to read a bank's CSV: the `ImportMapping`. It is the `mapping` of `preview` and `commit` and
 * what a saved profile stores. Every field is required, there are no defaults. Columns are
 * 0-based positions, they must be three different columns (400, at the second one named: first
 * `amountColumn`, then `descriptionColumn`), and there is a single amount column (no debit and
 * credit columns in this phase). The date and amount formats are those of
 * docs/DOMAIN.md, "CSV import".
 */
export const importMappingSchema = z
  .strictObject({
    /** How the file is read. `parse` suggests the one it detected. */
    delimiter: z.enum(CSV_DELIMITERS),
    /** The first non-blank record is a header row, not data. */
    hasHeader: z.boolean(),
    dateColumn: columnIndexSchema,
    amountColumn: columnIndexSchema,
    descriptionColumn: columnIndexSchema,
    /** One of IMPORT_DATE_FORMATS. A two-digit year is never accepted. */
    dateFormat: z.enum(IMPORT_DATE_FORMATS),
    /** "." or ",". The other one of the two is accepted as a thousands separator. */
    decimalSeparator: z.enum(IMPORT_DECIMAL_SEPARATORS),
    /** Which sign the bank puts on money that leaves the account. */
    signConvention: z.enum(IMPORT_SIGN_CONVENTIONS),
  })
  .superRefine((mapping, ctx) => {
    if (mapping.amountColumn === mapping.dateColumn) {
      ctx.addIssue({
        code: 'custom',
        message: 'The amount column must differ from the date column',
        path: ['amountColumn'],
      });
    }
    if (
      mapping.descriptionColumn === mapping.dateColumn ||
      mapping.descriptionColumn === mapping.amountColumn
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The description column must differ from the date and amount columns',
        path: ['descriptionColumn'],
      });
    }
  });
export type ImportMapping = z.infer<typeof importMappingSchema>;

// ---------------------------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/import/parse body → 200 ImportParseResponse. `csv` is the whole text of the file (may
 * be empty: the answer then has no records). `delimiter` is optional: without it the server
 * detects one (`detectDelimiter`). Writes nothing, and does not need a mapping. 400
 * `validation_error`: a bad body, and a quoted field that is never closed (at `csv`, the message
 * names its line). 413 `payload_too_large` above 10 MiB.
 */
export const importParseSchema = z.strictObject({
  csv: z.string(),
  delimiter: z.enum(CSV_DELIMITERS).optional(),
});
export type ImportParseInput = z.infer<typeof importParseSchema>;

/** A record of the file as read: the line it starts on and its cells as written (not trimmed). */
export interface ImportRecordDto {
  /** 1-based file line the record starts on (a quoted field may span several lines). */
  line: number;
  cells: string[];
}

/**
 * Response of POST /api/import/parse (200). Records are the non-blank lines of the file, read with
 * `delimiter`. Nothing here depends on a mapping, so `hasHeader` is not known yet: the first
 * record is offered as the header, and the UI treats it as a data row when the user says there is
 * no header (then the data rows are `recordCount`, else `recordCount - 1`).
 */
export interface ImportParseResponse {
  /** The delimiter that was used: the one in the request, or the detected one. */
  delimiter: CsvDelimiter;
  /** The cells of the FIRST record: the header row of a file that has one. [] for an empty file. */
  header: string[];
  /** The records after the first one, at most IMPORT_SAMPLE_ROWS (5), in file order. */
  sample: ImportRecordDto[];
  /** Every non-blank record of the file, the first one included. */
  recordCount: number;
  /** The most cells in any record: how many columns a mapping can address. */
  columnCount: number;
  /**
   * The id of a saved profile that fits this file, or null: the profile has a header signature
   * and the (normalized) header cell of each of its three mapped columns equals the profile's, at
   * the same position. With several, the most recently updated (then the highest id).
   */
  suggestedProfileId: number | null;
}

// ---------------------------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/import/preview body → 200 ImportPreviewResponse. Reads the file with the mapping (the
 * delimiter is the mapping's: nothing is detected here) and judges every data row. Writes nothing,
 * can be repeated freely. 400 `validation_error`: a bad body, an unterminated quoted field (at
 * `csv`), and a file with more than IMPORT_MAX_ROWS (10,000) data rows (at `csv`). 413
 * `payload_too_large` above 10 MiB.
 */
export const importPreviewSchema = z.strictObject({
  csv: z.string(),
  mapping: importMappingSchema,
});
export type ImportPreviewInput = z.infer<typeof importPreviewSchema>;

/** One data row of the file, judged: an element of `ImportPreviewResponse.rows` (POST /api/import/preview → 200). */
export interface ImportPreviewRow {
  /** 1-based file line the record starts on. It is what `commit` addresses the row by. */
  line: number;
  /** The date as `YYYY-MM-DD`, or null when it was not a valid date in the mapping's format. */
  date: IsoDate | null;
  /**
   * Cents in SPENDING sign: positive is an expense, negative is a refund (see `credit`). null when
   * the cell is not a valid amount or is too large. 0 for a zero amount.
   */
  amount: Cents | null;
  /** The text of the date and amount cells as they are in the file, trimmed, for error messages. */
  raw: { date: string; amount: string };
  /** Cleaned (whitespace collapsed, trimmed) and cut to 200 characters. "" when it is empty. */
  description: string;
  /**
   * The budget most often used by earlier spendings with the same normalized description, ties
   * broken by the most recent use, only when it is active in the month of `date`. Otherwise null.
   */
  suggestedBudgetId: number | null;
  /** A spending with this row's `importHash` is already stored: the row was imported before. */
  duplicate: boolean;
  /**
   * The row is on the other side of the sign convention (`amount` is negative): in a real bank
   * file mostly a salary or a transfer in, rarely a refund. It is imported only when the commit
   * lists it, so the UI leaves it unchecked by default.
   */
  credit: boolean;
  /**
   * Every code that applies, in the order of IMPORT_ROW_ERROR_CODES. Empty when the row can be
   * imported. A row with errors can't be committed.
   */
  errors: ImportRowErrorCode[];
}

/**
 * The counts of `ImportPreviewResponse.summary`. Each counts the rows that satisfy its own
 * condition, so they overlap (a credit can be a duplicate): they are not a partition of `total`.
 */
export interface ImportPreviewSummary {
  /** Every data row of the file. */
  total: number;
  /** Rows with at least one error. */
  invalid: number;
  /** Rows with `duplicate` true. */
  duplicates: number;
  /** Rows with `credit` true. */
  credits: number;
  /** Rows with no error, not a duplicate and not a credit: the ones the UI selects by default. */
  importable: number;
}

/** Response of POST /api/import/preview (200): one row per data row, in file order, and the counts. */
export interface ImportPreviewResponse {
  rows: ImportPreviewRow[];
  summary: ImportPreviewSummary;
}

// ---------------------------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------------------------

/** One row to import: the file line (from the preview) and the budget it goes to. */
export const importCommitRowSchema = z.strictObject({
  /** A `line` of the preview. */
  line: z.number().int().positive(),
  budgetId: idRefSchema,
});
export type ImportCommitRowInput = z.infer<typeof importCommitRowSchema>;

/**
 * POST /api/import/commit body → 201 ImportCommitResponse. The client sends the file and the
 * mapping again and lists the rows to import: it never sends an amount, a date or a
 * description, the server reads those from the file. Only the listed lines are imported. A
 * credit is imported only because it is listed.
 *
 * `rows` has 1 to IMPORT_MAX_ROWS (10,000) entries and no line twice (a 400 `validation_error` at
 * `rows.<i>.line`, the index of the second one). The checks, in this order:
 *  1. 400 `validation_error`: the shape of the body; the file's unterminated quote (at `csv`);
 *     more than IMPORT_MAX_ROWS data rows (at `csv`). 413 `payload_too_large` above 10 MiB.
 *  2. 422 `import_rows_rejected`, with every listed row that fails any of the row checks and
 *     the codes it fails (`ImportRowsRejectedDetails`). Nothing at all is imported when one row is
 *     rejected. A row is checked for each of these codes, and lists those that apply, in the order
 *     of IMPORT_REJECTION_CODES: `unknown_line`; `invalid_date`, `invalid_amount`, `zero_amount`,
 *     `amount_too_large`, `empty_description`; `unknown_budget`; `before_start_month`;
 *     `outside_active_months`; `duplicate`.
 *  3. The rows are stored in ONE transaction, ascending by line, with their `importHash`; the
 *     duplicate check is repeated inside it. Any failure stores nothing. 201 with what was stored.
 */
export const importCommitSchema = z
  .strictObject({
    csv: z.string(),
    mapping: importMappingSchema,
    rows: z.array(importCommitRowSchema).min(1).max(IMPORT_MAX_ROWS),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    value.rows.forEach((row, index) => {
      if (seen.has(row.line)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each line may be listed only once',
          path: ['rows', index, 'line'],
        });
      }
      seen.add(row.line);
    });
  });
export type ImportCommitInput = z.infer<typeof importCommitSchema>;

/** One spending that a commit created. */
export interface ImportCommitCreated {
  /** The file line it came from. */
  line: number;
  /** The id of the new spending (`GET /api/spendings` shows it). */
  id: number;
}

/** Response of POST /api/import/commit (201). */
export interface ImportCommitResponse {
  /** How many spendings were created: `items.length`, which is the number of rows listed. */
  created: number;
  /** One per created spending, ascending by `line` (and so by `id`). */
  items: ImportCommitCreated[];
}

/** A listed row that a commit refused. */
export interface ImportRejectedRow {
  /** The `line` that was listed. */
  line: number;
  /** Every code that applies, in the order of IMPORT_REJECTION_CODES. At least one. */
  errors: ImportRejectionCode[];
}

/**
 * `error.details` of the 422 `import_rows_rejected` response of `POST /api/import/commit`: every
 * rejected row among those listed, ascending by line. Nothing was imported.
 */
export interface ImportRowsRejectedDetails {
  rows: ImportRejectedRow[];
}

// ---------------------------------------------------------------------------------------------
// Saved profiles
// ---------------------------------------------------------------------------------------------

/**
 * Body of POST /api/import/profiles (→ 201 ImportProfileDto) and of PUT /api/import/profiles/:id
 * (→ 200 ImportProfileDto): a named mapping, saved so that the next file of the same bank needs no
 * remapping. PUT REPLACES the whole profile, so send every field.
 *
 * `name`: trimmed, 1 to 60 characters, unique under the same comparison as tag names (case is
 * ignored, accents are not): 409 `import_profile_name_taken`. A name made only of invisible
 * characters is a 400 at `name`, as for a tag.
 *
 * `header` is what lets `parse` recognise the bank's next file: send the `header` of the parse
 * response (the first record of the file). The server keeps the normalized cells (trimmed,
 * whitespace collapsed, case folded). When `mapping.hasHeader` is true and `header` is given, it
 * must reach the highest mapped column (400 at `header` otherwise). Omitted or null: the profile
 * never matches a file on its own (and a `hasHeader: false` profile ignores it and stores none).
 * Up to 100 cells of up to 200 characters.
 *
 * Errors: 400 `validation_error`, then for PUT 404 `not_found` (unknown id), then 409
 * `import_profile_name_taken` (another profile has this name; a profile never clashes with itself).
 * No 422 rule applies.
 */
export const importProfileSchema = z
  .strictObject({
    name: nameSchema,
    mapping: importMappingSchema,
    header: z
      .array(z.string().max(IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH))
      .max(IMPORT_PROFILE_MAX_HEADER_CELLS)
      .nullish(),
  })
  .superRefine((profile, ctx) => {
    if (!profile.mapping.hasHeader || profile.header == null) return;
    const needed = Math.max(
      profile.mapping.dateColumn,
      profile.mapping.amountColumn,
      profile.mapping.descriptionColumn,
    );
    if (profile.header.length <= needed) {
      ctx.addIssue({
        code: 'custom',
        message: 'The header must have a cell for every mapped column',
        path: ['header'],
      });
    }
  });
export type ImportProfileInput = z.infer<typeof importProfileSchema>;

/**
 * GET /api/import/profiles → 200 ImportProfileDto[], ascending by name under the name comparison
 * (case ignored), then id. Also the response of POST (201) and PUT (200).
 * DELETE /api/import/profiles/:id → 204 (404 `not_found` for an unknown id). A profile belongs to
 * no spending, so deleting one changes nothing else.
 */
export interface ImportProfileDto {
  id: number;
  /** Trimmed, 1 to 60 characters, unique ignoring case. */
  name: string;
  mapping: ImportMapping;
  /**
   * The normalized header cells the profile was saved with, or null. Sending this back as
   * `header` on a PUT keeps the signature as it is.
   */
  header: string[] | null;
}
