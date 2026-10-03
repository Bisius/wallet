import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { BudgetDto, MonthKey, TransferDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import type { LoadState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatDate, formatMonth } from '../../shared/format';
import { formatMoney } from '../../shared/money.pipe';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { closedMonthEffect, POOL_LABEL } from './transfer-text';
import { TransfersApi } from './transfers.api';

/** A transfer with its words, ready to show. */
interface Row {
  transfer: TransferDto;
  from: string;
  to: string;
  /** The date as the user reads it. */
  date: string;
  amount: string;
  /** What the row is called to a screen reader: "€50.00 from Groceries to Fun on Oct 2, 2026". */
  label: string;
}

/**
 * The money moved in the selected month (`GET /api/transfers?month=`, newest first): the date, who
 * gave and who got, the amount and the note, with a button to delete. A transfer is never edited, so
 * there is no edit: it is deleted and entered again. Names come from the budget list, which holds
 * budgets of every status; a side that is `null` is the unallocated pool of the month.
 *
 * Deleting asks first, and says what it does. A transfer in a closed month rewrites that month, so
 * the question says so in the words of the dialog that creates one. The page reloads what it shows
 * (`changed`) after a delete.
 */
@Component({
  selector: 'app-transfers-section',
  imports: [Button, EmptyState, ErrorState, Icon, LoadingState],
  template: `
    <section aria-labelledby="transfers-heading" class="card space-y-4">
      <div>
        <h2 #heading id="transfers-heading" tabindex="-1" class="text-lg font-semibold">
          Money moved in {{ monthLabel() }}
        </h2>
        <p class="text-sm text-muted">
          Money planned from one budget to another, or to and from what is unallocated.
        </p>
      </div>

      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading the money moved…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load the money moved"
            [error]="error()"
            (retry)="retry.emit()"
          />
        }
        @default {
          @if (rows().length === 0) {
            <app-empty-state
              [title]="'No money moved in ' + monthLabel()"
              description="When you move money between budgets, or to or from the unallocated amount, it is listed here."
            >
              @if (canMove()) {
                <button appButton variant="secondary" (click)="moveMoney.emit()">
                  <app-icon name="arrows-left-right" />
                  Move money
                </button>
              }
            </app-empty-state>
          } @else {
            <ul class="divide-y divide-line rounded-card border border-line">
              @for (row of rows(); track row.transfer.id) {
                <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-3">
                  <div class="min-w-0 flex-1">
                    <p class="font-medium break-words">
                      <span class="sr-only">From </span>{{ row.from }}
                      <span aria-hidden="true">→</span><span class="sr-only"> to </span>
                      {{ row.to }}
                    </p>
                    <p class="mt-0.5 text-sm break-words text-muted">
                      {{ row.date }}
                      @if (row.transfer.note) {
                        · {{ row.transfer.note }}
                      }
                    </p>
                  </div>
                  <p class="font-semibold tabular-nums">{{ row.amount }}</p>
                  <div class="flex w-full justify-end gap-1 sm:w-auto">
                    <button
                      appButton
                      variant="ghost"
                      size="sm"
                      [attr.aria-label]="'Delete transfer of ' + row.label"
                      (click)="remove(row)"
                    >
                      <app-icon name="trash" />
                      Delete
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
        }
      }
    </section>
  `,
  host: { class: 'block' },
})
export class TransfersSection {
  private readonly api = inject(TransfersApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The selected month. */
  readonly month = input.required<MonthKey>();
  /** The transfers of that month (`GET /api/transfers?month=`), once loaded. */
  readonly transfers = input<readonly TransferDto[]>();
  /** Where loading the transfers stands. */
  readonly state = input.required<LoadState>();
  /** Why loading failed, while `state` is `error`. */
  readonly error = input<unknown>();
  /** Every budget, of every status: the names of the sides. */
  readonly budgets = input<readonly BudgetDto[]>();
  /** Offer "Move money" when nothing was moved yet (there is a budget to move money to or from). */
  readonly canMove = input(false);

  /** The user wants to load the transfers again. */
  readonly retry = output<void>();
  /** The user wants to move money. */
  readonly moveMoney = output<void>();
  /** A transfer was deleted (or was already gone): the page reloads what it shows. */
  readonly changed = output<void>();

  protected readonly monthLabel = computed(() => formatMonth(this.month(), this.settings.locale()));

  protected readonly rows = computed<Row[]>(() => {
    const locale = this.settings.locale();
    const names = new Map((this.budgets() ?? []).map((budget) => [budget.id, budget.name]));
    const side = (id: number | null) =>
      id === null ? POOL_LABEL : (names.get(id) ?? `Budget ${id}`);
    return (this.transfers() ?? []).map((transfer) => {
      const from = side(transfer.fromBudgetId);
      const to = side(transfer.toBudgetId);
      const date = formatDate(transfer.date, locale, 'medium');
      const amount = formatMoney(transfer.amount, locale, this.settings.currency());
      return {
        transfer,
        from,
        to,
        date,
        amount,
        label: `${amount} from ${from} to ${to} on ${date}`,
      };
    });
  });

  /** Puts the keyboard on the heading, for a page whose button went away with the empty list. */
  focusHeading(): void {
    this.heading()?.nativeElement.focus();
  }

  protected async remove(row: Row): Promise<void> {
    const { transfer } = row;
    const month = transfer.date.slice(0, 7);
    const current = this.today.month();
    const closed = current !== undefined && month < current;
    const confirmed = await this.confirm.confirm({
      title: 'Delete this transfer?',
      message:
        `${row.amount} moved from ${row.from} to ${row.to} on ${row.date} goes back where it was.` +
        (closed ? ` ${closedMonthEffect(formatMonth(month, this.settings.locale()))}` : ''),
      confirmLabel: 'Delete transfer',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(transfer.id));
      this.toast.success('Transfer deleted.');
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'not_found') this.toast.info('That transfer was already gone.');
      else {
        this.toast.error(`Couldn't delete the transfer. ${parsed.message}`);
        return;
      }
    }
    this.changed.emit();
    // The row that had focus is gone.
    afterNextRender(() => this.focusHeading(), { injector: this.injector });
  }
}
