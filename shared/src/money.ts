/**
 * Money is always stored and transported as an integer number of minor units (cents).
 * Never use floating point amounts for arithmetic; convert at the UI edge only.
 */
export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Parses a user-entered decimal string ("12.5", "12,50", "-3") into cents. Returns null if invalid. */
export function parseCents(input: string): Cents | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return sign ? -cents : cents;
}

export function formatCents(cents: Cents, currency = 'EUR', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0);
}
