import { HttpTestingController } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { BudgetDto, MonthView, SavingsDto, TransferDto } from '@wallet/shared';
import { BudgetsPage } from '../app/features/budgets/budgets-page';
import { ConfirmDialog } from '../app/shared/ui/confirm-dialog';
import { ToastContainer } from '../app/shared/ui/toast-container';
import { ToastService } from '../app/shared/ui/toast.service';
import { getByLabel, getByRole, queryByRole, textOf, typeInto } from './dom';
import { budgetDto, budgetLine, monthView, savingsDto } from './fixtures';
import { primeStores, settle } from './harness';

/** The Budgets page with the shell's confirm dialog and toasts, as the app has them. */
@Component({
  selector: 'app-budgets-host',
  imports: [BudgetsPage, ConfirmDialog, ToastContainer],
  template: '<app-budgets-page /><app-confirm-dialog /><app-toast-container />',
})
export class BudgetsHost {}

export const GROCERIES_LINE = budgetLine({ id: 1, name: 'Groceries' });
export const FUN_LINE = budgetLine({
  id: 2,
  name: 'Fun',
  allocated: 15000,
  available: 15000,
  spent: 4050,
  remaining: 10950,
  usagePercent: 27,
});
export const GROCERIES = budgetDto({ id: 1, name: 'Groceries', sortOrder: 0 });
export const FUN = budgetDto({
  id: 2,
  name: 'Fun',
  sortOrder: 10,
  versions: [{ effectiveMonth: '2026-06', amount: 15000, incremental: false }],
});
export const OCTOBER = monthView({ month: '2026-10', budgets: [GROCERIES_LINE, FUN_LINE] });

export interface BudgetsReplies {
  /** The month view. Default: October with Groceries and Fun. */
  view?: MonthView;
  /** The budget list. Default: Groceries and Fun. */
  budgets?: BudgetDto[];
  /** The month's transfers. Default: none. */
  transfers?: TransferDto[];
  /** The savings overview, when the page asks for it again after money was moved. Default: an empty one. */
  savings?: SavingsDto;
}

/** Opens the Budgets page for a month and answers the three requests it makes. */
export async function openBudgetsPage(
  http: HttpTestingController,
  options: { month?: string } & BudgetsReplies = {},
) {
  const router = TestBed.inject(Router);
  const month = options.month ?? '2026-10';
  await primeStores(http);
  await router.navigateByUrl(`/budgets${month === '2026-10' ? '' : `?month=${month}`}`);
  const fixture = TestBed.createComponent(BudgetsHost);
  fixture.detectChanges();
  await settle(fixture);
  await answerBudgetsPage(http, fixture, month, options);
  return budgetsPageHelpers(http, fixture, month);
}

/**
 * Answers what the page asks for: the month view, the budget list and the month's transfers. After
 * money was moved or a move deleted the page also loads the savings overview again, for the badge on
 * the navigation (the page does not ask for it when it opens): that is answered here when it was
 * asked. Resolves to how many times it was.
 */
export async function answerBudgetsPage(
  http: HttpTestingController,
  fixture: ComponentFixture<unknown>,
  month: string,
  replies: BudgetsReplies = {},
): Promise<number> {
  http.expectOne(`/api/months/${month}`).flush(replies.view ?? { ...OCTOBER, month });
  http.expectOne('/api/budgets').flush(replies.budgets ?? [GROCERIES, FUN]);
  http.expectOne(`/api/transfers?month=${month}`).flush(replies.transfers ?? []);
  const savings = http.match('/api/savings');
  for (const request of savings) request.flush(replies.savings ?? savingsDto());
  await settle(fixture as never);
  return savings.length;
}

/** What a spec does on the page: find a card or a dialog, press a button, type into a field. */
export function budgetsPageHelpers(
  http: HttpTestingController,
  fixture: ComponentFixture<BudgetsHost>,
  month = '2026-10',
) {
  const element = fixture.nativeElement as HTMLElement;
  const helpers = {
    http,
    fixture,
    element,
    text: () => textOf(element),
    /** The page title with its actions. */
    header: () => element.querySelector('app-page-header') as HTMLElement,
    card: (name: string) => getByRole(element, 'article', name),
    cardText: (name: string) => textOf(getByRole(element, 'article', name)),
    /** The transfers list block. */
    transfers: () => getByRole(element, 'region', /Money moved in/),
    /** The "Move money" dialog: null when it is closed. */
    dialog: () => element.querySelector<HTMLDialogElement>('app-transfer-dialog dialog'),
    confirmDialog: () => element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!,
    press: async (name: string | RegExp, root: ParentNode = element) => {
      getByRole(root, 'button', name).click();
      await settle(fixture);
    },
    type: async (label: string | RegExp, value: string, root: ParentNode = element) => {
      typeInto(getByLabel(root, label), value);
      await settle(fixture);
    },
    value: (label: string | RegExp, root: ParentNode = element) =>
      (getByLabel(root, label) as HTMLInputElement).value,
    has: (role: string, name?: string | RegExp, root: ParentNode = element) =>
      queryByRole(root, role, name) !== null,
    toasts: () =>
      TestBed.inject(ToastService)
        .toasts()
        .map((toast) => toast.message),
    /** After money was moved or a move deleted, all three requests are made again, and the savings overview. */
    reloadAll: async (replies: BudgetsReplies = {}, at = month) => {
      await settle(fixture);
      return answerBudgetsPage(http, fixture, at, replies);
    },
  };
  return helpers;
}

export type BudgetsPageHelpers = ReturnType<typeof budgetsPageHelpers>;
