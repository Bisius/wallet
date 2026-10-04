import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SavingsStore } from '../../core/savings.store';
import { SelectedMonth } from '../../core/selected-month';
import { SPENDING_SEARCH_MAX_LENGTH } from '@wallet/shared/limits';
import {
  blur,
  fieldError,
  getByLabel,
  getByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import {
  budgetDto,
  budgetLine,
  monthView,
  outstandingMonth,
  savingsDto,
  spendingDto,
  spendingsPage,
  tagDto,
} from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import {
  COFFEE,
  FUN_LINE,
  GROCERIES_LINE,
  LUNCH,
  OCTOBER as OCTOBER_VIEW,
  openSpendingsPage,
  PAGE,
  SHOES,
  type SpendingsPageHelpers,
  SpendingsHost,
  spendingsPageHelpers,
  spendingsUrl,
} from '../../../testing/spendings-harness';
import { SEARCH_DEBOUNCE_MS } from './spending-filter-bar';

const TAGS = [
  tagDto({ id: 1, name: 'Groceries', color: '#15803d', usageCount: 5 }),
  tagDto({ id: 2, name: 'Travel', usageCount: 1 }),
];
const BUDGETS = [
  budgetDto({ id: 1, name: 'Groceries' }),
  budgetDto({ id: 2, name: 'Fun' }),
  budgetDto({
    id: 3,
    name: 'Old gym',
    endMonth: '2026-08',
    status: 'ended',
    hasHistory: true,
  }),
];

describe('SpendingsPage: search and filters', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'spendings', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
    localStorage.clear();
  });

  /** Lets the page and the router catch up while the clock is faked (`settle` waits on a real timer). */
  async function settleFake(p: SpendingsPageHelpers) {
    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      p.fixture.detectChanges();
    }
  }

  const search = (p: SpendingsPageHelpers) => getByLabel<HTMLInputElement>(p.bar(), 'Search');
  const scopeRadio = (p: SpendingsPageHelpers, label: string) =>
    getByLabel<HTMLInputElement>(p.bar(), label);

  /** Presses a key in a control. Resolves to the event, to see whether it was prevented. */
  function press(control: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    control.dispatchEvent(event);
    return event;
  }

  describe('the bar', () => {
    it('is a search landmark with a label on every control', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      expect(p.bar().getAttribute('aria-label')).toBe('Search and filter spendings');
      for (const label of [
        'Search',
        'Filter by budget',
        'Filter by tag',
        'Minimum amount',
        'Maximum amount',
        'October 2026',
        'All months',
      ]) {
        expect(getByLabel(p.bar(), label), label).toBeTruthy();
      }
      expect(getByRole(p.bar(), 'group', 'Show spendings from')).toBeTruthy();
    });

    it('starts with no filter: this month, empty boxes, no count and nothing to clear', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      expect(p.value('Search', p.bar())).toBe('');
      expect(p.value('Filter by budget', p.bar())).toBe('');
      expect(p.value('Filter by tag', p.bar())).toBe('');
      expect(p.value('Minimum amount', p.bar())).toBe('');
      expect(p.value('Maximum amount', p.bar())).toBe('');
      expect(scopeRadio(p, 'October 2026').checked).toBe(true);
      expect(scopeRadio(p, 'All months').checked).toBe(false);
      expect(queryByRole(p.bar(), 'button', 'Clear filters')).toBeNull();
      // No count: the name of the button is just "Filters".
      expect(getByRole(p.bar(), 'button', 'Filters')).toBeTruthy();
    });

    it('is a toolbar: the search is always there, and the rest is in a panel the Filters button opens', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      const panel = document.getElementById(p.filtersButton().getAttribute('aria-controls')!)!;
      expect(panel.contains(search(p))).toBe(false);
      expect(p.bar().contains(search(p))).toBe(true);
      for (const label of [
        'Filter by budget',
        'Filter by tag',
        'Minimum amount',
        'Maximum amount',
      ]) {
        expect(panel.contains(getByLabel(p.bar(), label)), label).toBe(true);
      }
      expect(panel.contains(getByRole(p.bar(), 'group', 'Show spendings from'))).toBe(true);
    });

    it('says what the search is for with its placeholder, and names it "Search" for a screen reader', async () => {
      const p = await openSpendingsPage(http);

      expect(search(p).getAttribute('placeholder')).toBe('Description or notes');
      expect(search(p).type).toBe('search');
    });

    it("offers the month's budgets, and all the tags", async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      const options = (label: string) =>
        Array.from(getByLabel<HTMLSelectElement>(p.bar(), label).options).map((o) => textOf(o));
      expect(options('Filter by budget')).toEqual(['All budgets', 'Groceries', 'Fun']);
      expect(options('Filter by tag')).toEqual(['All tags', 'Groceries', 'Travel']);
    });

    it('says that refunds are negative, under both amounts', async () => {
      const p = await openSpendingsPage(http);

      const hints = Array.from(p.bar().querySelectorAll('p')).filter(
        (hint) => textOf(hint) === 'Refunds are negative.',
      );
      expect(hints).toHaveLength(2);
      const minimum = getByLabel(p.bar(), 'Minimum amount');
      expect(
        textOf(document.getElementById(minimum.getAttribute('aria-describedby')!.split(' ')[0])!),
      ).toBe('Refunds are negative.');
    });

    it('lets a phone type a minus sign in the amounts, as the digits keypad has none', async () => {
      const p = await openSpendingsPage(http);

      expect(getByLabel(p.bar(), 'Minimum amount').getAttribute('inputmode')).toBe('text');
      expect(getByLabel(p.bar(), 'Maximum amount').getAttribute('inputmode')).toBe('text');
    });

    it('limits the search to what the API takes', async () => {
      const p = await openSpendingsPage(http);
      expect(search(p).getAttribute('maxlength')).toBe(String(SPENDING_SEARCH_MAX_LENGTH));
    });
  });

  describe('restored from the address', () => {
    it('shows every filter of the URL, and asks the API for exactly them', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=coffee&budgetId=2&tagId=2&minAmount=-500&maxAmount=2000&scope=all',
        firstPage: { budgetId: 2, tagId: 2, q: 'coffee', minAmount: -500, maxAmount: 2000 },
        tags: TAGS,
        budgets: BUDGETS,
      });

      expect(p.value('Search', p.bar())).toBe('coffee');
      expect(p.value('Filter by budget', p.bar())).toBe('2');
      expect(p.value('Filter by tag', p.bar())).toBe('2');
      expect(p.value('Minimum amount', p.bar())).toBe('-5.00');
      expect(p.value('Maximum amount', p.bar())).toBe('20.00');
      expect(scopeRadio(p, 'All months').checked).toBe(true);
      expect(scopeRadio(p, 'October 2026').checked).toBe(false);
      // Searching every month sends no date at all.
      expect(textOf(getByRole(p.element, 'heading', 'Spendings in all months'))).toBe(
        'Spendings in all months',
      );
    });

    it('counts the filters in use, in the name of the button that opens them, and shows the count on it', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=coffee&tagId=2&minAmount=0&scope=all',
        firstPage: { tagId: 2, q: 'coffee', minAmount: 0 },
        tags: TAGS,
        budgets: BUDGETS,
      });

      const button = getByRole(p.bar(), 'button', 'Filters, 4 active');
      // The number is drawn too, and hidden from a screen reader, which has it in the name.
      expect(button.textContent).toContain('4');
      expect(button.querySelector('app-badge[aria-hidden="true"]')?.textContent).toContain('4');
    });

    it('keeps the panel closed on a small screen when it arrives without filters', async () => {
      const p = await openSpendingsPage(http);

      const toggle = getByRole(p.bar(), 'button', 'Filters');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('opens the panel when it arrives with filters, so they can be seen', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?tagId=2',
        firstPage: { month: '2026-10', tagId: 2 },
        tags: TAGS,
      });

      const toggle = getByRole(p.bar(), 'button', 'Filters, 1 active');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(panel.classList.contains('hidden')).toBe(false);
    });

    it('leaves the panel closed when the only filter is the search, which is on screen anyway, and still counts it', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=tea',
        firstPage: { month: '2026-10', q: 'tea' },
      });

      const toggle = getByRole(p.bar(), 'button', 'Filters, 1 active');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(search(p).value).toBe('tea');
    });

    it('keeps the button, with its count, and the panel as they are when the panel is closed again', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?tagId=2',
        firstPage: { month: '2026-10', tagId: 2 },
        tags: TAGS,
      });

      getByRole(p.bar(), 'button', 'Filters, 1 active').click();
      await settle(p.fixture);

      const toggle = getByRole(p.bar(), 'button', 'Filters, 1 active');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.classList).toContain(
        'hidden',
      );
      // What is in a closed panel is still in force.
      expect(p.value('Filter by tag', p.bar())).toBe('2');
    });

    it('opens and closes the panel with the Filters button', async () => {
      const p = await openSpendingsPage(http);
      const toggle = () => getByRole(p.bar(), 'button', 'Filters');

      toggle().click();
      await settle(p.fixture);
      expect(toggle().getAttribute('aria-expanded')).toBe('true');

      toggle().click();
      await settle(p.fixture);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it.each([
      ['a budget that is not a number', 'budgetId=abc'],
      ['a tag id of 0', 'tagId=0'],
      ['an amount with decimals', 'minAmount=1.5'],
      ['a blank amount', 'maxAmount='],
      ['a search of only spaces', 'q=%20%20'],
      ['a scope it does not know', 'scope=weird'],
      ['a search that is too long', `q=${'x'.repeat(SPENDING_SEARCH_MAX_LENGTH + 1)}`],
    ])('ignores %s, and opens the page as if it were not there', async (_name, query) => {
      const p = await openSpendingsPage(http, { url: `/spendings?${query}` });

      expect(p.value('Search', p.bar())).toBe('');
      expect(p.value('Filter by budget', p.bar())).toBe('');
      expect(p.value('Minimum amount', p.bar())).toBe('');
      expect(scopeRadio(p, 'October 2026').checked).toBe(true);
      expect(p.text()).toContain('Coffee');
      expect(queryByRole(p.bar(), 'button', /active$/)).toBeNull();
    });

    it('ignores only the garbage when the URL also has good filters', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=tea&budgetId=abc&maxAmount=1.5',
        firstPage: { month: '2026-10', q: 'tea' },
      });

      expect(p.value('Search', p.bar())).toBe('tea');
      expect(p.value('Filter by budget', p.bar())).toBe('');
    });

    it('keeps the month of the URL', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?month=2026-09&q=tea',
        month: '2026-09',
        firstPage: { month: '2026-09', q: 'tea' },
        view: monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE] }),
      });

      expect(textOf(getByRole(p.element, 'heading', 'Spendings in September 2026'))).toBe(
        'Spendings in September 2026',
      );
      expect(scopeRadio(p, 'September 2026').checked).toBe(true);
    });
  });

  describe('typing', () => {
    it('applies the search after a pause of 300 ms, trimmed, and not on every keystroke', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      typeInto(search(p), 'c');
      typeInto(search(p), 'co');
      await vi.advanceTimersByTimeAsync(200);
      typeInto(search(p), '  cof ');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
      expect(navigate).not.toHaveBeenCalled();
      http.expectNone((request) => request.url === '/api/spendings');

      await vi.advanceTimersByTimeAsync(1);
      await settleFake(p);

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate.mock.calls[0][1]).toMatchObject({
        queryParams: { q: 'cof' },
        queryParamsHandling: 'merge',
      });
      expect(p.params()).toEqual({ q: 'cof' });
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'cof' })).flush(spendingsPage([COFFEE]));
      await settleFake(p);
      expect(textOf(p.list())).toContain('1 spending');
      // What was typed is still in the box, spaces and all.
      expect(search(p).value).toBe('  cof ');
    });

    it('replaces the history entry instead of adding one per keystroke', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      typeInto(search(p), 'tea');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(navigate.mock.calls[0][1]).toMatchObject({ replaceUrl: true });
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'tea' })).flush(spendingsPage([]));
    });

    it('applies the search at once when Enter is pressed', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      typeInto(search(p), 'tea');
      const enter = press(search(p), 'Enter');
      await settleFake(p);

      expect(enter.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'tea' })).flush(spendingsPage([]));
      // The pause that was running ends with nothing left to apply.
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('does not put an older search back into the box while the person is still typing', async () => {
      const p = await openSpendingsPage(http);
      // Hold the first navigation back, as a slow page would: the URL answers a moment late.
      const original = router.navigate.bind(router);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(router, 'navigate').mockImplementation(async (commands, extras) => {
        await gate;
        return original(commands, extras);
      });
      vi.useFakeTimers();

      typeInto(search(p), 'tea');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      typeInto(search(p), 'teapot');
      release();
      await settleFake(p);

      // The URL now says "tea", which is what was sent, and not what the box holds.
      expect(p.params()).toEqual({ q: 'tea' });
      expect(search(p).value).toBe('teapot');

      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      expect(p.params()).toEqual({ q: 'teapot' });
      expect(search(p).value).toBe('teapot');
      // The request for "tea" was replaced by the one for "teapot".
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'tea' }));
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'teapot' })).flush(spendingsPage([]));
    });

    it('takes the search off the URL when the box is emptied', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=tea',
        firstPage: { month: '2026-10', q: 'tea' },
      });
      vi.useFakeTimers();

      typeInto(search(p), '');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(p.params()).toEqual({});
      http.expectOne(spendingsUrl({ month: '2026-10' })).flush(PAGE);
    });

    it('sends a search of only spaces nowhere', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      typeInto(search(p), '    ');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(navigate).not.toHaveBeenCalled();
    });

    it('keeps the characters that are special in a URL intact', async () => {
      const p = await openSpendingsPage(http);
      vi.useFakeTimers();

      typeInto(search(p), '100% café & tea+milk');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      http
        .expectOne(spendingsUrl({ month: '2026-10', q: '100% café & tea+milk' }))
        .flush(spendingsPage([]));
      expect(p.params()['q']).toBe('100% café & tea+milk');
    });
  });

  describe('amounts', () => {
    it('are typed as money, signed as stored, and sent as whole cents', async () => {
      const p = await openSpendingsPage(http);
      vi.useFakeTimers();

      typeInto(getByLabel(p.bar(), 'Minimum amount'), '-5');
      typeInto(getByLabel(p.bar(), 'Maximum amount'), '12,5');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(p.params()).toEqual({ minAmount: '-500', maxAmount: '1250' });
      http
        .expectOne(spendingsUrl({ month: '2026-10', minAmount: -500, maxAmount: 1250 }))
        .flush(spendingsPage([SHOES]));
      await settleFake(p);
      expect(textOf(p.list())).toContain('Shoes (returned)');
    });

    it('can be 0, which hides the refunds', async () => {
      const p = await openSpendingsPage(http);
      vi.useFakeTimers();

      typeInto(getByLabel(p.bar(), 'Minimum amount'), '0');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      http
        .expectOne(spendingsUrl({ month: '2026-10', minAmount: 0 }))
        .flush(spendingsPage([COFFEE, LUNCH]));
      await settleFake(p);
      expect(p.params()).toEqual({ minAmount: '0' });
    });

    it('say what is wrong with text that is not an amount, and are not sent', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      const minimum = getByLabel(p.bar(), 'Minimum amount');
      typeInto(minimum, 'abc');
      blur(minimum);
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(fieldError(minimum)).toBe('Enter an amount like 12.50 or 12,50.');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('say that the minimum is above the maximum before sending, and send nothing', async () => {
      const p = await openSpendingsPage(http);
      const navigate = vi.spyOn(router, 'navigate');
      vi.useFakeTimers();

      typeInto(getByLabel(p.bar(), 'Minimum amount'), '10');
      typeInto(getByLabel(p.bar(), 'Maximum amount'), '5');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      const maximum = getByLabel(p.bar(), 'Maximum amount');
      expect(fieldError(maximum)).toBe("The minimum amount can't be above the maximum.");
      expect(maximum.getAttribute('aria-invalid')).toBe('true');
      expect(navigate).not.toHaveBeenCalled();
      http.expectNone((request) => request.url === '/api/spendings');

      // Fixing it sends the filters.
      typeInto(maximum, '15');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      expect(fieldError(maximum)).toBe('');
      http
        .expectOne(spendingsUrl({ month: '2026-10', minAmount: 1000, maxAmount: 1500 }))
        .flush(spendingsPage([]));
    });

    it('can be emptied, which takes the bound off', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?minAmount=500',
        firstPage: { month: '2026-10', minAmount: 500 },
      });
      vi.useFakeTimers();

      typeInto(getByLabel(p.bar(), 'Minimum amount'), '');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(p.params()).toEqual({});
      http.expectOne(spendingsUrl({ month: '2026-10' })).flush(PAGE);
    });
  });

  describe('choices', () => {
    it('a budget adds a history entry and asks for that budget only', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      const navigate = vi.spyOn(router, 'navigate');

      await p.type('Filter by budget', '2', p.bar());

      expect(navigate.mock.calls[0][1]).toMatchObject({ replaceUrl: false });
      expect(p.params()).toEqual({ budgetId: '2' });
      await p.answer({ month: '2026-10', budgetId: 2 }, spendingsPage([SHOES]));
      expect(textOf(p.list())).toContain('Shoes (returned)');
      expect(textOf(p.list())).not.toContain('Coffee');
    });

    it('a tag asks for the spendings that carry it', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await p.type('Filter by tag', '2', p.bar());

      expect(p.params()).toEqual({ tagId: '2' });
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));
      expect(getByRole(p.bar(), 'button', 'Filters, 1 active')).toBeTruthy();
    });

    it('go together: every filter is one parameter of the same request', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await p.type('Filter by budget', '1', p.bar());
      await p.answer({ month: '2026-10', budgetId: 1 });
      await p.type('Filter by tag', '1', p.bar());
      await p.answer({ month: '2026-10', budgetId: 1, tagId: 1 });

      expect(p.params()).toEqual({ budgetId: '1', tagId: '1' });
      expect(getByRole(p.bar(), 'button', 'Filters, 2 active')).toBeTruthy();
    });

    it('go back to "all" when the first choice is picked again', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Filter by tag', '2', p.bar());
      await p.answer({ month: '2026-10', tagId: 2 });

      await p.type('Filter by tag', '', p.bar());

      expect(p.params()).toEqual({});
      await p.answer({ month: '2026-10' });
    });
  });

  describe('every month', () => {
    it('is a switch: no month is sent, the budgets of all times are offered, the title says so', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      const navigate = vi.spyOn(router, 'navigate');

      scopeRadio(p, 'All months').click();
      await settle(p.fixture);

      expect(navigate.mock.calls[0][1]).toMatchObject({ replaceUrl: false });
      expect(p.params()).toEqual({ scope: 'all' });
      // A spending can be in a budget that has ended: the full list names it and offers it.
      http.expectOne('/api/budgets').flush(BUDGETS);
      await p.answer({}, spendingsPage([COFFEE, SHOES]));

      expect(textOf(getByRole(p.element, 'heading', 'Spendings in all months'))).toBe(
        'Spendings in all months',
      );
      expect(
        Array.from(getByLabel<HTMLSelectElement>(p.bar(), 'Filter by budget').options).map((o) =>
          textOf(o),
        ),
      ).toEqual(['All budgets', 'Groceries', 'Fun', 'Old gym']);
      expect(getByRole(p.bar(), 'button', 'Filters, 1 active')).toBeTruthy();
      expect(scopeRadio(p, 'All months').checked).toBe(true);
    });

    it('names the budgets of rows that are in no month the page shows', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        page: spendingsPage([spendingDto({ id: 9, budgetId: 3, description: 'Gym fee' })]),
        budgets: BUDGETS,
      });

      expect(textOf(p.list())).toContain('Gym fee Old gym');
    });

    it('does not follow the month switcher: the list is the same whatever month is shown', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        budgets: BUDGETS,
      });

      await TestBed.inject(SelectedMonth).select('2026-09');
      await settle(p.fixture);

      // The add form follows the month, the list does not move.
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE] }));
      await settle(p.fixture);
      http.expectNone((request) => request.url === '/api/spendings');
      expect(p.params()).toEqual({ scope: 'all', month: '2026-09' });
    });

    it('goes back to the shown month with the first choice', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        budgets: BUDGETS,
      });

      scopeRadio(p, 'October 2026').click();
      await settle(p.fixture);

      expect(p.params()).toEqual({});
      await p.answer({ month: '2026-10' });
      expect(textOf(getByRole(p.element, 'heading', 'Spendings in October 2026'))).toBe(
        'Spendings in October 2026',
      );
    });

    it('says what the page covers in the subtitle, and which month the form adds to', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        budgets: BUDGETS,
      });

      expect(p.text()).toContain(
        'Every expense, linked to a budget, in every month. The form adds to October 2026.',
      );
      expect(p.text()).not.toContain('Every expense, linked to a budget, for');
    });

    it('names the buttons of a row with its date, since the same coffee is in the list many times', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        budgets: BUDGETS,
        page: spendingsPage([
          spendingDto({ id: 9, date: '2026-10-02', description: 'Coffee', amount: 350 }),
          spendingDto({ id: 8, date: '2026-09-02', description: 'Coffee', amount: 350 }),
        ]),
      });

      expect(getByRole(p.list(), 'button', 'Edit Coffee, €3.50, Oct 2, 2026')).toBeTruthy();
      expect(
        getByRole(p.list(), 'button', 'More actions for Coffee, €3.50, Sep 2, 2026'),
      ).toBeTruthy();
      await p.rowAction('Coffee, €3.50, Sep 2, 2026', 'Delete');
      // The question says the date once.
      expect(textOf(p.confirmDialog())).toContain(
        'Coffee, €3.50 on Wed, Sep 2, 2026 will be removed from Groceries.',
      );
    });

    it('shows the selected check mark, not only a color', async () => {
      const p = await openSpendingsPage(http);
      const labels = Array.from(p.bar().querySelectorAll('fieldset label'));
      expect(labels).toHaveLength(2);
      expect(labels[0].querySelector('svg')).not.toBeNull();
      expect(labels[1].querySelector('svg')).toBeNull();
    });
  });

  describe('keeps the filters while the month changes', () => {
    it('asks for the new month with the same filters, and keeps the boxes', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=tea&tagId=2',
        firstPage: { month: '2026-10', tagId: 2, q: 'tea' },
        tags: TAGS,
      });

      await TestBed.inject(SelectedMonth).select('2026-09');
      await settle(p.fixture);

      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE] }));
      await p.answer({ month: '2026-09', tagId: 2, q: 'tea' }, spendingsPage([]));
      expect(p.value('Search', p.bar())).toBe('tea');
      expect(p.value('Filter by tag', p.bar())).toBe('2');
      expect(p.params()).toEqual({ q: 'tea', tagId: '2', month: '2026-09' });
    });

    it('keeps a budget that does not exist in the new month visible, by name, so it can be removed', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?budgetId=2',
        firstPage: { month: '2026-10', budgetId: 2 },
      });

      await TestBed.inject(SelectedMonth).select('2026-07');
      await settle(p.fixture);
      http
        .expectOne('/api/months/2026-07')
        .flush(monthView({ month: '2026-07', status: 'closed', budgets: [GROCERIES_LINE] }));
      await p.answer({ month: '2026-07', budgetId: 2 }, spendingsPage([]));
      // Fun is not in July's budgets: the full list is asked for, to name it.
      http.expectOne('/api/budgets').flush(BUDGETS);
      await settle(p.fixture);

      const select = getByLabel<HTMLSelectElement>(p.bar(), 'Filter by budget');
      expect(select.value).toBe('2');
      expect(Array.from(select.options).map((o) => textOf(o))).toEqual([
        'All budgets',
        'Groceries',
        'Fun',
      ]);
      expect(textOf(p.list())).toContain('No spendings for Fun in July 2026');
    });
  });

  describe('editing a spending of another month (searching every month)', () => {
    const OLD_GYM = budgetDto({
      id: 3,
      name: 'Old gym',
      endMonth: '2026-09',
      status: 'ended',
      hasHistory: true,
    });
    const SEPTEMBER = monthView({
      month: '2026-09',
      status: 'closed',
      budgets: [GROCERIES_LINE, budgetLine({ id: 3, name: 'Old gym' })],
    });
    const FEE = spendingDto({
      id: 21,
      date: '2026-09-14',
      amount: 3000,
      budgetId: 3,
      description: 'Gym fee',
    });

    function openAllMonths() {
      return openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        page: spendingsPage([COFFEE, FEE]),
        budgets: [...BUDGETS.slice(0, 2), OLD_GYM],
        tags: TAGS,
      });
    }

    it('waits for the month the spending is dated in, and opens with its own date and budget', async () => {
      const p = await openAllMonths();

      await p.press('Edit Gym fee, €30.00, Sep 14, 2026', p.list());
      expect(p.dialog()).toBeNull();
      http.expectOne('/api/months/2026-09').flush(SEPTEMBER);
      await settle(p.fixture);

      const dialog = p.dialog() as HTMLElement;
      expect(p.value('Date', dialog)).toBe('2026-09-14');
      // The date stays in the month it is in, not the one on show.
      expect(getByLabel(dialog, 'Date').getAttribute('min')).toBe('2026-09-01');
      expect(getByLabel(dialog, 'Date').getAttribute('max')).toBe('2026-09-30');
      // Its budget is among that month's, though it is not among October's.
      expect(p.value('Budget', dialog)).toBe('3');
      expect(
        Array.from(getByLabel<HTMLSelectElement>(dialog, 'Budget').options).map((o) => textOf(o)),
      ).toEqual(['Groceries · €300.00 left', 'Old gym · €300.00 left']);
    });

    it('sends only what the person changed, so the date and the budget stay as they were', async () => {
      const p = await openAllMonths();
      await p.press('Edit Gym fee, €30.00, Sep 14, 2026', p.list());
      http.expectOne('/api/months/2026-09').flush(SEPTEMBER);
      await settle(p.fixture);
      const dialog = p.dialog() as HTMLElement;
      await p.type('Description (optional)', 'Gym fee (September)', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/21');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ description: 'Gym fee (September)' });
      request.flush({ ...FEE, description: 'Gym fee (September)' });
      await settle(p.fixture);
      // The list and the month on show are loaded again, and so is the savings overview: September is
      // closed, and what it owes savings is behind the badge on the navigation.
      http.expectOne('/api/months/2026-10').flush({ ...OCTOBER_VIEW });
      http.expectOne(spendingsUrl({})).flush(spendingsPage([COFFEE, FEE]));
      http.expectOne('/api/savings').flush(savingsDto());
      await settle(p.fixture);
      expect(p.toasts()).toEqual(['Spending updated.']);
    });

    it('opens at once for a spending of the month on show', async () => {
      const p = await openAllMonths();

      await p.press('Edit Coffee, €3.50, Oct 2, 2026', p.list());

      expect(p.dialog()).not.toBeNull();
      expect(p.value('Date', p.dialog() as HTMLElement)).toBe('2026-10-02');
      http.expectNone((request) => request.url.startsWith('/api/months/'));
    });

    it('says so, and does not open, when that month cannot be loaded', async () => {
      const p = await openAllMonths();
      await p.press('Edit Gym fee, €30.00, Sep 14, 2026', p.list());

      flushError(http.expectOne('/api/months/2026-09'), 500, 'internal_error', 'No ledger');
      await settle(p.fixture);

      expect(p.toasts()).toEqual(["Couldn't load September 2026 to edit this spending. No ledger"]);
      expect(p.dialog()).toBeNull();

      // Another row still opens.
      await p.press('Edit Coffee, €3.50, Oct 2, 2026', p.list());
      expect(p.dialog()).not.toBeNull();
    });
  });

  describe('while a new search loads', () => {
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        spendingDto({ id: from - index, description: `Item ${from - index}`, amount: 100 }),
      );
    /** The container of the rows: marked busy while the rows are the previous search's. */
    const busy = (p: SpendingsPageHelpers) => p.list().querySelector('[aria-busy="true"]');

    it('keeps the previous rows on screen, dimmed and marked busy, instead of "Loading…"', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      expect(busy(p)).toBeNull();

      await p.type('Filter by tag', '2', p.bar());

      // The request is out and not answered: the list is what it was.
      expect(textOf(p.list())).toContain('Coffee');
      expect(textOf(p.list())).toContain('Lunch');
      expect(textOf(p.list())).not.toContain('Loading spendings');
      expect(busy(p)).not.toBeNull();
      expect(busy(p)?.classList.contains('opacity-90')).toBe(true);
      // The count above it is the previous search's too, and stays (it is not emptied and read out
      // again), until the new one comes.
      expect(textOf(p.result())).toContain('3 spendings');
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));

      expect(busy(p)).toBeNull();
      expect(textOf(p.list())).not.toContain('Coffee');
      expect(textOf(p.list())).toContain('Lunch');
      expect(textOf(p.result())).toContain('1 spending');
      expect(p.list().querySelector('.opacity-90')).toBeNull();
    });

    it('does not offer "Load more" for rows that belong to the previous search', async () => {
      const p = await openSpendingsPage(http, {
        page: spendingsPage(many(120, 50), { total: 120 }),
        tags: TAGS,
      });
      expect(queryByRole(p.list(), 'button', 'Load more')).not.toBeNull();

      await p.type('Filter by tag', '2', p.bar());

      expect(textOf(p.list())).toContain('Item 120');
      expect(queryByRole(p.list(), 'button', 'Load more')).toBeNull();
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage(many(70, 50), { total: 90 }));
      expect(queryByRole(p.list(), 'button', 'Load more')).not.toBeNull();
    });

    it('keeps the rows "Load more" added too, until the new first page comes', async () => {
      const p = await openSpendingsPage(http, {
        page: spendingsPage(many(120, 50), { total: 120 }),
        tags: TAGS,
      });
      await p.press('Load more', p.list());
      http
        .expectOne(spendingsUrl({ month: '2026-10', offset: 50 }))
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);

      await p.type('Filter by tag', '2', p.bar());

      expect(textOf(p.list())).toContain('Showing 100 of 120');
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));
      expect(textOf(p.list())).toContain('Showing 1 of 1');
    });

    it('shows "Loading…" when there is nothing to keep: the previous list had no rows', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=zzz',
        firstPage: { month: '2026-10', q: 'zzz' },
        page: spendingsPage([]),
        tags: TAGS,
      });
      expect(textOf(p.list())).toContain('Nothing matches these filters');

      await p.type('Filter by tag', '2', p.bar());

      expect(textOf(p.list())).toContain('Loading spendings');
      expect(textOf(p.list())).not.toContain('Nothing matches these filters');
      expect(busy(p)).toBeNull();
      await p.answer({ month: '2026-10', tagId: 2, q: 'zzz' }, spendingsPage([LUNCH]));
      expect(textOf(p.list())).toContain('Lunch');
    });

    it("does not show the previous month's rows under the next month's title", async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await TestBed.inject(SelectedMonth).select('2026-09');
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('Spendings in September 2026');
      expect(textOf(p.list())).toContain('Loading spendings');
      expect(textOf(p.list())).not.toContain('Coffee');
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE] }));
      await p.answer({ month: '2026-09' }, spendingsPage([]));
    });

    it('shows the failure of the new search, not the previous rows as if they were its answer', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await p.type('Filter by tag', '2', p.bar());
      flushError(
        http.expectOne(spendingsUrl({ month: '2026-10', tagId: 2 })),
        500,
        'internal_error',
        'No spendings today',
      );
      await settle(p.fixture);

      expect(textOf(p.list())).toContain("Couldn't load the spendings");
      expect(textOf(p.list())).not.toContain('Coffee');
      expect(busy(p)).toBeNull();
    });

    it('does not leave the count of the previous search above a range the API would refuse', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      router.setUpLocationChangeListener();
      expect(textOf(p.result())).toContain('3 spendings');

      // The address is changed to a range whose minimum is above its maximum: nothing is sent.
      await router.navigateByUrl('/spendings?minAmount=1000&maxAmount=500');
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('Fix the amount range to search');
      expect(textOf(p.result())).toBe('');
      expect(textOf(p.list())).not.toContain('Coffee');
    });
  });

  describe('the savings overview (the badge on the navigation)', () => {
    const SEPTEMBER_VIEW = monthView({
      month: '2026-09',
      status: 'closed',
      budgets: [GROCERIES_LINE, FUN_LINE],
    });
    const SEPTEMBER_SPENDING = spendingDto({
      id: 30,
      date: '2026-09-12',
      amount: 1500,
      description: 'Late bill',
    });

    /** The shell has the overview by then: one month waits to be moved to savings. */
    async function withOverview(p: SpendingsPageHelpers) {
      const savings = TestBed.inject(SavingsStore);
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(savingsDto({ outstanding: [outstandingMonth()] }));
      await settle(p.fixture);
      expect(savings.outstandingCount()).toBe(1);
      return savings;
    }
    const AFTER = savingsDto({
      outstanding: [outstandingMonth(), outstandingMonth({ month: '2026-08', savingsDue: 1000 })],
    });

    async function openSeptember() {
      return openSpendingsPage(http, {
        url: '/spendings?month=2026-09',
        month: '2026-09',
        view: SEPTEMBER_VIEW,
        page: spendingsPage([SEPTEMBER_SPENDING]),
        tags: TAGS,
      });
    }

    it('is looked at again after a spending is added to a closed month', async () => {
      const p = await openSeptember();
      const savings = await withOverview(p);
      await p.type('Amount', '15', p.form());

      await p.press('Add spending', p.form());
      http
        .expectOne('/api/spendings')
        .flush({ ...SEPTEMBER_SPENDING, id: 31 }, { status: 201, statusText: 'Created' });
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(AFTER);
      http.expectOne('/api/months/2026-09').flush(SEPTEMBER_VIEW);
      http.expectOne(spendingsUrl({ month: '2026-09' })).flush(spendingsPage([SEPTEMBER_SPENDING]));
      await settle(p.fixture);

      expect(savings.outstandingCount()).toBe(2);
    });

    it('is looked at again after a spending of a closed month is deleted', async () => {
      const p = await openSeptember();
      const savings = await withOverview(p);

      await p.rowAction('Late bill, €15.00', 'Delete');
      await p.press('Delete spending', p.confirmDialog());
      http.expectOne('/api/spendings/30').flush(null, { status: 204, statusText: 'No Content' });
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(AFTER);
      http.expectOne('/api/months/2026-09').flush(SEPTEMBER_VIEW);
      http.expectOne(spendingsUrl({ month: '2026-09' })).flush(spendingsPage([]));
      await settle(p.fixture);

      expect(savings.outstandingCount()).toBe(2);
    });

    it('is looked at again after a spending of a closed month is edited', async () => {
      const p = await openSeptember();
      const savings = await withOverview(p);
      await p.press('Edit Late bill, €15.00', p.list());
      await p.type('Date', '2026-09-30', p.dialog() as HTMLElement);

      await p.press('Save changes', p.dialog() as HTMLElement);
      http.expectOne('/api/spendings/30').flush({ ...SEPTEMBER_SPENDING, date: '2026-09-30' });
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(AFTER);
      http.expectOne('/api/months/2026-09').flush(SEPTEMBER_VIEW);
      http.expectOne(spendingsUrl({ month: '2026-09' })).flush(spendingsPage([SEPTEMBER_SPENDING]));
      await settle(p.fixture);

      expect(savings.outstandingCount()).toBe(2);
    });

    it('is not asked for when the spending is in the current month: it cannot change what is owed', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Amount', '3', p.form());

      await p.press('Add spending', p.form());
      http
        .expectOne('/api/spendings')
        .flush({ ...COFFEE, id: 40 }, { status: 201, statusText: 'Created' });
      await settle(p.fixture);
      http.expectNone('/api/savings');
      http.expectOne('/api/months/2026-10').flush(OCTOBER_VIEW);
      http.expectOne(spendingsUrl({ month: '2026-10' })).flush(PAGE);
      await settle(p.fixture);
      http.expectNone('/api/savings');
    });
  });

  describe('while other filters change', () => {
    it('leaves a range that was typed and not sent where it is, and still says what is wrong with it', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      vi.useFakeTimers();
      typeInto(getByLabel(p.bar(), 'Minimum amount'), '10');
      typeInto(getByLabel(p.bar(), 'Maximum amount'), '5');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      expect(fieldError(getByLabel(p.bar(), 'Maximum amount'))).not.toBe('');

      typeInto(getByLabel(p.bar(), 'Filter by tag'), '2');
      await settleFake(p);

      http.expectOne(spendingsUrl({ month: '2026-10', tagId: 2 })).flush(spendingsPage([LUNCH]));
      await settleFake(p);
      // Still what was typed (tidied up when focus left the boxes), not what the address says.
      expect(p.value('Minimum amount', p.bar())).toBe('10.00');
      expect(p.value('Maximum amount', p.bar())).toBe('5.00');
      expect(fieldError(getByLabel(p.bar(), 'Maximum amount'))).toBe(
        "The minimum amount can't be above the maximum.",
      );
    });

    it('does not lose a search typed a moment ago when a tag is chosen, and sends both', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      vi.useFakeTimers();
      typeInto(search(p), 'te');

      typeInto(getByLabel(p.bar(), 'Filter by tag'), '2');
      await settleFake(p);
      http.expectOne(spendingsUrl({ month: '2026-10', tagId: 2 })).flush(spendingsPage([LUNCH]));
      await settleFake(p);
      expect(search(p).value).toBe('te');

      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      http
        .expectOne(spendingsUrl({ month: '2026-10', tagId: 2, q: 'te' }))
        .flush(spendingsPage([LUNCH]));
      expect(p.params()).toEqual({ tagId: '2', q: 'te' });
    });

    it('lets the address change a box that a push which never arrived left behind', async () => {
      const p = await openSpendingsPage(http);
      // The first push is cancelled on its way: the address does not change, and nothing comes back.
      vi.spyOn(router, 'navigate').mockResolvedValueOnce(false);
      vi.useFakeTimers();
      typeInto(search(p), 'tea');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);
      expect(p.params()).toEqual({});

      typeInto(search(p), 'teapot');
      // A link to the same words as that lost push lands before the person is done.
      await router.navigateByUrl('/spendings?q=tea');
      await settleFake(p);

      expect(search(p).value).toBe('tea');
      http.expectOne(spendingsUrl({ month: '2026-10', q: 'tea' })).flush(spendingsPage([COFFEE]));
    });
  });

  describe('clearing', () => {
    async function filtered() {
      const p = await openSpendingsPage(http, {
        url: '/spendings?month=2026-09&q=tea&budgetId=1&tagId=2&minAmount=100&maxAmount=900&scope=all',
        month: '2026-09',
        firstPage: { budgetId: 1, tagId: 2, q: 'tea', minAmount: 100, maxAmount: 900 },
        view: monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [GROCERIES_LINE, FUN_LINE],
        }),
        page: spendingsPage([]),
        tags: TAGS,
        budgets: BUDGETS,
      });
      return p;
    }

    it('turns every filter off, keeps the month, and shows the month again', async () => {
      const p = await filtered();

      await p.press('Clear filters', p.bar());

      expect(p.params()).toEqual({ month: '2026-09' });
      await p.answer({ month: '2026-09' });
      expect(p.value('Search', p.bar())).toBe('');
      expect(p.value('Filter by budget', p.bar())).toBe('');
      expect(p.value('Filter by tag', p.bar())).toBe('');
      expect(p.value('Minimum amount', p.bar())).toBe('');
      expect(p.value('Maximum amount', p.bar())).toBe('');
      expect(scopeRadio(p, 'September 2026').checked).toBe(true);
      expect(queryByRole(p.bar(), 'button', 'Clear filters')).toBeNull();
      expect(queryByRole(p.bar(), 'button', /active$/)).toBeNull();
    });

    it('puts the keyboard on the list heading, because the button that was pressed is gone', async () => {
      const p = await filtered();

      await p.press('Clear filters', p.bar());
      await p.answer({ month: '2026-09' });

      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Spendings in September 2026'),
      );
    });

    it('also empties a box that has text which was not sent yet', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?tagId=2',
        firstPage: { month: '2026-10', tagId: 2 },
        tags: TAGS,
      });
      vi.useFakeTimers();

      const minimum = getByLabel(p.bar(), 'Minimum amount');
      typeInto(minimum, 'abc');
      blur(minimum);
      await settleFake(p);
      expect(fieldError(minimum)).toBe('Enter an amount like 12.50 or 12,50.');
      getByRole(p.bar(), 'button', 'Clear filters').click();
      await settleFake(p);
      http.expectOne(spendingsUrl({ month: '2026-10' })).flush(PAGE);
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      expect(p.value('Minimum amount', p.bar())).toBe('');
      expect(fieldError(minimum)).toBe('');
    });
  });

  describe('the result line', () => {
    it('says how many spendings match and their net total, as the API counts them', async () => {
      const p = await openSpendingsPage(http, {
        page: { ...PAGE, total: 120, totalAmount: -34567 },
      });

      expect(textOf(p.result())).toBe('120 spendings · -€345.67 net. Refunds are subtracted.');
    });

    it('is a polite live region that stays in the page, so what changes in it is announced', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      const line = p.result();
      expect(line.getAttribute('aria-live')).toBe('polite');

      const before = textOf(line);

      await p.type('Filter by tag', '2', p.bar());
      // While the new list loads there is nothing to announce yet: the line is not emptied, which
      // would be a change of its own, and it says what the rows still on screen are.
      expect(textOf(p.result())).toBe(before);
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));

      // The one change: the new count.
      expect(p.result()).toBe(line);
      expect(textOf(line)).toBe('1 spending · €12.50 net. Refunds are subtracted.');
    });

    it('does not paint a net total in red: refunds are good news in the list, so the sign says it', async () => {
      const p = await openSpendingsPage(http, { page: { ...PAGE, totalAmount: -4500 } });

      expect(textOf(p.result())).toContain('-€45.00 net');
      expect(p.result().querySelector('.text-negative')).toBeNull();
    });

    it('covers every match, not the rows on the page', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=tea',
        firstPage: { month: '2026-10', q: 'tea' },
        page: spendingsPage([COFFEE], { total: 61, totalAmount: 99999 }),
      });

      expect(textOf(p.result())).toContain('61 spendings · €999.99 net');
      expect(textOf(p.list())).toContain('Showing 1 of 61');
    });
  });

  describe('when nothing matches', () => {
    it('says so, apart from a month that has no spendings, and offers to clear the filters', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=zzz',
        firstPage: { month: '2026-10', q: 'zzz' },
        page: spendingsPage([]),
      });

      const empty = p.list().querySelector('app-empty-state') as HTMLElement;
      expect(textOf(empty)).toContain('Nothing matches these filters');
      expect(textOf(empty)).toContain(
        'No spendings in October 2026 fit the search and filters you chose',
      );
      expect(textOf(p.list())).not.toContain('No spendings in October 2026 When you spend');

      await p.press('Clear filters', empty);
      await p.answer({ month: '2026-10' });
      expect(textOf(p.list())).toContain('Coffee');
      expect(p.params()).toEqual({});
      expect(p.value('Search', p.bar())).toBe('');
    });

    it('names the budget when it is the only filter, as it always did', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?budgetId=2',
        firstPage: { month: '2026-10', budgetId: 2 },
        page: spendingsPage([]),
      });

      expect(textOf(p.list())).toContain('No spendings for Fun in October 2026');
      await p.press('Show all budgets');
      await p.answer({ month: '2026-10' });
      expect(p.value('Filter by budget', p.bar())).toBe('');
    });

    it('speaks of every month when that is where it looked', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all&q=zzz',
        firstPage: { q: 'zzz' },
        page: spendingsPage([]),
        budgets: BUDGETS,
      });

      expect(textOf(p.list())).toContain(
        'No spendings in all months fit the search and filters you chose',
      );
    });

    it('says there are no spendings at all when every month is empty and nothing narrows it', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all',
        firstPage: {},
        page: spendingsPage([]),
        budgets: BUDGETS,
      });

      const empty = p.list().querySelector('app-empty-state') as HTMLElement;
      expect(textOf(empty)).toContain('No spendings yet');
      // Nothing narrows the list, so there is nothing for the empty state to clear.
      expect(queryByRole(empty, 'button')).toBeNull();
    });
  });

  describe('a range the API would refuse', () => {
    it('is not sent when it comes from the address, and the list says to fix it', async () => {
      await primeStores(http);
      await router.navigateByUrl('/spendings?minAmount=1000&maxAmount=500');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush({ ...monthView({ budgets: [GROCERIES_LINE] }) });
      http.expectOne('/api/tags').flush([]);
      await settle(fixture);

      http.expectNone((request) => request.url === '/api/spendings');
      const element = fixture.nativeElement as HTMLElement;
      expect(textOf(element)).toContain('Fix the amount range to search');
      expect(textOf(element)).toContain("The minimum amount can't be above the maximum.");
      expect(textOf(element)).not.toContain('Loading spendings');
      const maximum = getByLabel(element, 'Maximum amount');
      expect(fieldError(maximum)).toBe("The minimum amount can't be above the maximum.");
    });

    it('goes ahead once the range is fixed', async () => {
      await primeStores(http);
      await router.navigateByUrl('/spendings?minAmount=1000&maxAmount=500');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(monthView({ budgets: [GROCERIES_LINE] }));
      http.expectOne('/api/tags').flush([]);
      await settle(fixture);
      const p = spendingsPageHelpers(http, router, fixture);
      vi.useFakeTimers();

      typeInto(getByLabel(p.bar(), 'Maximum amount'), '20');
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await settleFake(p);

      http
        .expectOne(spendingsUrl({ month: '2026-10', minAmount: 1000, maxAmount: 2000 }))
        .flush(spendingsPage([LUNCH]));
      await settleFake(p);
      expect(textOf(p.list())).not.toContain('Fix the amount range to search');
      expect(textOf(p.list())).toContain('Lunch');
      expect(fieldError(getByLabel(p.bar(), 'Maximum amount'))).toBe('');
    });
  });

  describe('when the server refuses the filters', () => {
    it('shows what it said, not a blank page, and offers to clear them', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Filter by tag', '2', p.bar());
      flushError(
        http.expectOne(spendingsUrl({ month: '2026-10', tagId: 2 })),
        400,
        'validation_error',
        'Invalid request',
        [{ path: 'maxAmount', message: '`minAmount` must not be greater than `maxAmount`' }],
      );
      await settle(p.fixture);

      const alert = getByRole(p.list(), 'alert');
      expect(textOf(alert)).toContain("The server didn't accept these filters");
      expect(textOf(alert)).toContain('`minAmount` must not be greater than `maxAmount`');
      // The bar is still there to change them.
      expect(getByLabel(p.bar(), 'Search')).toBeTruthy();

      await p.press('Clear filters', alert);
      await p.answer({ month: '2026-10' });
      expect(textOf(p.list())).toContain('Coffee');
    });

    it('falls back to the plain error for a failure that is not about the filters', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      await p.type('Filter by tag', '2', p.bar());
      flushError(
        http.expectOne(spendingsUrl({ month: '2026-10', tagId: 2 })),
        500,
        'internal_error',
        'The list is busy',
      );
      await settle(p.fixture);

      const alert = getByRole(p.list(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the spendings");
      expect(textOf(alert)).toContain('The list is busy');
      expect(queryByRole(alert, 'button', 'Try again')).not.toBeNull();
    });
  });

  describe('load more', () => {
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        spendingDto({ id: from - index, description: `Item ${from - index}`, amount: 100 }),
      );

    it('keeps every filter in the next request', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?q=item&budgetId=1&tagId=2&minAmount=0&maxAmount=5000',
        firstPage: {
          month: '2026-10',
          budgetId: 1,
          tagId: 2,
          q: 'item',
          minAmount: 0,
          maxAmount: 5000,
        },
        page: spendingsPage(many(120, 50), { total: 120 }),
        tags: TAGS,
      });

      await p.press('Load more', p.list());

      http
        .expectOne(
          spendingsUrl({
            month: '2026-10',
            budgetId: 1,
            tagId: 2,
            q: 'item',
            minAmount: 0,
            maxAmount: 5000,
            offset: 50,
          }),
        )
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);
      expect(textOf(p.list())).toContain('Showing 100 of 120');
    });

    it('keeps searching every month in the next request', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?scope=all&q=item',
        firstPage: { q: 'item' },
        page: spendingsPage(many(120, 50), { total: 120 }),
        budgets: BUDGETS,
      });

      await p.press('Load more', p.list());

      http
        .expectOne(spendingsUrl({ q: 'item', offset: 50 }))
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);
      expect(textOf(p.list())).toContain('Showing 100 of 120');
    });

    it('drops the extra rows when the filters change, and shows the new first page', async () => {
      const p = await openSpendingsPage(http, {
        page: spendingsPage(many(120, 50), { total: 120 }),
        tags: TAGS,
      });
      await p.press('Load more', p.list());
      http
        .expectOne(spendingsUrl({ month: '2026-10', offset: 50 }))
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);
      expect(textOf(p.list())).toContain('Showing 100 of 120');

      await p.type('Filter by tag', '2', p.bar());
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));

      expect(textOf(p.list())).toContain('Showing 1 of 1');
      expect(textOf(p.list())).not.toContain('Item 120');
    });
  });

  describe('Back and Forward', () => {
    it('follow the filters: going back to an address without one shows the list as it was', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });
      // In the app the router listens for the browser's Back and Forward from the start.
      router.setUpLocationChangeListener();
      await p.type('Filter by tag', '2', p.bar());
      await p.answer({ month: '2026-10', tagId: 2 }, spendingsPage([LUNCH]));
      expect(p.value('Filter by tag', p.bar())).toBe('2');

      TestBed.inject(Location).back();
      await settle(p.fixture);
      await settle(p.fixture);

      // The history had the page without the tag before the choice.
      expect(p.params()).toEqual({});
      expect(p.value('Filter by tag', p.bar())).toBe('');
      await p.answer({ month: '2026-10' });
      expect(textOf(p.list())).toContain('Coffee');
    });

    it('put the address into the boxes, the typed ones too', async () => {
      const p = await openSpendingsPage(http, { tags: TAGS });

      await router.navigateByUrl('/spendings?q=tea&minAmount=-250&scope=all');
      await settle(p.fixture);
      http.expectOne('/api/budgets').flush(BUDGETS);
      await p.answer({ q: 'tea', minAmount: -250 }, spendingsPage([]));

      expect(p.value('Search', p.bar())).toBe('tea');
      expect(p.value('Minimum amount', p.bar())).toBe('-2.50');
      expect(scopeRadio(p, 'All months').checked).toBe(true);

      await router.navigateByUrl('/spendings');
      await settle(p.fixture);
      await p.answer({ month: '2026-10' });

      expect(p.value('Search', p.bar())).toBe('');
      expect(p.value('Minimum amount', p.bar())).toBe('');
      expect(scopeRadio(p, 'October 2026').checked).toBe(true);
    });
  });

  describe('the tags on a row', () => {
    it('show a marker and the name of each tag, in a list named "Tags"', async () => {
      const p = await openSpendingsPage(http, {
        tags: TAGS,
        page: spendingsPage([
          spendingDto({ id: 5, description: 'Weekly shop', tagIds: [1, 2] }),
          spendingDto({ id: 6, description: 'Bus', tagIds: [] }),
        ]),
      });

      const row = Array.from(p.list().querySelectorAll('ul.divide-y > li')).find((li) =>
        textOf(li).includes('Weekly shop'),
      ) as HTMLElement;
      const chips = getByRole(row, 'list', 'Tags');
      expect(Array.from(chips.querySelectorAll('li')).map((li) => textOf(li))).toEqual([
        'Groceries',
        'Travel',
      ]);
      // A tag with a color has a dot (never the only signal: the name is there), one without has the tag icon.
      expect(
        chips.querySelector<HTMLElement>('span[aria-hidden="true"]')?.style.backgroundColor,
      ).not.toBe('');
      expect(chips.querySelectorAll('svg')).toHaveLength(1);
      // A row without tags has no list.
      const bus = Array.from(p.list().querySelectorAll('ul.divide-y > li')).find((li) =>
        textOf(li).includes('Bus'),
      ) as HTMLElement;
      expect(queryByRole(bus, 'list', 'Tags')).toBeNull();
    });

    it('leave out a tag the list does not know', async () => {
      const p = await openSpendingsPage(http, {
        tags: TAGS,
        page: spendingsPage([spendingDto({ id: 5, description: 'Weekly shop', tagIds: [1, 99] })]),
      });

      const chips = getByRole(p.list(), 'list', 'Tags');
      expect(Array.from(chips.querySelectorAll('li')).map((li) => textOf(li))).toEqual([
        'Groceries',
      ]);
    });

    it('do not change the budget a row shows', async () => {
      const p = await openSpendingsPage(http, {
        tags: TAGS,
        page: spendingsPage([spendingDto({ id: 5, description: 'Weekly shop', tagIds: [1] })]),
      });

      expect(textOf(p.list())).toContain('Weekly shop Groceries Groceries €12.50');
    });
  });

  describe('a tag that is not in the list', () => {
    it('stays visible in the tag filter, by number, so it can be removed', async () => {
      const p = await openSpendingsPage(http, {
        url: '/spendings?tagId=99',
        firstPage: { month: '2026-10', tagId: 99 },
        tags: TAGS,
        page: spendingsPage([]),
      });

      const select = getByLabel<HTMLSelectElement>(p.bar(), 'Filter by tag');
      expect(select.value).toBe('99');
      expect(Array.from(select.options).map((o) => textOf(o))).toEqual([
        'All tags',
        'Groceries',
        'Travel',
        'Tag 99',
      ]);
    });
  });
});
