/** A budgeting month, formatted as "YYYY-MM". */
export type MonthKey = string;

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

/** Inclusive list of month keys from `from` to `to`. Empty if `from` is after `to`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let key = from; compareMonths(key, to) <= 0; key = addMonths(key, 1)) months.push(key);
  return months;
}
