import {
  afterNextRender,
  Component,
  computed,
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
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { Amount } from '../../shared/ui/amount';
import { AsyncSection } from '../../shared/ui/async-section';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { EmptyState } from '../../shared/ui/states';
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
 * gave and who got, the amount and the note, with a menu to delete. A transfer is never edited, so
 * there is no edit: it is deleted and entered again. Names come from the budget list, which holds
 * budgets of every status; a side that is `null` is the unallocated pool of the month.
 *
 * Deleting asks first, and says what it does. A transfer in a closed month rewrites that month, so
 * the question says so in the words of the dialog that creates one. The page reloads what it shows
 * (`changed`) after a delete.
 */
@Component({
  selector: 'app-transfers-section',
  imports: [ActionMenu, Amount, AppList, AsyncSection, Button, EmptyState, Icon, ListRow, MenuItem],
  template: `
    <app-async-section
      [heading]="'Money moved in ' + monthLabel()"
      description="Money planned between budgets, or to and from what is unallocated."
      focusable
      [state]="state()"
      [error]="error()"
      loadingLabel="Loading the money moved…"
      errorTitle="Couldn't load the money moved"
      (retry)="retry.emit()"
    >
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
        <ul appList>
          @for (row of rows(); track row.transfer.id) {
            <li appListRow>
              <span rowTitle>
                <span class="sr-only">From </span>{{ row.from }}
                <app-icon name="arrow-right" class="align-text-bottom" /><span class="sr-only">
                  to
                </span>
                {{ row.to }}
              </span>
              <p rowMeta>
                <span>
                  {{ row.date }}
                  @if (row.transfer.note) {
                    · {{ row.transfer.note }}
                  }
                </span>
              </p>
              <app-amount rowAmount [cents]="row.transfer.amount" />
              <app-action-menu rowActions [label]="'More actions for transfer of ' + row.label">
                <button appMenuItem destructive (click)="remove(row)">
                  <app-icon name="trash" />
                  Delete
                </button>
              </app-action-menu>
            </li>
          }
        </ul>
      }
    </app-async-section>
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
  private readonly section = viewChild.required(AsyncSection);

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
    this.section().focusHeading();
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
