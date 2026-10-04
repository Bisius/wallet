import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { MonthView, SpendingDto, SpendingsPage, TagDto } from '@wallet/shared';
import { spendingCreateSchema, spendingUpdateSchema } from '@wallet/shared';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { budgetLine, monthView, spendingDto, spendingsPage } from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import { menuItemNames, rowAction } from '../../../testing/menu';
import { LAST_BUDGET_KEY } from './last-budget.store';
import { SpendingsPage as SpendingsPageComponent } from './spendings-page';

@Component({
  selector: 'app-spendings-host',
  imports: [SpendingsPageComponent, ConfirmDialog, ToastContainer],
  template: '<app-spendings-page /><app-confirm-dialog /><app-toast-container />',
})
class SpendingsHost {}

const GROCERIES = budgetLine({ id: 1, name: 'Groceries', color: '#2563eb' });
const FUN = budgetLine({
  id: 2,
  name: 'Fun',
  available: 15000,
  spent: 0,
  remaining: 15000,
  usagePercent: 0,
  allocated: 15000,
});
const OCTOBER = monthView({ month: '2026-10', budgets: [GROCERIES, FUN] });

const COFFEE = spendingDto({ id: 3, date: '2026-10-02', amount: 350, description: 'Coffee' });
const LUNCH = spendingDto({ id: 2, date: '2026-10-02', amount: 1250, description: 'Lunch' });
const SHOES = spendingDto({
  id: 1,
  date: '2026-10-01',
  amount: -4500,
  budgetId: 2,
  description: 'Shoes (returned)',
});
const PAGE = spendingsPage([COFFEE, LUNCH, SHOES]);

const firstPageUrl = (month = '2026-10', budgetId?: number) =>
  `/api/spendings?month=${month}${budgetId === undefined ? '' : `&budgetId=${budgetId}`}&limit=50&offset=0`;

describe('SpendingsPage', () => {
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
    // A spec that is not about tags and answers the page's first requests one by one (to look at an
    // error, say) leaves the tag list unanswered: answer it with no tags. It was asked for once.
    const tags = http.match('/api/tags');
    expect(tags.length).toBeLessThanOrEqual(1);
    for (const request of tags) {
      if (!request.cancelled) request.flush([]);
    }
    http.verify();
    localStorage.clear();
  });

  interface Data {
    view?: MonthView;
    page?: SpendingsPage;
    tags?: TagDto[];
  }

  /** Opens the page for a month and answers its two requests. */
  async function open(month = '2026-10', data: Data = {}) {
    await primeStores(http);
    await router.navigateByUrl(`/spendings${month === '2026-10' ? '' : `?month=${month}`}`);
    const fixture = TestBed.createComponent(SpendingsHost);
    fixture.detectChanges();
    await settle(fixture);
    // The tag list is asked for once, when the page is first shown: not again after a change.
    http.expectOne('/api/tags').flush(data.tags ?? []);
    await answer(fixture, month, data);
    return page(fixture);
  }

  async function answer(
    fixture: { detectChanges(): void },
    month: string,
    data: Data = {},
    budgetId?: number,
  ) {
    http.expectOne(`/api/months/${month}`).flush(data.view ?? { ...OCTOBER, month });
    http.expectOne(firstPageUrl(month, budgetId)).flush(data.page ?? PAGE);
    await settle(fixture as never);
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<SpendingsHost>>) {
    const element = fixture.nativeElement as HTMLElement;
    const helpers = {
      fixture,
      element,
      text: () => textOf(element),
      list: () => getByRole(element, 'region', /Spendings in/),
      form: () => element.querySelector('section app-spending-form') as HTMLElement,
      dialog: () => queryByRole(element, 'dialog', 'Edit spending') as HTMLElement | null,
      confirmDialog: () => element.querySelector('app-confirm-dialog dialog') as HTMLDialogElement,
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      /** Presses an item of the "More actions" menu of a row: `rowAction('Lunch, €12.50', 'Delete')`. */
      rowAction: (row: string, item: string | RegExp) =>
        rowAction(element, item, `More actions for ${row}`),
      /** Unfolds "More" of the quick add (description, tags, Refund), as a person does with its summary. */
      openMore: async () => {
        const details = helpers.form().querySelector('details') as HTMLDetailsElement;
        if (!details.open) (details.querySelector('summary') as HTMLElement).click();
        await settle(fixture);
        expect(details.open).toBe(true);
      },
      type: async (label: string | RegExp, value: string, root: ParentNode = helpers.form()) => {
        typeInto(getByLabel(root, label), value);
        await settle(fixture);
      },
      flip: async (label: string | RegExp, root: ParentNode = helpers.form()) => {
        getByLabel(root, label).click();
        await settle(fixture);
      },
      value: (label: string | RegExp, root: ParentNode = helpers.form()) =>
        (getByLabel(root, label) as HTMLInputElement).value,
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** After a change the page loads the list and the month view again. */
      reload: async (data: Data = {}, month = '2026-10') => {
        await settle(fixture);
        await answer(fixture, month, data);
      },
    };
    return helpers;
  }

  const noRequest = (pattern: RegExp) => http.expectNone((request) => pattern.test(request.url));

  describe('the add form', () => {
    it('has an amount, a budget, a date and a description, each with a label', async () => {
      const p = await open();

      for (const label of ['Amount', 'Budget', 'Date', 'Description (optional)', 'Refund']) {
        expect(getByLabel(p.form(), label), label).toBeTruthy();
      }
      expect(p.value('Amount')).toBe('');
    });

    describe('is compact', () => {
      const more = (p: Awaited<ReturnType<typeof open>>) =>
        p.form().querySelector('details') as HTMLDetailsElement;

      it('puts the amount, the budget and the date up front, and the description, the tags and Refund under "More"', async () => {
        const p = await open();

        const details = more(p);
        expect(textOf(details.querySelector('summary') as Element)).toContain('More');
        expect(details.open).toBe(false);
        for (const label of ['Amount', 'Budget', 'Date']) {
          expect(details.contains(getByLabel(p.form(), label)), label).toBe(false);
        }
        for (const label of ['Description (optional)', 'Tags (optional)', 'Refund']) {
          expect(details.contains(getByLabel(p.form(), label)), label).toBe(true);
        }
      });

      it('says to a screen reader what "More" holds', async () => {
        const p = await open();

        expect(textOf(more(p).querySelector('summary') as Element)).toContain(
          'description, tags and refund',
        );
      });

      it('opens by itself when the description has a value', async () => {
        const p = await open();
        expect(more(p).open).toBe(false);

        await p.type('Description (optional)', 'Tea');

        expect(more(p).open).toBe(true);
      });

      it('opens by itself when Refund is turned on, so the switch that changes the button is in sight', async () => {
        const p = await open();

        await p.flip('Refund');

        expect(more(p).open).toBe(true);
        expect(getByRole(p.form(), 'button', 'Add refund')).toBeTruthy();
      });

      it('opens by itself, and puts the cursor in the field, when what is in it is not valid', async () => {
        const p = await open();
        await p.type('Amount', '5');
        await p.type('Description (optional)', 'x'.repeat(201));
        // The person folded it again: a problem in it unfolds it.
        (more(p).querySelector('summary') as HTMLElement).click();
        await settle(p.fixture);
        expect(more(p).open).toBe(false);

        await p.press('Add spending');

        expect(more(p).open).toBe(true);
        expect(fieldError(getByLabel(p.form(), 'Description (optional)'))).not.toBe('');
        expect(document.activeElement).toBe(getByLabel(p.form(), 'Description (optional)'));
        noRequest(/\/api\/spendings$/);
      });

      it('stays as the person left it after an entry is added', async () => {
        const p = await open();
        await p.openMore();
        await p.type('Amount', '5');

        await p.press('Add spending');
        http
          .expectOne('/api/spendings')
          .flush(spendingDto({ id: 4, amount: 500 }), { status: 201, statusText: 'Created' });
        await p.reload();

        expect(more(p).open).toBe(true);
        expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));
      });
    });

    it("starts on today's date from the server, inside the shown month", async () => {
      const p = await open();

      const date = getByLabel(p.form(), 'Date');
      expect((date as HTMLInputElement).value).toBe('2026-10-02');
      expect(date.getAttribute('min')).toBe('2026-10-01');
      expect(date.getAttribute('max')).toBe('2026-10-31');
    });

    it('uses the nearest day of another month: the last of a past one, the first of a future one', async () => {
      const past = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES] }),
        page: spendingsPage([]),
      });
      expect(past.value('Date')).toBe('2026-08-31');
      past.fixture.destroy();

      await router.navigateByUrl('/spendings?month=2026-12');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);
      await answer(fixture, '2026-12', {
        view: monthView({ month: '2026-12', status: 'future', budgets: [GROCERIES] }),
        page: spendingsPage([]),
      });
      expect(page(fixture).value('Date')).toBe('2026-12-01');
    });

    it('starts on the first budget, and shows what is left in each', async () => {
      const p = await open();

      expect(p.value('Budget')).toBe('1');
      const options = Array.from(getByLabel(p.form(), 'Budget').querySelectorAll('option')).map(
        (option) => textOf(option),
      );
      expect(options).toEqual(['Groceries · €300.00 left', 'Fun · €150.00 left']);
    });

    it('says "over by" for a budget that has been overspent, not a negative amount left', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [
            GROCERIES,
            budgetLine({
              id: 2,
              name: 'Fun',
              available: 15000,
              spent: 19950,
              remaining: -4950,
              usagePercent: 133,
              alert: 'over',
            }),
          ],
        }),
      });

      const options = Array.from(getByLabel(p.form(), 'Budget').querySelectorAll('option')).map(
        (option) => textOf(option),
      );
      expect(options).toEqual(['Groceries · €300.00 left', 'Fun · over by €49.50']);
    });

    it('starts on the budget used last, when it exists in the month', async () => {
      localStorage.setItem(LAST_BUDGET_KEY, '2');
      const p = await open();
      expect(p.value('Budget')).toBe('2');
    });

    it('falls back to the first budget when the last one is not in this month', async () => {
      localStorage.setItem(LAST_BUDGET_KEY, '99');
      const p = await open();
      expect(p.value('Budget')).toBe('1');
    });

    it('works when the browser storage cannot be used', async () => {
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      try {
        const p = await open();
        expect(p.value('Budget')).toBe('1');

        await p.type('Amount', '5');
        await p.press('Add spending');
        http
          .expectOne('/api/spendings')
          .flush(spendingDto({ id: 9, amount: 500 }), { status: 201, statusText: 'Created' });
        await p.reload();
        expect(textOf(getByRole(p.element, 'status', /Added/))).toContain(
          'Added €5.00 to Groceries',
        );
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });

    it('picks another budget when the month switcher moves to a month the chosen one does not exist in', async () => {
      const RENT = budgetLine({ id: 3, name: 'Rent', available: 90000, remaining: 90000 });
      const p = await open('2026-10', {
        view: monthView({ budgets: [GROCERIES, FUN, RENT] }),
      });
      await p.type('Budget', '3');
      expect(p.value('Budget')).toBe('3');

      await router.navigateByUrl('/spendings?month=2026-09');
      await settle(p.fixture);
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES, FUN] }));
      http.expectOne(firstPageUrl('2026-09')).flush(spendingsPage([]));
      await settle(p.fixture);

      // Rent did not exist in September: the form falls back to the first budget that did.
      expect(p.value('Budget')).toBe('1');
    });

    it('keeps the date inside the month when the month switcher moves while it is open', async () => {
      const p = await open();
      await router.navigateByUrl('/spendings?month=2026-09');
      await settle(p.fixture);
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES, FUN] }));
      http.expectOne(firstPageUrl('2026-09')).flush(spendingsPage([]));
      await settle(p.fixture);

      expect(p.value('Date')).toBe('2026-09-30');
      expect(getByLabel(p.form(), 'Date').getAttribute('max')).toBe('2026-09-30');
    });
  });

  describe('adding a spending', () => {
    it('posts the spending with the date, the budget and integer cents', async () => {
      const p = await open();
      await p.type('Amount', '12,50');
      await p.openMore();
      await p.type('Description (optional)', '  Coffee beans ');

      await p.press('Add spending');

      const request = http.expectOne('/api/spendings');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        amount: 1250,
        budgetId: 1,
        description: 'Coffee beans',
      });
      expect(spendingCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(spendingDto({ id: 4, amount: 1250, description: 'Coffee beans' }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();
    });

    it('leaves the description out when there is none', async () => {
      const p = await open();
      await p.type('Amount', '3');
      await p.press('Add spending');

      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toEqual({ date: '2026-10-02', amount: 300, budgetId: 1 });
      request.flush(spendingDto({ id: 4, amount: 300 }), { status: 201, statusText: 'Created' });
      await p.reload();
    });

    it('uses the budget and the date that were chosen', async () => {
      const p = await open();
      await p.type('Amount', '20');
      await p.type('Budget', '2');
      await p.type('Date', '2026-10-15');
      await p.press('Add spending');

      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toEqual({ date: '2026-10-15', amount: 2000, budgetId: 2 });
      request.flush(spendingDto({ id: 4, budgetId: 2, amount: 2000 }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();
    });

    it("confirms with the budget's remaining amount from a fresh month view", async () => {
      const p = await open();
      await p.type('Amount', '12,50');
      await p.press('Add spending');
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 4, amount: 1250 }), { status: 201, statusText: 'Created' });
      await settle(p.fixture);

      // Nothing is claimed before the month view has been loaded again.
      expect(queryByRole(p.element, 'status', /Added/)).toBeNull();
      const fresh = monthView({
        budgets: [
          budgetLine({
            id: 1,
            name: 'Groceries',
            spent: 11250,
            remaining: 28750,
            usagePercent: 28,
          }),
          FUN,
        ],
      });
      await answer(p.fixture, '2026-10', {
        view: fresh,
        page: spendingsPage([spendingDto({ id: 4, amount: 1250 }), ...PAGE.items]),
      });

      expect(textOf(getByRole(p.element, 'status', /Added/))).toBe(
        'Added €12.50 to Groceries. €287.50 left of €400.00.',
      );
    });

    it('says when the budget has gone over, or is close to its limit', async () => {
      const p = await open();
      await p.type('Amount', '100');
      await p.press('Add spending');
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 4, amount: 10000 }), { status: 201, statusText: 'Created' });
      await settle(p.fixture);
      await answer(p.fixture, '2026-10', {
        view: monthView({
          budgets: [
            budgetLine({
              id: 1,
              spent: 36000,
              remaining: 4000,
              usagePercent: 90,
              alert: 'warning',
            }),
            FUN,
          ],
        }),
      });
      expect(textOf(getByRole(p.element, 'status', /Added/))).toBe(
        'Added €100.00 to Groceries. €40.00 left of €400.00. Warning: 90% used.',
      );

      await p.type('Amount', '60');
      await p.press('Add spending');
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 5, amount: 6000 }), { status: 201, statusText: 'Created' });
      await settle(p.fixture);
      await answer(p.fixture, '2026-10', {
        view: monthView({
          budgets: [
            budgetLine({
              id: 1,
              spent: 42000,
              remaining: -2000,
              usagePercent: 105,
              alert: 'over',
            }),
            FUN,
          ],
        }),
      });
      expect(textOf(getByRole(p.element, 'status', /Added/))).toBe(
        'Added €60.00 to Groceries. Over budget by €20.00 (105% used).',
      );
    });

    it('is ready for the next entry: amount and description cleared, budget and date kept, cursor on the amount', async () => {
      const p = await open();
      await p.type('Amount', '5');
      await p.openMore();
      await p.type('Description (optional)', 'Tea');
      await p.type('Budget', '2');
      await p.type('Date', '2026-10-09');
      await p.flip('Refund');
      await p.press('Add refund');
      http.expectOne('/api/spendings').flush(spendingDto({ id: 4, budgetId: 2, amount: -500 }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();

      expect(p.value('Amount')).toBe('');
      expect(p.value('Description (optional)')).toBe('');
      expect((getByLabel(p.form(), 'Refund') as HTMLInputElement).checked).toBe(false);
      // What the next entry most likely shares with this one stays.
      expect(p.value('Budget')).toBe('2');
      expect(p.value('Date')).toBe('2026-10-09');
      expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));
      // A fresh form does not scold the person who has not typed yet.
      expect(fieldError(getByLabel(p.form(), 'Amount'))).toBe('');
      expect(p.toasts()).toEqual([]);
    });

    it('remembers the budget for the next time', async () => {
      const p = await open();
      await p.type('Amount', '5');
      await p.type('Budget', '2');
      await p.press('Add spending');
      http.expectOne('/api/spendings').flush(spendingDto({ id: 4, budgetId: 2, amount: 500 }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();

      expect(localStorage.getItem(LAST_BUDGET_KEY)).toBe('2');
    });

    it('adds a second spending straight away, without touching the budget again', async () => {
      const p = await open();
      await p.type('Amount', '5');
      await p.type('Budget', '2');
      await p.press('Add spending');
      http.expectOne('/api/spendings').flush(spendingDto({ id: 4, budgetId: 2, amount: 500 }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();

      await p.type('Amount', '7,5');
      await p.press('Add spending');
      const request = http.expectOne('/api/spendings');
      expect(request.request.body).toEqual({ date: '2026-10-02', amount: 750, budgetId: 2 });
      request.flush(spendingDto({ id: 5, budgetId: 2, amount: 750 }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();
    });

    describe('refund', () => {
      it('is a switch: the person types a plain amount, and the request carries it negative', async () => {
        const p = await open();
        await p.type('Amount', '45');
        await p.openMore();
        await p.flip('Refund');
        expect(textOf(getByRole(p.form(), 'button', 'Add refund'))).toBe('Add refund');

        await p.press('Add refund');

        const request = http.expectOne('/api/spendings');
        expect(request.request.body).toEqual({ date: '2026-10-02', amount: -4500, budgetId: 1 });
        expect(spendingCreateSchema.safeParse(request.request.body).success).toBe(true);
        request.flush(spendingDto({ id: 4, amount: -4500 }), {
          status: 201,
          statusText: 'Created',
        });
        await p.reload();
      });

      it('is confirmed as a refund', async () => {
        const p = await open();
        await p.type('Amount', '45');
        await p.openMore();
        await p.flip('Refund');
        await p.press('Add refund');
        http
          .expectOne('/api/spendings')
          .flush(spendingDto({ id: 4, amount: -4500 }), { status: 201, statusText: 'Created' });
        await p.reload();

        expect(textOf(getByRole(p.element, 'status', /Refund of/))).toContain(
          'Refund of €45.00 added to Groceries.',
        );
      });

      it('says what it is for, and refuses a typed minus sign', async () => {
        const p = await open();
        expect(textOf(p.form())).toContain(
          'Money coming back into the budget, such as a returned item.',
        );

        await p.type('Amount', '-5');
        await p.press('Add spending');

        expect(fieldError(getByLabel(p.form(), 'Amount'))).toBe(
          'Enter the amount without a minus sign. Turn on Refund for money coming back.',
        );
        noRequest(/\/api\/spendings$/);
      });
    });

    it('needs an amount above zero, a budget and a date in the month, and sends nothing otherwise', async () => {
      const p = await open();
      await p.press('Add spending');
      expect(fieldError(getByLabel(p.form(), 'Amount'))).toBe('Amount is required.');
      expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));

      await p.type('Amount', '0');
      await p.type('Date', '2026-09-30');
      await p.press('Add spending');
      expect(fieldError(getByLabel(p.form(), 'Amount'))).toBe('Enter an amount greater than zero.');
      expect(fieldError(getByLabel(p.form(), 'Date'))).toBe('Choose a date in October 2026.');
      noRequest(/\/api\/spendings$/);
    });

    it('limits the description to what the API accepts', async () => {
      const p = await open();
      expect(getByLabel(p.form(), 'Description (optional)').getAttribute('maxlength')).toBe('200');
    });

    describe('errors from the API', () => {
      const submit = async (p: Awaited<ReturnType<typeof open>>) => {
        await p.type('Amount', '10');
        await p.press('Add spending');
      };

      it('shows outside_active_months on the date, keeping what was typed', async () => {
        const p = await open();
        await submit(p);
        flushError(
          http.expectOne('/api/spendings'),
          422,
          'rule_violation',
          'The date is outside the active months of "Groceries" (2026-06 to no end)',
          { rule: 'outside_active_months', field: 'date' },
        );
        await settle(p.fixture);

        expect(fieldError(getByLabel(p.form(), 'Date'))).toBe(
          'The date is outside the active months of "Groceries" (2026-06 to no end)',
        );
        expect(document.activeElement).toBe(getByLabel(p.form(), 'Date'));
        // Focus moved on, so the amount was tidied up as the person left it.
        expect(p.value('Amount')).toBe('10.00');
        expect(p.toasts()).toEqual([]);
      });

      it('shows before_start_month on the date', async () => {
        const p = await open();
        await submit(p);
        flushError(
          http.expectOne('/api/spendings'),
          422,
          'rule_violation',
          'A spending cannot be dated 2026-10-02, before the start month 2026-11',
          { rule: 'before_start_month', field: 'date' },
        );
        await settle(p.fixture);

        expect(fieldError(getByLabel(p.form(), 'Date'))).toBe(
          'A spending cannot be dated 2026-10-02, before the start month 2026-11',
        );
      });

      it('shows unknown_budget on the budget', async () => {
        const p = await open();
        await submit(p);
        flushError(
          http.expectOne('/api/spendings'),
          422,
          'rule_violation',
          'Budget 1 does not exist',
          { rule: 'unknown_budget', field: 'budgetId' },
        );
        await settle(p.fixture);

        expect(fieldError(getByLabel(p.form(), 'Budget'))).toBe('Budget 1 does not exist');
        expect(document.activeElement).toBe(getByLabel(p.form(), 'Budget'));
      });

      it('lets the person try again once the field is changed', async () => {
        const p = await open();
        await submit(p);
        flushError(
          http.expectOne('/api/spendings'),
          422,
          'rule_violation',
          'The date is outside the active months',
          { rule: 'outside_active_months', field: 'date' },
        );
        await settle(p.fixture);

        await p.type('Date', '2026-10-10');
        await p.press('Add spending');
        const request = http.expectOne('/api/spendings');
        expect(request.request.body.date).toBe('2026-10-10');
        request.flush(spendingDto({ id: 4, amount: 1000, date: '2026-10-10' }), {
          status: 201,
          statusText: 'Created',
        });
        await p.reload();
      });

      it('shows an error that belongs to no field in an alert in the form', async () => {
        const p = await open();
        await submit(p);
        flushError(http.expectOne('/api/spendings'), 500, 'internal_error', 'Something broke');
        await settle(p.fixture);

        expect(textOf(getByRole(p.form(), 'alert'))).toBe('Something broke');
        // What was typed is kept (the box tidies it up when focus leaves it, for the button).
        expect(p.value('Amount')).toBe('10.00');
      });

      it('puts focus back on the button that was pressed when the error belongs to no field', async () => {
        const p = await open();
        const button = getByRole(p.form(), 'button', 'Add spending');
        button.focus();
        await submit(p);
        // A button that is disabled while the request is out loses focus to the page, as in a browser.
        button.blur();
        flushError(http.expectOne('/api/spendings'), 500, 'internal_error', 'Something broke');
        await settle(p.fixture);

        expect(document.activeElement).toBe(button);
      });
    });

    describe('without budgets', () => {
      it('sends the person to create one first', async () => {
        const p = await open('2026-10', {
          view: monthView({ budgets: [] }),
          page: spendingsPage([]),
        });

        expect(p.text()).toContain('No budgets in October 2026');
        expect(p.element.querySelector('app-spending-form')).toBeNull();
        expect(getByRole(p.element, 'link', 'Go to budgets').getAttribute('href')).toBe('/budgets');
      });
    });

    it('says what a closed or future month means for a new spending', async () => {
      const closed = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES] }),
        page: spendingsPage([]),
      });
      expect(closed.text()).toContain(
        'August 2026 is closed. A spending added to it changes what is due to savings.',
      );
    });
  });

  describe('the list', () => {
    it('groups the month by day, newest first, with the budget, description and amount of each', async () => {
      const p = await open();

      const headings = Array.from(p.list().querySelectorAll('h3')).map((h) => textOf(h));
      expect(headings).toEqual(['Fri, Oct 2, 2026', 'Thu, Oct 1, 2026']);

      const rows = Array.from(p.list().querySelectorAll('li')).map((li) => textOf(li));
      expect(rows[0]).toContain('Coffee Groceries €3.50');
      expect(rows[1]).toContain('Lunch Groceries €12.50');
      expect(rows[2]).toContain('Shoes (returned) Fun Refund -€45.00');
    });

    it('shows the net total as the API reports it, not a sum of the rows', async () => {
      const p = await open('2026-10', {
        page: { ...PAGE, total: 3, totalAmount: 99999 },
      });

      expect(textOf(p.list())).toContain('3 spendings · €999.99 net. Refunds are subtracted.');
    });

    it('counts the whole month, not only the rows that are loaded', async () => {
      const p = await open('2026-10', { page: { ...PAGE, total: 120, totalAmount: 456700 } });

      expect(textOf(p.list())).toContain('120 spendings · €4,567.00 net');
      expect(textOf(p.list())).toContain('Showing 3 of 120');
    });

    it('marks a refund with a word and a minus sign, not only a color', async () => {
      const p = await open();

      const row = Array.from(p.list().querySelectorAll('li')).find((li) =>
        textOf(li).includes('Shoes'),
      ) as HTMLElement;
      expect(textOf(row)).toContain('Refund');
      expect(textOf(row)).toContain('-€45.00');
    });

    it('says "No description" when a spending has none', async () => {
      const p = await open('2026-10', {
        page: spendingsPage([spendingDto({ id: 8, description: '' })]),
      });
      expect(textOf(p.list())).toContain('No description');
    });

    it('says when the month has no spendings', async () => {
      const p = await open('2026-10', { page: spendingsPage([]) });
      expect(textOf(p.list())).toContain('No spendings in October 2026');
    });

    it('says it is loading while the requests are out', async () => {
      await primeStores(http);
      await router.navigateByUrl('/spendings');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);

      expect(textOf(fixture.nativeElement)).toContain('Loading spendings…');
      expect(textOf(fixture.nativeElement)).toContain("Loading this month's budgets…");
      await answer(fixture, '2026-10');
    });

    it('shows what the API said when the list cannot be loaded, and can try again', async () => {
      await primeStores(http);
      await router.navigateByUrl('/spendings');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(http.expectOne(firstPageUrl()), 500, 'internal_error', 'The list is busy');
      await settle(fixture);
      const p = page(fixture);

      const alert = getByRole(p.list(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the spendings");
      expect(textOf(alert)).toContain('The list is busy');
      // The form still works.
      expect(getByLabel(p.form(), 'Amount')).toBeTruthy();

      getByRole(alert, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne(firstPageUrl()).flush(PAGE);
      await settle(fixture);
      expect(p.text()).toContain('Coffee');
    });

    it('shows the error in the form when the month view cannot be loaded, and keeps the list', async () => {
      await primeStores(http);
      await router.navigateByUrl('/spendings');
      const fixture = TestBed.createComponent(SpendingsHost);
      fixture.detectChanges();
      await settle(fixture);
      flushError(http.expectOne('/api/months/2026-10'), 500, 'internal_error', 'No ledger');
      http.expectOne(firstPageUrl()).flush(PAGE);
      await settle(fixture);
      const p = page(fixture);

      expect(
        textOf(getByRole(p.element.querySelector('section') as HTMLElement, 'alert')),
      ).toContain('No ledger');
      expect(p.text()).toContain('Coffee');
      // Without the month view the row names its budget by number.
      expect(p.text()).toContain('Budget 1');
    });
  });

  describe('filter by budget', () => {
    it('offers every budget of the month, and asks the API for one budget only', async () => {
      const p = await open();
      const select = getByLabel(p.element, 'Filter by budget');
      expect(Array.from(select.querySelectorAll('option')).map((option) => textOf(option))).toEqual(
        ['All budgets', 'Groceries', 'Fun'],
      );

      typeInto(select, '2');
      await settle(p.fixture);
      http
        .expectOne(firstPageUrl('2026-10', 2))
        .flush(spendingsPage([SHOES], { totalAmount: -4500 }));
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('Shoes (returned)');
      expect(textOf(p.list())).not.toContain('Coffee');
      expect(textOf(p.list())).toContain('1 spending · -€45.00 net');
    });

    it('says so when a budget has no spendings, and goes back to all of them', async () => {
      const p = await open();
      typeInto(getByLabel(p.element, 'Filter by budget'), '2');
      await settle(p.fixture);
      http.expectOne(firstPageUrl('2026-10', 2)).flush(spendingsPage([]));
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('No spendings for Fun in October 2026');

      await p.press('Show all budgets');
      http.expectOne(firstPageUrl()).flush(PAGE);
      await settle(p.fixture);
      expect(textOf(p.list())).toContain('Coffee');
      expect((getByLabel(p.element, 'Filter by budget') as HTMLSelectElement).value).toBe('');
    });

    it('starts again from all budgets when the month changes', async () => {
      const p = await open();
      typeInto(getByLabel(p.element, 'Filter by budget'), '2');
      await settle(p.fixture);
      http.expectOne(firstPageUrl('2026-10', 2)).flush(spendingsPage([SHOES]));
      await settle(p.fixture);

      await router.navigateByUrl('/spendings?month=2026-09');
      await settle(p.fixture);
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', budgets: [GROCERIES, FUN] }));
      http.expectOne(firstPageUrl('2026-09')).flush(spendingsPage([]));
      await settle(p.fixture);

      expect((getByLabel(p.element, 'Filter by budget') as HTMLSelectElement).value).toBe('');
    });
  });

  describe('load more', () => {
    const many = (from: number, count: number): SpendingDto[] =>
      Array.from({ length: count }, (_unused, index) =>
        spendingDto({
          id: from - index,
          date: `2026-10-${String(Math.max(1, 28 - Math.floor((from - index) / 5))).padStart(2, '0')}`,
          description: `Item ${from - index}`,
          amount: 100,
        }),
      );

    it('shows how many rows are loaded and offers more while there are some', async () => {
      const p = await open('2026-10', { page: spendingsPage(many(120, 50), { total: 120 }) });

      expect(textOf(p.list())).toContain('Showing 50 of 120');
      expect(queryByRole(p.list(), 'button', 'Load more')).not.toBeNull();
    });

    it('asks for the next page with limit and offset, and appends it to the list', async () => {
      const p = await open('2026-10', { page: spendingsPage(many(120, 50), { total: 120 }) });

      await p.press('Load more');
      const request = http.expectOne('/api/spendings?month=2026-10&limit=50&offset=50');
      expect(request.request.method).toBe('GET');
      request.flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('Showing 100 of 120');
      const rows = Array.from(p.list().querySelectorAll('li'));
      expect(rows).toHaveLength(100);
      expect(textOf(rows[0])).toContain('Item 120');
      expect(textOf(rows[50])).toContain('Item 70');
      expect(queryByRole(p.list(), 'button', 'Load more')).not.toBeNull();
    });

    it('keeps the budget filter in the next request', async () => {
      const p = await open();
      typeInto(getByLabel(p.element, 'Filter by budget'), '1');
      await settle(p.fixture);
      http
        .expectOne(firstPageUrl('2026-10', 1))
        .flush(spendingsPage(many(120, 50), { total: 120 }));
      await settle(p.fixture);

      await p.press('Load more');
      http
        .expectOne('/api/spendings?month=2026-10&budgetId=1&limit=50&offset=50')
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);
      expect(textOf(p.list())).toContain('Showing 100 of 120');
    });

    it('stops offering more at the last page, and moves focus to the list heading', async () => {
      const p = await open('2026-10', { page: spendingsPage(many(60, 50), { total: 60 }) });

      await p.press('Load more');
      http
        .expectOne('/api/spendings?month=2026-10&limit=50&offset=50')
        .flush(spendingsPage(many(10, 10), { total: 60, offset: 50 }));
      await settle(p.fixture);

      expect(textOf(p.list())).toContain('Showing 60 of 60');
      expect(queryByRole(p.list(), 'button', 'Load more')).toBeNull();
      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Spendings in October 2026'),
      );
    });

    it('does not offer more when everything is loaded', async () => {
      const p = await open();
      expect(queryByRole(p.list(), 'button', 'Load more')).toBeNull();
    });

    it('shows a failure next to the button, and lets the person try again', async () => {
      const p = await open('2026-10', { page: spendingsPage(many(120, 50), { total: 120 }) });

      await p.press('Load more');
      flushError(
        http.expectOne('/api/spendings?month=2026-10&limit=50&offset=50'),
        500,
        'internal_error',
        'Try later',
      );
      await settle(p.fixture);

      expect(textOf(getByRole(p.list(), 'alert'))).toBe("Couldn't load more spendings. Try later");
      expect(textOf(p.list())).toContain('Showing 50 of 120');

      await p.press('Load more');
      http
        .expectOne('/api/spendings?month=2026-10&limit=50&offset=50')
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);
      expect(queryByRole(p.list(), 'alert')).toBeNull();
      expect(textOf(p.list())).toContain('Showing 100 of 120');
    });

    it('starts from the first page again after a change', async () => {
      const p = await open('2026-10', { page: spendingsPage(many(120, 50), { total: 120 }) });
      await p.press('Load more');
      http
        .expectOne('/api/spendings?month=2026-10&limit=50&offset=50')
        .flush(spendingsPage(many(70, 50), { total: 120, offset: 50 }));
      await settle(p.fixture);

      await p.type('Amount', '5');
      await p.press('Add spending');
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 200, amount: 500 }), { status: 201, statusText: 'Created' });
      await p.reload({
        page: spendingsPage(
          [spendingDto({ id: 200, amount: 500, description: 'New' }), ...many(120, 49)],
          { total: 121 },
        ),
      });

      expect(textOf(p.list())).toContain('Showing 50 of 121');
    });
  });

  describe('edit', () => {
    it('opens a dialog with the spending filled in', async () => {
      const p = await open();
      await p.press('Edit Lunch, €12.50');

      const dialog = p.dialog() as HTMLElement;
      expect((dialog as HTMLDialogElement).open).toBe(true);
      expect(p.value('Amount', dialog)).toBe('12.50');
      expect(p.value('Budget', dialog)).toBe('1');
      expect(p.value('Date', dialog)).toBe('2026-10-02');
      expect(p.value('Description (optional)', dialog)).toBe('Lunch');
      expect((getByLabel(dialog, 'Refund') as HTMLInputElement).checked).toBe(false);
      expect(getByLabel(dialog, 'Notes (optional)')).toBeTruthy();
      // The dialog shows every field: nothing of it is folded behind "More".
      expect(dialog.querySelector('details')).toBeNull();
    });

    it('shows a refund as a plain amount with the Refund switch on', async () => {
      const p = await open();
      await p.press('Edit Shoes (returned), -€45.00');

      const dialog = p.dialog() as HTMLElement;
      expect(p.value('Amount', dialog)).toBe('45.00');
      expect((getByLabel(dialog, 'Refund') as HTMLInputElement).checked).toBe(true);
      expect(p.value('Budget', dialog)).toBe('2');
    });

    it('sends only what changed, with PATCH, then reloads and confirms', async () => {
      const p = await open();
      await p.press('Edit Lunch, €12.50');
      const dialog = p.dialog() as HTMLElement;
      await p.type('Amount', '13', dialog);
      await p.type('Budget', '2', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/2');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ amount: 1300, budgetId: 2 });
      expect(spendingUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...LUNCH, amount: 1300, budgetId: 2 });
      await p.reload();

      expect(p.toasts()).toEqual(['Spending updated.']);
      expect(p.dialog()).toBeNull();
    });

    it('turns the Refund switch into the sign of the amount', async () => {
      const p = await open();
      await p.press('Edit Lunch, €12.50');
      const dialog = p.dialog() as HTMLElement;
      await p.flip('Refund', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/2');
      expect(request.request.body).toEqual({ amount: -1250 });
      request.flush({ ...LUNCH, amount: -1250 });
      await p.reload();
    });

    it('can clear the description and the notes', async () => {
      const p = await open('2026-10', {
        page: spendingsPage([{ ...LUNCH, notes: 'With Anna' }]),
      });
      await p.press('Edit Lunch, €12.50');
      const dialog = p.dialog() as HTMLElement;
      expect(p.value('Notes (optional)', dialog)).toBe('With Anna');
      await p.type('Description (optional)', '', dialog);
      await p.type('Notes (optional)', '', dialog);

      await p.press('Save changes', dialog);

      const request = http.expectOne('/api/spendings/2');
      expect(request.request.body).toEqual({ description: '', notes: null });
      request.flush({ ...LUNCH, description: '', notes: null });
      await p.reload();
    });

    it('closes without a request when nothing changed', async () => {
      const p = await open();
      await p.press('Edit Lunch, €12.50');
      await p.press('Save changes', p.dialog() as HTMLElement);

      expect(p.dialog()).toBeNull();
      noRequest(/\/api\/spendings\/2/);
    });

    it('shows what the API says on the field it names, and keeps the dialog open', async () => {
      const p = await open();
      await p.press('Edit Lunch, €12.50');
      const dialog = p.dialog() as HTMLElement;
      await p.type('Date', '2026-10-20', dialog);
      await p.press('Save changes', dialog);
      flushError(
        http.expectOne('/api/spendings/2'),
        422,
        'rule_violation',
        'The date is outside the active months',
        { rule: 'outside_active_months', field: 'date' },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(dialog, 'Date'))).toBe('The date is outside the active months');
      expect(p.dialog()).not.toBeNull();
    });

    it('cancels without a request, and gives focus back to the Edit button', async () => {
      const p = await open();
      const edit = getByRole(p.element, 'button', 'Edit Lunch, €12.50');
      edit.focus();
      edit.click();
      await settle(p.fixture);
      await p.press('Cancel', p.dialog() as HTMLElement);

      expect(p.dialog()).toBeNull();
      expect(document.activeElement).toBe(edit);
      noRequest(/\/api\/spendings\/2/);
    });

    it('opens from the menu of the row too, and gives focus back to the menu button', async () => {
      const p = await open();
      const menu = getByRole(p.element, 'button', 'More actions for Lunch, €12.50');
      menu.focus();

      await p.rowAction('Lunch, €12.50', 'Edit');
      expect(p.dialog()).not.toBeNull();
      await p.press('Cancel', p.dialog() as HTMLElement);

      expect(p.dialog()).toBeNull();
      expect(document.activeElement).toBe(menu);
    });
  });

  describe('the actions of a row', () => {
    it('are the title, which edits, and one menu: no Edit and Delete buttons beside every amount', async () => {
      const p = await open();

      const row = getByRole(p.element, 'listitem', /Lunch/);
      expect(
        queryAllByRole(row, 'button')
          .filter((button) => !button.closest('[popover]'))
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Edit Lunch, €12.50', 'More actions for Lunch, €12.50']);
      expect(menuItemNames(row)).toEqual(['Edit', 'Delete']);
    });

    it('keep the amount of a refund green and its minus sign', async () => {
      const p = await open();

      const amount = getByRole(p.element, 'listitem', /Shoes/).querySelector(
        'app-amount span',
      ) as HTMLElement;
      expect(amount.textContent).toBe('-€45.00');
      expect(amount.className).toContain('text-positive');
    });
  });

  describe('delete', () => {
    it('asks first, and does nothing when cancelled', async () => {
      const p = await open();
      await p.rowAction('Lunch, €12.50', 'Delete');

      const text = textOf(p.confirmDialog());
      expect(text).toContain('Delete this spending?');
      expect(text).toContain('Lunch, €12.50 on Fri, Oct 2, 2026 will be removed from Groceries.');
      await p.press('Cancel', p.confirmDialog());
      noRequest(/\/api\/spendings\/2/);
    });

    it('deletes once confirmed, then reloads and puts focus on the list heading', async () => {
      const p = await open();
      await p.rowAction('Lunch, €12.50', 'Delete');
      await p.press('Delete spending', p.confirmDialog());

      const request = http.expectOne('/api/spendings/2');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ page: spendingsPage([COFFEE, SHOES]) });

      expect(p.toasts()).toEqual(['Spending deleted.']);
      expect(textOf(p.list())).not.toContain('Lunch');
      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Spendings in October 2026'),
      );
    });

    it('reports a failure with the message of the API', async () => {
      const p = await open();
      await p.rowAction('Lunch, €12.50', 'Delete');
      await p.press('Delete spending', p.confirmDialog());
      flushError(http.expectOne('/api/spendings/2'), 404, 'not_found', 'Spending not found');
      await settle(p.fixture);

      expect(p.toasts()).toEqual(['Spending not found']);
      expect(textOf(p.list())).toContain('Lunch');
    });
  });
});
