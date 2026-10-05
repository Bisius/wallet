import type { IsoDate, MonthKey } from './month';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Every non-2xx response has the `ApiError` body. `error.code` is one of these values and fixes the
 * HTTP status (see `API_ERROR_STATUS`). Later phases may add members, so a client should fall back
 * to the HTTP status for a code it does not know.
 */
export type ApiErrorCode =
  /** 400. Body, query or path parameters failed validation. `details` is a `ValidationIssue[]`. */
  | 'validation_error'
  /** 400. The request body is not parseable JSON. */
  | 'invalid_json'
  /**
   * 404. The addressed id, month row or route does not exist. Also: `GET /api/settings` before
   * onboarding, and `GET /api/months/:month` for a month outside the tracked range.
   */
  | 'not_found'
  /**
   * 409. The settings do not exist yet. Until onboarding completes, every endpoint except
   * `GET /api/health`, `GET /api/today`, `GET|PUT /api/settings` and `POST /api/onboarding` answers
   * with this code.
   */
  | 'not_onboarded'
  /** 409. `POST /api/onboarding` when the settings already exist. */
  | 'already_onboarded'
  /** 409. `DELETE /api/budgets/:id` on a budget that has spendings or transfers. Archive it. */
  | 'has_history'
  /**
   * 409. `POST /api/savings/settle/:month` with an `amount` that is not the month's current
   * outstanding: an edit moved it since the client looked. `details` is an
   * `OutstandingChangedDetails` (`{ month, outstanding }`) carrying the current value, so the
   * client can show it and ask again.
   */
  | 'outstanding_changed'
  /**
   * 409. `POST /api/savings/settle/:month` for a month whose outstanding is 0: there is nothing to
   * settle (it was settled already, or nothing was due).
   */
  | 'nothing_to_settle'
  /**
   * 409. `DELETE /api/savings/transactions/:id` on an `opening` or a `settlement` row. The opening
   * balance changes with `PUT /api/savings/opening`, and a settlement is undone with
   * `DELETE /api/savings/settle/:month`.
   */
  | 'not_deletable'
  /**
   * 409. `POST /api/tags` or `PATCH /api/tags/:id` with a name that another tag already has,
   * ignoring case and surrounding whitespace ("Groceries" and "groceries" are the same name).
   */
  | 'tag_name_taken'
  /**
   * 409. `POST /api/import/profiles` and `PUT /api/import/profiles/:id` with a name that another
   * import profile already has, under the same comparison as `tag_name_taken` (case is ignored,
   * accents are not).
   */
  | 'import_profile_name_taken'
  /**
   * 409. `POST /api/backups` when the server has no backup directory (the in-memory database and
   * no `BACKUP_DIR`, see shared/src/backups.ts), so there is nowhere to put a backup.
   */
  | 'backups_unavailable'
  /**
   * 409. `POST /api/telegram/pairing` or `POST /api/telegram/test` while `TELEGRAM_BOT_TOKEN` is not
   * set: the Telegram bot is off, so there is no bot to link or to send a message with (see
   * shared/src/telegram.ts).
   */
  | 'telegram_not_configured'
  /**
   * 409. `POST /api/telegram/test` while no Telegram account is linked: there is no chat to send
   * the message to.
   */
  | 'telegram_not_linked'
  /**
   * 413. The request body is larger than the limit of its route: 100 kB (`DEFAULT_BODY_LIMIT_BYTES`)
   * everywhere, 10 MiB (`IMPORT_MAX_BODY_BYTES`) for the `/api/import` endpoints, which carry a CSV
   * file. `details` is a `PayloadTooLargeDetails`.
   */
  | 'payload_too_large'
  /**
   * 422. `POST /api/import/commit` listed rows that can't be imported: nothing was imported.
   * `details` is an `ImportRowsRejectedDetails` naming every rejected row and its codes.
   */
  | 'import_rows_rejected'
  /**
   * 422. Well-formed input that breaks a rule of docs/DOMAIN.md. `details` is a
   * `RuleViolationDetails` naming the rule.
   */
  | 'rule_violation'
  /** 500. Unexpected server error. The message is generic; the cause is only in the server log. */
  | 'internal_error'
  /**
   * 503. `POST /api/telegram/test` when the message could not be sent: the bot is not running (see
   * `TelegramStatusDto.connection`), or Telegram refused the message.
   */
  | 'telegram_unavailable';

/** The HTTP status that goes with each `ApiErrorCode`. */
export const API_ERROR_STATUS = {
  validation_error: 400,
  invalid_json: 400,
  not_found: 404,
  not_onboarded: 409,
  already_onboarded: 409,
  has_history: 409,
  outstanding_changed: 409,
  nothing_to_settle: 409,
  not_deletable: 409,
  tag_name_taken: 409,
  import_profile_name_taken: 409,
  backups_unavailable: 409,
  telegram_not_configured: 409,
  telegram_not_linked: 409,
  payload_too_large: 413,
  import_rows_rejected: 422,
  rule_violation: 422,
  internal_error: 500,
  telegram_unavailable: 503,
} as const satisfies Record<ApiErrorCode, number>;

/** `error.details` of a 413 `payload_too_large`. */
export interface PayloadTooLargeDetails {
  /** The limit of the route that refused the body, in bytes. */
  limitBytes: number;
}

/** One entry of `details` for a `validation_error`. */
export interface ValidationIssue {
  /** Dot-joined path of the offending field, e.g. "budgets.0.amount". Empty for the whole body. */
  path: string;
  message: string;
}

/**
 * Which rule a `rule_violation` (422) broke. The `message` is human readable English; the UI can
 * switch on `rule` and attach the error to `field`.
 */
export type RuleViolationRule =
  /** The start month is after the current month, so the current month would not be tracked. */
  | 'start_month_in_future'
  /**
   * The start month is more than `MAX_START_MONTH_AGE_MONTHS` months before the current month.
   * Only checked when the start month is set or changed, never when it stays as it is.
   */
  | 'start_month_too_old'
  /** `PUT /api/settings` would move `startMonth` later than the earliest stored fact. */
  | 'start_month_after_facts'
  /**
   * A date or month is earlier than `settings.startMonth`. Nothing before it is accepted: not a
   * spending, a transfer or any other fact.
   */
  | 'before_start_month'
  /**
   * A date or month is outside the active months of the budget or subscription it belongs to. For
   * a spending the field is "date". For a transfer it names the budget side that is not active in
   * the month of the transfer's date ("fromBudgetId" or "toBudgetId"), because the ledger ignores
   * a transfer unless every budget it names is active in its month.
   */
  | 'outside_active_months'
  /** An `endMonth` would be earlier than the item's `startMonth`. */
  | 'end_before_start'
  /** A budget `startMonth` would move later than its earliest spending or transfer. */
  | 'start_after_activity'
  /** A budget `endMonth` (archive) would be earlier than its latest spending or transfer. */
  | 'end_before_activity'
  /**
   * `PATCH /api/subscriptions/:id` would move the `anchorDate` of a yearly subscription to another
   * month of the year (its renewal month) while the subscription already has a closed month: that
   * would silently re-spread every cycle, closed months included. Cancel it and add a new one.
   * Changing only the day of the anchor date is always accepted.
   */
  | 'renewal_month_in_history'
  /**
   * A budget id does not refer to an existing budget: the `budgetId` of a spending (field
   * "budgetId"), or a budget side of a transfer (field "fromBudgetId" or "toBudgetId").
   */
  | 'unknown_budget'
  /**
   * An entry of a spending's `tagIds` does not refer to an existing tag (field "tagIds.<i>", the
   * index of the first one that does not).
   */
  | 'unknown_tag'
  /** A settlement addresses the current month or a future one. Only closed months settle. */
  | 'month_not_closed'
  /**
   * The allocations of a settlement do not add up to its `amount`, or one of them has the opposite
   * sign.
   */
  | 'allocation_mismatch'
  /** A `goalId` does not refer to an existing goal. */
  | 'unknown_goal'
  /**
   * A `goalId` refers to an archived goal where money would go into it or be allocated to it: a
   * deposit, the destination (`toGoalId`) of a reallocation, or a settlement allocation (even one
   * that takes money from savings). An archived goal can still be the SOURCE of a withdrawal or of
   * a reallocation (`fromGoalId`), so the money left in it is never frozen.
   */
  | 'goal_archived'
  /**
   * A withdrawal or a reallocation takes more than its source holds: the balance, as it is now, of
   * the goal or of the unassigned savings.
   */
  | 'insufficient_balance'
  /** A date is after today. Savings transactions record money that has already moved. */
  | 'date_in_future';

/** `error.details` of a `rule_violation`. */
export interface RuleViolationDetails {
  rule: RuleViolationRule;
  /** The request field that broke the rule, in the same dot notation as `ValidationIssue.path`. */
  field?: string;
}

/** Body of every non-2xx response. */
export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /**
     * `ValidationIssue[]` for `validation_error`, `RuleViolationDetails` for `rule_violation`,
     * `OutstandingChangedDetails` for `outstanding_changed`, `ImportRowsRejectedDetails` for
     * `import_rows_rejected` and `PayloadTooLargeDetails` for `payload_too_large`.
     */
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------------------------

/** A page of a list. `total` counts every matching row; `limit`/`offset` are what was applied. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /api/health → 200. */
export interface HealthResponse {
  status: 'ok';
  time: string;
}

/**
 * GET /api/today → 200. "Today" according to the server clock and its time zone (`TZ`). The UI must
 * use this and never the browser clock. Works before onboarding.
 */
export interface TodayResponse {
  date: IsoDate;
  /** The month of `date`: the current month. */
  month: MonthKey;
}
