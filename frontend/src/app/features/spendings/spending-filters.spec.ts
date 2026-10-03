import { MAX_CENTS, SPENDING_SEARCH_MAX_LENGTH } from '@wallet/shared/limits';
import {
  activeCount,
  filtersFromParams,
  filtersProblem,
  NO_FILTERS,
  narrowingCount,
  paramsFromFilters,
  RANGE_MESSAGE,
  sameFilters,
  type SpendingFilters,
} from './spending-filters';

/** A URL's query as `filtersFromParams` reads it. */
const read = (query: Record<string, string>) => (name: string) => query[name] ?? null;

describe('filtersFromParams', () => {
  it('has no filter when the URL has none', () => {
    expect(filtersFromParams(read({}))).toEqual(NO_FILTERS);
  });

  it('reads every filter', () => {
    expect(
      filtersFromParams(
        read({
          q: 'coffee',
          budgetId: '2',
          tagId: '13',
          minAmount: '-500',
          maxAmount: '2000',
          scope: 'all',
        }),
      ),
    ).toEqual({
      q: 'coffee',
      budgetId: 2,
      tagId: 13,
      minAmount: -500,
      maxAmount: 2000,
      allMonths: true,
    });
  });

  it('trims the search, but keeps the spaces inside it', () => {
    expect(filtersFromParams(read({ q: '  green tea ' })).q).toBe('green tea');
  });

  it('reads 0 as an amount: it is a real bound, which hides the refunds', () => {
    const filters = filtersFromParams(read({ minAmount: '0', maxAmount: '0' }));
    expect(filters.minAmount).toBe(0);
    expect(filters.maxAmount).toBe(0);
  });

  describe('ignores what cannot be a filter, so a mangled link still opens the page', () => {
    it.each([
      ['an empty search', { q: '' }],
      ['a search of only spaces', { q: '   ' }],
      ['a search longer than the API takes', { q: 'x'.repeat(SPENDING_SEARCH_MAX_LENGTH + 1) }],
      ['a budget that is not a number', { budgetId: 'abc' }],
      ['a budget id of 0', { budgetId: '0' }],
      ['a negative budget id', { budgetId: '-3' }],
      ['a decimal budget id', { budgetId: '1.5' }],
      ['a budget id with a leading zero', { budgetId: '02' }],
      ['an id beyond what a number holds', { tagId: '99999999999999999999' }],
      ['a blank tag', { tagId: '' }],
      ['an amount with decimals', { minAmount: '12.5' }],
      ['an amount written with a comma', { minAmount: '12,50' }],
      ['a blank amount', { minAmount: '' }],
      ['an amount with spaces', { maxAmount: ' 5' }],
      ['an amount with a plus sign', { maxAmount: '+5' }],
      ['an amount in exponent notation', { maxAmount: '1e3' }],
      ['"-0"', { minAmount: '-0' }],
      ['an amount beyond the largest the API takes', { maxAmount: String(MAX_CENTS + 1) }],
      ['an unknown scope', { scope: 'everything' }],
      ['a scope in capitals', { scope: 'ALL' }],
    ])('%s', (_name, query) => {
      expect(filtersFromParams(read(query))).toEqual(NO_FILTERS);
    });

    it('keeps the good filters when another is garbage', () => {
      expect(filtersFromParams(read({ q: 'tea', budgetId: 'x', minAmount: '300' }))).toEqual({
        ...NO_FILTERS,
        q: 'tea',
        minAmount: 300,
      });
    });

    it('takes the largest amount the API takes', () => {
      expect(filtersFromParams(read({ maxAmount: String(MAX_CENTS) })).maxAmount).toBe(MAX_CENTS);
      expect(filtersFromParams(read({ minAmount: String(-MAX_CENTS) })).minAmount).toBe(-MAX_CENTS);
    });
  });
});

describe('paramsFromFilters', () => {
  it('writes the filters it is given, and turns the ones that are off into null, which removes them', () => {
    expect(
      paramsFromFilters({
        q: ' tea ',
        budgetId: null,
        tagId: 4,
        minAmount: -500,
        maxAmount: null,
        allMonths: true,
      }),
    ).toEqual({
      q: 'tea',
      budgetId: null,
      tagId: '4',
      minAmount: '-500',
      maxAmount: null,
      scope: 'all',
    });
  });

  it('touches only the filters it is given, so the others stay in the URL', () => {
    expect(paramsFromFilters({ tagId: 7 })).toEqual({ tagId: '7' });
    expect(paramsFromFilters({})).toEqual({});
  });

  it('turns every filter off with the empty filters', () => {
    expect(paramsFromFilters(NO_FILTERS)).toEqual({
      q: null,
      budgetId: null,
      tagId: null,
      minAmount: null,
      maxAmount: null,
      scope: null,
    });
  });

  it('writes 0 as an amount, not as "off"', () => {
    expect(paramsFromFilters({ minAmount: 0 })).toEqual({ minAmount: '0' });
  });

  it('round trips: what is written is read back', () => {
    const filters: SpendingFilters = {
      q: 'green tea & more',
      budgetId: 3,
      tagId: 9,
      minAmount: -12345,
      maxAmount: 0,
      allMonths: true,
    };
    const params = paramsFromFilters(filters);
    expect(filtersFromParams((name) => params[name] ?? null)).toEqual(filters);
  });
});

describe('counting the filters', () => {
  it('counts each narrowing filter once, a range as two, and searching all months as one more', () => {
    expect(narrowingCount(NO_FILTERS)).toBe(0);
    expect(activeCount(NO_FILTERS)).toBe(0);

    const some = { ...NO_FILTERS, q: 'a', tagId: 1, minAmount: 0 };
    expect(narrowingCount(some)).toBe(3);
    expect(activeCount(some)).toBe(3);

    const all = {
      q: 'a',
      budgetId: 1,
      tagId: 1,
      minAmount: 1,
      maxAmount: 2,
      allMonths: true,
    };
    expect(narrowingCount(all)).toBe(5);
    expect(activeCount(all)).toBe(6);
    expect(activeCount({ ...NO_FILTERS, allMonths: true })).toBe(1);
    expect(narrowingCount({ ...NO_FILTERS, allMonths: true })).toBe(0);
  });
});

describe('filtersProblem', () => {
  it('refuses a minimum above the maximum, as the API does', () => {
    expect(filtersProblem({ ...NO_FILTERS, minAmount: 501, maxAmount: 500 })).toBe(RANGE_MESSAGE);
    expect(filtersProblem({ ...NO_FILTERS, minAmount: 0, maxAmount: -1 })).toBe(RANGE_MESSAGE);
  });

  it('accepts equal bounds, one bound alone, and no bound', () => {
    expect(filtersProblem({ ...NO_FILTERS, minAmount: 500, maxAmount: 500 })).toBeNull();
    expect(filtersProblem({ ...NO_FILTERS, minAmount: 500 })).toBeNull();
    expect(filtersProblem({ ...NO_FILTERS, maxAmount: -500 })).toBeNull();
    expect(filtersProblem(NO_FILTERS)).toBeNull();
  });
});

describe('sameFilters', () => {
  it('compares every filter', () => {
    expect(sameFilters(NO_FILTERS, { ...NO_FILTERS })).toBe(true);
    for (const change of [
      { q: 'a' },
      { budgetId: 1 },
      { tagId: 1 },
      { minAmount: 0 },
      { maxAmount: 0 },
      { allMonths: true },
    ]) {
      expect(sameFilters(NO_FILTERS, { ...NO_FILTERS, ...change })).toBe(false);
    }
  });
});
