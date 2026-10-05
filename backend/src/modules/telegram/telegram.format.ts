/**
 * Formatting for the messages of the bot, shared by every file that writes one (the flows, the
 * commands and the notifications). Messages are English, and amounts and dates follow the currency
 * and the locale of Settings (docs/DOMAIN.md, "Formatting"). Owned by T1; T2 and T3 import it and do
 * not edit it.
 */
import type { Cents, IsoDate, MonthKey, SettingsDto } from '@wallet/shared';

/** The part of the settings that formatting needs. */
export type MessageFormat = Pick<SettingsDto, 'currency' | 'locale'>;

const moneyFormats = new Map<string, Intl.NumberFormat | null>();

function moneyFormat({ currency, locale }: MessageFormat): Intl.NumberFormat | null {
  const key = `${locale}|${currency}`;
  let format = moneyFormats.get(key);
  if (format === undefined) {
    try {
      format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    } catch {
      format = null; // an ill-formed currency or locale: plain digits and the code, below
    }
    moneyFormats.set(key, format);
  }
  return format;
}

/** Integer cents as a plain decimal string, exactly: `-123456` is "-1234.56". No float is involved. */
function decimalOf(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs - whole * 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * Cents as a currency amount ("€1,234.56", "-€12.40"). `Intl.NumberFormat` takes the exact decimal
 * text of the cents, so every safe integer prints right to the cent.
 */
export function formatMoney(cents: Cents, format: MessageFormat): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatMoney: cents must be a safe integer, got ${cents}`);
  }
  const decimal = decimalOf(cents);
  const formatter = moneyFormat(format);
  return formatter ? formatter.format(decimal as `${number}`) : `${decimal} ${format.currency}`;
}

/** Day and month as the locale writes them, with the weekday: "Mon 5 Oct" (en-GB), "Mon, Oct 5" (en-US). */
export function formatDay(date: IsoDate, { locale }: Pick<MessageFormat, 'locale'>): string {
  return intl(locale, { weekday: 'short', day: 'numeric', month: 'short' }, utcDate(date));
}

/** A month's name, "October" (or "October 2026" with `withYear`). */
export function formatMonth(
  month: MonthKey,
  { locale }: Pick<MessageFormat, 'locale'>,
  withYear = false,
): string {
  const options: Intl.DateTimeFormatOptions = withYear
    ? { month: 'long', year: 'numeric' }
    : { month: 'long' };
  return intl(locale, options, utcDate(`${month}-01`));
}

/** A calendar date as an instant at midnight UTC: formatted in UTC again, no time zone moves it. */
function utcDate(date: IsoDate): Date {
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  );
}

function intl(locale: string, options: Intl.DateTimeFormatOptions, date: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
  }
}
