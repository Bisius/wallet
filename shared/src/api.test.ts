import { describe, expect, it } from 'vitest';
import { API_ERROR_STATUS, type ApiErrorCode } from './api';

describe('API_ERROR_STATUS', () => {
  const expected: Record<ApiErrorCode, number> = {
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
    payload_too_large: 413,
    import_rows_rejected: 422,
    rule_violation: 422,
    internal_error: 500,
  };

  it.each(Object.entries(expected))('%s is HTTP %i', (code, status) => {
    expect(API_ERROR_STATUS[code as ApiErrorCode]).toBe(status);
  });

  it('has no other codes', () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual(Object.keys(expected).sort());
  });
});
