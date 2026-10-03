import { MAX_MONTHS_AHEAD } from '@wallet/shared/limits';
// Zod-free deep imports: they keep zod out of the initial bundle.
import { addMonths, parseMonthKey, type MonthKey } from '@wallet/shared/month';

/** Query parameter that carries the year of the report (`/report?year=2026`). */
export const YEAR_PARAM = 'year';

/** The year a query value names: four digits, 0001 or later. null for anything else. */
export function parseYear(value: string | null): number | null {
  if (value === null || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 1 ? year : null;
}

/** The calendar year of a month: `2026-10` is 2026. */
export function yearOf(month: MonthKey): number {
  return parseMonthKey(month).year;
}

/** The years a report can have months in: from the start month's year to the horizon's. */
export function yearBounds(
  startMonth: MonthKey | undefined,
  currentMonth: MonthKey,
): { min: number; max: number } {
  return {
    min: startMonth === undefined ? yearOf(currentMonth) : yearOf(startMonth),
    max: yearOf(addMonths(currentMonth, MAX_MONTHS_AHEAD)),
  };
}
