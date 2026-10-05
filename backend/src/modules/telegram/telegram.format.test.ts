import { formatCents } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import { withTimeZone } from '../../testing/helpers';
import { formatDay, formatMoney, formatMonth } from './telegram.format';

const EUR = { currency: 'EUR', locale: 'en-US' };

describe('formatMoney', () => {
  it('formats integer cents in the currency and the locale of the settings', () => {
    expect(formatMoney(2340, EUR)).toBe('€23.40');
    expect(formatMoney(2340, { currency: 'EUR', locale: 'de-DE' })).toMatch(/^23,40\s€$/);
    expect(formatMoney(123456, { currency: 'USD', locale: 'en-US' })).toBe('$1,234.56');
    expect(formatMoney(1234567, { currency: 'EUR', locale: 'it-IT' })).toMatch(/^12\.345,67\s€$/);
  });

  it('keeps the sign, the zero and the small amounts', () => {
    expect(formatMoney(0, EUR)).toBe('€0.00');
    expect(formatMoney(5, EUR)).toBe('€0.05');
    expect(formatMoney(100, EUR)).toBe('€1.00');
    expect(formatMoney(-1240, EUR)).toBe('-€12.40');
    expect(formatMoney(-5, EUR)).toBe('-€0.05');
  });

  it('is exact to the cent for every safe integer, where a float quotient is not', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, EUR)).toBe('€90,071,992,547,409.91');
    expect(formatMoney(-Number.MAX_SAFE_INTEGER, EUR)).toBe('-€90,071,992,547,409.91');
    expect(formatMoney(1_000_000_000_001, EUR)).toBe('€10,000,000,000.01');
  });

  it('agrees with the formatter of the shared package wherever that one is exact', () => {
    for (let cents = -250_000; cents <= 250_000; cents += 137) {
      expect(formatMoney(cents, EUR)).toBe(formatCents(cents, 'EUR', 'en-US'));
    }
  });

  it('refuses what is not a whole number of cents', () => {
    expect(() => formatMoney(12.5, EUR)).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, EUR)).toThrow(RangeError);
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 2, EUR)).toThrow(RangeError);
  });

  it('falls back to plain digits and the code for a currency or locale Intl cannot use', () => {
    expect(formatMoney(1234, { currency: 'EU', locale: 'en-US' })).toBe('12.34 EU');
    expect(formatMoney(-1234, { currency: 'eur!', locale: 'en-US' })).toBe('-12.34 eur!');
  });
});

describe('formatDay', () => {
  it('writes the weekday, the day and the month the way the locale does', () => {
    expect(formatDay('2026-10-05', { locale: 'en-GB' })).toBe('Mon 5 Oct');
    expect(formatDay('2026-10-05', { locale: 'en-US' })).toBe('Mon, Oct 5');
    expect(formatDay('2026-09-30', { locale: 'en-GB' })).toBe('Wed 30 Sept');
  });

  it('is a calendar date: no time zone moves it', async () => {
    for (const timeZone of [
      'UTC',
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
      'America/Los_Angeles',
    ]) {
      expect(await withTimeZone(timeZone, () => formatDay('2026-03-01', { locale: 'en-GB' }))).toBe(
        'Sun 1 Mar',
      );
    }
  });

  it('handles a leap day', () => {
    expect(formatDay('2028-02-29', { locale: 'en-GB' })).toBe('Tue 29 Feb');
  });

  it('falls back to English for a locale that Intl refuses', () => {
    expect(formatDay('2026-10-05', { locale: 'xx_invalid' })).toBe('Mon, Oct 5');
  });
});

describe('formatMonth', () => {
  it('names the month, with the year on request', () => {
    expect(formatMonth('2026-10', { locale: 'en-US' })).toBe('October');
    expect(formatMonth('2026-10', { locale: 'en-US' }, true)).toBe('October 2026');
    expect(formatMonth('2026-01', { locale: 'en-US' }, true)).toBe('January 2026');
    expect(formatMonth('2026-12', { locale: 'de-DE' })).toBe('Dezember');
  });

  it('is not moved by the time zone', async () => {
    expect(
      await withTimeZone('Pacific/Kiritimati', () => formatMonth('2026-03', { locale: 'en-US' })),
    ).toBe('March');
    expect(
      await withTimeZone('Pacific/Pago_Pago', () => formatMonth('2026-03', { locale: 'en-US' })),
    ).toBe('March');
  });
});
