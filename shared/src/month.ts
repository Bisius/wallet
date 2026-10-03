/** A budgeting month, formatted as "YYYY-MM". */
export type MonthKey = string;

/** A calendar date with no time zone, as "YYYY-MM-DD". Its month is its first 7 characters. */
export type IsoDate = string;

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): value is MonthKey {
  return MONTH_KEY_RE.test(value);
}

export function toMonthKey(year: number, month: number): MonthKey {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Month key of a date, using the date's local calendar. */
export function monthKeyOf(date: Date): MonthKey {
  return toMonthKey(date.getFullYear(), date.getMonth() + 1);
}

export function parseMonthKey(key: MonthKey): { year: number; month: number } {
  if (!isMonthKey(key)) throw new Error(`Invalid month key: ${key}`);
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

export function addMonths(key: MonthKey, delta: number): MonthKey {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + delta;
  return toMonthKey(Math.floor(index / 12), (index % 12) + 1);
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Number of months from `from` to `to`: 0 when equal, negative when `to` is earlier. */
export function monthDiff(from: MonthKey, to: MonthKey): number {
  const a = parseMonthKey(from);
  const b = parseMonthKey(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Inclusive list of month keys from `from` to `to`. Empty if `from` is after `to`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let key = from; compareMonths(key, to) <= 0; key = addMonths(key, 1)) months.push(key);
  return months;
}

/** Number of days in a month (28 to 31, leap years included). */
export function daysInMonth(key: MonthKey): number {
  const { year, month } = parseMonthKey(key);
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0); // day 0 of the next month is the last day of this one
  return date.getUTCDate();
}

/**
 * The date of a billing day in `month`: the day of `anchorDate`, clamped to the length of the month
 * (31 becomes 30 in April, 28 or 29 in February). Only the day of `anchorDate` is read.
 */
export function billingDateIn(month: MonthKey, anchorDate: IsoDate): IsoDate {
  const day = Math.min(Number(anchorDate.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** The date `days` days after `date` (before it when negative). Calendar arithmetic, no time zone. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const result = new Date(0);
  result.setUTCFullYear(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + days,
  );
  return toIsoDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

/** Number of days from `from` to `to`: 0 when equal, negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const epochDay = (date: IsoDate): number => {
    const value = new Date(0);
    value.setUTCFullYear(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
    );
    return Math.round(value.getTime() / 86_400_000);
  };
  return epochDay(to) - epochDay(from);
}

function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${toMonthKey(year, month)}-${String(day).padStart(2, '0')}`;
}
