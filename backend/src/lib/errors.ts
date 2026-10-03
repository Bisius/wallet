import {
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  type RuleViolationDetails,
  type RuleViolationRule,
} from '@wallet/shared';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

/** An `HttpError` with the status that goes with `code` (`API_ERROR_STATUS`), so they cannot disagree. */
export const apiError = (code: ApiErrorCode, message: string, details?: unknown) =>
  new HttpError(API_ERROR_STATUS[code], code, message, details);

/**
 * 422 `rule_violation`: well-formed input that breaks a rule of docs/DOMAIN.md. `field` names the
 * request field (dot notation, or the path parameter such as "month") the UI can attach it to.
 */
export function ruleViolation(rule: RuleViolationRule, message: string, field?: string) {
  const details: RuleViolationDetails = field === undefined ? { rule } : { rule, field };
  return apiError('rule_violation', message, details);
}

export const notOnboarded = () =>
  apiError('not_onboarded', 'Setup is not finished: complete onboarding first');

export const alreadyOnboarded = () =>
  apiError('already_onboarded', 'Wallet is already set up: the settings exist');

export const hasHistory = (what: string) =>
  apiError('has_history', `${what} has spendings or transfers; archive it instead of deleting it`);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let body: ApiError;
  let status: number;

  if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  } else if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: { code: 'invalid_json', message: 'Request body is not valid JSON' } };
  } else {
    console.error(err);
    status = 500;
    body = { error: { code: 'internal_error', message: 'Something went wrong' } };
  }

  res.status(status).json(body);
};
