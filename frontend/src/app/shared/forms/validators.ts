import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { MonthKey } from '@wallet/shared/month';
import { formatMonth } from '../format';

/** The part of a zod schema that `zodValidator` needs. */
export interface Parser {
  safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } };
}

/**
 * Validates a control with a schema from `@wallet/shared`, so the form follows the same rules as the
 * API (and says the same thing). An empty value is left to `Validators.required`.
 */
export function zodValidator(schema: Parser): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    if (value === null || value === undefined || value === '') return null;
    const result = schema.safeParse(value);
    if (result.success) return null;
    return { schema: { message: result.error?.issues[0]?.message ?? 'This value is not valid.' } };
  };
}

/** For a money control (cents or null): zero or more. */
export const nonNegativeAmount: ValidatorFn = (control) => {
  const value: unknown = control.value;
  return typeof value === 'number' && value < 0
    ? { amount: { message: 'Enter an amount of zero or more.' } }
    : null;
};

/** For a money control (cents or null): more than zero. */
export const positiveAmount: ValidatorFn = (control) => {
  const value: unknown = control.value;
  return typeof value === 'number' && value <= 0
    ? { amount: { message: 'Enter an amount greater than zero.' } }
    : null;
};

/**
 * For a number control (or null): a whole number from 1 to 100. The API's own schema message is not
 * meant for users, so this one says it plainly.
 */
export const wholePercent: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (value === null || value === '') return null;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100
    ? null
    : { percent: { message: 'Enter a whole number from 1 to 100.' } };
};

/**
 * For a date control (`YYYY-MM-DD` or empty): the date has to be in `month`. The month and locale
 * are read each time the control is validated, because the month switcher can change them while a
 * form is open.
 */
export function dateInMonth(month: () => MonthKey, locale: () => string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value as string | null;
    if (!value || value.slice(0, 7) === month()) return null;
    return { date: { message: `Choose a date in ${formatMonth(month(), locale())}.` } };
  };
}
