import {
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { SpendingDto } from '@wallet/shared';
import { DataChanges } from '../core/data-changes';
import { reloaded, resourceState } from '../core/resource-state';
import { SavingsStore } from '../core/savings.store';
import { SelectedMonth } from '../core/selected-month';
import { SettingsStore } from '../core/settings.store';
import { TodayStore } from '../core/today.store';
import { MonthsApi } from '../features/months/months.api';
import { addedConfirmation } from '../features/spendings/spending-confirmation';
import { SpendingForm } from '../features/spendings/spending-form';
import { formatMonth } from '../shared/format';
import { formatMoney } from '../shared/money.pipe';
import { Button } from '../shared/ui/button';
import { AppDialog } from '../shared/ui/dialog';
import { LinkButton } from '../shared/ui/link-button';
import { EmptyState, ErrorState, LoadingState } from '../shared/ui/states';
import { ToastService } from '../shared/ui/toast.service';
import { AddSpending } from './add-spending';

/**
 * "Add spending" from any page: the spending form of the Spendings page (the same fields, defaults
 * and checks: today's date, the budget used last) in a dialog. The shell shows this component while
 * `AddSpending.isOpen()`, so every opening starts from the month's budgets as the server has them.
 *
 * The spending goes to the month the pages show (`SelectedMonth`, which is the current month unless
 * the person picked another), and the dialog says which. After a save it loads the month again for
 * the budget's fresh figures, closes, confirms in a toast with them (the sentence the Spendings page
 * shows under its form) and tells the app that its figures changed (`DataChanges`), so the page
 * behind shows the new numbers. A spending in a closed month also asks for the savings overview
 * again, as the Spendings page does: the badge on the navigation counts the months to move.
 */
@Component({
  selector: 'app-add-spending-dialog',
  imports: [
    AppDialog,
    SpendingForm,
    Button,
    LinkButton,
    RouterLink,
    LoadingState,
    ErrorState,
    EmptyState,
  ],
  template: `
    <app-dialog heading="Add spending" [locked]="locked()" (closed)="add.close()">
      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading this month's budgets…" />
          <div class="dialog-footer">
            <button appButton variant="secondary" (click)="add.close()">Cancel</button>
          </div>
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load this month's budgets"
            [error]="view.error()"
            (retry)="view.reload()"
          />
          <div class="dialog-footer">
            <button appButton variant="secondary" (click)="add.close()">Cancel</button>
          </div>
        }
        @default {
          @if (month(); as month) {
            <p class="mb-4 text-sm text-muted">{{ note() }}</p>
            @if (lines().length === 0) {
              <app-empty-state
                [title]="'No budgets in ' + monthLabel()"
                description="A spending belongs to a budget. Create a budget first, then add spendings to it."
              >
                <a
                  appLinkButton
                  variant="primary"
                  routerLink="/budgets"
                  [queryParams]="selected.linkParams()"
                  (click)="add.close()"
                >
                  Go to budgets
                </a>
              </app-empty-state>
              <div class="dialog-footer">
                <button appButton variant="secondary" (click)="add.close()">Cancel</button>
              </div>
            } @else {
              <app-spending-form
                [month]="month"
                [budgets]="lines()"
                [inDialog]="true"
                (saved)="onSaved($event)"
                (cancelled)="add.close()"
              />
            }
          }
        }
      }
    </app-dialog>
  `,
})
export class AddSpendingDialog {
  protected readonly add = inject(AddSpending);
  protected readonly selected = inject(SelectedMonth);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly savings = inject(SavingsStore);
  private readonly changes = inject(DataChanges);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly form = viewChild(SpendingForm);

  protected readonly month = this.selected.month;
  /** `GET /api/months/:month`: the budgets to choose from, with what is left in each. */
  protected readonly view = inject(MonthsApi).view(this.month);
  private readonly viewState = resourceState(this.view);
  private readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  protected readonly lines = computed(() => this.monthView()?.budgets ?? []);

  /** What to show: the month's budgets, or why they are not there yet. */
  protected readonly state = computed<'loading' | 'error' | 'ready'>(() =>
    this.month() === undefined ? 'loading' : this.viewState(),
  );

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** Which month the spending goes to, and what that means when it is not the running one. */
  protected readonly note = computed(() => {
    const month = this.monthLabel();
    switch (this.monthView()?.status) {
      case 'closed':
        return `${month} is closed. A spending added to it changes what is due to savings.`;
      case 'future':
        return `${month} has not started yet. A spending dated in it counts towards its projection.`;
      default:
        return `Adding to ${month}.`;
    }
  });

  /** The spending is saved and the month is loading again: Escape would close it before it says so. */
  private readonly finishing = signal(false);
  protected readonly locked = computed(() => this.finishing() || (this.form()?.saving() ?? false));

  constructor() {
    // The cursor goes to the amount once the form is there (the dialog opens before the budgets arrive).
    effect(() => {
      const form = this.form();
      if (form) untracked(() => form.focusAmount());
    });
  }

  protected async onSaved(spending: SpendingDto): Promise<void> {
    this.finishing.set(true);
    this.refreshSavingsFor(spending.date);
    // The budget's figures after this spending, for the confirmation.
    await reloaded(this.view, this.injector);
    const line = this.lines().find((candidate) => candidate.id === spending.budgetId);
    const message = addedConfirmation(
      { budgetId: spending.budgetId, amount: spending.amount },
      line,
      (cents) => formatMoney(cents, this.settings.locale(), this.settings.currency()),
    );
    this.add.close();
    this.changes.notify();
    this.toast.success(message);
  }

  /**
   * A spending in a closed month moves what that month owes savings, and the badge counts the months
   * to move. The navigation only looks again when the person moves to another page, so a change made
   * here asks for the overview at once. One in the current or a later month cannot change it, and the
   * most common spending, today's, must not make the server work out the savings for nothing.
   */
  private refreshSavingsFor(date: string): void {
    const current = this.today.month();
    if (current === undefined || date.slice(0, 7) < current) this.savings.refresh();
  }
}
