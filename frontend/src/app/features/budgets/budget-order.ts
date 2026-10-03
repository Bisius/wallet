/** The part of a budget that decides its place in the list. */
export interface Placed {
  id: number;
  sortOrder: number;
}

/** One `PATCH /api/budgets/:id { sortOrder }` to send. */
export interface SortOrderChange {
  id: number;
  sortOrder: number;
}

/** How far apart a whole list is numbered again. The API spaces new budgets the same way. */
export const SORT_ORDER_STEP = 10;

/**
 * The changes that make budget `id` trade places with `neighbourId`, the card next to it. The API
 * orders budgets by `sortOrder`, then by id, and has no "reorder" call, so a move is a `PATCH` of
 * `sortOrder`.
 *
 * The usual case swaps the two `sortOrder` values: two changes, and nothing else moves (budgets
 * that are not shown on the page, such as archived ones, keep their numbers). When both have the
 * same value (the API allows ties) a swap changes nothing, so the whole list is numbered again in
 * steps of 10 with the two exchanged, and only the budgets whose number changed are returned.
 *
 * `items` are all the budgets, as the API lists them. An unknown id gives no changes.
 */
export function planSwap(
  items: readonly Placed[],
  id: number,
  neighbourId: number,
): SortOrderChange[] {
  const a = items.find((item) => item.id === id);
  const b = items.find((item) => item.id === neighbourId);
  if (!a || !b || a.id === b.id) return [];

  if (a.sortOrder !== b.sortOrder) {
    return [
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: a.sortOrder },
    ];
  }

  const ordered = [...items].sort((x, y) => x.sortOrder - y.sortOrder || x.id - y.id);
  const swapped = ordered.map((item) => (item.id === a.id ? b : item.id === b.id ? a : item));
  return swapped
    .map((item, index): SortOrderChange => ({ id: item.id, sortOrder: index * SORT_ORDER_STEP }))
    .filter(
      (change) => items.find((item) => item.id === change.id)?.sortOrder !== change.sortOrder,
    );
}
