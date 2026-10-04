import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SavingsTransactionDto } from '@wallet/shared';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import {
  goalDto,
  savingsDto,
  savingsTransaction as row,
  transactionsPage,
} from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { menuItemNames, rowAction } from '../../../testing/menu';
import { openSavingsPage } from '../../../testing/savings-harness';

const HOLIDAY = goalDto({ id: 1, name: 'Holiday', balance: 35000 });
const OLD = goalDto({ id: 3, name: 'Old laptop', archived: true, balance: 5000 });
const OVERVIEW = savingsDto({ unassigned: 10000, goals: [HOLIDAY, OLD] });

/** Newest first, as the API lists them. */
const ROWS: SavingsTransactionDto[] = [
  row({ id: 30, date: '2026-10-02', kind: 'deposit', amount: 5000, goalId: 1, note: 'Bonus' }),
  row({ id: 29, date: '2026-10-01', kind: 'withdrawal', amount: -1250, goalId: null }),
  row({ id: 28, date: '2026-09-30', kind: 'reallocation', amount: 4000, goalId: null, groupId: 7 }),
  row({ id: 27, date: '2026-09-30', kind: 'reallocation', amount: -4000, goalId: 1, groupId: 7 }),
  row({
    id: 26,
    date: '2026-09-15',
    kind: 'settlement',
    amount: 11240,
    goalId: null,
    settlesMonth: '2026-08',
  }),
  row({
    id: 25,
    date: '2026-09-15',
    kind: 'settlement',
    amount: 20000,
    goalId: 1,
    settlesMonth: '2026-08',
  }),
  row({ id: 1, date: '2026-06-01', kind: 'opening', amount: 100000, goalId: null }),
];

describe('the history', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const open = (history = transactionsPage(ROWS)) =>
    openSavingsPage(http, { savings: OVERVIEW, history });
  type Page = Awaited<ReturnType<typeof open>>;
  const section = (p: Page) => p.region('History');
  const entries = (p: Page) =>
    queryAllByRole(section(p), 'listitem').filter(
      (li) =>
        li.parentElement?.tagName === 'UL' && li.parentElement.parentElement?.tagName === 'SECTION',
    );
  const entry = (p: Page, text: string | RegExp) =>
    entries(p).find((li) =>
      typeof text === 'string' ? textOf(li).includes(text) : text.test(textOf(li)),
    )!;
  /** The buttons an entry shows: what is in its menu is not one of them, `menuItemNames` lists that. */
  const buttons = (li: Element) =>
    queryAllByRole(li as HTMLElement, 'button')
      .filter((b) => !b.closest('[popover]'))
      .map((b) => b.getAttribute('aria-label'));
  const url = (query: string) => `/api/savings/transactions?${query}`;
  const choose = async (p: Page, label: string, value: string) => {
    typeInto(getByLabel<HTMLSelectElement>(section(p), label), value);
    await settle(p.fixture);
  };

  describe('the entries', () => {
    it('says so when there is nothing yet', async () => {
      const p = await open(transactionsPage([]));

      expect(textOf(section(p))).toContain('No savings activity yet');
    });

    it('describes a deposit and a withdrawal with their dates, notes and signed amounts', async () => {
      const p = await open();

      const deposit = textOf(entry(p, 'Deposit to Holiday'));
      expect(deposit).toContain('Oct 2, 2026');
      expect(deposit).toContain('Bonus');
      expect(deposit).toContain('+€50.00');
      const withdrawal = textOf(entry(p, 'Withdrawal from Unassigned savings'));
      expect(withdrawal).toContain('Oct 1, 2026');
      expect(withdrawal).toContain('-€12.50');
    });

    it('shows the two rows of a reallocation as ONE entry', async () => {
      const p = await open();

      const moves = entries(p).filter((li) => textOf(li).startsWith('Moved'));
      expect(moves.map((li) => textOf(li).split(' Sep')[0])).toEqual([
        'Moved €40.00 from Holiday to Unassigned savings',
      ]);
      expect(entries(p)).toHaveLength(5);
    });

    it('shows the allocations of a settlement as one entry, listing where each part went', async () => {
      const p = await open();

      const settled = textOf(entry(p, 'Settled August 2026'));
      expect(settled).toContain('Sep 15, 2026');
      expect(settled).toContain('Holiday: +€200.00');
      expect(settled).toContain('Unassigned savings: +€112.40');
    });

    it('shows the opening balance', async () => {
      const p = await open();

      const opening = textOf(entry(p, 'Opening balance'));
      expect(opening).toContain('Jun 1, 2026');
      expect(opening).toContain('+€1,000.00');
    });

    it('lists the entries in the order of the API, newest first', async () => {
      const p = await open();

      expect(entries(p).map((li) => textOf(li).split(' ')[0])).toEqual([
        'Deposit',
        'Withdrawal',
        'Moved',
        'Settled',
        'Opening',
      ]);
    });

    it('names a reallocation by the place it touched when the other side is filtered out', async () => {
      const p = await open();
      await choose(p, 'Filter by goal', '1');
      http.expectOne(url('goalId=1&limit=50&offset=0')).flush(
        transactionsPage([
          row({
            id: 27,
            date: '2026-09-30',
            kind: 'reallocation',
            amount: -4000,
            goalId: 1,
            groupId: 7,
          }),
        ]),
      );
      await settle(p.fixture);

      const text = textOf(entry(p, 'Moved'));
      expect(text).toContain('Moved out of Holiday');
      expect(text).toContain('-€40.00');
    });
  });

  describe('what can be done with an entry', () => {
    it('lets the user delete a deposit, a withdrawal and a reallocation', async () => {
      const p = await open();

      // Deleting is destructive, so it is in the menu of the entry, which names the entry.
      expect(buttons(entry(p, 'Deposit to Holiday'))).toEqual([
        'More actions for Deposit to Holiday, Oct 2, 2026',
      ]);
      expect(menuItemNames(entry(p, 'Deposit to Holiday'))).toEqual(['Delete']);
      expect(buttons(entry(p, 'Withdrawal from'))).toEqual([
        'More actions for Withdrawal from Unassigned savings, Oct 1, 2026',
      ]);
      expect(menuItemNames(entry(p, 'Withdrawal from'))).toEqual(['Delete']);
      expect(buttons(entry(p, 'Moved €40.00'))).toEqual([
        'More actions for Moved €40.00 from Holiday to Unassigned savings, Sep 30, 2026',
      ]);
      expect(menuItemNames(entry(p, 'Moved €40.00'))).toEqual(['Delete']);
    });

    it('never offers to delete a settlement or the opening balance: they have their own actions', async () => {
      const p = await open();

      const settlement = entry(p, 'Settled August 2026');
      expect(buttons(settlement)).toEqual(['More actions for Settled August 2026']);
      expect(menuItemNames(settlement)).toEqual(['Undo settlement']);
      expect(textOf(settlement)).not.toContain('Delete');
      const opening = entry(p, 'Opening balance');
      expect(buttons(opening)).toEqual(['Edit opening balance']);
      expect(textOf(opening)).not.toContain('Delete');
    });

    it('offers to undo a settled month once, on its newest entry', async () => {
      const p = await open(
        transactionsPage([
          row({
            id: 40,
            date: '2026-10-02',
            kind: 'settlement',
            amount: 1200,
            settlesMonth: '2026-08',
          }),
          row({
            id: 26,
            date: '2026-09-15',
            kind: 'settlement',
            amount: 30000,
            settlesMonth: '2026-08',
          }),
          row({
            id: 20,
            date: '2026-09-14',
            kind: 'settlement',
            amount: 7000,
            settlesMonth: '2026-07',
          }),
        ]),
      );

      expect(entries(p).map((li) => buttons(li).length)).toEqual([1, 0, 1]);
    });
  });

  describe('deleting', () => {
    it('asks first, saying what it does', async () => {
      const p = await open();

      await rowAction(entry(p, 'Deposit to Holiday'), 'Delete');
      await settle(p.fixture);

      const dialog = p.confirmDialog();
      expect(textOf(getByRole(dialog, 'heading', 'Delete this entry?'))).toBe('Delete this entry?');
      const message = textOf(dialog);
      expect(message).toContain('Deposit to Holiday, Oct 2, 2026 (€50.00).');
      expect(message).toContain('The money is taken out again.');
      expect(message).toContain('can leave it below zero');
      http.expectNone('/api/savings/transactions/30');
    });

    it('deletes a deposit and loads everything again', async () => {
      const p = await open();
      await rowAction(entry(p, 'Deposit to Holiday'), 'Delete');

      await p.confirm('Delete entry');
      const request = http.expectOne('/api/savings/transactions/30');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ savings: OVERVIEW, history: transactionsPage(ROWS.slice(1)) });

      expect(p.toasts()).toEqual(['Entry deleted.']);
      expect(textOf(section(p))).not.toContain('Deposit to Holiday');
      expect(document.activeElement).toBe(getByRole(section(p), 'heading', 'History'));
    });

    it('deletes a reallocation by one of its rows: the API removes both', async () => {
      const p = await open();
      await rowAction(entry(p, 'Moved €40.00'), 'Delete');
      await settle(p.fixture);
      expect(textOf(p.confirmDialog())).toContain('Both of its entries are removed');

      await p.confirm('Delete entry');

      const request = http.expectOne('/api/savings/transactions/27');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ savings: OVERVIEW });
    });

    it('does nothing when the user cancels', async () => {
      const p = await open();
      await rowAction(entry(p, 'Withdrawal from'), 'Delete');

      await p.confirm('Cancel');

      http.expectNone('/api/savings/transactions/29');
      expect(entries(p)).toHaveLength(5);
      // The question was asked from the menu of the entry, and focus goes back to its button.
      expect(document.activeElement).toBe(
        getByRole(entry(p, 'Withdrawal from'), 'button', /^More actions/),
      );
    });

    it('says what the API said when it refuses (not_deletable)', async () => {
      const p = await open();
      await rowAction(entry(p, 'Deposit to Holiday'), 'Delete');
      await p.confirm('Delete entry');

      flushError(
        http.expectOne('/api/savings/transactions/30'),
        409,
        'not_deletable',
        'A settlement is undone, not deleted',
      );
      await p.reload({ savings: OVERVIEW, history: transactionsPage(ROWS) });

      expect(p.toasts()).toEqual([
        "Couldn't delete the entry. A settlement is undone, not deleted",
      ]);
    });

    it('says the entry was already gone when the API cannot find it', async () => {
      const p = await open();
      await rowAction(entry(p, 'Deposit to Holiday'), 'Delete');
      await p.confirm('Delete entry');

      flushError(http.expectOne('/api/savings/transactions/30'), 404, 'not_found', 'No such row');
      await p.reload({ savings: OVERVIEW, history: transactionsPage(ROWS.slice(1)) });

      expect(p.toasts()).toEqual(['That entry was already gone.']);
    });
  });

  describe('undoing a settlement', () => {
    it('asks first, then removes the settlements of the month and brings it back to the inbox', async () => {
      const p = await open();
      await rowAction(entry(p, 'Settled August 2026'), 'Undo settlement');
      await settle(p.fixture);

      const dialog = p.confirmDialog();
      expect(textOf(getByRole(dialog, 'heading', 'Undo the settlement of August 2026?'))).toBe(
        'Undo the settlement of August 2026?',
      );
      expect(textOf(dialog)).toContain('Every settlement recorded for August 2026 is removed');
      http.expectNone('/api/savings/settle/2026-08');

      await p.confirm('Undo settlement');
      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({
        savings: savingsDto({
          unassigned: 10000,
          goals: [HOLIDAY],
          outstanding: [
            {
              month: '2026-08',
              savingsDue: 31240,
              settled: 0,
              outstanding: 31240,
              direction: 'move',
              adjustment: false,
              breakdown: { unallocated: 31240, budgetsSettled: 0, reservesReleased: 0 },
            },
          ],
        }),
        history: transactionsPage(ROWS.slice(0, 4)),
      });

      expect(p.toasts()).toEqual([
        'Settlement of August 2026 undone. The month is back in the list.',
      ]);
      expect(textOf(p.region('Move to savings'))).toContain('August 2026: move €312.40 to savings');
    });

    it('does nothing when the user cancels', async () => {
      const p = await open();
      await rowAction(entry(p, 'Settled August 2026'), 'Undo settlement');

      await p.confirm('Cancel');

      http.expectNone('/api/savings/settle/2026-08');
    });
  });

  describe('filters', () => {
    it('limits the history to a goal, to unassigned savings, or to a kind, and combines them', async () => {
      const p = await open();

      await choose(p, 'Filter by goal', '1');
      http.expectOne(url('goalId=1&limit=50&offset=0')).flush(transactionsPage([ROWS[0]]));
      await settle(p.fixture);
      expect(entries(p)).toHaveLength(1);

      await choose(p, 'Filter by type', 'deposit');
      http
        .expectOne(url('goalId=1&kind=deposit&limit=50&offset=0'))
        .flush(transactionsPage([ROWS[0]]));
      await settle(p.fixture);

      await choose(p, 'Filter by goal', 'unassigned');
      http
        .expectOne(url('unassigned=true&kind=deposit&limit=50&offset=0'))
        .flush(transactionsPage([]));
      await settle(p.fixture);

      await choose(p, 'Filter by goal', 'all');
      http.expectOne(url('kind=deposit&limit=50&offset=0')).flush(transactionsPage([]));
      await settle(p.fixture);

      await choose(p, 'Filter by type', '');
      http.expectOne(url('limit=50&offset=0')).flush(transactionsPage(ROWS));
      await settle(p.fixture);
      expect(entries(p)).toHaveLength(5);
    });

    it('lists every goal, archived ones too: they hold entries', async () => {
      const p = await open();

      const options = Array.from(
        getByLabel<HTMLSelectElement>(section(p), 'Filter by goal').options,
      ).map((o) => textOf(o));
      expect(options).toEqual([
        'All savings',
        'Unassigned savings',
        'Holiday',
        'Old laptop (archived)',
      ]);
      const kinds = Array.from(
        getByLabel<HTMLSelectElement>(section(p), 'Filter by type').options,
      ).map((o) => textOf(o));
      expect(kinds).toEqual([
        'All types',
        'Month settlements',
        'Deposits',
        'Withdrawals',
        'Reallocations',
        'Opening balance',
      ]);
    });

    it('goes back to all savings when the goal it is limited to is deleted: its entries moved to unassigned savings', async () => {
      const p = await open();
      await choose(p, 'Filter by goal', '1');
      http.expectOne(url('goalId=1&limit=50&offset=0')).flush(transactionsPage([ROWS[0]]));
      await settle(p.fixture);
      expect(getByLabel<HTMLSelectElement>(section(p), 'Filter by goal').value).toBe('1');

      await p.menuAction('More actions for Holiday', 'Delete');
      await p.confirm('Delete goal');
      http.expectOne('/api/goals/1').flush(null, { status: 204, statusText: 'No Content' });
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(savingsDto({ unassigned: 45000, goals: [OLD] }));
      http.expectOne('/api/savings/opening').flush({ amount: 100000, date: '2026-06-01' });
      await settle(p.fixture);
      // The filter is dropped, so the history asks for everything. (What was asked for the goal is
      // not wanted any more: its request is cancelled.)
      const stale = http.match(url('goalId=1&limit=50&offset=0'));
      expect(stale.every((request) => request.cancelled)).toBe(true);
      http.expectOne(url('limit=50&offset=0')).flush(transactionsPage(ROWS));
      await settle(p.fixture);

      expect(getByLabel<HTMLSelectElement>(section(p), 'Filter by goal').value).toBe('all');
      expect(entries(p)).toHaveLength(5);
    });

    it('says nothing matches, and shows everything again on request', async () => {
      const p = await open();
      await choose(p, 'Filter by type', 'withdrawal');
      http.expectOne(url('kind=withdrawal&limit=50&offset=0')).flush(transactionsPage([]));
      await settle(p.fixture);

      expect(textOf(section(p))).toContain('Nothing matches these filters');
      expect(textOf(section(p))).not.toContain('No savings activity yet');

      await p.press('Show everything', section(p));
      http.expectOne(url('limit=50&offset=0')).flush(transactionsPage(ROWS));
      await settle(p.fixture);

      expect(entries(p)).toHaveLength(5);
      expect(getByLabel<HTMLSelectElement>(section(p), 'Filter by type').value).toBe('');
    });
  });

  describe('Load more', () => {
    const FIRST = ROWS.slice(0, 3);
    const REST = ROWS.slice(3);

    it('shows how much is loaded and appends the next page, grouping rows that were split between pages', async () => {
      // The page boundary falls inside the reallocation: only its newest row is on the first page.
      const p = await open(transactionsPage(FIRST, { total: ROWS.length }));
      expect(textOf(section(p))).toContain(`Showing 3 of ${ROWS.length} records`);
      expect(entries(p)).toHaveLength(3);

      await p.press('Load more');
      http
        .expectOne(url('limit=50&offset=3'))
        .flush(transactionsPage(REST, { total: ROWS.length, offset: 3 }));
      await settle(p.fixture);

      expect(textOf(section(p))).toContain(`Showing ${ROWS.length} of ${ROWS.length} records`);
      expect(queryByRole(section(p), 'button', 'Load more')).toBeNull();
      // The reallocation became one entry once both rows were there.
      const moves = entries(p).filter((li) => textOf(li).startsWith('Moved'));
      expect(moves.map((li) => textOf(li).split(' Sep')[0])).toEqual([
        'Moved €40.00 from Holiday to Unassigned savings',
      ]);
      expect(entries(p)).toHaveLength(5);
    });

    it('says what went wrong and keeps the button when a page cannot be loaded', async () => {
      const p = await open(transactionsPage(FIRST, { total: ROWS.length }));
      await p.press('Load more');

      flushError(
        http.expectOne(url('limit=50&offset=3')),
        500,
        'internal_error',
        'Something went wrong',
      );
      await settle(p.fixture);

      expect(p.alerts()).toEqual(["Couldn't load more of the history. Something went wrong"]);
      expect(queryByRole(section(p), 'button', 'Load more')).not.toBeNull();
      expect(entries(p)).toHaveLength(3);
    });

    it('starts again when the list got shorter on the server', async () => {
      const p = await open(transactionsPage(FIRST, { total: ROWS.length }));
      await p.press('Load more');

      http.expectOne(url('limit=50&offset=3')).flush(transactionsPage([], { total: 3, offset: 3 }));
      await p.reload({ savings: OVERVIEW, history: transactionsPage(FIRST) });

      expect(queryByRole(section(p), 'button', 'Load more')).toBeNull();
    });
  });

  describe('loading and failing', () => {
    it('says it is loading while the first page is on its way', async () => {
      const p = await openSavingsPage(http, { savings: OVERVIEW, history: transactionsPage(ROWS) });
      await choose(p, 'Filter by type', 'deposit');

      expect(textOf(section(p))).toContain('Loading the history…');
      http.expectOne(url('kind=deposit&limit=50&offset=0')).flush(transactionsPage([ROWS[0]]));
      await settle(p.fixture);
      expect(textOf(section(p))).not.toContain('Loading the history…');
    });

    it('shows what the API said when the history cannot be loaded, with a way to try again, and the rest of the page still works', async () => {
      const p = await openSavingsPage(http, { savings: OVERVIEW, history: transactionsPage(ROWS) });
      await choose(p, 'Filter by type', 'deposit');
      flushError(
        http.expectOne(url('kind=deposit&limit=50&offset=0')),
        500,
        'internal_error',
        'The ledger is down',
      );
      await settle(p.fixture);

      expect(textOf(section(p))).toContain("Couldn't load the history");
      expect(textOf(section(p))).toContain('The ledger is down');
      expect(queryByRole(p.element, 'region', 'Your savings')).not.toBeNull();

      await p.press('Try again', section(p));
      http.expectOne(url('kind=deposit&limit=50&offset=0')).flush(transactionsPage([ROWS[0]]));
      await settle(p.fixture);
      expect(entries(p)).toHaveLength(1);
    });
  });
});
