import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { parseApiError } from '../../core/api-error';
import { apiError, httpError } from '../../../testing/harness';
import { applyApiErrors, focusFirstInvalid } from './api-errors';

function form() {
  return new FormGroup({
    startMonth: new FormControl('2026-10'),
    salary: new FormControl<number | null>(null),
    budgets: new FormArray([
      new FormGroup({ name: new FormControl('Rent'), amount: new FormControl<number | null>(1) }),
      new FormGroup({ name: new FormControl('Fun'), amount: new FormControl<number | null>(2) }),
    ]),
  });
}

describe('applyApiErrors', () => {
  it('puts each validation message on the control at its dot path, including form array rows', () => {
    const f = form();
    const parsed = parseApiError(
      httpError(
        400,
        apiError('validation_error', 'Invalid request body', [
          { path: 'salary', message: 'Amount must not be negative' },
          { path: 'budgets.1.amount', message: 'Amount out of range' },
        ]),
      ),
    );

    const leftover = applyApiErrors(f, parsed);

    expect(leftover).toBeNull();
    expect(f.controls.salary.errors).toEqual({ server: 'Amount must not be negative' });
    expect(f.controls.salary.touched).toBe(true);
    expect(f.get('budgets.1.amount')?.errors).toEqual({ server: 'Amount out of range' });
    expect(f.get('budgets.0.amount')?.errors).toBeNull();
  });

  it('puts a rule violation on the field it names', () => {
    const f = form();
    const parsed = parseApiError(
      httpError(
        422,
        apiError('rule_violation', 'Start month is after the current month', {
          rule: 'start_month_in_future',
          field: 'startMonth',
        }),
      ),
    );

    expect(applyApiErrors(f, parsed)).toBeNull();
    expect(f.controls.startMonth.errors).toEqual({
      server: 'Start month is after the current month',
    });
  });

  it('returns what it could not place: fields the form does not have, and the whole body', () => {
    const f = form();
    const parsed = parseApiError(
      httpError(
        400,
        apiError('validation_error', 'Invalid request body', [
          { path: 'nickname', message: 'Unrecognized key' },
          { path: '', message: 'Body must be an object' },
          { path: 'salary', message: 'Required' },
        ]),
      ),
    );

    expect(applyApiErrors(f, parsed)).toBe('Unrecognized key Body must be an object');
    expect(f.controls.salary.errors).toEqual({ server: 'Required' });
  });

  it('returns the general message when the API named no field', () => {
    const f = form();
    const parsed = parseApiError(httpError(409, apiError('already_onboarded', 'Already set up')));

    expect(applyApiErrors(f, parsed)).toBe('Already set up');
    expect(f.valid).toBe(true);
  });

  it('is over once the field has been edited, even if the rejected value is typed again', () => {
    const f = form();
    f.controls.salary.setValue(100);
    applyApiErrors(
      f,
      parseApiError(
        httpError(422, apiError('rule_violation', 'Too early', { rule: 'x', field: 'salary' })),
      ),
    );
    expect(f.controls.salary.errors).toEqual({ server: 'Too early' });

    f.controls.salary.setValue(200);
    expect(f.controls.salary.errors).toBeNull();

    // The situation may have changed on the server: this is a new attempt, not the old one.
    f.controls.salary.setValue(100);
    expect(f.controls.salary.errors).toBeNull();
    expect(f.valid).toBe(true);
  });

  it('keeps the error through a revalidation that leaves the value alone (a control bound again)', () => {
    const f = form();
    applyApiErrors(
      f,
      parseApiError(
        httpError(400, apiError('validation_error', 'x', [{ path: 'salary', message: 'Nope' }])),
      ),
    );

    f.controls.salary.updateValueAndValidity({ emitEvent: false });

    expect(f.controls.salary.errors).toEqual({ server: 'Nope' });
  });

  it('replaces an earlier server error on the same control', () => {
    const f = form();
    const reject = (message: string) =>
      applyApiErrors(
        f,
        parseApiError(
          httpError(400, apiError('validation_error', 'x', [{ path: 'salary', message }])),
        ),
      );

    reject('First');
    reject('Second');

    expect(f.controls.salary.errors).toEqual({ server: 'Second' });
    f.controls.salary.setValue(5);
    expect(f.controls.salary.errors).toBeNull();
  });

  it('makes the form invalid until the user edits the field', () => {
    const f = form();
    applyApiErrors(
      f,
      parseApiError(
        httpError(400, apiError('validation_error', 'x', [{ path: 'salary', message: 'Nope' }])),
      ),
    );
    expect(f.invalid).toBe(true);

    f.controls.salary.setValue(5);
    expect(f.controls.salary.errors).toBeNull();
    expect(f.valid).toBe(true);
  });
});

describe('focusFirstInvalid', () => {
  it('focuses the first control marked invalid', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<input id="a"><input id="b" aria-invalid="true"><input id="c" aria-invalid="true">';
    document.body.append(root);

    expect(focusFirstInvalid(root)).toBe(true);
    expect(document.activeElement?.id).toBe('b');
    root.remove();
  });

  it('says so when nothing is invalid', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input id="a">';
    expect(focusFirstInvalid(root)).toBe(false);
  });
});
