/**
 * A naive reference for the spendings search and the tags (docs/DOMAIN.md, "Tags and search"),
 * written from the doc alone and sharing nothing with the implementation: it does not import
 * `foldText`, and it never folds anything but with `toLowerCase()`.
 *
 * That is only the ground truth on a restricted alphabet, and the generators below stay inside it:
 * ASCII letters, digits, the space, `%` and `_`, and a few letters outside ASCII that have one
 * lower-case form and one upper-case form and no special mapping (é, ü, д, α). Text outside it
 * (Greek final sigma, ß, ligatures, other alphabets) is for the hand-picked tables, where the
 * expected answer is written down by hand.
 *
 * The reference is a plain filter over a list: every filter is an `&&`, the order is a sort, the
 * page is a slice and the totals are sums, so each rule can be read off the doc and checked by eye.
 */
import * as fc from 'fast-check';

export interface RefSpending {
  id: number;
  date: string;
  amount: number;
  budgetId: number;
  description: string;
  notes: string | null;
  /** Ascending, each once. */
  tagIds: number[];
}

export interface RefTag {
  id: number;
  name: string;
  color: string | null;
}

/** The parameters of `GET /api/spendings`, as the client means them (strings are not encoded yet). */
export interface RefQuery {
  month?: string;
  from?: string;
  to?: string;
  budgetId?: number;
  tagId?: number;
  q?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
  offset?: number;
}

export interface RefPage {
  items: RefSpending[];
  total: number;
  limit: number;
  offset: number;
  totalAmount: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SEARCH_LENGTH = 100;

/**
 * What the doc says of the query itself: a bad query is a 400. `month` and `from`/`to` exclude each
 * other, `from` is not after `to`, `minAmount` is not above `maxAmount`, `q` has 1 to 100
 * characters once trimmed, `limit` is 1 to 200 and `offset` is not negative.
 */
export function isValidQuery(query: RefQuery): boolean {
  if (query.month !== undefined && (query.from !== undefined || query.to !== undefined))
    return false;
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) return false;
  if (
    query.minAmount !== undefined &&
    query.maxAmount !== undefined &&
    query.minAmount > query.maxAmount
  ) {
    return false;
  }
  if (query.q !== undefined) {
    const length = [...query.q.trim()].length;
    if (length < 1 || length > MAX_SEARCH_LENGTH) return false;
  }
  if (query.limit !== undefined && !(query.limit >= 1 && query.limit <= MAX_LIMIT)) return false;
  if (query.offset !== undefined && !(query.offset >= 0)) return false;
  return true;
}

/**
 * The page the doc demands: the spendings that match EVERY filter, newest first (date, then id,
 * descending), cut to `limit` from `offset`; `total` and `totalAmount` cover all the matches.
 */
export function searchReference(spendings: readonly RefSpending[], query: RefQuery): RefPage {
  const needle = query.q === undefined ? undefined : query.q.trim().toLowerCase();
  const matching = spendings
    .filter(
      (s) =>
        (query.month === undefined || s.date.slice(0, 7) === query.month) &&
        (query.from === undefined || s.date >= query.from) &&
        (query.to === undefined || s.date <= query.to) &&
        (query.budgetId === undefined || s.budgetId === query.budgetId) &&
        (query.tagId === undefined || s.tagIds.includes(query.tagId)) &&
        (needle === undefined ||
          s.description.toLowerCase().includes(needle) ||
          (s.notes !== null && s.notes.toLowerCase().includes(needle))) &&
        (query.minAmount === undefined || s.amount >= query.minAmount) &&
        (query.maxAmount === undefined || s.amount <= query.maxAmount),
    )
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  return {
    items: matching.slice(offset, offset + limit).map((s) => ({ ...s, tagIds: [...s.tagIds] })),
    total: matching.length,
    limit,
    offset,
    totalAmount: matching.reduce((sum, s) => sum + s.amount, 0),
  };
}

/** The query string of `query`, encoded. */
export function queryString(query: RefQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

// -------------------------------------------------------------------------------------------------
// Tags
// -------------------------------------------------------------------------------------------------

/**
 * "Names are unique ignoring case ... under the comparison that also sorts the list
 * (`Intl.Collator('en', { sensitivity: 'accent' })`)": the doc names the comparison, so this is it.
 */
const nameCollator = new Intl.Collator('en', { sensitivity: 'accent' });
export const sameName = (a: string, b: string): boolean => nameCollator.compare(a, b) === 0;

/** `GET /api/tags`: ascending by name ignoring case, then id, with how many spendings carry each. */
export function tagListReference(tags: readonly RefTag[], spendings: readonly RefSpending[]) {
  return [...tags]
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      usageCount: spendings.filter((s) => s.tagIds.includes(tag.id)).length,
    }));
}

// -------------------------------------------------------------------------------------------------
// Generators over the restricted alphabet
// -------------------------------------------------------------------------------------------------

/** Characters with one lower-case and one upper-case form: `toLowerCase()` is the ground truth. */
export const ALPHABET = [
  'a',
  'b',
  'c',
  'A',
  'B',
  'C',
  'x',
  'é',
  'É',
  'ü',
  'д',
  'Д',
  'α',
  'Α',
  '1',
  '2',
  ' ',
  '%',
  '_',
];

/** Text with no padding (a description and notes are trimmed when stored). */
export const textArb = (maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...ALPHABET), { maxLength }).map((chars) => chars.join('').trim());

/** The same text with each letter in a case of its own. */
export function recase(text: string, bits: number): string {
  return [...text]
    .map((char, index) => ((bits >> (index % 20)) & 1 ? char.toUpperCase() : char.toLowerCase()))
    .join('');
}
