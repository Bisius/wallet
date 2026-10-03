import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { ParsedApiError } from '../../core/api-error';

/** The server error currently attached to a control, so the next one replaces it. */
const attached = new WeakMap<AbstractControl, ValidatorFn>();

/**
 * Rejects the value the control holds *now*, with `message`. Angular revalidates a control whenever
 * it is bound to a new directive (a wizard step that is shown again), which would wipe an error put
 * there with `setErrors`. A validator survives that: the error stays while the control still holds
 * the rejected value, and is over for good as soon as the user edits it. (Typing the old value again
 * is a new attempt, which the API may now accept: its situation may have changed since.)
 */
function rejectCurrentValue(control: AbstractControl, message: string): void {
  const previous = attached.get(control);
  if (previous) control.removeValidators(previous);

  const rejected: unknown = control.value;
  let over = false;
  const validator: ValidatorFn = (candidate): ValidationErrors | null => {
    if (over) return null;
    if (Object.is(candidate.value, rejected)) return { server: message };
    over = true;
    return null;
  };
  attached.set(control, validator);

  control.addValidators(validator);
  control.markAsTouched();
  control.updateValueAndValidity();
}

/**
 * Puts what the API said on the form: each field error becomes a `server` error on the control with
 * that dot path (`budgets.0.amount` finds the control in a form array), shown by its `Field`. The
 * error disappears when the user edits that control.
 *
 * Returns what could not be put on a control, to show at the top of the form: the messages of fields
 * the form does not have, or the general message when the API named no field at all. Null when
 * every message found its field.
 */
export function applyApiErrors(form: AbstractControl, error: ParsedApiError): string | null {
  const unplaced: string[] = [];
  let placed = 0;

  for (const [path, message] of Object.entries(error.fieldErrors)) {
    const control = path === '' ? null : form.get(path);
    if (!control) {
      unplaced.push(message);
      continue;
    }
    rejectCurrentValue(control, message);
    placed++;
  }

  if (unplaced.length > 0) return unplaced.join(' ');
  return placed > 0 ? null : error.message;
}

/** Moves focus to the first control showing an error. Call it after the error has rendered. */
export function focusFirstInvalid(root: HTMLElement): boolean {
  const control = root.querySelector<HTMLElement>('[aria-invalid="true"]');
  control?.focus();
  return control !== null;
}
