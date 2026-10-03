import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  output,
  viewChild,
} from '@angular/core';
import type { SavingsTransactionKind } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { formatMoney } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { SavingsData, UNASSIGNED_LABEL } from './savings-data';
import { type PlaceFilter, SavingsApi } from './savings.api';
import { Settlement } from './settlement';
import {
  canDelete,
  describeEntry,
  type EntryText,
  groupTransactions,
  type HistoryEntry,
} from './transaction-entries';

/** An entry with its words, ready to show. */
interface EntryView {
  entry: HistoryEntry;
  text: EntryText;
  /** The date as the user reads it. */
  date: string;
  /** What the entry is called to a screen reader: "Deposit to Holiday, Oct 2, 2026". */
  label: string;
  deletable: boolean;
}

/** The kinds a history can be limited to, in the words of the filter. */
const KIND_CHOICES: readonly { value: SavingsTransactionKind | ''; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'settlement', label: 'Month settlements' },
  { value: 'deposit', label: 'Deposits' },
  { value: 'withdrawal', label: 'Withdrawals' },
  { value: 'reallocation', label: 'Reallocations' },
  { value: 'opening', label: 'Opening balance' },
];

/**
 * The savings history, newest first: every settlement, deposit, withdrawal and reallocation, with
 * "Load more" and filters by goal (or unassigned savings) and by kind. The rows are the API's; this
 * only puts the rows that belong together back as one entry (the two sides of a reallocation, the
 * allocations of a settlement) and says what each one is.
 *
 * What can be done with an entry follows the API: a deposit, a withdrawal and a reallocation can be
 * deleted, a settlement is undone for its whole month, and the opening balance is edited.
 */
@Component({
  selector: 'app-transaction-history',
  imports: [Amount, AppInput, Button, EmptyState, ErrorState, Field, Icon, LoadingState],
  templateUrl: './transaction-history.html',
  host: { class: 'block' },
})
export class TransactionHistory {
  protected readonly data = inject(SavingsData);
  private readonly api = inject(SavingsApi);
  private readonly settlement = inject(Settlement);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The user wants to change the opening balance (its entry offers it). */
  readonly editOpening = output<void>();

  protected readonly kindChoices = KIND_CHOICES;
  protected readonly unassignedLabel = UNASSIGNED_LABEL;

  /** Every goal, archived ones included: they hold rows too. */
  protected readonly goals = computed(() => this.data.savings()?.goals ?? []);

  protected readonly views = computed<EntryView[]>(() => {
    const locale = this.settings.locale();
    const currency = this.settings.currency();
    const context = {
      place: (goalId: number | null) => this.data.placeName(goalId),
      money: (cents: number) => formatMoney(cents, locale, currency),
      month: (month: string) => formatMonth(month, locale),
    };
    return groupTransactions(this.data.rows()).map((entry) => {
      const text = describeEntry(entry, context);
      const date = formatDate(entry.date, locale, 'medium');
      return { entry, text, date, label: `${text.title}, ${date}`, deletable: canDelete(entry) };
    });
  });

  protected onPlaceChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const place: PlaceFilter =
      value === 'all' ? 'all' : value === 'unassigned' ? 'unassigned' : Number(value);
    this.data.setFilter({ ...this.data.filter(), place });
  }

  protected onKindChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.data.setFilter({
      ...this.data.filter(),
      kind: value === '' ? null : (value as SavingsTransactionKind),
    });
  }

  protected clearFilters(): void {
    this.data.setFilter({ place: 'all', kind: null });
  }

  protected async loadMore(): Promise<void> {
    await this.data.loadMore();
    // The button that had focus leaves with the last page: keep the keyboard in the list.
    if (!this.data.hasMore() && !this.data.moreError()) this.focusHeading();
  }

  protected async remove(view: EntryView): Promise<void> {
    const { entry, text } = view;
    const consequence =
      entry.kind === 'reallocation'
        ? 'Both of its entries are removed and the money is back where it was.'
        : entry.kind === 'deposit'
          ? 'The money is taken out again. A deletion is not limited by the balance, so it can leave it below zero.'
          : 'The money goes back where it was taken from.';
    const confirmed = await this.confirm.confirm({
      title: 'Delete this entry?',
      message: `${view.label}${text.amount === null ? '' : ` (${formatMoney(text.amount, this.settings.locale(), this.settings.currency())})`}. ${consequence}`,
      confirmLabel: 'Delete entry',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      // Whichever row's id is given, a reallocation is deleted with both of its rows.
      await firstValueFrom(this.api.removeTransaction(entry.rows[0].id));
      this.toast.success('Entry deleted.');
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'not_found') this.toast.info('That entry was already gone.');
      else this.toast.error(`Couldn't delete the entry. ${parsed.message}`);
    }
    await this.data.reload();
    // The row that had focus is gone.
    this.focusHeading();
  }

  protected async undoSettlement(view: EntryView): Promise<void> {
    const month = view.entry.settlesMonth;
    if (!month) return;
    const label = this.settlement.monthLabel(month);
    const confirmed = await this.confirm.confirm({
      title: `Undo the settlement of ${label}?`,
      message:
        `Every settlement recorded for ${label} is removed, and the month goes back to the Move to savings list ` +
        `with its full amount. Your savings balance goes back to what it was before the month was settled.`,
      confirmLabel: 'Undo settlement',
      tone: 'danger',
    });
    if (!confirmed) return;

    await this.settlement.undo(month);
    this.focusHeading();
  }

  private focusHeading(): void {
    afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
  }
}
