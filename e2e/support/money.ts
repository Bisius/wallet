/*
 * Expected money, as the app writes it for the harness's settings (EUR, en-US). Specs keep their test
 * data and their hand calculations in integer cents and turn the result into the text a user reads
 * only at the edge, in an assertion. Integer arithmetic on purpose: no Intl and no division of the
 * amount, so it cannot share a mistake with the code under test.
 */

/** `123456` -> `€1,234.56`, `-5000` -> `-€50.00` (a minus sign before the currency symbol). */
export function eur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}€${grouped}.${String(fraction).padStart(2, '0')}`;
}

/** Like `eur`, with a plus sign for a positive amount, as the app writes money that came in. */
export function signedEur(cents: number): string {
  return cents > 0 ? `+${eur(cents)}` : eur(cents);
}

/** The way a plain amount is typed into a money field: `4550` -> `45.50`. */
export function typed(cents: number): string {
  return eur(cents).replace(/^-?€/, '').replace(/,/g, '');
}

/** Escapes text for use inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
