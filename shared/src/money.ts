/**
 * Money is always stored and transported as an integer number of minor units (cents).
 * Never use floating point amounts for arithmetic; convert at the UI edge only.
 */
export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Parses a user-entered decimal string ("12.5", "12,50", "-3") into cents. Returns null if invalid,
 * and also when the amount is not a safe integer number of cents (a long run of digits would
 * otherwise come back inexact). "-0" is 0, never a negative zero.
 */
export function parseCents(input: string): Cents | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  // BigInt keeps the arithmetic exact however many digits were typed.
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return sign && cents !== 0n ? -Number(cents) : Number(cents);
}

export function formatCents(cents: Cents, currency = 'EUR', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Division rounded UP to the next integer: the smallest integer q with q * denominator >= numerator.
 * Exact integer math (the `%` operator, never a float quotient), so it is right for every safe
 * integer. `numerator` is any safe integer (a negative one rounds towards zero, e.g. -7 / 3 is -2);
 * `denominator` must be a positive safe integer, otherwise a `RangeError` is thrown.
 *
 * This is the rounding of docs/DOMAIN.md: the yearly reserve contribution and the monthly
 * equivalent of a yearly price (100.00 / 12 shows as 8.34).
 */
export function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError(`ceilDiv: numerator must be a safe integer, got ${numerator}`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`ceilDiv: denominator must be a positive integer, got ${denominator}`);
  }
  const remainder = numerator % denominator;
  // `numerator - remainder` is an exact multiple of the denominator, so this division is exact.
  return (numerator - remainder) / denominator + (remainder > 0 ? 1 : 0);
}

/**
 * Splits `total` into `parts` integer parts that differ by at most 1 and sum exactly to `total`.
 * The remainder goes to the first parts, so the larger parts come first:
 * `splitEvenly(10000, 12)` is 8.34 four times, then 8.33 eight times. A negative total splits the
 * same way (`splitEvenly(-10, 3)` is [-3, -3, -4]). `total` must be a safe integer and `parts` a
 * positive safe integer, otherwise a `RangeError` is thrown. Exact for every safe total, at both
 * ends of the range.
 */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`splitEvenly: total must be a safe integer, got ${total}`);
  }
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new RangeError(`splitEvenly: parts must be a positive integer, got ${parts}`);
  }
  // `%` keeps the sign of the total, so |remainder| < parts and `total - remainder` moves TOWARDS
  // zero: it is a safe integer and an exact multiple of `parts`, so the division is exact. (Taking
  // a non-negative remainder first would subtract from a negative total and leave the safe range
  // near -Number.MAX_SAFE_INTEGER.)
  let remainder = total % parts;
  let base = (total - remainder) / parts;
  if (remainder < 0) {
    // Floor semantics for a negative total: one part less, and the shortfall is handed out below.
    base -= 1;
    remainder += parts;
  }
  return Array.from({ length: parts }, (_unused, index) => (index < remainder ? base + 1 : base));
}
