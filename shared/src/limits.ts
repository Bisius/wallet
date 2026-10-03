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
