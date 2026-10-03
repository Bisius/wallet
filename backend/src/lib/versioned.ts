/**
 * Pure rules for "effective from month" rows (budget versions, subscription prices) and for the
 * lifecycle of the item that owns them. See docs/DOMAIN.md, "Versioned values". Nothing here
 * touches the database, so the rules are unit-tested on their own.
 *
 * Rows are never deleted by archive, cancel or a move of the start month (engineering decision,
 * 2026-10-02). A row is read as "the latest one effective at or before M" and only the months of
 * the item's active range are ever computed, so a row dated after the end month is inert (it
 * applies again if the end month moves later) and a row dated before the start month may be the
 * one in effect at the start month. The one edit left is `firstRowRedate`.
 */
import { type MonthKey, compareMonths } from '@wallet/shared';

/** Where a budget or subscription stands relative to the current month. */
export type LifecycleStatus = 'upcoming' | 'active' | 'ended';

/**
 * `upcoming` before the start month, `ended` after the end month, `active` in between. An item
 * whose end month is the current month is still `active`: the month is not over yet.
 */
export function lifecycleStatus(
  startMonth: MonthKey,
  endMonth: MonthKey | null,
  currentMonth: MonthKey,
): LifecycleStatus {
  if (currentMonth < startMonth) return 'upcoming';
  if (endMonth !== null && currentMonth > endMonth) return 'ended';
  return 'active';
}

/** True when `month` lies within `startMonth..endMonth` (no end month: never ends). */
export function isWithinActiveMonths(
  startMonth: MonthKey,
  endMonth: MonthKey | null,
  month: MonthKey,
): boolean {
  return month >= startMonth && (endMonth === null || month <= endMonth);
}

/** A stored row that takes effect from a month and holds until the next one. */
export interface EffectiveRow {
  effectiveMonth: MonthKey;
}

/**
 * The row in effect in `month`: the latest one with `effectiveMonth <= month`, or null when there
 * is none (the month is before the first row). `rows` must be in ascending month order.
 */
export function effectiveAt<T extends EffectiveRow>(rows: readonly T[], month: MonthKey): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (row.effectiveMonth > month) break;
    found = row;
  }
  return found;
}

/**
 * The row an item shows as its current one: the row in effect in `min(currentMonth, endMonth)`, so
 * an ended item shows its last row and a row dated after its end month (inert) is never shown.
 * null while the item is upcoming. `rows` must be in ascending month order.
 */
export function currentRow<T extends EffectiveRow>(
  rows: readonly T[],
  startMonth: MonthKey,
  endMonth: MonthKey | null,
  currentMonth: MonthKey,
): T | null {
  if (lifecycleStatus(startMonth, endMonth, currentMonth) === 'upcoming') return null;
  const asOf = endMonth !== null && endMonth < currentMonth ? endMonth : currentMonth;
  return effectiveAt(rows, asOf);
}

/**
 * The only change a move of an item's start month makes to its rows: moving it EARLIER than the
 * first row re-dates that first row to `newStart`, so that a row is in effect at the start month.
 * Returns the row to re-date, or null when nothing changes: moving the start later (or to any month
 * at or after the first row) leaves every row where it is. Rows are given in any order.
 *
 * Re-dating cannot collide with another row: the first row is the earliest one, and `newStart` is
 * before it.
 */
export function firstRowRedate(
  rows: readonly (EffectiveRow & { id: number })[],
  newStart: MonthKey,
): { id: number; to: MonthKey } | null {
  const first = [...rows].sort((a, b) => compareMonths(a.effectiveMonth, b.effectiveMonth))[0];
  if (!first || first.effectiveMonth <= newStart) return null;
  return { id: first.id, to: newStart };
}
