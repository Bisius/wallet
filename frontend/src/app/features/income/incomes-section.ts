import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { IncomeDto, MonthKey } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import type { LoadState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { formatMoney } from '../../shared/money.pipe';
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { AppSection } from '../../shared/ui/section';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { IncomeForm } from './income-form';
import { IncomesApi } from './incomes.api';

/**
 * The one-off incomes of the selected month (`incomes`, newest first): list, add, edit and delete.
 * Adding and editing happen in a dialog (`IncomeForm`).
 */
@Component({
  selector: 'app-incomes-section',
  imports: [
    AppSection,
    ActionMenu,
    Amount,
    AppList,
    Button,
    Icon,
    EmptyState,
    ErrorState,
    ListRow,
    LoadingState,
    MenuItem,
    IncomeForm,
  ],
  template: `
    <app-section
      [heading]="'One-off income in ' + monthLabel()"
      description="Bonuses, refunds and anything else that comes in besides your salary."
      focusable
    >
      <button sectionAction appButton (click)="openForm()">
        <app-icon name="plus" />
        Add income
      </button>

      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading one-off income…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load one-off income"
            [error]="error()"
            (retry)="retry.emit()"
          />
        }
        @default {
          @if (list().length === 0) {
            <app-empty-state
              [title]="'No one-off income in ' + monthLabel()"
              description="When money comes in besides your salary, add it here so the month's income is right."
            />
          } @else {
            <ul appList>
              @for (income of list(); track income.id) {
                <li appListRow>
                  <span rowTitle>{{ income.description }}</span>
                  <p rowMeta>
                    <span>{{ dateLabel(income.date) }}</span>
                  </p>
                  <app-amount rowAmount [cents]="income.amount" [signed]="true" />
                  <app-action-menu rowActions [label]="'More actions for ' + income.description">
                    <button appMenuItem (click)="openForm(income)">
                      <app-icon name="pencil" />
                      Edit
                    </button>
                    <button appMenuItem destructive (click)="remove(income)">
                      <app-icon name="trash" />
                      Delete
                    </button>
                  </app-action-menu>
                </li>
              }
            </ul>
          }
        }
      }
    </app-section>

    @if (form(); as dialog) {
      <app-income-form
        [month]="month()"
        [income]="dialog.income"
        (saved)="onSaved()"
        (cancelled)="closeForm()"
      />
    }
  `,
  host: { class: 'block' },
})
export class IncomesSection {
  private readonly api = inject(IncomesApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly section = viewChild(AppSection);

  /** The selected month. */
  readonly month = input.required<MonthKey>();
  /** The incomes of that month (`GET /api/incomes?month=`), once loaded. */
  readonly incomes = input<readonly IncomeDto[]>();
  /** Where loading the incomes stands. */
  readonly state = input.required<LoadState>();
  /** Why loading failed, while `state` is `error`. */
  readonly error = input<unknown>();

  /** The user wants to load the incomes again. */
  readonly retry = output<void>();

  /** Something was added, changed or deleted: the page reloads what it shows. */
  readonly changed = output<void>();

  protected readonly list = computed(() => this.incomes() ?? []);
  /** The dialog: adding (`income` unset) or editing one. `null` while it is closed. */
  protected readonly form = signal<{ income: IncomeDto | undefined } | null>(null);

  protected readonly monthLabel = computed(() => formatMonth(this.month(), this.settings.locale()));

  protected dateLabel(date: string): string {
    return formatDate(date, this.settings.locale(), 'full');
  }

  protected openForm(income?: IncomeDto): void {
    this.form.set({ income });
  }

  protected closeForm(): void {
    this.form.set(null);
  }

  /** The form saved: the dialog closes (and gives focus back to what opened it), the page reloads. */
  protected onSaved(): void {
    this.form.set(null);
    this.changed.emit();
  }

  protected async remove(income: IncomeDto): Promise<void> {
    const amount = formatMoney(income.amount, this.settings.locale(), this.settings.currency());
    const confirmed = await this.confirm.confirm({
      title: 'Delete this income?',
      message: `"${income.description}" (${amount}, ${this.dateLabel(income.date)}) will no longer count towards the income of ${this.monthLabel()}.`,
      confirmLabel: 'Delete income',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(income.id));
      this.toast.success('Income deleted.');
      this.changed.emit();
      // The row that had focus is gone.
      afterNextRender(() => this.section()?.focusHeading(), { injector: this.injector });
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }
}
