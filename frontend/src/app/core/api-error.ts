import { HttpErrorResponse } from '@angular/common/http';
// Eager code imports the zod-free modules directly: the `@wallet/shared` barrel would pull all of
// zod into the initial bundle (see "exports" in shared/package.json).
import { API_ERROR_STATUS } from '@wallet/shared/api';
import type { ApiErrorCode, RuleViolationRule } from '@wallet/shared/api';

/** An API (or network) failure, ready to show to the user. */
export interface ParsedApiError {
  /** HTTP status. 0 when the server could not be reached at all. */
  status: number;
  /** The API's error code, or null when the response had no `ApiError` body or an unknown code. */
  code: ApiErrorCode | null;
  /** Message for the user: the API's own message, else a description of the HTTP status. */
  message: string;
  /**
   * Messages per request field, keyed by the dot path the API reports (`budgets.0.amount`). From
   * `validation_error` (`details[].path`) and `rule_violation` (`details.field`). An empty key means
   * the whole body.
   */
  fieldErrors: Record<string, string>;
  /** The rule a `rule_violation` broke. */
  rule: RuleViolationRule | null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(API_ERROR_STATUS));

/** What to tell the user for a status, used when the response has no usable `ApiError` body. */
export function describeStatus(status: number): string {
  if (status === 0) return "Can't reach the server. Check your connection and try again.";
  if (status === 400) return 'The request was not valid.';
  if (status === 401 || status === 403) return "You don't have access to that.";
  if (status === 404) return "That wasn't found.";
  if (status === 409) return 'That conflicts with the current data.';
  if (status === 422) return 'That breaks one of the rules.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  if (status >= 500) return 'The server ran into a problem. Try again in a moment.';
  return `The request failed (HTTP ${status}).`;
}

interface ErrorBody {
  code: string;
  message: string;
  details: unknown;
}

function readBody(body: unknown): ErrorBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const inner: unknown = (body as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return null;
  const { code, message, details } = inner as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message, details };
}

function collectValidationIssues(details: unknown, into: Record<string, string>): void {
  if (!Array.isArray(details)) return;
  for (const issue of details as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as Record<string, unknown>;
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    into[path] ??= message;
  }
}

/**
 * Turns whatever a failed request threw into a message plus per-field errors. Understands the
 * `ApiError` body; for any other response (or an error code this client does not know) it falls back
 * to the HTTP status.
 */
export function parseApiError(error: unknown): ParsedApiError {
  if (error instanceof HttpErrorResponse) {
    const status = error.status;
    const body = readBody(error.error);
    if (body === null) {
      return { status, code: null, message: describeStatus(status), fieldErrors: {}, rule: null };
    }

    const code = KNOWN_CODES.has(body.code) ? (body.code as ApiErrorCode) : null;
    const message = body.message.trim() || describeStatus(status);
    const fieldErrors: Record<string, string> = {};
    let rule: RuleViolationRule | null = null;

    if (code === 'validation_error') collectValidationIssues(body.details, fieldErrors);
    if (code === 'rule_violation' && typeof body.details === 'object' && body.details !== null) {
      const details = body.details as Record<string, unknown>;
      if (typeof details['rule'] === 'string') rule = details['rule'] as RuleViolationRule;
      const field = details['field'];
      if (typeof field === 'string' && field !== '') fieldErrors[field] = message;
    }
    return { status, code, message, fieldErrors, rule };
  }

  const message = error instanceof Error && error.message ? error.message : describeStatus(0);
  return { status: 0, code: null, message, fieldErrors: {}, rule: null };
}

/** True for a failed request whose body is an `ApiError` with this code. */
export function hasApiErrorCode(error: unknown, code: ApiErrorCode): boolean {
  return error instanceof HttpErrorResponse && readBody(error.error)?.code === code;
}

/**
 * The `details` of a failed request's `ApiError` body, untyped: what they hold depends on the code
 * (`OutstandingChangedDetails` for `outstanding_changed`), so the caller checks the shape. undefined
 * when the error is not an `ApiError` or carries no details.
 */
export function apiErrorDetails(error: unknown): unknown {
  return error instanceof HttpErrorResponse ? readBody(error.error)?.details : undefined;
}

/** 409 `not_onboarded`: the settings do not exist, so the app must send the user to onboarding. */
export function isNotOnboardedError(error: unknown): boolean {
  return (
    error instanceof HttpErrorResponse &&
    error.status === 409 &&
    hasApiErrorCode(error, 'not_onboarded')
  );
}
