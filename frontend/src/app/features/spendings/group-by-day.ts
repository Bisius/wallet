import type { IsoDate, SpendingDto } from '@wallet/shared';

/** The spendings of one day, in the order they came in. */
export interface DayGroup {
  date: IsoDate;
  items: SpendingDto[];
}

/**
 * Groups spendings that are already sorted by date (the API gives newest first) into one group per
 * day, keeping the order. Only neighbours are merged, so the order of the list is never changed.
 */
export function groupByDay(spendings: readonly SpendingDto[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const spending of spendings) {
    const last = groups.at(-1);
    if (last?.date === spending.date) last.items.push(spending);
    else groups.push({ date: spending.date, items: [spending] });
  }
  return groups;
}
