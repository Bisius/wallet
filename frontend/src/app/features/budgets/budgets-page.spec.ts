import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { BudgetDto, MonthBudgetLine, MonthView, TransferDto } from '@wallet/shared';
import {
  budgetArchiveSchema,
  budgetCreateSchema,
  budgetUpdateSchema,
  budgetVersionSchema,
} from '@wallet/shared';
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
import { budgetDto, budgetLine, monthView } from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import { menuItem, menuItemNames, rowAction } from '../../../testing/menu';
import { BudgetsPage } from './budgets-page';

@Component({
  selector: 'app-budgets-host',
  imports: [BudgetsPage, ConfirmDialog, ToastContainer],
  template: '<app-budgets-page /><app-confirm-dialog /><app-toast-container />',
})
class BudgetsHost {}

/** Two budgets the way the month view and the budget list report them. */
const GROCERIES_LINE = budgetLine();
const FUN_LINE = budgetLine({
  id: 2,
  name: 'Fun',
  color: '#2563eb',
  icon: '🎬',
  incremental: true,
  carriedIn: 1200,
  allocated: 15000,
  available: 16200,
  spent: 4050,
  remaining: 12150,
  usagePercent: 25,
  carriedOut: 12150,
  toSavings: 0,
});
const GROCERIES = budgetDto({ id: 1, name: 'Groceries', sortOrder: 0 });
const FUN = budgetDto({
  id: 2,
  name: 'Fun',
  sortOrder: 10,
  color: '#2563eb',
  icon: '🎬',
  versions: [{ effectiveMonth: '2026-06', amount: 15000, incremental: true }],
});

const OCTOBER = monthView({ month: '2026-10', budgets: [GROCERIES_LINE, FUN_LINE] });

describe('BudgetsPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'budgets', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    // A spec that is not about transfers and answers the page's requests one by one (to look at an
    // error, or at a month switch) leaves the month's transfers unanswered: answer them with none.
    // There is one such request at most.
    const transfers = http.match((candidate) => candidate.url === '/api/transfers');
    expect(transfers.length).toBeLessThanOrEqual(1);
    for (const request of transfers) {
      if (!request.cancelled) request.flush([]);
    }
    http.verify();
  });

  interface Data {
    view?: MonthView;
    budgets?: BudgetDto[];
    transfers?: TransferDto[];
  }

  /** Opens the page for a month and answers its two requests. */
  async function open(month = '2026-10', data: Data = {}) {
    await primeStores(http);
    await router.navigateByUrl(`/budgets${month === '2026-10' ? '' : `?month=${month}`}`);
    const fixture = TestBed.createComponent(BudgetsHost);
    fixture.detectChanges();
    await settle(fixture);
    // The month's transfers are loaded with the page (and after money was moved), not after a budget
    // changed, so `answer` does not ask for them.
    http.expectOne(`/api/transfers?month=${month}`).flush(data.transfers ?? []);
    await answer(fixture, month, data);
    return page(fixture);
  }

  async function answer(fixture: { detectChanges(): void }, month: string, data: Data = {}) {
    http.expectOne(`/api/months/${month}`).flush(data.view ?? { ...OCTOBER, month });
    http.expectOne('/api/budgets').flush(data.budgets ?? [GROCERIES, FUN]);
    await settle(fixture as never);
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<BudgetsHost>>) {
    const element = fixture.nativeElement as HTMLElement;
    const helpers = {
      fixture,
      element,
      text: () => textOf(element),
      card: (name: string) => getByRole(element, 'article', name),
      cardText: (name: string) => textOf(getByRole(element, 'article', name)),
      summary: () => textOf(getByRole(element, 'region', /at a glance/)),
      /** The folded list of upcoming and ended budgets (the strip's help is a `details` too). */
      inactive: () =>
        Array.from(element.querySelectorAll('details')).find((details) =>
          textOf(details.querySelector('summary') as Element).startsWith(
            'Upcoming and ended budgets',
          ),
        ) ?? null,
      /** Opens the "More actions" menu called `menu` and presses its item: `menuAction('More actions for Rent', 'Delete')`. */
      menuAction: (menu: string | RegExp, item: string | RegExp) => rowAction(element, item, menu),
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      /** Picks a radio button (a color). */
      choose: async (label: string | RegExp) => {
        getByLabel(element, label).click();
        await settle(fixture);
      },
      /** Flips a switch. */
      flip: async (label: string | RegExp) => {
        getByLabel(element, label).click();
        await settle(fixture);
      },
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(element, label), value);
        await settle(fixture);
      },
      dialog: (name?: string | RegExp) => queryByRole(element, 'dialog', name),
      /** The budget form's dialog: null when it is closed (the confirm dialog is always there). */
      formDialog: () => element.querySelector('app-budget-form dialog'),
      confirmDialog: () => element.querySelector('app-confirm-dialog dialog') as HTMLDialogElement,
      value: (label: string | RegExp) => (getByLabel(element, label) as HTMLInputElement).value,
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** After a change the page loads the month view and the budget list again. */
      reload: async (data: Data = {}, month = '2026-10') => {
        await settle(fixture);
        await answer(fixture, month, data);
      },
    };
    return helpers;
  }

  /** Asserts that no request to a URL matching `pattern` was made. */
  const noRequest = (pattern: RegExp) => http.expectNone((request) => pattern.test(request.url));

  describe('the month at a glance', () => {
    it('shows budgeted and unallocated exactly as the API reports them', async () => {
      // Figures that do not add up on purpose: the page must show what it is told, not compute.
      const p = await open('2026-10', {
        view: monthView({
          income: { salary: 111, extra: 0, total: 222 },
          fixedCosts: 333,
          totals: { allocated: 444, spent: 0, remaining: 0, transfersNet: 0 },
          unallocated: 555,
          budgets: [GROCERIES_LINE],
        }),
      });

      expect(p.summary()).toContain('Budgeted €4.44');
      expect(p.summary()).toContain('Unallocated €5.55');
      expect(p.text()).not.toContain('Over-allocated');
    });

    it('is a slim strip: the Dashboard has income, fixed costs and spent, the cards what each budget spent', async () => {
      const p = await open();

      const strip = getByRole(p.element, 'region', /at a glance/);
      expect(
        Array.from(strip.querySelectorAll('dl > div')).map((figure) =>
          textOf(figure.querySelector('dt') as Element),
        ),
      ).toEqual(['Budgeted', 'Unallocated']);
      expect(p.summary()).not.toContain('Income');
      expect(p.summary()).not.toContain('Fixed costs');
      expect(p.summary()).not.toContain('Spent');
      // Flat, with the figures a size down from the Dashboard's big ones.
      expect(strip.closest('.card')).toBeNull();
      expect(strip.querySelector('dd.text-kpi')).toBeNull();
      expect(strip.querySelectorAll('dd.text-stat')).toHaveLength(2);
    });

    it('keeps what the status means behind "How this works", folded away', async () => {
      const p = await open();

      const details = getByRole(p.element, 'region', /at a glance/).querySelector(
        'details',
      ) as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(textOf(details.querySelector('summary') as Element)).toBe('How this works');
      expect(textOf(details)).toContain('This month is still running');
    });

    it('says a closed month is closed, and what that means', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES_LINE] }),
      });

      expect(p.summary()).toContain('Closed month');
      expect(p.summary()).toContain('This month is over, so its figures are final.');
    });

    it('says the current month is still running', async () => {
      const p = await open();

      expect(p.summary()).toContain('Current month');
      expect(p.summary()).toContain('This month is still running');
    });

    it('calls a future month a projection', async () => {
      const p = await open('2026-12', {
        view: monthView({ month: '2026-12', status: 'future', budgets: [GROCERIES_LINE] }),
      });

      expect(p.summary()).toContain('Projection');
      expect(p.summary()).toContain('This month has not started yet.');
    });

    it('warns, in an alert and by how much, when the month is over-allocated', async () => {
      const p = await open('2026-10', {
        view: monthView({
          income: { salary: 100000, extra: 0, total: 100000 },
          budgets: [budgetLine({ allocated: 112000, available: 112000, remaining: 112000 })],
        }),
      });

      const alert = getByRole(p.element, 'alert', /Over-allocated by/);
      expect(textOf(alert)).toContain('Over-allocated by €120.00');
      expect(textOf(alert)).toContain(
        'that amount will be taken from savings when the month closes',
      );
      // The tile carries the sign and the word, not only the red.
      expect(p.summary()).toContain('Unallocated -€120.00 Over-allocated');
    });

    it('words the over-allocation of a closed month in the past tense', async () => {
      const p = await open('2026-08', {
        view: monthView({
          month: '2026-08',
          status: 'closed',
          income: { salary: 100000, extra: 0, total: 100000 },
          budgets: [budgetLine({ allocated: 105000, available: 105000, remaining: 105000 })],
        }),
      });

      expect(textOf(getByRole(p.element, 'alert', /Over-allocated by/))).toContain(
        "Over-allocated by €50.00 Fixed costs and budgets added up to more than this month's income, so that amount is taken from savings.",
      );
    });

    it('shows no warning when the month is not over-allocated', async () => {
      const p = await open();
      expect(queryByRole(p.element, 'alert', /Over-allocated/)).toBeNull();
    });
  });

  describe('budget cards', () => {
    it('shows one card per budget of the month, in the API order, with name, available, spent and remaining', async () => {
      const p = await open();

      expect(
        Array.from(p.element.querySelectorAll('article h3')).map((h) => h.textContent?.trim()),
      ).toEqual(['Groceries', 'Fun']);
      expect(p.cardText('Groceries')).toContain('Available €400.00');
      expect(p.cardText('Groceries')).toContain('Spent €100.00');
      expect(p.cardText('Groceries')).toContain('Remaining €300.00');
    });

    it('shows the figures it is given, never its own sums', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [budgetLine({ available: 111, spent: 222, remaining: 333, usagePercent: 7 })],
        }),
      });

      const text = p.cardText('Groceries');
      expect(text).toContain('Available €1.11');
      expect(text).toContain('Spent €2.22');
      expect(text).toContain('Remaining €3.33');
      expect(text).toContain('7% used');
    });

    it('shows the name, color and icon of the budget', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [
            GROCERIES_LINE,
            FUN_LINE,
            budgetLine({ id: 3, name: 'Rent', color: '#10b981', icon: null }),
          ],
        }),
        budgets: [GROCERIES, FUN, budgetDto({ id: 3, name: 'Rent', sortOrder: 20 })],
      });

      // The icon is decoration (the name says it all), so it is hidden from assistive technology.
      const icon = p.card('Fun').querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(icon.textContent).toBe('🎬');
      // Systems without an emoji font in the page's own stack draw an empty box.
      expect(icon.classList.contains('font-emoji')).toBe(true);
      // The color rings the avatar, or is a dot beside the name of a budget with no icon. A budget
      // with neither has the neutral dot. The color is never read out.
      expect(icon.style.borderColor).toBe('rgb(37, 99, 235)');
      const dot = (name: string) =>
        p.card(name).querySelector('span[appColorDot]') as HTMLElement | null;
      expect(dot('Fun')).toBeNull();
      expect(dot('Rent')?.style.backgroundColor).toBe('rgb(16, 185, 129)');
      expect(dot('Groceries')?.style.backgroundColor).toBe('');
      expect(p.cardText('Rent')).not.toContain('#10b981');
    });

    describe('actions', () => {
      const visibleButtons = (card: HTMLElement) =>
        queryAllByRole(card, 'button')
          .filter((button) => !button.hasAttribute('appMenuItem'))
          .map((button) => button.getAttribute('aria-label') ?? textOf(button));

      it('are Edit and Move money on the card, and the rest in its menu, the one that deletes last', async () => {
        const p = await open();

        expect(visibleButtons(p.card('Groceries'))).toEqual([
          'Edit Groceries',
          'Move money from Groceries',
          'More actions for Groceries',
        ]);
        expect(menuItemNames(p.card('Groceries'))).toEqual([
          'Archive',
          'Move up',
          'Move down',
          'Delete',
        ]);
      });

      it('leave out what does not apply: no Archive once archived, no Delete with history', async () => {
        const p = await open('2026-10', {
          budgets: [GROCERIES, { ...FUN, endMonth: '2026-12', hasHistory: true }],
        });

        expect(menuItemNames(p.card('Fun'))).toEqual(['Move up', 'Move down']);
        expect(menuItemNames(p.card('Groceries'))).toEqual([
          'Archive',
          'Move up',
          'Move down',
          'Delete',
        ]);
      });
    });

    describe('alert state', () => {
      const cases: {
        name: string;
        line: Partial<MonthBudgetLine>;
        words: string;
        tone: string;
        valueNow: string;
        valueText: string;
      }[] = [
        {
          name: 'ok',
          line: { alert: 'ok', usagePercent: 25 },
          words: 'On track 25% used, warns at 80%',
          tone: 'bg-accent',
          valueNow: '25',
          valueText: '25% used, on track',
        },
        {
          name: 'warning',
          line: {
            alert: 'warning',
            usagePercent: 85,
            spent: 34000,
            remaining: 6000,
            toSavings: 6000,
          },
          words: 'Warning 85% used, warns at 80%',
          tone: 'bg-warning',
          valueNow: '85',
          valueText: '85% used, warning',
        },
        {
          name: 'over budget',
          line: {
            alert: 'over',
            usagePercent: 175,
            spent: 70000,
            remaining: -30000,
            toSavings: -30000,
          },
          words: 'Over budget by €300.00 · 175% used',
          tone: 'bg-negative',
          // The bar fills to 100, whatever the percentage says.
          valueNow: '100',
          valueText: '175% used, over budget',
        },
      ];

      for (const c of cases) {
        it(`says "${c.name}" in words, in the bar and in its color`, async () => {
          const p = await open('2026-10', { view: monthView({ budgets: [budgetLine(c.line)] }) });

          expect(p.cardText('Groceries')).toContain(c.words);
          const bar = getByRole(p.card('Groceries'), 'progressbar', 'Groceries usage');
          expect(bar.getAttribute('aria-valuenow')).toBe(c.valueNow);
          expect(bar.getAttribute('aria-valuetext')).toBe(c.valueText);
          expect(bar.querySelector('div')?.className).toContain(c.tone);
        });
      }

      it('has no bar, only words, when nothing is available', async () => {
        const p = await open('2026-10', {
          view: monthView({
            budgets: [
              budgetLine({
                allocated: 0,
                available: 0,
                spent: 0,
                remaining: 0,
                usagePercent: null,
                toSavings: 0,
              }),
            ],
          }),
        });

        expect(p.cardText('Groceries')).toContain('On track Nothing available this month.');
        expect(queryByRole(p.card('Groceries'), 'progressbar')).toBeNull();
      });

      it('says it is over budget, and by how much, when there is no usage figure to show', async () => {
        const p = await open('2026-10', {
          view: monthView({
            budgets: [
              budgetLine({
                allocated: 0,
                available: 0,
                spent: 500,
                remaining: -500,
                usagePercent: null,
                alert: 'over',
                toSavings: -500,
              }),
            ],
          }),
        });

        expect(p.cardText('Groceries')).toContain('Over budget by €5.00');
        expect(p.cardText('Groceries')).not.toContain('% used');
        expect(queryByRole(p.card('Groceries'), 'progressbar')).toBeNull();
      });

      it('uses the warning threshold of the budget, as the API reports it', async () => {
        const p = await open('2026-10', {
          view: monthView({ budgets: [budgetLine({ warnPercent: 90 })] }),
        });
        expect(p.cardText('Groceries')).toContain('25% used, warns at 90%');
      });

      it('shows a negative remaining with its minus sign', async () => {
        const p = await open('2026-10', {
          view: monthView({
            budgets: [
              budgetLine({
                alert: 'over',
                spent: 45000,
                remaining: -5000,
                usagePercent: 112,
                toSavings: -5000,
              }),
            ],
          }),
        });
        expect(p.cardText('Groceries')).toContain('Remaining -€50.00');
      });
    });

    describe('incremental budgets', () => {
      it('carry a badge, and show what came in from the month before', async () => {
        const p = await open();

        expect(p.cardText('Fun')).toContain('Incremental');
        expect(p.cardText('Fun')).toContain('Carried in from September 2026: +€12.00');
        expect(p.cardText('Groceries')).not.toContain('Incremental');
        expect(p.cardText('Groceries')).not.toContain('Carried in');
      });

      it('show a carried-in deficit with its minus sign', async () => {
        const p = await open('2026-10', {
          view: monthView({
            budgets: [budgetLine({ id: 2, name: 'Fun', incremental: true, carriedIn: -500 })],
          }),
        });
        expect(p.cardText('Fun')).toContain('Carried in from September 2026: -€5.00');
      });

      it('say so when nothing came in', async () => {
        const p = await open('2026-10', {
          view: monthView({
            budgets: [budgetLine({ id: 2, name: 'Fun', incremental: true, carriedIn: 0 })],
          }),
        });
        expect(p.cardText('Fun')).toContain('Nothing carried in from September 2026.');
      });

      it('mark the last month of an archived budget', async () => {
        const p = await open('2026-10', {
          view: monthView({ budgets: [budgetLine({ endsThisMonth: true })] }),
        });
        expect(p.cardText('Groceries')).toContain('Last month');
      });
    });

    describe('what happens when the month ends', () => {
      it('is the outcome of a closed month: carried over, moved to savings or taken from savings', async () => {
        const p = await open('2026-08', {
          view: monthView({
            month: '2026-08',
            status: 'closed',
            budgets: [
              budgetLine({ id: 1, name: 'Groceries', toSavings: 5000, carriedOut: 0 }),
              budgetLine({ id: 2, name: 'Fun', incremental: true, carriedOut: 7000, toSavings: 0 }),
              budgetLine({ id: 3, name: 'Gifts', remaining: -3000, toSavings: -3000 }),
              budgetLine({ id: 4, name: 'Pets', remaining: 0, toSavings: 0, carriedOut: 0 }),
            ],
          }),
        });

        expect(p.cardText('Groceries')).toContain('Moved to savings: €50.00');
        expect(p.cardText('Fun')).toContain('Carried into September 2026: €70.00');
        // Taken from savings is a magnitude with the direction in the words, not a second sign.
        expect(p.cardText('Gifts')).toContain('Taken from savings: €30.00');
        expect(p.cardText('Pets')).toContain('Nothing carried over or moved to savings.');
      });

      it('shows a deficit carried over with its minus sign', async () => {
        const p = await open('2026-08', {
          view: monthView({
            month: '2026-08',
            status: 'closed',
            budgets: [
              budgetLine({ incremental: true, remaining: -4000, carriedOut: -4000, toSavings: 0 }),
            ],
          }),
        });
        expect(p.cardText('Groceries')).toContain('Carried into September 2026: -€40.00');
      });

      it('is only a projection in the current month', async () => {
        const p = await open();

        expect(p.cardText('Groceries')).toContain('Projected to move to savings: €300.00');
        expect(p.cardText('Fun')).toContain('Projected to carry into November 2026: €121.50');
        expect(p.cardText('Groceries')).not.toContain('Moved to savings');
      });

      it('is a projection in a future month too', async () => {
        const p = await open('2026-12', {
          view: monthView({
            month: '2026-12',
            status: 'future',
            budgets: [budgetLine({ remaining: -3000, toSavings: -3000 })],
          }),
        });
        expect(p.cardText('Groceries')).toContain('Projected to be taken from savings: €30.00');
      });
    });
  });

  describe('loading and failing', () => {
    it('says it is loading while the requests are out', async () => {
      await primeStores(http);
      await router.navigateByUrl('/budgets');
      const fixture = TestBed.createComponent(BudgetsHost);
      fixture.detectChanges();
      await settle(fixture);

      expect(textOf(fixture.nativeElement)).toContain("Loading this month's budgets…");
      await answer(fixture, '2026-10');
    });

    it('shows what the API said when the month cannot be loaded, and can try again', async () => {
      await primeStores(http);
      await router.navigateByUrl('/budgets');
      const fixture = TestBed.createComponent(BudgetsHost);
      fixture.detectChanges();
      await settle(fixture);
      flushError(
        http.expectOne('/api/months/2026-10'),
        500,
        'internal_error',
        'The ledger is busy',
      );
      http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
      await settle(fixture);
      const p = page(fixture);

      const alert = getByRole(p.element.querySelector('app-budgets-page') as HTMLElement, 'alert');
      expect(textOf(alert)).toContain("Couldn't load this month's budgets");
      expect(textOf(alert)).toContain('The ledger is busy');

      getByRole(alert, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      expect(p.text()).toContain('Budgets in October 2026');
    });

    it('keeps showing the figures when only the budget list fails, without the buttons', async () => {
      await primeStores(http);
      await router.navigateByUrl('/budgets');
      const fixture = TestBed.createComponent(BudgetsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(http.expectOne('/api/budgets'), 500, 'internal_error', 'No budget table');
      await settle(fixture);
      const p = page(fixture);

      expect(p.text()).toContain("Couldn't load the budget list");
      expect(p.text()).toContain('No budget table');
      expect(p.cardText('Groceries')).toContain('Available €400.00');
      expect(queryByRole(p.card('Groceries'), 'button', 'Edit Groceries')).toBeNull();

      getByRole(p.element, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
      await settle(fixture);
      expect(queryByRole(p.card('Groceries'), 'button', 'Edit Groceries')).not.toBeNull();
    });

    it('invites the user to create a budget when the month has none', async () => {
      const p = await open('2026-10', { view: monthView({ budgets: [] }), budgets: [] });

      expect(p.text()).toContain('No budgets in October 2026');
      expect(queryAllByRole(p.element, 'button', 'New budget')).toHaveLength(2);
    });

    it('says no budget existed in a closed month that has none', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [] }),
        budgets: [],
      });
      expect(p.text()).toContain('No budget was active in this month.');
    });

    it('follows the month switcher: another month is another request', async () => {
      const p = await open();
      await router.navigateByUrl('/budgets?month=2026-09');
      await settle(p.fixture);

      http.expectOne('/api/months/2026-09').flush(
        monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [budgetLine({ name: 'Rent' })],
        }),
      );
      await settle(p.fixture);

      expect(p.text()).toContain('Budgets in September 2026');
      expect(p.cardText('Rent')).toContain('Available €400.00');
      // The budget list does not depend on the month.
      noRequest(/\/api\/budgets/);
    });
  });

  describe('upcoming and ended budgets', () => {
    const UPCOMING = budgetDto({
      id: 3,
      name: 'Holiday 2027',
      sortOrder: 20,
      startMonth: '2027-01',
      status: 'upcoming',
      current: null,
      versions: [{ effectiveMonth: '2027-01', amount: 25000, incremental: true }],
    });
    const ENDED = budgetDto({
      id: 4,
      name: 'Old gym',
      sortOrder: 30,
      startMonth: '2026-06',
      endMonth: '2026-08',
      status: 'ended',
      hasHistory: true,
      versions: [{ effectiveMonth: '2026-06', amount: 3000, incremental: false }],
    });

    it('sit in a collapsed section below the cards, with their dates and amounts', async () => {
      const p = await open('2026-10', { budgets: [GROCERIES, FUN, UPCOMING, ENDED] });

      const details = p.inactive() as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(textOf(details.querySelector('summary') as Element)).toBe(
        'Upcoming and ended budgets (2)',
      );
      expect(textOf(details)).toContain(
        'Holiday 2027 Starts January 2027 · €250.00 a month, incremental',
      );
      expect(textOf(details)).toContain('Old gym Ended August 2026 · €30.00 a month');
    });

    it('can still be edited, and deleted when they have no history', async () => {
      const p = await open('2026-10', { budgets: [GROCERIES, FUN, UPCOMING, ENDED] });

      // Two things to do: both are in the menu of the row, the one that deletes last.
      expect(menuItemNames(p.element, 'More actions for Holiday 2027')).toEqual(['Edit', 'Delete']);
      // It has spendings: only archiving would have been possible, and it is archived already. The
      // one thing left, Edit, is a button of the row.
      expect(queryByRole(p.element, 'button', 'Edit Old gym')).not.toBeNull();
      expect(queryByRole(p.element, 'button', 'More actions for Old gym')).toBeNull();
      expect(queryByRole(p.element, 'button', 'Delete Old gym')).toBeNull();
    });

    it('are left out when there are none', async () => {
      const p = await open();
      expect(p.inactive()).toBeNull();
    });

    it('also list, for another month, the budgets that start after it or ended before it', async () => {
      // Looking back at August: Rent only exists from October, and Holiday 2027 even later.
      const rent = budgetDto({
        id: 5,
        name: 'Rent',
        sortOrder: 40,
        startMonth: '2026-10',
        versions: [{ effectiveMonth: '2026-10', amount: 90000, incremental: false }],
      });
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES_LINE] }),
        budgets: [GROCERIES, rent, UPCOMING],
      });

      const details = p.inactive() as HTMLDetailsElement;
      expect(textOf(details.querySelector('summary') as Element)).toBe(
        'Upcoming and ended budgets (2)',
      );
      expect(textOf(details)).toContain('Rent Starts October 2026 · €900.00 a month');
      expect(textOf(details)).toContain('Holiday 2027 Starts January 2027');
      expect(menuItemNames(details, 'More actions for Rent')).toEqual(['Edit', 'Delete']);
    });

    it('do not repeat a budget that has a card in the month shown', async () => {
      // Viewing August: "Old gym" was active then, so it is a card there, like Groceries.
      const p = await open('2026-08', {
        view: monthView({
          month: '2026-08',
          status: 'closed',
          budgets: [GROCERIES_LINE, budgetLine({ id: 4, name: 'Old gym' })],
        }),
        budgets: [GROCERIES, ENDED],
      });

      expect(p.inactive()).toBeNull();
      expect(p.cardText('Old gym')).toContain('Ended Aug 2026');
      expect(queryByRole(p.card('Old gym'), 'button', 'Edit Old gym')).not.toBeNull();
      // An ended budget cannot be archived again.
      expect(menuItemNames(p.card('Old gym'))).not.toContain('Archive');
    });
  });

  describe('create', () => {
    it('opens a dialog with the fields, naming the month the budget starts in', async () => {
      const p = await open();
      await p.press('New budget');

      const dialog = p.dialog('New budget') as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      for (const label of [
        'Name',
        'Monthly amount',
        'Incremental',
        'Start month',
        'Icon (optional)',
        'Warning threshold (%) (optional)',
        'Notes (optional)',
      ]) {
        expect(getByLabel(dialog, label), label).toBeTruthy();
      }
      expect(getByRole(dialog, 'group', /Color/)).toBeTruthy();
      expect(p.value('Start month')).toBe('2026-10');
      expect(textOf(dialog)).toContain(
        'The budget starts in October 2026. Earlier months are not affected.',
      );
      expect(document.activeElement).toBe(getByLabel(dialog, 'Name'));
    });

    it('groups the amount fields under a legend with spacing, not in a box of their own inside the dialog', async () => {
      const p = await open();
      await p.press('New budget');
      const dialog = p.dialog('New budget') as HTMLElement;

      const group = getByRole(dialog, 'group', 'Amount');
      expect(group.tagName).toBe('FIELDSET');
      expect(getByLabel(group, 'Monthly amount')).toBeTruthy();
      expect(getByLabel(group, 'Start month')).toBeTruthy();
      expect(group.className).not.toMatch(/\b(border|rounded-card|p-\d)/);
    });

    it('explains the incremental switch in one line, and follows it', async () => {
      const p = await open();
      await p.press('New budget');
      const dialog = p.dialog('New budget') as HTMLElement;

      expect(textOf(dialog)).toContain(
        'At month end the leftover goes to savings, and overspending is taken from savings.',
      );
      await p.flip('Incremental');
      expect(textOf(dialog)).toContain(
        'Leftover money, or overspending, carries into the next month.',
      );
    });

    it('starts in the selected month when it is not closed', async () => {
      const p = await open('2026-12', {
        view: monthView({ month: '2026-12', status: 'future', budgets: [GROCERIES_LINE] }),
      });
      await p.press('New budget');
      expect(p.value('Start month')).toBe('2026-12');
    });

    it('starts in the current month, not a closed one, when a closed month is shown', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES_LINE] }),
      });
      await p.press('New budget');
      expect(p.value('Start month')).toBe('2026-10');
    });

    it('posts the budget, with integer cents, then reloads and confirms', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', '  Holiday ');
      await p.type('Monthly amount', '250,50');
      await p.flip('Incremental');
      await p.choose('Pink');
      await p.type('Icon (optional)', '✈️');
      await p.type('Warning threshold (%) (optional)', '90');
      await p.type('Notes (optional)', '  Flights and hotel ');

      await p.press('Create budget');

      const request = http.expectOne('/api/budgets');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'Holiday',
        amount: 25050,
        incremental: true,
        startMonth: '2026-10',
        color: '#be185d',
        icon: '✈️',
        alertWarnPercent: 90,
        notes: 'Flights and hotel',
      });
      expect(budgetCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(budgetDto({ id: 5, name: 'Holiday' }), { status: 201, statusText: 'Created' });
      await settle(p.fixture);
      await answer(p.fixture, '2026-10', {
        view: monthView({
          budgets: [GROCERIES_LINE, FUN_LINE, budgetLine({ id: 5, name: 'Holiday' })],
        }),
        budgets: [GROCERIES, FUN, budgetDto({ id: 5, name: 'Holiday', sortOrder: 20 })],
      });

      expect(p.toasts()).toEqual(['Holiday created.']);
      expect(p.formDialog()).toBeNull();
      expect(p.cardText('Holiday')).toContain('Available €400.00');
    });

    it('sends only what was filled in', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '900');
      await p.press('Create budget');

      const request = http.expectOne('/api/budgets');
      expect(request.request.body).toEqual({
        name: 'Rent',
        amount: 90000,
        incremental: false,
        startMonth: '2026-10',
      });
      request.flush(budgetDto({ id: 5, name: 'Rent' }), { status: 201, statusText: 'Created' });
      await p.reload({}, '2026-10');
    });

    it('needs a name and an amount, and does not call the API without them', async () => {
      const p = await open();
      await p.press('New budget');
      await p.press('Create budget');

      const dialog = p.dialog('New budget') as HTMLElement;
      expect(fieldError(getByLabel(dialog, 'Name'))).toBe('Name is required.');
      expect(fieldError(getByLabel(dialog, 'Monthly amount'))).toBe('Monthly amount is required.');
      expect(document.activeElement).toBe(getByLabel(dialog, 'Name'));

      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '-5');
      await p.press('Create budget');
      expect(fieldError(getByLabel(dialog, 'Monthly amount'))).toBe(
        'Enter an amount of zero or more.',
      );
      noRequest(/\/api\/budgets/);
    });

    it('accepts an amount of zero', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Placeholder');
      await p.type('Monthly amount', '0');
      await p.press('Create budget');

      const request = http.expectOne('/api/budgets');
      expect(request.request.body.amount).toBe(0);
      request.flush(budgetDto({ id: 5, name: 'Placeholder' }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();
    });

    it('limits what the API limits', async () => {
      const p = await open();
      await p.press('New budget');
      const dialog = p.dialog('New budget') as HTMLElement;

      expect(getByLabel(dialog, 'Name').getAttribute('maxlength')).toBe('60');
      expect(getByLabel(dialog, 'Icon (optional)').getAttribute('maxlength')).toBe('32');
      expect(getByLabel(dialog, 'Notes (optional)').getAttribute('maxlength')).toBe('1000');
      expect(getByLabel(dialog, 'Warning threshold (%) (optional)').getAttribute('min')).toBe('1');
      expect(getByLabel(dialog, 'Warning threshold (%) (optional)').getAttribute('max')).toBe(
        '100',
      );
    });

    it('rejects a threshold outside 1 to 100 before asking the API', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '1');
      await p.type('Warning threshold (%) (optional)', '150');
      await p.press('Create budget');

      expect(fieldError(getByLabel(p.element, 'Warning threshold (%) (optional)'))).toBe(
        'Enter a whole number from 1 to 100.',
      );
      noRequest(/\/api\/budgets/);
    });

    it('warns that a start in a closed month changes that month', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Start month', '2026-08');

      const dialog = p.dialog('New budget') as HTMLElement;
      expect(textOf(dialog)).toContain(
        'Backdating: August 2026 is already closed. A budget that starts then also changes that month',
      );
    });

    it('does not start before the first month Wallet tracks', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '1');
      await p.type('Start month', '2026-05');
      await p.press('Create budget');

      expect(fieldError(getByLabel(p.element, 'Start month'))).toBe('Choose June 2026 or later.');
      noRequest(/\/api\/budgets/);
    });

    it('shows what the API says on the field it names, and keeps what was typed', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '900');
      await p.press('Create budget');

      flushError(
        http.expectOne('/api/budgets'),
        422,
        'rule_violation',
        'A budget cannot start in 2026-10, before the start month 2026-11',
        { rule: 'before_start_month', field: 'startMonth' },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(p.element, 'Start month'))).toBe(
        'A budget cannot start in 2026-10, before the start month 2026-11',
      );
      expect(p.value('Name')).toBe('Rent');
      expect(p.dialog('New budget')).not.toBeNull();
      expect(p.toasts()).toEqual([]);
    });

    it('shows an error that belongs to no field in an alert inside the dialog', async () => {
      const p = await open();
      await p.press('New budget');
      await p.type('Name', 'Rent');
      await p.type('Monthly amount', '900');
      await p.press('Create budget');
      flushError(http.expectOne('/api/budgets'), 500, 'internal_error', 'Something broke');
      await settle(p.fixture);

      expect(textOf(getByRole(p.dialog('New budget') as HTMLElement, 'alert'))).toBe(
        'Something broke',
      );
    });

    it('cancels without a request and gives focus back to the New budget button', async () => {
      const p = await open();
      const opener = getByRole(
        p.element.querySelector('header') as HTMLElement,
        'button',
        'New budget',
      );
      opener.focus();
      opener.click();
      await settle(p.fixture);
      await p.press('Cancel', p.dialog('New budget') as HTMLElement);

      expect(p.formDialog()).toBeNull();
      expect(document.activeElement).toBe(opener);
      noRequest(/\/api\/budgets/);
    });

    it('closes on Escape too', async () => {
      const p = await open();
      await p.press('New budget');
      (p.dialog('New budget') as HTMLDialogElement).close();
      await settle(p.fixture);

      expect(p.formDialog()).toBeNull();
    });

    it('lets the user pick an icon from the suggestions and pick it again to clear it', async () => {
      const p = await open();
      await p.press('New budget');
      const dialog = p.dialog('New budget') as HTMLElement;

      await p.press('Use the shopping cart icon', dialog);
      expect(p.value('Icon (optional)')).toBe('🛒');
      expect(
        getByRole(dialog, 'button', 'Use the shopping cart icon').getAttribute('aria-pressed'),
      ).toBe('true');
      // The field and the suggestions draw an emoji with the emoji font stack too.
      expect(getByLabel(dialog, 'Icon (optional)').classList.contains('font-emoji')).toBe(true);
      expect(
        getByRole(dialog, 'button', 'Use the shopping cart icon')
          .querySelector('span')
          ?.classList.contains('font-emoji'),
      ).toBe(true);

      await p.press('Use the shopping cart icon', dialog);
      expect(p.value('Icon (optional)')).toBe('');
    });
  });

  describe('edit', () => {
    it('opens with the budget filled in, from the current month', async () => {
      const p = await open();
      await p.press('Edit Fun');

      const dialog = p.dialog('Edit Fun') as HTMLElement;
      expect(p.value('Name')).toBe('Fun');
      expect(p.value('Monthly amount')).toBe('150.00');
      expect((getByLabel(dialog, 'Incremental') as HTMLInputElement).checked).toBe(true);
      expect(p.value('Applies from')).toBe('2026-10');
      expect((getByLabel(dialog, 'Blue') as HTMLInputElement).checked).toBe(true);
      expect(p.value('Icon (optional)')).toBe('🎬');
      expect(textOf(dialog)).toContain(
        'The new amount applies from October 2026 on. Earlier months keep their amounts.',
      );
    });

    it('defaults "applies from" to the current month, not to the month the page shows', async () => {
      const p = await open('2026-08', {
        view: monthView({
          month: '2026-08',
          status: 'closed',
          budgets: [GROCERIES_LINE, FUN_LINE],
        }),
      });
      await p.press('Edit Groceries');

      expect(p.value('Applies from')).toBe('2026-10');
    });

    it('does not offer months the budget does not exist in', async () => {
      const p = await open('2026-10', {
        budgets: [
          budgetDto({ id: 1, name: 'Groceries', startMonth: '2026-08', endMonth: '2027-02' }),
          FUN,
        ],
      });
      await p.press('Edit Groceries');

      const input = getByLabel(p.element, 'Applies from');
      expect(input.getAttribute('min')).toBe('2026-08');
      expect(input.getAttribute('max')).toBe('2027-02');
    });

    it('starts at the first month of a budget that has not started yet', async () => {
      const upcoming = budgetDto({
        id: 3,
        name: 'Holiday 2027',
        sortOrder: 20,
        startMonth: '2027-01',
        status: 'upcoming',
        current: null,
        versions: [{ effectiveMonth: '2027-01', amount: 25000, incremental: true }],
      });
      const p = await open('2026-10', { budgets: [GROCERIES, FUN, upcoming] });
      await p.menuAction('More actions for Holiday 2027', 'Edit');

      expect(p.value('Applies from')).toBe('2027-01');
      expect(p.value('Monthly amount')).toBe('250.00');
    });

    it('sends only what changed in the fields, with PATCH', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.type('Name', 'Food');
      await p.choose('Orange');
      await p.type('Notes (optional)', 'Weekly shop');

      await p.press('Save changes');

      const request = http.expectOne('/api/budgets/1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({
        name: 'Food',
        color: '#c2410c',
        notes: 'Weekly shop',
      });
      expect(budgetUpdateSchema.safeParse(request.request.body).success).toBe(true);
      // The amount did not change: no version is sent.
      request.flush({ ...GROCERIES, name: 'Food' });
      await p.reload();

      expect(p.toasts()).toEqual(['Food updated.']);
      expect(p.formDialog()).toBeNull();
    });

    it('clears an optional field by sending null', async () => {
      const p = await open();
      await p.press('Edit Fun');
      await p.choose('None');
      await p.type('Icon (optional)', '');

      await p.press('Save changes');

      const request = http.expectOne('/api/budgets/2');
      expect(request.request.body).toEqual({ color: null, icon: null });
      request.flush({ ...FUN, color: null, icon: null });
      await p.reload();
    });

    it('puts a new amount on the current month, with PUT, and leaves the fields alone', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.type('Monthly amount', '450');

      await p.press('Save changes');

      noRequest(/\/api\/budgets\/1$/);
      const request = http.expectOne('/api/budgets/1/versions/2026-10');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ amount: 45000, incremental: false });
      expect(budgetVersionSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(GROCERIES);
      await p.reload();

      expect(p.toasts()).toEqual(['Groceries updated.']);
    });

    it('sends a changed mode with the amount, since a version holds both', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.flip('Incremental');

      await p.press('Save changes');

      const request = http.expectOne('/api/budgets/1/versions/2026-10');
      expect(request.request.body).toEqual({ amount: 40000, incremental: true });
      request.flush(GROCERIES);
      await p.reload();
    });

    it('sends the fields first and the version after, and closes when both are saved', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.type('Name', 'Food');
      await p.type('Monthly amount', '450');
      await p.press('Save changes');

      http.expectOne('/api/budgets/1').flush({ ...GROCERIES, name: 'Food' });
      await settle(p.fixture);
      // The page reloads as soon as the first request has changed something.
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
      await settle(p.fixture);
      const put = http.expectOne('/api/budgets/1/versions/2026-10');
      expect(put.request.body).toEqual({ amount: 45000, incremental: false });
      put.flush(GROCERIES);
      await p.reload();

      expect(p.toasts()).toEqual(['Food updated.']);
      expect(p.formDialog()).toBeNull();
    });

    it('keeps the dialog open, with the message on the field, when the version is refused', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.type('Name', 'Food');
      await p.type('Monthly amount', '450');
      await p.press('Save changes');
      http.expectOne('/api/budgets/1').flush({ ...GROCERIES, name: 'Food' });
      await settle(p.fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      http.expectOne('/api/budgets').flush([{ ...GROCERIES, name: 'Food' }, FUN]);
      await settle(p.fixture);

      flushError(
        http.expectOne('/api/budgets/1/versions/2026-10'),
        422,
        'rule_violation',
        "2026-10 is outside the budget's active months",
        { rule: 'outside_active_months', field: 'month' },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(p.element, 'Applies from'))).toBe(
        "2026-10 is outside the budget's active months",
      );
      expect(p.dialog('Edit Groceries')).not.toBeNull();
      // The refused month has to be changed before another try (the message is about that value).
      // The name is saved already: saving again does not send it again.
      await p.type('Applies from', '2026-11');
      await p.press('Save changes');
      noRequest(/\/api\/budgets\/1$/);
      http.expectOne('/api/budgets/1/versions/2026-11').flush(GROCERIES);
      await p.reload();
    });

    it('can schedule a change for a later month, and says so', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.type('Applies from', '2027-01');
      await p.type('Monthly amount', '500');

      expect(textOf(p.dialog('Edit Groceries') as HTMLElement)).toContain(
        'Scheduled: the new amount applies from January 2027 on. October 2026 and earlier months keep their amounts.',
      );
      await p.press('Save changes');

      const request = http.expectOne('/api/budgets/1/versions/2027-01');
      expect(request.request.body).toEqual({ amount: 50000, incremental: false });
      request.flush(GROCERIES);
      await p.reload();
    });

    it('treats backdating as an explicit choice with a visible warning', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      const dialog = p.dialog('Edit Groceries') as HTMLElement;
      expect(textOf(dialog)).not.toContain('Backdating');

      await p.type('Applies from', '2026-08');
      expect(textOf(dialog)).toContain(
        "Backdating: August 2026 is already closed. Changing its amount also changes that month's figures and what is due to savings.",
      );

      await p.type('Monthly amount', '500');
      await p.press('Save changes');
      const request = http.expectOne('/api/budgets/1/versions/2026-08');
      expect(request.request.body).toEqual({ amount: 50000, incremental: false });
      request.flush(GROCERIES);
      await p.reload();
    });

    it('shows what is in effect in another month, until the amount is edited', async () => {
      const scheduled = budgetDto({
        id: 1,
        name: 'Groceries',
        versions: [
          { effectiveMonth: '2026-06', amount: 40000, incremental: false },
          { effectiveMonth: '2027-01', amount: 52000, incremental: true },
        ],
      });
      const p = await open('2026-10', { budgets: [scheduled, FUN] });
      await p.press('Edit Groceries');
      expect(p.value('Monthly amount')).toBe('400.00');

      await p.type('Applies from', '2027-02');
      expect(p.value('Monthly amount')).toBe('520.00');
      expect((getByLabel(p.element, 'Incremental') as HTMLInputElement).checked).toBe(true);

      // Once the amount is edited, moving the month does not overwrite it.
      await p.type('Monthly amount', '600');
      await p.type('Applies from', '2026-10');
      expect(p.value('Monthly amount')).toBe('600.00');
    });

    it('lists the amount history', async () => {
      const scheduled = budgetDto({
        id: 1,
        name: 'Groceries',
        versions: [
          { effectiveMonth: '2026-06', amount: 40000, incremental: false },
          { effectiveMonth: '2027-01', amount: 52000, incremental: true },
        ],
      });
      const p = await open('2026-10', { budgets: [scheduled, FUN] });
      await p.press('Edit Groceries');

      const dialog = p.dialog('Edit Groceries') as HTMLElement;
      expect(textOf(dialog)).toContain('Amount history (2)');
      expect(textOf(dialog)).toContain('From June 2026: €400.00 not incremental');
      expect(textOf(dialog)).toContain('From January 2027: €520.00 incremental');
    });

    it('closes without a request when nothing changed', async () => {
      const p = await open();
      await p.press('Edit Groceries');
      await p.press('Save changes');

      expect(p.formDialog()).toBeNull();
      expect(p.toasts()).toEqual([]);
      noRequest(/\/api\/budgets\/1/);
    });
  });

  describe('archive', () => {
    it('asks first, saying that the balance is released to savings when the last month closes', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Archive');

      expect(p.confirmDialog().open).toBe(true);
      const text = textOf(p.confirmDialog());
      expect(text).toContain('Archive "Groceries"?');
      expect(text).toContain('It stays active through October 2026, its last month');
      expect(text).toContain(
        'Whatever is left in it when October 2026 closes is released to savings',
      );
      expect(text).toContain("An archived budget can't be reopened.");

      await p.press('Cancel', p.confirmDialog());
      noRequest(/\/api\/budgets\/1/);
    });

    it('mentions when a budget can only be archived because it has spendings', async () => {
      const p = await open('2026-10', {
        budgets: [{ ...GROCERIES, hasHistory: true }, FUN],
      });
      await p.menuAction('More actions for Groceries', 'Archive');
      expect(textOf(p.confirmDialog())).toContain(
        'It has spendings, so it can only be archived, not deleted.',
      );
    });

    it('posts the archive once confirmed, with no end month: the server uses the current one', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Archive');
      await p.press('Archive budget', p.confirmDialog());

      const request = http.expectOne('/api/budgets/1/archive');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({});
      expect(budgetArchiveSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...GROCERIES, endMonth: '2026-10' });
      await p.reload({
        view: monthView({
          budgets: [budgetLine({ endsThisMonth: true }), FUN_LINE],
        }),
        budgets: [{ ...GROCERIES, endMonth: '2026-10' }, FUN],
      });

      expect(p.toasts()).toEqual(['Groceries archived.']);
      // The end month says it already: no second badge for the same fact.
      expect(p.cardText('Groceries')).toContain('Ends Oct 2026');
      expect(p.cardText('Groceries')).not.toContain('Last month');
      // It cannot be archived twice, and focus stayed on the card's menu button: the item that was
      // pressed is hidden.
      expect(menuItemNames(p.card('Groceries'))).not.toContain('Archive');
      expect(document.activeElement).toBe(
        getByRole(p.card('Groceries'), 'button', 'More actions for Groceries'),
      );
    });

    it('does not offer to archive a budget that is archived or has not started', async () => {
      const p = await open('2026-10', {
        budgets: [{ ...GROCERIES, endMonth: '2026-12' }, FUN],
      });
      expect(menuItemNames(p.card('Groceries'))).not.toContain('Archive');
      expect(menuItemNames(p.card('Fun'))).toContain('Archive');
    });

    it('reports a refusal with the message of the API', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Archive');
      await p.press('Archive budget', p.confirmDialog());
      flushError(
        http.expectOne('/api/budgets/1/archive'),
        422,
        'rule_violation',
        'The end month 2026-10 is before the latest spending (2026-11-03)',
        { rule: 'end_before_activity', field: 'endMonth' },
      );
      await p.reload();

      expect(p.toasts()).toEqual([
        'The end month 2026-10 is before the latest spending (2026-11-03)',
      ]);
    });
  });

  describe('delete', () => {
    it('is only offered for a budget without history', async () => {
      const p = await open('2026-10', { budgets: [GROCERIES, { ...FUN, hasHistory: true }] });

      expect(menuItemNames(p.card('Groceries'))).toContain('Delete');
      expect(menuItemNames(p.card('Fun'))).not.toContain('Delete');
      expect(menuItemNames(p.card('Fun'))).toContain('Archive');
    });

    it('asks first, and does nothing when cancelled', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Delete');

      const text = textOf(p.confirmDialog());
      expect(text).toContain('Delete "Groceries"?');
      expect(text).toContain('It has no spendings or transfers');
      await p.press('Cancel', p.confirmDialog());
      noRequest(/\/api\/budgets\/1/);
    });

    it('deletes once confirmed, reloads and puts focus on the list heading', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Delete');
      await p.press('Delete budget', p.confirmDialog());

      const request = http.expectOne('/api/budgets/1');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ view: monthView({ budgets: [FUN_LINE] }), budgets: [FUN] });

      expect(p.toasts()).toEqual(['Groceries deleted.']);
      expect(queryByRole(p.element, 'article', 'Groceries')).toBeNull();
      expect(document.activeElement).toBe(
        getByRole(p.element, 'heading', 'Budgets in October 2026'),
      );
    });

    it('handles 409 has_history: says what the API says and reloads, so the button goes away', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Delete');
      await p.press('Delete budget', p.confirmDialog());
      flushError(
        http.expectOne('/api/budgets/1'),
        409,
        'has_history',
        'Budget has spendings or transfers; archive it instead of deleting it',
      );
      await p.reload({ budgets: [{ ...GROCERIES, hasHistory: true }, FUN] });

      expect(p.toasts()).toEqual([
        'Budget has spendings or transfers; archive it instead of deleting it',
      ]);
      expect(menuItemNames(p.card('Groceries'))).not.toContain('Delete');
    });
  });

  describe('reorder', () => {
    it('has Move up and Move down in the menu of each card, and the ends cannot move further', async () => {
      const p = await open();

      expect(menuItem(p.card('Groceries'), 'Move up').disabled).toBe(true);
      expect(menuItem(p.card('Groceries'), 'Move down').disabled).toBe(false);
      expect(menuItem(p.card('Fun'), 'Move up').disabled).toBe(false);
      expect(menuItem(p.card('Fun'), 'Move down').disabled).toBe(true);
    });

    it('does nothing when the first card is moved up', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Move up');
      noRequest(/\/api\/budgets\//);
    });

    it('trades sort orders with the neighbour using two PATCH requests', async () => {
      const p = await open();
      await p.menuAction('More actions for Fun', 'Move up');

      const toFun = http.expectOne('/api/budgets/2');
      const toGroceries = http.expectOne('/api/budgets/1');
      expect(toFun.request.method).toBe('PATCH');
      expect(toFun.request.body).toEqual({ sortOrder: 0 });
      expect(toGroceries.request.body).toEqual({ sortOrder: 10 });
      expect(budgetUpdateSchema.safeParse(toFun.request.body).success).toBe(true);
      toFun.flush({ ...FUN, sortOrder: 0 });
      toGroceries.flush({ ...GROCERIES, sortOrder: 10 });
      await p.reload({
        view: monthView({ budgets: [FUN_LINE, GROCERIES_LINE] }),
        budgets: [
          { ...FUN, sortOrder: 0 },
          { ...GROCERIES, sortOrder: 10 },
        ],
      });

      expect(
        Array.from(p.element.querySelectorAll('article h3')).map((h) => h.textContent?.trim()),
      ).toEqual(['Fun', 'Groceries']);
    });

    it("announces the move, and puts the keyboard on the moved card's menu button", async () => {
      const p = await open();
      await p.menuAction('More actions for Fun', 'Move up');
      http.expectOne('/api/budgets/2').flush({ ...FUN, sortOrder: 0 });
      http.expectOne('/api/budgets/1').flush({ ...GROCERIES, sortOrder: 10 });
      await p.reload({
        view: monthView({ budgets: [FUN_LINE, GROCERIES_LINE] }),
        budgets: [
          { ...FUN, sortOrder: 0 },
          { ...GROCERIES, sortOrder: 10 },
        ],
      });

      expect(textOf(getByRole(p.element, 'status', /moved up/))).toBe(
        'Fun moved up. It is now number 1 of 2.',
      );
      expect(document.activeElement).toBe(
        getByRole(p.card('Fun'), 'button', 'More actions for Fun'),
      );
    });

    it('moves down too', async () => {
      const p = await open();
      await p.menuAction('More actions for Groceries', 'Move down');

      const toGroceries = http.expectOne('/api/budgets/1');
      const toFun = http.expectOne('/api/budgets/2');
      expect(toGroceries.request.body).toEqual({ sortOrder: 10 });
      expect(toFun.request.body).toEqual({ sortOrder: 0 });
      toGroceries.flush({ ...GROCERIES, sortOrder: 10 });
      toFun.flush({ ...FUN, sortOrder: 0 });
      await p.reload({
        view: monthView({ budgets: [FUN_LINE, GROCERIES_LINE] }),
        budgets: [
          { ...FUN, sortOrder: 0 },
          { ...GROCERIES, sortOrder: 10 },
        ],
      });

      expect(textOf(getByRole(p.element, 'status', /moved down/))).toBe(
        'Groceries moved down. It is now number 2 of 2.',
      );
      expect(document.activeElement).toBe(
        getByRole(p.card('Groceries'), 'button', 'More actions for Groceries'),
      );
    });

    it('numbers the budgets again when two have the same sort order', async () => {
      const tied = [
        { ...GROCERIES, sortOrder: 0 },
        { ...FUN, sortOrder: 0 },
      ];
      const p = await open('2026-10', { budgets: tied });
      await p.menuAction('More actions for Fun', 'Move up');

      // A swap would change nothing. Fun already has the first number, and Groceries takes the next
      // one, so that is the only request.
      const toGroceries = http.expectOne('/api/budgets/1');
      expect(toGroceries.request.body).toEqual({ sortOrder: 10 });
      noRequest(/\/api\/budgets\/2$/);
      toGroceries.flush({ ...GROCERIES, sortOrder: 10 });
      await p.reload({
        view: monthView({ budgets: [FUN_LINE, GROCERIES_LINE] }),
        budgets: [
          { ...FUN, sortOrder: 0 },
          { ...GROCERIES, sortOrder: 10 },
        ],
      });

      expect(
        Array.from(p.element.querySelectorAll('article h3')).map((h) => h.textContent?.trim()),
      ).toEqual(['Fun', 'Groceries']);
    });

    it('ignores another move while one is being saved', async () => {
      const p = await open();
      await p.menuAction('More actions for Fun', 'Move up');
      expect(menuItem(p.card('Fun'), 'Move up').disabled).toBe(true);
      expect(menuItem(p.card('Groceries'), 'Move down').disabled).toBe(true);
      await p.menuAction('More actions for Groceries', 'Move down');

      // Only the first move sent anything.
      const patches = http.match((request) => request.method === 'PATCH');
      expect(patches.map((request) => request.request.url).sort()).toEqual([
        '/api/budgets/1',
        '/api/budgets/2',
      ]);
    });

    it('reports a failure, and still loads the real order', async () => {
      const p = await open();
      await p.menuAction('More actions for Fun', 'Move up');
      flushError(http.expectOne('/api/budgets/2'), 500, 'internal_error', 'Could not save');
      http.expectOne('/api/budgets/1').flush({ ...GROCERIES, sortOrder: 10 });
      await p.reload();

      expect(p.toasts()).toEqual(['Could not save']);
      expect(queryByRole(p.element, 'status', /moved/)).toBeNull();
    });
  });
});
