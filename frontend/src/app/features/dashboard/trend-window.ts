import { addMonths, type MonthKey } from '@wallet/shared/month';
import type { MonthRange } from '../months/months.api';

/** How many months the trend chart shows at most. */
export const TREND_MONTHS = 12;

/**
 * The months the trend chart shows for a selected month: the `size` months that end with it, but
 * never any before `startMonth` (the first month Wallet tracks), so a young wallet gets a shorter
 * chart instead of a request the API would cut short. Before the settings have loaded (`startMonth`
 * unknown) the window is the full one.
 */
export function trendWindow(
  selected: MonthKey,
  startMonth: MonthKey | undefined,
  size = TREND_MONTHS,
): MonthRange {
  const earliest = addMonths(selected, -(size - 1));
  const from = startMonth !== undefined && earliest < startMonth ? startMonth : earliest;
  // A start month after the selected month cannot happen (the selection is kept inside the tracked
  // months), but a range that runs backwards would be a 400.
  return { from: from > selected ? selected : from, to: selected };
}
