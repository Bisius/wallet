import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SavingsStore } from '../../core/savings.store';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import {
  budgetsPageHelpers,
  type BudgetsPageHelpers,
  BudgetsHost,
  FUN,
  FUN_LINE,
  GROCERIES,
  GROCERIES_LINE,
  openBudgetsPage,
} from '../../../testing/budgets-harness';
import {
  budgetLine,
  monthView,
  outstandingMonth,
  savingsDto,
  transferDto,
} from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';

const CREATED = { status: 201, statusText: 'Created' };

describe('BudgetsPage: moving money', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'budgets', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const cardAction = (p: BudgetsPageHelpers, name: string, label: string) =>
    getByRole(p.card(name), 'button', label);

  describe('the actions', () => {
    it('offers "Move money" in the header, next to "New budget"', async () => {
      const p = await openBudgetsPage(http);

      expect(queryAllByRole(p.header(), 'button').map((b) => textOf(b))).toEqual([
        'Move money',
        'New budget',
      ]);
    });

    it('offers "Move money" on each card, named after the budget', async () => {
      const p = await openBudgetsPage(http);

      expect(cardAction(p, 'Groceries', 'Move money from Groceries')).toBeTruthy();
      expect(cardAction(p, 'Fun', 'Move money from Fun')).toBeTruthy();
    });

    it('hides them when there is no budget to move money to or from', async () => {
      const p = await openBudgetsPage(http, { view: monthView({ budgets: [] }), budgets: [] });

      expect(p.has('button', 'Move money')).toBe(false);
      // The list still says what it is for, and has nothing to offer.
      expect(p.transfers()).toBeTruthy();
      expect(queryByRole(p.transfers(), 'button')).toBeNull();
    });

    it('hides the card buttons with the other card actions while the budget list is missing', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(BudgetsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush({ ...monthView({ budgets: [GROCERIES_LINE] }) });
      flushError(http.expectOne('/api/budgets'), 500, 'internal_error', 'No budget table');
      http.expectOne('/api/transfers?month=2026-10').flush([]);
      await settle(fixture);
      const p = budgetsPageHelpers(http, fixture);

      expect(p.has('button', /Move money/, p.card('Groceries'))).toBe(false);
      // Without the list there is nothing to put in the dialog's pickers.
      expect(p.has('button', 'Move money')).toBe(false);
    });
  });

  describe('the dialog', () => {
    it('opens from the header with nothing chosen', async () => {
      const p = await openBudgetsPage(http);

      await p.press('Move money', p.header());

      expect(p.dialog()?.open).toBe(true);
      expect(p.value('From', p.dialog()!)).toBe('');
      expect(p.value('To', p.dialog()!)).toBe('');
      expect(p.value('Date', p.dialog()!)).toBe('2026-10-02');
    });

    it('opens from a card with that budget as the source', async () => {
      const p = await openBudgetsPage(http);

      await p.press('Move money from Fun', p.card('Fun'));

      expect(p.value('From', p.dialog()!)).toBe('2');
      expect(p.value('To', p.dialog()!)).toBe('');
    });

    it('reads what each budget holds from the month view the page already has: no second request', async () => {
      const p = await openBudgetsPage(http);

      await p.press('Move money', p.header());

      const from = p.dialog()!.querySelector('select') as HTMLSelectElement;
      expect(Array.from(from.options).map((o) => textOf(o))).toEqual([
        'Choose…',
        'Unallocated · €2,150.00 left',
        'Groceries · €300.00 left',
        'Fun · €109.50 left',
      ]);
    });

    it('starts on the 1st of a month that is not the current one, for the transfer to land where it is looked at', async () => {
      const p = await openBudgetsPage(http, {
        month: '2026-09',
        view: monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [GROCERIES_LINE, FUN_LINE],
        }),
      });

      await p.press('Move money', p.header());

      expect(p.value('Date', p.dialog()!)).toBe('2026-09-01');
      expect(textOf(p.dialog()!)).toContain(
        "September 2026 is closed. A transfer in it changes that month's budgets and what is due to savings.",
      );
    });

    it('closes when cancelled, and asks for nothing', async () => {
      const p = await openBudgetsPage(http);
      await p.press('Move money', p.header());

      await p.press('Cancel', p.dialog()!);

      expect(p.dialog()).toBeNull();
    });
  });

  describe('after money is moved', () => {
    async function move(p: BudgetsPageHelpers) {
      await p.press('Move money from Groceries', p.card('Groceries'));
      await p.type('To', '2', p.dialog()!);
      await p.type('Amount', '50', p.dialog()!);
      await p.press('Move money', p.dialog()!);
    }

    it('loads the month view, the budgets and the transfers again, and shows the new numbers', async () => {
      const p = await openBudgetsPage(http);
      await move(p);

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        fromBudgetId: 1,
        toBudgetId: 2,
        amount: 5000,
      });
      request.flush(transferDto({ id: 8 }), CREATED);
      await p.reloadAll({
        view: monthView({
          month: '2026-10',
          budgets: [
            budgetLine({
              id: 1,
              name: 'Groceries',
              transfersNet: -5000,
              available: 35000,
              remaining: 25000,
            }),
            budgetLine({
              id: 2,
              name: 'Fun',
              transfersNet: 5000,
              available: 20000,
              remaining: 15950,
            }),
          ],
        }),
        transfers: [transferDto({ id: 8 })],
      });

      expect(p.toasts()).toEqual(['Moved €50.00 from Groceries to Fun.']);
      expect(p.dialog()).toBeNull();
      expect(p.cardText('Groceries')).toContain(
        'Net moved out this month: -€50.00 (already part of Available)',
      );
      expect(p.cardText('Groceries')).toContain('Available €350.00');
      expect(p.cardText('Fun')).toContain(
        'Net moved in this month: +€50.00 (already part of Available)',
      );
      expect(textOf(p.transfers())).toContain('From Groceries to Fun Oct 2, 2026 €50.00');
    });

    it('puts the keyboard on the list heading when the button that opened the dialog is gone', async () => {
      const p = await openBudgetsPage(http);
      // The only "Move money" that is in the list block is the one of the empty list.
      await p.press('Move money', p.transfers());
      await p.type('From', '1', p.dialog()!);
      await p.type('To', '2', p.dialog()!);
      await p.type('Amount', '50', p.dialog()!);
      await p.press('Move money', p.dialog()!);

      http.expectOne('/api/transfers').flush(transferDto({ id: 8 }), CREATED);
      await p.reloadAll({ transfers: [transferDto({ id: 8 })] });

      expect(p.has('button', 'Move money', p.transfers())).toBe(false);
      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Money moved in October 2026'),
      );
    });

    it('keeps the keyboard on the button that opened the dialog when that button is still there', async () => {
      const p = await openBudgetsPage(http);
      const opener = getByRole(p.header(), 'button', 'Move money');
      opener.focus();
      opener.click();
      await settle(p.fixture);
      await p.type('From', '1', p.dialog()!);
      await p.type('To', '2', p.dialog()!);
      await p.type('Amount', '50', p.dialog()!);
      await p.press('Move money', p.dialog()!);

      http.expectOne('/api/transfers').flush(transferDto({ id: 8 }), CREATED);
      await p.reloadAll({ transfers: [transferDto({ id: 8 })] });

      expect(document.activeElement).toBe(opener);
    });

    it('also loads everything again when the API says a budget is not what the page thought', async () => {
      const p = await openBudgetsPage(http);
      await move(p);

      flushError(
        http.expectOne('/api/transfers'),
        422,
        'rule_violation',
        'Budget 2 is not active in 2026-10',
        {
          rule: 'outside_active_months',
          field: 'toBudgetId',
        },
      );
      await p.reloadAll({ budgets: [GROCERIES, { ...FUN, endMonth: '2026-09', status: 'ended' }] });

      // The dialog stays, and says that Fun can't be used any more, on its field.
      expect(p.dialog()?.open).toBe(true);
      expect(p.value('To', p.dialog()!)).toBe('2');
      expect(textOf(p.dialog()!)).toContain("Fun isn't active in October 2026. Choose another.");
    });
  });

  describe('the badge on the navigation (months to move to savings)', () => {
    /** The shell has the savings overview by the time the person is on this page: one month waits. */
    async function withOverview(p: BudgetsPageHelpers) {
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

    it('is looked at again after money is moved, since a transfer in a closed month changes what it owes', async () => {
      const p = await openBudgetsPage(http);
      const savings = await withOverview(p);
      await p.press('Move money from Groceries', p.card('Groceries'));
      await p.type('To', '2', p.dialog()!);
      await p.type('Amount', '50', p.dialog()!);
      await p.type('Date', '2026-09-20', p.dialog()!);
      http
        .expectOne('/api/months/2026-09')
        .flush(
          monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE, FUN_LINE] }),
        );
      await settle(p.fixture);
      await p.press('Move money', p.dialog()!);
      await p.press('Move money anyway', p.confirmDialog());
      http.expectOne('/api/transfers').flush(transferDto({ id: 8, date: '2026-09-20' }), CREATED);

      // Without waiting for the person to go to another page, the navigation hears about it.
      const asked = await p.reloadAll({ savings: AFTER });

      expect(asked).toBe(1);
      expect(savings.outstandingCount()).toBe(2);
    });

    it('is looked at again after a transfer is deleted', async () => {
      const p = await openBudgetsPage(http, { transfers: [transferDto({ id: 5 })] });
      const savings = await withOverview(p);
      await p.transferAction('€50.00 from Groceries to Fun on Oct 2, 2026', 'Delete');
      await p.press('Delete transfer', p.confirmDialog());
      http.expectOne('/api/transfers/5').flush(null, { status: 204, statusText: 'No Content' });

      const asked = await p.reloadAll({ transfers: [], savings: AFTER });

      expect(asked).toBe(1);
      expect(savings.outstandingCount()).toBe(2);
    });

    it('is not asked for when the page opens: the shell has it already', async () => {
      const p = await openBudgetsPage(http);

      http.expectNone('/api/savings');
      expect(p.has('button', 'Move money')).toBe(true);
    });
  });

  describe('the list of transfers', () => {
    it("lists the month's transfers under the cards, named from the budget list", async () => {
      const p = await openBudgetsPage(http, {
        transfers: [
          transferDto({
            id: 2,
            date: '2026-10-09',
            fromBudgetId: null,
            toBudgetId: 1,
            amount: 2500,
            note: 'Bonus',
          }),
          transferDto({ id: 1, date: '2026-10-02' }),
        ],
      });

      expect(textOf(getByRole(p.element, 'heading', 'Money moved in October 2026'))).toBe(
        'Money moved in October 2026',
      );
      expect(queryAllByRole(p.transfers(), 'listitem').map((row) => textOf(row))).toEqual([
        'From Unallocated to Groceries Oct 9, 2026 · Bonus €25.00 Delete',
        'From Groceries to Fun Oct 2, 2026 €50.00 Delete',
      ]);
    });

    it('asks for the transfers of the shown month, and again when the month changes', async () => {
      const p = await openBudgetsPage(http);
      await TestBed.inject(Router).navigateByUrl('/budgets?month=2026-09');
      await settle(p.fixture);

      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES_LINE] }));
      http.expectOne('/api/transfers?month=2026-09').flush([transferDto({ date: '2026-09-12' })]);
      await settle(p.fixture);

      expect(textOf(getByRole(p.element, 'heading', 'Money moved in September 2026'))).toBe(
        'Money moved in September 2026',
      );
      expect(queryAllByRole(p.transfers(), 'listitem')).toHaveLength(1);
    });

    it('says when nothing was moved', async () => {
      const p = await openBudgetsPage(http);
      expect(textOf(p.transfers())).toContain('No money moved in October 2026');
    });

    it('keeps the budgets when only the transfers cannot be loaded, and can try again', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(BudgetsHost);
      fixture.detectChanges();
      await settle(fixture);
      http
        .expectOne('/api/months/2026-10')
        .flush(monthView({ budgets: [GROCERIES_LINE, FUN_LINE] }));
      http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
      flushError(
        http.expectOne('/api/transfers?month=2026-10'),
        500,
        'internal_error',
        'No transfers today',
      );
      await settle(fixture);
      const p = budgetsPageHelpers(http, fixture);

      expect(p.cardText('Groceries')).toContain('Available €400.00');
      const alert = getByRole(p.transfers(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the money moved");
      expect(textOf(alert)).toContain('No transfers today');

      await p.press('Try again', alert);
      http.expectOne('/api/transfers?month=2026-10').flush([transferDto()]);
      await settle(fixture);
      expect(queryAllByRole(p.transfers(), 'listitem')).toHaveLength(1);
    });

    it('deletes a transfer after asking, and loads everything again', async () => {
      const p = await openBudgetsPage(http, { transfers: [transferDto({ id: 5 })] });
      await p.transferAction('€50.00 from Groceries to Fun on Oct 2, 2026', 'Delete');
      await p.press('Delete transfer', p.confirmDialog());

      const request = http.expectOne('/api/transfers/5');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reloadAll({ transfers: [] });

      expect(p.toasts()).toEqual(['Transfer deleted.']);
      expect(textOf(p.transfers())).toContain('No money moved in October 2026');
      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Money moved in October 2026'),
      );
    });

    it('asks again in the words of a closed month when the transfer is in one', async () => {
      const p = await openBudgetsPage(http, {
        month: '2026-09',
        view: monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [GROCERIES_LINE, FUN_LINE],
        }),
        transfers: [transferDto({ id: 5, date: '2026-09-20' })],
      });

      await p.transferAction('€50.00 from Groceries to Fun on Sep 20, 2026', 'Delete');

      expect(textOf(p.confirmDialog())).toContain(
        "September 2026 is already closed, so this changes that month's budgets and the amount due to savings for it.",
      );
    });
  });

  describe('the cards show what was moved', () => {
    it('says what came in, and that it is already part of what is available', async () => {
      const p = await openBudgetsPage(http, {
        view: monthView({
          budgets: [
            budgetLine({
              id: 1,
              name: 'Groceries',
              transfersNet: 5000,
              allocated: 40000,
              available: 45000,
              remaining: 35000,
            }),
          ],
        }),
      });

      expect(p.cardText('Groceries')).toContain(
        'Net moved in this month: +€50.00 (already part of Available)',
      );
      expect(p.cardText('Groceries')).toContain('Available €450.00');
    });

    it('says what went out, with a minus sign and a word, not only a color', async () => {
      const p = await openBudgetsPage(http, {
        view: monthView({
          budgets: [
            budgetLine({
              id: 1,
              name: 'Groceries',
              transfersNet: -12050,
              allocated: 40000,
              available: 27950,
              remaining: 17950,
            }),
          ],
        }),
      });

      expect(p.cardText('Groceries')).toContain(
        'Net moved out this month: -€120.50 (already part of Available)',
      );
    });

    it('says nothing when nothing was moved', async () => {
      const p = await openBudgetsPage(http);

      expect(p.cardText('Groceries')).not.toContain('Moved');
    });
  });
});
