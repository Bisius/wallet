import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MonthBudgetLine, MonthKey, SpendingDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { formatMoney, MoneyPipe } from '../../shared/money.pipe';
import { PageHeader } from '../../shared/page-header';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { MonthStatusBadge } from '../../shared/ui/month-status';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { ALERT_LABELS } from '../budgets/budget-utils';
import { MonthsApi } from '../months/months.api';
import { groupByDay } from './group-by-day';
import { SpendingEditDialog } from './spending-edit-dialog';
import { SpendingForm } from './spending-form';
import { SpendingsApi, type SpendingsFilter } from './spendings.api';

/** What was just added, for the confirmation under the form. */
interface Added {
  budgetId: number;
  amount: number;
}

/** Rows that "Load more" added to the first page, for the filter they belong to. */
interface Extras {
  key: string;
  items: SpendingDto[];
}

const NO_EXTRAS: Extras = { key: '', items: [] };

const keyOf = (filter: SpendingsFilter | undefined) =>
  filter ? `${filter.month}|${filter.budgetId ?? ''}` : '';

/**
 * The spendings of the selected month: a quick form to add one, and the month's list grouped by
 * day, newest first, with a budget filter and "Load more". The budgets in the form and the figures
 * in the confirmation come from the month view (`GET /api/months/:month`); nothing is calculated
 * here.
 */
@Component({
  selector: 'app-spendings-page',
  imports: [
    RouterLink,
    PageHeader,
    Field,
    AppInput,
    Button,
    Icon,
    Amount,
    MoneyPipe,
    MonthStatusBadge,
    EmptyState,
    ErrorState,
    LoadingState,
    SpendingForm,
    SpendingEditDialog,
  ],
  templateUrl: './spendings-page.html',
})
export class SpendingsPage {
  private readonly api = inject(SpendingsApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly selected = inject(SelectedMonth);
  protected readonly month = this.selected.month;

  // Resources belong to the page: each visit loads fresh data.
  protected readonly view = inject(MonthsApi).view(this.month);

  /** The budget the person chose to limit the list to, and the month it was chosen in. */
  private readonly choice = signal<{ month: MonthKey; budgetId: number } | null>(null);
  /** The budget the list is limited to, or `null` for all of them: another month starts over. */
  protected readonly budgetFilter = computed(() => {
    const choice = this.choice();
    return choice && choice.month === this.month() ? choice.budgetId : null;
  });
  private readonly filter = computed<SpendingsFilter | undefined>(() => {
    const month = this.month();
    return month ? { month, budgetId: this.budgetFilter() } : undefined;
  });
  protected readonly first = this.api.firstPage(this.filter);
  protected readonly firstState = resourceState(this.first);
  protected readonly viewState = resourceState(this.view);

  private readonly extras = signal<Extras>(NO_EXTRAS);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal<string | null>(null);

  /** The spending being edited in the dialog. */
  protected readonly editing = signal<SpendingDto | null>(null);
  protected readonly added = signal<Added | null>(null);

  protected readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  /** The budgets that exist in the shown month: the choices of the form and the filter. */
  protected readonly lines = computed<readonly MonthBudgetLine[]>(
    () => this.monthView()?.budgets ?? [],
  );

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** Every row loaded so far: the first page, then what "Load more" added. */
  protected readonly items = computed<readonly SpendingDto[]>(() => {
    const head = this.first.hasValue() ? this.first.value().items : [];
    const extras = this.extras();
    return extras.key === keyOf(this.filter()) ? [...head, ...extras.items] : head;
  });
  protected readonly groups = computed(() => groupByDay(this.items()));
  /** How many rows match the filter, and their net total: the API counts all of them. */
  protected readonly total = computed(() => (this.first.hasValue() ? this.first.value().total : 0));
  protected readonly totalAmount = computed(() =>
    this.first.hasValue() ? this.first.value().totalAmount : 0,
  );
  protected readonly hasMore = computed(() => this.items().length < this.total());

  protected readonly filterName = computed(
    () => this.lines().find((line) => line.id === this.budgetFilter())?.name,
  );

  /**
   * What was just added, in a sentence or two, with the budget's figures as the month view reports
   * them (nothing here is calculated: only the sign is turned around to say "over budget by").
   */
  protected readonly confirmation = computed(() => {
    const added = this.added();
    if (!added) return null;
    const line = this.lines().find((candidate) => candidate.id === added.budgetId);
    const money = (cents: number) =>
      formatMoney(cents, this.settings.locale(), this.settings.currency());
    const name = line?.name ?? 'the budget';

    const parts = [
      added.amount < 0
        ? `Refund of ${money(-added.amount)} added to ${name}.`
        : `Added ${money(added.amount)} to ${name}.`,
    ];
    if (line && line.remaining < 0) {
      const used = line.usagePercent === null ? '' : ` (${line.usagePercent}% used)`;
      parts.push(`Over budget by ${money(-line.remaining)}${used}.`);
    } else if (line) {
      parts.push(`${money(line.remaining)} left of ${money(line.available)}.`);
      if (line.alert === 'warning' && line.usagePercent !== null) {
        parts.push(`${ALERT_LABELS.warning}: ${line.usagePercent}% used.`);
      }
    }
    return parts.join(' ');
  });

  constructor() {
    // Another month is another list: forget the failure of "Load more" and the confirmation. (The
    // filter and the extra rows are tied to their month, so they need no reset.)
    effect(() => {
      this.month();
      untracked(() => {
        this.moreError.set(null);
        this.added.set(null);
      });
    });
  }

  protected dateLabel(date: string): string {
    return formatDate(date, this.settings.locale(), 'full');
  }

  protected budgetOf(id: number): MonthBudgetLine | undefined {
    return this.lines().find((line) => line.id === id);
  }

  /** What a row is called to a screen reader: "Coffee, €3.50". */
  protected rowLabel(spending: SpendingDto): string {
    const money = formatMoney(spending.amount, this.settings.locale(), this.settings.currency());
    return `${spending.description || 'Spending'}, ${money}`;
  }

  protected onFilterChange(event: Event): void {
    this.setFilter((event.target as HTMLSelectElement).value);
  }

  protected setFilter(value: string): void {
    const month = this.month();
    this.choice.set(value === '' || !month ? null : { month, budgetId: Number(value) });
    this.extras.set(NO_EXTRAS);
    this.moreError.set(null);
  }

  /** Something changed on the server: load the list from its first page again, and the month view. */
  protected async reload(): Promise<void> {
    this.extras.set(NO_EXTRAS);
    this.moreError.set(null);
    await Promise.all([reloaded(this.first, this.injector), reloaded(this.view, this.injector)]);
  }

  protected async onAdded(spending: SpendingDto): Promise<void> {
    this.added.set(null);
    await this.reload();
    // Said after the month view has reloaded, so the budget's figures are the fresh ones.
    this.added.set({ budgetId: spending.budgetId, amount: spending.amount });
  }

  protected async onEdited(): Promise<void> {
    this.editing.set(null);
    this.toast.success('Spending updated.');
    await this.reload();
  }

  protected async remove(spending: SpendingDto): Promise<void> {
    const budget = this.budgetOf(spending.budgetId);
    const label = this.rowLabel(spending);
    const confirmed = await this.confirm.confirm({
      title: 'Delete this spending?',
      message:
        `${label} on ${this.dateLabel(spending.date)} will be removed` +
        (budget ? ` from ${budget.name}.` : '.') +
        ' It no longer counts towards the budget.',
      confirmLabel: 'Delete spending',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(spending.id));
      this.toast.success('Spending deleted.');
      this.added.set(null);
      await this.reload();
      // The row that had focus is gone.
      this.focus(() => this.heading()?.nativeElement ?? null);
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }

  protected async loadMore(): Promise<void> {
    const filter = this.filter();
    if (!filter || this.loadingMore()) return;
    const key = keyOf(filter);

    this.loadingMore.set(true);
    this.moreError.set(null);
    try {
      const page = await firstValueFrom(this.api.pageAt(filter, this.items().length));
      // The filter or the month changed while the page was coming: it is not for this list.
      if (keyOf(this.filter()) !== key) return;
      if (page.items.length === 0) {
        // The list got shorter on the server since it was loaded: start again.
        await this.reload();
        return;
      }
      this.extras.update((extras) => ({
        key,
        items: [...(extras.key === key ? extras.items : []), ...page.items],
      }));
      // The button that had focus leaves with the last page: keep the keyboard in the list.
      if (!this.hasMore()) this.focus(() => this.heading()?.nativeElement ?? null);
    } catch (error) {
      this.moreError.set(parseApiError(error).message);
    } finally {
      this.loadingMore.set(false);
    }
  }

  private focus(find: () => HTMLElement | null): void {
    afterNextRender(() => find()?.focus(), { injector: this.injector });
  }
}
