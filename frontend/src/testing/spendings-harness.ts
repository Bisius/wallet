import { HttpParams } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { BudgetDto, MonthView, SpendingsPage, TagDto } from '@wallet/shared';
import { SpendingsPage as SpendingsPageComponent } from '../app/features/spendings/spendings-page';
import { ConfirmDialog } from '../app/shared/ui/confirm-dialog';
import { ToastContainer } from '../app/shared/ui/toast-container';
import { ToastService } from '../app/shared/ui/toast.service';
import { getByLabel, getByRole, queryByRole, textOf, typeInto } from './dom';
import { budgetLine, monthView, spendingDto, spendingsPage as pageOf } from './fixtures';
import { primeStores, settle } from './harness';
import { rowAction } from './menu';

/** The Spendings page with the shell's confirm dialog and toasts, as the app has them. */
@Component({
  selector: 'app-spendings-host',
  imports: [SpendingsPageComponent, ConfirmDialog, ToastContainer],
  template: '<app-spendings-page /><app-confirm-dialog /><app-toast-container />',
})
export class SpendingsHost {}

export const GROCERIES_LINE = budgetLine({ id: 1, name: 'Groceries', color: '#2563eb' });
export const FUN_LINE = budgetLine({
  id: 2,
  name: 'Fun',
  available: 15000,
  spent: 0,
  remaining: 15000,
  usagePercent: 0,
  allocated: 15000,
});
export const OCTOBER = monthView({ month: '2026-10', budgets: [GROCERIES_LINE, FUN_LINE] });

export const COFFEE = spendingDto({
  id: 3,
  date: '2026-10-02',
  amount: 350,
  description: 'Coffee',
});
export const LUNCH = spendingDto({ id: 2, date: '2026-10-02', amount: 1250, description: 'Lunch' });
export const SHOES = spendingDto({
  id: 1,
  date: '2026-10-01',
  amount: -4500,
  budgetId: 2,
  description: 'Shoes (returned)',
});
export const PAGE = pageOf([COFFEE, LUNCH, SHOES]);

/** What `GET /api/spendings` is asked, in the order the page puts it (the API's order of parameters). */
export interface SpendingsQuery {
  month?: string;
  budgetId?: number;
  tagId?: number;
  q?: string;
  minAmount?: number;
  maxAmount?: number;
  offset?: number;
}

/**
 * The URL of a spendings request, encoded the way the HTTP client encodes it, so a spec can say what
 * it expects as plain values and still match the request exactly (parameters and their order).
 */
export function spendingsUrl(query: SpendingsQuery = {}): string {
  const fromObject: Record<string, string | number> = {};
  if (query.month !== undefined) fromObject['month'] = query.month;
  if (query.budgetId !== undefined) fromObject['budgetId'] = query.budgetId;
  if (query.tagId !== undefined) fromObject['tagId'] = query.tagId;
  if (query.q !== undefined) fromObject['q'] = query.q;
  if (query.minAmount !== undefined) fromObject['minAmount'] = query.minAmount;
  if (query.maxAmount !== undefined) fromObject['maxAmount'] = query.maxAmount;
  fromObject['limit'] = 50;
  fromObject['offset'] = query.offset ?? 0;
  return `/api/spendings?${new HttpParams({ fromObject }).toString()}`;
}

export interface SpendingsReplies {
  /** The month view the page asks for. Default: October with Groceries and Fun. */
  view?: MonthView;
  /** The first page of the list. Default: three spendings. */
  page?: SpendingsPage;
  /** The tags. Default: none. */
  tags?: TagDto[];
  /** The budget list, for specs that make the page ask for it. */
  budgets?: BudgetDto[];
}

/**
 * Opens the Spendings page at `url` and answers what it asks for at once: the month view, the tags
 * and the first page, whose request is `firstPage`. A spec that is about a request the page makes
 * after that (a filter, "Load more") answers it itself.
 */
export async function openSpendingsPage(
  http: HttpTestingController,
  options: {
    url?: string;
    month?: string;
    firstPage?: SpendingsQuery;
  } & SpendingsReplies = {},
) {
  const router = TestBed.inject(Router);
  const month = options.month ?? '2026-10';
  await primeStores(http);
  await router.navigateByUrl(options.url ?? '/spendings');
  const fixture = TestBed.createComponent(SpendingsHost);
  fixture.detectChanges();
  await settle(fixture);

  http.expectOne(`/api/months/${month}`).flush(options.view ?? { ...OCTOBER, month });
  http.expectOne(spendingsUrl(options.firstPage ?? { month })).flush(options.page ?? PAGE);
  http.expectOne('/api/tags').flush(options.tags ?? []);
  await settle(fixture);
  // The budget list is asked for only when the filters need it (every month, or a budget that is not in
  // the month): the request follows the answers above.
  if (options.budgets) {
    http.expectOne('/api/budgets').flush(options.budgets);
    await settle(fixture);
  }
  return spendingsPageHelpers(http, router, fixture);
}

/** What a spec does on the page: find a block, press a button, type into a field, read the URL. */
export function spendingsPageHelpers(
  http: HttpTestingController,
  router: Router,
  fixture: ComponentFixture<SpendingsHost>,
) {
  const element = fixture.nativeElement as HTMLElement;
  const helpers = {
    http,
    router,
    fixture,
    element,
    text: () => textOf(element),
    /** The search and filters block. */
    bar: () => getByRole(element, 'search') as HTMLElement,
    /** The list of spendings, with its heading and the result line. */
    list: () => getByRole(element, 'region', /Spendings in/),
    /** The result line under the list heading: a live region. */
    result: () =>
      getByRole(element, 'region', /Spendings in/).querySelector<HTMLElement>('h2 + p[aria-live]')!,
    form: () => element.querySelector('section app-spending-form') as HTMLElement,
    dialog: () => queryByRole(element, 'dialog', 'Edit spending') as HTMLElement | null,
    confirmDialog: () => element.querySelector('app-confirm-dialog dialog') as HTMLDialogElement,
    /** The query parameters of the address bar. */
    params: () => router.parseUrl(router.url).queryParams as Record<string, string>,
    press: async (name: string | RegExp, root: ParentNode = element) => {
      getByRole(root, 'button', name).click();
      await settle(fixture);
    },
    /**
     * Unfolds "More" in the quick add (description, tags, Refund), as a person does with its summary. It
     * stays as it is when it is open already.
     */
    openMore: async (root: ParentNode = element) => {
      const summary = Array.from(root.querySelectorAll('summary')).find((candidate) =>
        textOf(candidate).startsWith('More'),
      );
      if (!summary) throw new Error('There is no "More" disclosure to open');
      const details = summary.parentElement as HTMLDetailsElement;
      if (!details.open) summary.click();
      await settle(fixture);
      if (!details.open) throw new Error('"More" did not open');
    },
    /** The "Filters" button of the toolbar, whatever its name says about the count ("Filters, 2 active"). */
    filtersButton: () => getByRole(getByRole(element, 'search'), 'button', /^Filters/),
    /** Unfolds the panel under the toolbar (budget, tag, amounts, months). It stays open when it is. */
    openFilters: async () => {
      const button = getByRole(getByRole(element, 'search'), 'button', /^Filters/);
      if (button.getAttribute('aria-expanded') !== 'true') {
        button.click();
        await settle(fixture);
      }
    },
    /**
     * Opens the "More actions" menu of a row, which a spec names the way the row is named to a screen
     * reader (`'Coffee, €3.50'`), and presses its item: `await p.rowAction('Coffee, €3.50', 'Delete')`.
     */
    rowAction: (row: string, item: string | RegExp) =>
      rowAction(element, item, `More actions for ${row}`),
    type: async (label: string | RegExp, value: string, root: ParentNode = element) => {
      typeInto(getByLabel(root, label), value);
      await settle(fixture);
    },
    value: (label: string | RegExp, root: ParentNode = element) =>
      (getByLabel(root, label) as HTMLInputElement).value,
    toasts: () =>
      TestBed.inject(ToastService)
        .toasts()
        .map((toast) => toast.message),
    /** Answers the first page of a query. */
    answer: async (query: SpendingsQuery, page: SpendingsPage = PAGE) => {
      http.expectOne(spendingsUrl(query)).flush(page);
      await settle(fixture);
    },
  };
  return helpers;
}

export type SpendingsPageHelpers = ReturnType<typeof spendingsPageHelpers>;
