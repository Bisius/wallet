import { HttpErrorResponse } from '@angular/common/http';
import {
  apiErrorDetails,
  describeStatus,
  hasApiErrorCode,
  isNotOnboardedError,
  parseApiError,
} from './api-error';
import { apiError, httpError } from '../../testing/harness';

describe('parseApiError', () => {
  it('reads the message of an ApiError body', () => {
    const parsed = parseApiError(httpError(404, apiError('not_found', 'Budget 7 not found')));
    expect(parsed).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Budget 7 not found',
      fieldErrors: {},
      rule: null,
    });
  });

  it('maps validation_error details to field errors by path', () => {
    const parsed = parseApiError(
      httpError(
        400,
        apiError('validation_error', 'Invalid request body', [
          { path: 'budgets.0.amount', message: 'Amount must not be negative' },
          { path: 'startMonth', message: 'Expected a month in YYYY-MM format' },
          { path: 'startMonth', message: 'a second message for the same field is ignored' },
          { path: '', message: 'Unrecognized key' },
        ]),
      ),
    );
    expect(parsed.code).toBe('validation_error');
    expect(parsed.message).toBe('Invalid request body');
    expect(parsed.fieldErrors).toEqual({
      'budgets.0.amount': 'Amount must not be negative',
      startMonth: 'Expected a month in YYYY-MM format',
      '': 'Unrecognized key',
    });
  });

  it('maps a rule_violation to its field and keeps the rule', () => {
    const parsed = parseApiError(
      httpError(
        422,
        apiError('rule_violation', 'Start month is after the current month', {
          rule: 'start_month_in_future',
          field: 'startMonth',
        }),
      ),
    );
    expect(parsed.code).toBe('rule_violation');
    expect(parsed.rule).toBe('start_month_in_future');
    expect(parsed.fieldErrors).toEqual({ startMonth: 'Start month is after the current month' });
  });

  it('keeps the rule of a rule_violation that names no field', () => {
    const parsed = parseApiError(
      httpError(422, apiError('rule_violation', 'Too early', { rule: 'before_start_month' })),
    );
    expect(parsed.rule).toBe('before_start_month');
    expect(parsed.fieldErrors).toEqual({});
    expect(parsed.message).toBe('Too early');
  });

  it('falls back to the HTTP status for a body that is not an ApiError', () => {
    const html = httpError(502, '<html>Bad gateway</html>');
    expect(parseApiError(html)).toMatchObject({
      status: 502,
      code: null,
      message: describeStatus(502),
      fieldErrors: {},
    });
    expect(parseApiError(httpError(500, { error: 'nope' })).message).toBe(describeStatus(500));
    expect(parseApiError(httpError(404, null)).message).toBe("That wasn't found.");
  });

  it('says the server cannot be reached for status 0', () => {
    const offline = new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') });
    const parsed = parseApiError(offline);
    expect(parsed.status).toBe(0);
    expect(parsed.message).toMatch(/can't reach the server/i);
  });

  it('keeps the server message for a code this client does not know, and the status for the rest', () => {
    const parsed = parseApiError(
      httpError(423, apiError('locked' as never, 'The wallet is locked for maintenance')),
    );
    expect(parsed.code).toBeNull();
    expect(parsed.status).toBe(423);
    expect(parsed.message).toBe('The wallet is locked for maintenance');

    // A known code with an empty message still says something useful.
    expect(parseApiError(httpError(409, apiError('has_history', '  '))).message).toBe(
      describeStatus(409),
    );
  });

  it('copes with errors that are not HTTP responses', () => {
    expect(parseApiError(new Error('boom')).message).toBe('boom');
    expect(parseApiError('what').message).toMatch(/can't reach the server/i);
    expect(parseApiError(undefined).fieldErrors).toEqual({});
  });
});

describe('describeStatus', () => {
  it.each([
    [0, /can't reach/i],
    [400, /not valid/i],
    [403, /access/i],
    [404, /wasn't found/i],
    [409, /conflicts/i],
    [422, /rules/i],
    [429, /too many/i],
    [503, /server ran into a problem/i],
    [418, /HTTP 418/],
  ])('describes status %i', (status, expected) => {
    expect(describeStatus(status)).toMatch(expected);
  });
});

describe('error code checks', () => {
  it('recognises the not_onboarded conflict, and only that', () => {
    const notOnboarded = httpError(409, apiError('not_onboarded', 'Finish onboarding first'));
    const hasHistory = httpError(409, apiError('has_history', 'Archive it instead'));
    expect(isNotOnboardedError(notOnboarded)).toBe(true);
    expect(isNotOnboardedError(hasHistory)).toBe(false);
    expect(isNotOnboardedError(httpError(404, apiError('not_found', 'x')))).toBe(false);
    expect(isNotOnboardedError(new Error('x'))).toBe(false);
    expect(hasApiErrorCode(hasHistory, 'has_history')).toBe(true);
  });
});

describe('apiErrorDetails', () => {
  it('gives the details of an ApiError body as they came', () => {
    const error = httpError(
      409,
      apiError('outstanding_changed', 'The amount changed', {
        month: '2026-09',
        outstanding: 33000,
      }),
    );
    expect(apiErrorDetails(error)).toEqual({ month: '2026-09', outstanding: 33000 });
  });

  it('is undefined without details, for a body that is not an ApiError, and for other errors', () => {
    expect(apiErrorDetails(httpError(404, apiError('not_found', 'x')))).toBeUndefined();
    expect(apiErrorDetails(httpError(500, 'oops'))).toBeUndefined();
    expect(apiErrorDetails(new Error('x'))).toBeUndefined();
  });
});
