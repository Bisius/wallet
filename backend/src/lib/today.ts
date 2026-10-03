import { type IsoDate, type MonthKey, toMonthKey } from '@wallet/shared';
import type { Clock } from './clock';

/**
 * The one place that turns the clock's instant into a calendar date. "Today" is the date the
 * instant falls on in the SERVER'S LOCAL TIME ZONE (the `TZ` environment variable decides it, as
 * docs/DOMAIN.md says), not the UTC date: at 23:30 UTC on 31 March a server in Rome (UTC+2) is
 * already on 1 April. Everything that needs today or the current month calls these helpers.
 */
export function todayOf(clock: Clock): IsoDate {
  const now = clock.now();
  const month = toMonthKey(now.getFullYear(), now.getMonth() + 1);
  return `${month}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The current month of docs/DOMAIN.md: the month of `todayOf(clock)`. */
export function currentMonthOf(clock: Clock): MonthKey {
  return monthOfDate(todayOf(clock));
}

/** The month of a `YYYY-MM-DD` date: its first 7 characters. */
export function monthOfDate(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

/** The 1st of a month, as a date. */
export function firstDayOf(month: MonthKey): IsoDate {
  return `${month}-01`;
}

/**
 * Inclusive bounds that select exactly the dates of `month` when compared as strings
 * (`date >= from && date <= to`). `to` is "-31" for every month: no real date of a shorter month
 * sorts above it, so it is a valid upper bound without a calendar lookup.
 */
export function monthBounds(month: MonthKey): { from: IsoDate; to: IsoDate } {
  return { from: `${month}-01`, to: `${month}-31` };
}

/** UTC ISO-8601 timestamp for the `createdAt`/`updatedAt` columns, taken from the injected clock. */
export function timestampOf(clock: Clock): string {
  return clock.now().toISOString();
}
