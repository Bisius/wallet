import { HttpTestingController } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { Page, SavingsDto, SavingsOpeningDto, SavingsTransactionDto } from '@wallet/shared';
import { SavingsPage } from '../app/features/savings/savings-page';
import { ConfirmDialog } from '../app/shared/ui/confirm-dialog';
import { ToastContainer } from '../app/shared/ui/toast-container';
import { ToastService } from '../app/shared/ui/toast.service';
import { getByLabel, getByRole, queryByRole, textOf, typeInto } from './dom';
import { transactionsPage } from './fixtures';
import { primeStores, settle } from './harness';

/** The Savings page with the shell's confirm dialog and toasts, as the app has them. */
@Component({
  selector: 'app-savings-host',
  imports: [SavingsPage, ConfirmDialog, ToastContainer],
  template: '<app-savings-page /><app-confirm-dialog /><app-toast-container />',
})
export class SavingsHost {}

/** The three things the page loads: the overview, the opening balance and the first page of the history. */
export interface SavingsReplies {
  savings: SavingsDto;
  opening?: SavingsOpeningDto;
  history?: Page<SavingsTransactionDto>;
}

export const OPENING: SavingsOpeningDto = { amount: 100000, date: '2026-06-01' };

export const HISTORY_URL = '/api/savings/transactions?limit=50&offset=0';

/** Opens the Savings page and answers its three requests. */
export async function openSavingsPage(http: HttpTestingController, data: SavingsReplies) {
  await primeStores(http);
  const fixture = TestBed.createComponent(SavingsHost);
  fixture.detectChanges();
  await settle(fixture);
  http.expectOne('/api/savings').flush(data.savings);
  http.expectOne('/api/savings/opening').flush(data.opening ?? OPENING);
  http.expectOne(HISTORY_URL).flush(data.history ?? transactionsPage([]));
  await settle(fixture);
  return savingsPage(http, fixture);
}

/**
 * What a spec does on the page: find a block, press a button, type into a field, read the toasts. After
 * a change the page loads its data again: `reload` answers those three requests.
 */
export function savingsPage(http: HttpTestingController, fixture: ComponentFixture<SavingsHost>) {
  const element = fixture.nativeElement as HTMLElement;
  const helpers = {
    fixture,
    element,
    text: () => textOf(element),
    region: (name: string | RegExp) => getByRole(element, 'region', name),
    regionText: (name: string | RegExp) => textOf(getByRole(element, 'region', name)),
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
    /** The dialog of a component (the confirm dialog is always in the page, so it is asked for by tag). */
    dialog: (tag: string) => element.querySelector<HTMLElement>(`${tag} dialog[open]`),
    confirmDialog: () => element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!,
    /** Answers the confirm dialog. */
    confirm: async (name: string | RegExp) => {
      await settle(fixture);
      getByRole(helpers.confirmDialog(), 'button', name).click();
      await settle(fixture);
    },
    toasts: () =>
      TestBed.inject(ToastService)
        .toasts()
        .map((toast) => toast.message),
    /** The alerts that say something: the toasts' live region is always there, and empty. */
    alerts: () =>
      Array.from(element.querySelectorAll('[role="alert"]'))
        .map((alert) => textOf(alert))
        .filter((text) => text !== ''),
    has: (role: string, name?: string | RegExp) => queryByRole(element, role, name) !== null,
    /** Answers the three requests the page makes after something changed. */
    reload: async (data: SavingsReplies, history = HISTORY_URL) => {
      await settle(fixture);
      http.expectOne('/api/savings').flush(data.savings);
      http.expectOne('/api/savings/opening').flush(data.opening ?? OPENING);
      http.expectOne(history).flush(data.history ?? transactionsPage([]));
      await settle(fixture);
    },
  };
  return helpers;
}
