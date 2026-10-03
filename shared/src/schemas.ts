import { z } from 'zod';
import {
  DESCRIPTION_MAX_LENGTH,
  ICON_MAX_LENGTH,
  MAX_CENTS,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
} from './limits';
import { isMonthKey } from './month';

// The constants live in './limits' (no zod); they are re-exported so existing imports keep working.
export {
  DESCRIPTION_MAX_LENGTH,
  ICON_MAX_LENGTH,
  MAX_CENTS,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
} from './limits';

// ---------------------------------------------------------------------------------------------
// Money, months, dates, ids
// ---------------------------------------------------------------------------------------------

/** Integer cents, |value| <= MAX_CENTS. */
export const centsSchema = z
  .number()
  .int()
  .refine((value) => Math.abs(value) <= MAX_CENTS, 'Amount out of range');
export const positiveCentsSchema = centsSchema.refine((v) => v > 0, 'Amount must be positive');
export const nonNegativeCentsSchema = centsSchema.refine(
  (v) => v >= 0,
  'Amount must not be negative',
);
export const nonZeroCentsSchema = centsSchema.refine((v) => v !== 0, 'Amount must not be zero');

export const monthKeySchema = z.string().refine(isMonthKey, 'Expected a month in YYYY-MM format');

/** A real calendar date in YYYY-MM-DD format (2026-02-30 is rejected). */
export const isoDateSchema = z.iso.date();

/** An id taken from a path or query string ("12" becomes 12). Do not use it for JSON bodies. */
export const idSchema = z.coerce.number().int().positive();

/** An id inside a JSON body. Strictly a positive integer: no string or boolean coercion. */
export const idRefSchema = z.number().int().positive();

/**
 * Signed whole cents taken from a query string ("-500", "0", "1250"): an optional minus sign and
 * digits, with no spaces, no sign other than "-", no leading zeros, no exponent and no decimals.
 * Unlike `z.coerce.number()` it never reads a blank value as 0, which would quietly turn
 * `?minAmount=` into a real bound. A number is accepted as it is (and |value| <= MAX_CENTS, like
 * every amount).
 */
export const queryCentsSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && /^(?:0|-?[1-9]\d*)$/.test(value) ? Number(value) : value,
  centsSchema,
);

// ---------------------------------------------------------------------------------------------
// Path parameters (validate `req.params` with these)
// ---------------------------------------------------------------------------------------------

/** Path `/:id`. */
export const idParamsSchema = z.strictObject({ id: idSchema });
/** Path `/:month`. */
export const monthParamsSchema = z.strictObject({ month: monthKeySchema });
/** Path `/:id/<something>/:month`. */
export const idMonthParamsSchema = z.strictObject({ id: idSchema, month: monthKeySchema });

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** A required display name: trimmed, 1 to NAME_MAX_LENGTH characters. */
export const nameSchema = z.string().trim().min(1, 'Name is required').max(NAME_MAX_LENGTH);

/** A short label: trimmed, 0 to DESCRIPTION_MAX_LENGTH characters. Add `.min(1)` to require one. */
export const descriptionSchema = z.string().trim().max(DESCRIPTION_MAX_LENGTH);

/** Free text: trimmed, up to NOTES_MAX_LENGTH characters. Empty or blank text becomes null. */
export const notesSchema = z
  .string()
  .trim()
  .max(NOTES_MAX_LENGTH)
  .transform((value) => (value === '' ? null : value));

/** A hex color such as "#3b82f6". Stored lower-case. Send null (not "") for "no color". */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color like #3b82f6')
  .transform((value) => value.toLowerCase());

/** An icon key or an emoji: 1 to ICON_MAX_LENGTH characters. Send null (not "") for "no icon". */
export const iconSchema = z.string().trim().min(1, 'Icon must not be empty').max(ICON_MAX_LENGTH);

// ---------------------------------------------------------------------------------------------
// PATCH bodies
// ---------------------------------------------------------------------------------------------

/** `.refine(hasAnyKey, AT_LEAST_ONE_FIELD)` on a PATCH schema whose fields are all optional. */
export const hasAnyKey = (value: object): boolean => Object.keys(value).length > 0;
export const AT_LEAST_ONE_FIELD = 'At least one field is required';
