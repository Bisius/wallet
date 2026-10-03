import { MAX_CENTS, SPENDING_SEARCH_MAX_LENGTH } from '@wallet/shared/limits';
import type { Cents } from '@wallet/shared/money';

/**
 * What narrows the spendings list, besides the month: the filters the bar edits. They live in the URL
 * (see `SpendingQuery`), so a filtered list can be bookmarked, survives a reload and follows the
 * browser's back and forward buttons.
 */
export interface SpendingFilters {
  /** Text to find in the description or the notes, trimmed. `''`: no search. */
  q: string;
  /** Only this budget. `null`: all of them. */
  budgetId: number | null;
  /** Only spendings that carry this tag. `null`: any. */
  tagId: number | null;
  /** Signed cents, as stored: a refund is negative. Both bounds are inclusive. `null`: no bound. */
  minAmount: Cents | null;
  maxAmount: Cents | null;
  /** Search every month, not only the selected one. */
  allMonths: boolean;
}

export const NO_FILTERS: SpendingFilters = {
  q: '',
  budgetId: null,
  tagId: null,
  minAmount: null,
  maxAmount: null,
  allMonths: false,
};

/** The query parameter of each filter. The names match the API's (`GET /api/spendings`) except `scope`. */
export const FILTER_PARAM = {
  q: 'q',
  budgetId: 'budgetId',
  tagId: 'tagId',
  minAmount: 'minAmount',
  maxAmount: 'maxAmount',
  allMonths: 'scope',
} as const satisfies Record<keyof SpendingFilters, string>;

/** The `scope` value that means every month. Anything else is the selected month. */
const ALL_MONTHS = 'all';

/** The message when the lower bound of the amount is above the upper one. */
export const RANGE_MESSAGE = "The minimum amount can't be above the maximum.";

// Strictly what the API takes (`idSchema`, `queryCentsSchema`): digits, no sign but "-", no leading
// zeros, nothing else. A hand-edited URL that says anything else is ignored.
const ID = /^[1-9]\d*$/;
const WHOLE_CENTS = /^(?:0|-?[1-9]\d*)$/;

function parseId(raw: string | null): number | null {
  if (raw === null || !ID.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function parseAmount(raw: string | null): Cents | null {
  if (raw === null || !WHOLE_CENTS.test(raw)) return null;
  const cents = Number(raw);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS ? cents : null;
}

/**
 * The filters a URL asks for. `read` gives the value of a query parameter, or null when it is not
 * there. A value that cannot be a filter (text that is not a number, an id of 0, a search longer than
 * the API takes) is ignored, as if it were not in the URL, so a mangled link still opens the page.
 */
export function filtersFromParams(read: (name: string) => string | null): SpendingFilters {
  const q = (read(FILTER_PARAM.q) ?? '').trim();
  return {
    q: q.length <= SPENDING_SEARCH_MAX_LENGTH ? q : '',
    budgetId: parseId(read(FILTER_PARAM.budgetId)),
    tagId: parseId(read(FILTER_PARAM.tagId)),
    minAmount: parseAmount(read(FILTER_PARAM.minAmount)),
    maxAmount: parseAmount(read(FILTER_PARAM.maxAmount)),
    allMonths: read(FILTER_PARAM.allMonths) === ALL_MONTHS,
  };
}

/**
 * The query parameters for some filters, for `Router.navigate`: a parameter is `null` when its filter
 * is off, which removes it from the URL. Only the filters in `patch` are covered.
 */
export function paramsFromFilters(patch: Partial<SpendingFilters>): Record<string, string | null> {
  const params: Record<string, string | null> = {};
  if (patch.q !== undefined) params[FILTER_PARAM.q] = patch.q.trim() === '' ? null : patch.q.trim();
  if (patch.budgetId !== undefined) {
    params[FILTER_PARAM.budgetId] = patch.budgetId === null ? null : String(patch.budgetId);
  }
  if (patch.tagId !== undefined) {
    params[FILTER_PARAM.tagId] = patch.tagId === null ? null : String(patch.tagId);
  }
  if (patch.minAmount !== undefined) {
    params[FILTER_PARAM.minAmount] = patch.minAmount === null ? null : String(patch.minAmount);
  }
  if (patch.maxAmount !== undefined) {
    params[FILTER_PARAM.maxAmount] = patch.maxAmount === null ? null : String(patch.maxAmount);
  }
  if (patch.allMonths !== undefined) {
    params[FILTER_PARAM.allMonths] = patch.allMonths ? ALL_MONTHS : null;
  }
  return params;
}

export function sameFilters(a: SpendingFilters, b: SpendingFilters): boolean {
  return (
    a.q === b.q &&
    a.budgetId === b.budgetId &&
    a.tagId === b.tagId &&
    a.minAmount === b.minAmount &&
    a.maxAmount === b.maxAmount &&
    a.allMonths === b.allMonths
  );
}

/** How many filters narrow the list: the search, the budget, the tag and each bound of the amount. */
export function narrowingCount(filters: SpendingFilters): number {
  return (
    (filters.q === '' ? 0 : 1) +
    (filters.budgetId === null ? 0 : 1) +
    (filters.tagId === null ? 0 : 1) +
    (filters.minAmount === null ? 0 : 1) +
    (filters.maxAmount === null ? 0 : 1)
  );
}

/** How many filters are on, for the count next to "Filters": the narrowing ones, and searching all months. */
export function activeCount(filters: SpendingFilters): number {
  return narrowingCount(filters) + (filters.allMonths ? 1 : 0);
}

/** A reason the API would refuse these filters (it answers 400), so they are not sent; else null. */
export function filtersProblem(filters: SpendingFilters): string | null {
  const { minAmount, maxAmount } = filters;
  return minAmount !== null && maxAmount !== null && minAmount > maxAmount ? RANGE_MESSAGE : null;
}
