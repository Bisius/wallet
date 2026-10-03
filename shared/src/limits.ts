/**
 * Constants and small enums shared by the backend and the UI, with no runtime dependencies.
 *
 * They live apart from the zod schemas on purpose: importing a value from a module that builds zod
 * schemas pulls all of zod (hundreds of kB) into the importing bundle. Eager frontend code imports
 * from `@wallet/shared/limits` instead. The schema modules re-export what they used to define, so
 * `@wallet/shared` and the old import paths keep working.
 */

// --- Money ------------------------------------------------------------------------------------

/**
 * Largest absolute amount any single request may carry: 10 billion units (1e12 cents). A cap far
 * below Number.MAX_SAFE_INTEGER keeps each amount, and `amount * 100`, exact. Sums stay exact while
 * the running total (times 100, in the alert math) stays below about 9e13 cents, which no personal
 * ledger approaches.
 */
export const MAX_CENTS = 1_000_000_000_000;

// --- Text -------------------------------------------------------------------------------------

/** Length limits, so the UI can set `maxlength` on inputs. */
export const NAME_MAX_LENGTH = 60;
export const DESCRIPTION_MAX_LENGTH = 200;
export const NOTES_MAX_LENGTH = 1000;
export const ICON_MAX_LENGTH = 32;

// --- Months -----------------------------------------------------------------------------------

/** The widest range GET /api/months accepts, and the most months it returns. */
export const MAX_MONTH_RANGE = 120;
/** Projection horizon: a month more than this many months after the current one does not exist. */
export const MAX_MONTHS_AHEAD = 120;

// --- Onboarding and settings ------------------------------------------------------------------

/** The most budgets the onboarding wizard may create. */
export const MAX_ONBOARDING_BUDGETS = 50;

/**
 * How far back `settings.startMonth` may be set: at most this many months (20 years) before the
 * current month, otherwise 422 `start_month_too_old`. Every request recomputes the ledger from the
 * start month, so an accidental "0001-01" would make each request take seconds. Checked when the
 * start month is set or changed, never when it stays as it is (docs/DOMAIN.md, "Start month").
 */
export const MAX_START_MONTH_AGE_MONTHS = 240;

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Values used when onboarding omits `theme` or `alertWarnPercent`. */
export const DEFAULT_THEME: Theme = 'system';
export const DEFAULT_ALERT_WARN_PERCENT = 80;

// --- Subscriptions ----------------------------------------------------------------------------

export const SUBSCRIPTION_FREQUENCIES = ['monthly', 'yearly'] as const;
export type SubscriptionFrequency = (typeof SUBSCRIPTION_FREQUENCIES)[number];

/**
 * GET /api/subscriptions/upcoming looks `days` days ahead: 30 when omitted, 1 to 366 otherwise. No
 * started subscription's next billing date is more than 366 days away (that is the longest gap
 * between two renewals of a yearly one), so the widest window lists the next renewal of every
 * subscription that has started or starts within it.
 */
export const UPCOMING_DEFAULT_DAYS = 30;
export const UPCOMING_MIN_DAYS = 1;
export const UPCOMING_MAX_DAYS = 366;

// --- Spendings --------------------------------------------------------------------------------

/** Page size of GET /api/spendings when `limit` is omitted, and the largest `limit` allowed. */
export const SPENDINGS_DEFAULT_LIMIT = 50;
export const SPENDINGS_MAX_LIMIT = 200;

// --- Tags and search --------------------------------------------------------------------------

/** The longest tag name, after trimming (the shortest is 1), so the UI can set `maxlength`. */
export const TAG_NAME_MAX_LENGTH = 30;

/** The most tags one spending may carry (`tagIds` of `POST` and `PATCH /api/spendings`). */
export const MAX_TAGS_PER_SPENDING = 10;

/** The longest `q` of `GET /api/spendings`, after trimming (the shortest is 1). */
export const SPENDING_SEARCH_MAX_LENGTH = 100;

// --- Savings ----------------------------------------------------------------------------------

/**
 * What a savings transaction is (docs/DOMAIN.md, "Savings"). `opening` and `settlement` rows are
 * made by `PUT /api/savings/opening` and `POST /api/savings/settle/:month`, the other three by
 * `POST /api/savings/transactions`.
 */
export const SAVINGS_TRANSACTION_KINDS = [
  'opening',
  'settlement',
  'deposit',
  'withdrawal',
  'reallocation',
] as const;
export type SavingsTransactionKind = (typeof SAVINGS_TRANSACTION_KINDS)[number];

/** The kinds `POST /api/savings/transactions` creates. */
export const MANUAL_SAVINGS_KINDS = ['deposit', 'withdrawal', 'reallocation'] as const;
export type ManualSavingsKind = (typeof MANUAL_SAVINGS_KINDS)[number];

/** Page size of GET /api/savings/transactions when `limit` is omitted, and the largest allowed. */
export const SAVINGS_TRANSACTIONS_DEFAULT_LIMIT = 50;
export const SAVINGS_TRANSACTIONS_MAX_LIMIT = 200;

/** The most allocations one settlement may be split into. */
export const MAX_SETTLEMENT_ALLOCATIONS = 50;

// --- CSV export and import --------------------------------------------------------------------

/**
 * The delimiters the importer reads: comma, semicolon, tab and pipe. The exports always write a
 * comma.
 */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/**
 * The closed set of date formats of the importer (docs/DOMAIN.md, "CSV import"). `DD` and `MM`
 * accept one or two digits (so `5/3/2026` reads as 5 March under `DD/MM/YYYY`), `YYYY` is exactly
 * four digits (a two-digit year is never accepted), and `YYYYMMDD` is exactly eight digits.
 */
export const IMPORT_DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD.MM.YYYY',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

/** The decimal separator of a bank's amounts. The other one of the two counts as thousands. */
export const IMPORT_DECIMAL_SEPARATORS = ['.', ','] as const;
export type ImportDecimalSeparator = (typeof IMPORT_DECIMAL_SEPARATORS)[number];

/**
 * Which sign a bank puts on money that LEAVES the account. `expenses_negative` (most banks): an
 * expense is -12.30. `expenses_positive` (credit cards, and Wallet's own export): an expense is
 * +12.30.
 */
export const IMPORT_SIGN_CONVENTIONS = ['expenses_negative', 'expenses_positive'] as const;
export type ImportSignConvention = (typeof IMPORT_SIGN_CONVENTIONS)[number];

/**
 * Why a file row cannot be imported, as `ImportPreviewRow.errors`, in this order (a row lists every
 * code that applies, in the order of this list). The first five come from the text of the row
 * alone, `before_start_month` from its date and `settings.startMonth`.
 */
export const IMPORT_ROW_ERROR_CODES = [
  'invalid_date',
  'invalid_amount',
  'zero_amount',
  'amount_too_large',
  'empty_description',
  'before_start_month',
] as const;
export type ImportRowErrorCode = (typeof IMPORT_ROW_ERROR_CODES)[number];

/**
 * Why a listed row of `POST /api/import/commit` is rejected: every `ImportRowErrorCode` plus four
 * more, in the canonical order in which a row lists its codes. `unknown_budget`,
 * `before_start_month` and `outside_active_months` are the rules of `POST /api/spendings` under the
 * same names; `duplicate` is the preview's `duplicate` flag.
 */
export const IMPORT_REJECTION_CODES = [
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
] as const;
export type ImportRejectionCode = (typeof IMPORT_REJECTION_CODES)[number];

/** `POST /api/import/parse` returns this many records after the first one as the sample. */
export const IMPORT_SAMPLE_ROWS = 5;

/** The most data rows `preview` and `commit` accept in one file (and rows one commit lists). */
export const IMPORT_MAX_ROWS = 10_000;

/** The highest column index a mapping may name (a mapping addresses at most 100 columns). */
export const IMPORT_MAX_COLUMN_INDEX = 99;

/** The most header cells, and the longest cell, a saved profile keeps (`ImportProfileInput.header`). */
export const IMPORT_PROFILE_MAX_HEADER_CELLS = IMPORT_MAX_COLUMN_INDEX + 1;
export const IMPORT_PROFILE_HEADER_CELL_MAX_LENGTH = 200;

/**
 * Body limits in bytes. Every JSON body is limited to `DEFAULT_BODY_LIMIT_BYTES` (express's own
 * default of 100 kB) except the `/api/import` ones, which carry a whole CSV file in a string and may
 * be `IMPORT_MAX_BODY_BYTES` (10 MiB). A larger body is a 413 `payload_too_large`.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024;
export const IMPORT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The files `GET /api/export/<kind>.csv` serves. */
export const EXPORT_KINDS = ['spendings', 'incomes', 'savings'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

// --- Backups ----------------------------------------------------------------------------------

/**
 * An automatic backup is due once the newest one is this old (and at startup when it already is).
 * Rotation keeps `BACKUP_KEEP_DAILY` daily and `BACKUP_KEEP_MONTHLY` monthly backups (docs/PLAN.md,
 * Phase 7); the contract exposes no "kind" of backup, because one file can be kept for both reasons.
 */
export const BACKUP_INTERVAL_HOURS = 24;
export const BACKUP_KEEP_DAILY = 14;
export const BACKUP_KEEP_MONTHLY = 12;
