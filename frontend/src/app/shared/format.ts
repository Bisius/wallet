// Zod-free deep import: keeps zod out of the initial bundle (see "exports" in shared/package.json).
import { isMonthKey, parseMonthKey, type IsoDate, type MonthKey } from '@wallet/shared/month';

const FALLBACK_LOCALE = 'en-US';

const monthFormats = {
  long: { month: 'long', year: 'numeric' },
  short: { month: 'short', year: 'numeric' },
  /** "Oct": the month alone, for a chart axis that writes the year apart. */
  monthOnly: { month: 'short' },
  /** "2026" */
  yearOnly: { year: 'numeric' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

const dateFormats = {
  /** "Fri, Oct 2, 2026" */
  full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  /** "Oct 2, 2026" */
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  /** "Fri, Oct 2" */
  day: { weekday: 'short', day: 'numeric', month: 'short' },
  /** "October 2": a day that repeats every year, so no year. */
  monthDay: { day: 'numeric', month: 'long' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type MonthStyle = keyof typeof monthFormats;
export type DateStyle = keyof typeof dateFormats;

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, key: string, options: Intl.DateTimeFormatOptions) {
  const cacheKey = `${locale}|${key}`;
  let format = cache.get(cacheKey);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    } catch {
      // An ill-formed locale tag must not break the page.
      format = new Intl.DateTimeFormat(FALLBACK_LOCALE, { ...options, timeZone: 'UTC' });
    }
    cache.set(cacheKey, format);
  }
  return format;
}

/** A calendar date at UTC midnight: a calendar date has no time zone, so UTC keeps it exact. */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

/**
 * `2026-10` as "October 2026" (`long`) or "Oct 2026" (`short`), in the given locale. `monthOnly` is
 * "Oct" and `yearOnly` "2026", for a chart axis that writes the two apart.
 */
export function formatMonth(month: MonthKey, locale: string, style: MonthStyle = 'long'): string {
  if (!isMonthKey(month)) return month;
  const { year, month: number } = parseMonthKey(month);
  return formatter(locale, `month-${style}`, monthFormats[style]).format(
    utcDate(year, number - 1, 1),
  );
}

/** `2026-10-02` as a readable date in the given locale. */
export function formatDate(date: IsoDate, locale: string, style: DateStyle = 'full'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return formatter(locale, `date-${style}`, dateFormats[style]).format(
    utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

/** The number of days in a month: 28 to 31. */
export function daysInMonth(month: MonthKey): number {
  const { year, month: number } = parseMonthKey(month);
  return utcDate(year, number, 0).getUTCDate();
}

/** `2026-10` → `2026-10-01`. */
export function firstDayOf(month: MonthKey): IsoDate {
  return `${month}-01`;
}

/** `2026-02` → `2026-02-28`. */
export function lastDayOf(month: MonthKey): IsoDate {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

/** The date itself when it is in the month, else the nearest day of that month. */
export function clampDateToMonth(date: IsoDate, month: MonthKey): IsoDate {
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  if (date < first) return first;
  if (date > last) return last;
  return date;
}

/**
 * The month itself when it lies between `min` and `max`, else the nearest of them. Either bound can
 * be left out (`null` or `undefined`): a budget that is not archived has no last month.
 */
export function clampMonth(
  month: MonthKey,
  min?: MonthKey | null,
  max?: MonthKey | null,
): MonthKey {
  if (min && month < min) return min;
  if (max && month > max) return max;
  return month;
}
