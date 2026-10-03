import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Cents, MonthBudgetLine, MonthKey, SpendingDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SavingsStore } from '../../core/savings.store';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { TagsStore } from '../../core/tags.store';
import { TodayStore } from '../../core/today.store';
import { formatDate, formatMonth } from '../../shared/format';
import { formatMoney, MoneyPipe } from '../../shared/money.pipe';
import { PageHeader } from '../../shared/page-header';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { MonthStatusBadge } from '../../shared/ui/month-status';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { TagChip } from '../../shared/ui/tag-chip';
import { ToastService } from '../../shared/ui/toast.service';
import { BudgetsApi } from '../budgets/budgets.api';
import { ALERT_LABELS } from '../budgets/budget-utils';
import { MonthsApi } from '../months/months.api';
import { groupByDay } from './group-by-day';
import { SpendingEditDialog } from './spending-edit-dialog';
import { type BudgetOption, SpendingFilterBar } from './spending-filter-bar';
import { filtersProblem, narrowingCount } from './spending-filters';
import { SpendingForm } from './spending-form';
import { SpendingQuery } from './spending-query';
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

/** A list as the page shows it: its rows, and how many match and their net total (the API's own). */
interface Shown {
  /** The month it is for, null for every month. */
  scope: MonthKey | null;
  items: readonly SpendingDto[];
  total: number;
  totalAmount: Cents;
}

const keyOf = (filter: SpendingsFilter | undefined) =>
  filter
    ? JSON.stringify([
        filter.month,
        filter.budgetId,
        filter.tagId,
        filter.q,
        filter.minAmount,
        filter.maxAmount,
      ])
    : '';

/** What the list says when it has no rows. */
type EmptyKind = 'budget' | 'filtered' | 'nowhere' | 'month';

/**
 * How rows look while they are the previous search's. Dimmed and washed out, but only a little: text
 * that fades much further than this falls below the 4.5:1 contrast the page has everywhere else (the
 * green of a refund is the first to go, at about 85%). The delay keeps a quick answer from making the
 * rows flicker: the dimming only starts if the answer takes longer than that.
 */
const STALE_LOOK = 'opacity-90 saturate-50 delay-200';

/**
 * The spendings: a quick form to add one, and a list, newest first and grouped by day, that can be
 * searched and filtered (text, budget, tag, a range of amounts) in the selected month or in every
 * month, with "Load more". The filters are in the URL (`SpendingQuery`), so they survive a reload and
 * the Back button. The budgets in the form and the figures in the confirmation come from the month
 * view (`GET /api/months/:month`); the count and the net total of the list are the API's, over every
 * row that matches. Nothing is calculated here.
 */
@Component({
  selector: 'app-spendings-page',
  imports: [
    RouterLink,
    PageHeader,
    Button,
    Icon,
    Amount,
    MoneyPipe,
    MonthStatusBadge,
    EmptyState,
    ErrorState,
    LoadingState,
    TagChip,
    SpendingForm,
    SpendingEditDialog,
    SpendingFilterBar,
  ],
  providers: [SpendingQuery],
  templateUrl: './spendings-page.html',
})
export class SpendingsPage {
  private readonly api = inject(SpendingsApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly today = inject(TodayStore);
  private readonly query = inject(SpendingQuery);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly selected = inject(SelectedMonth);
  protected readonly month = this.selected.month;
  protected readonly tags = inject(TagsStore);

  // Resources belong to the page: each visit loads fresh data.
  private readonly monthsApi = inject(MonthsApi);
  protected readonly view = this.monthsApi.view(this.month);

  protected readonly filters = this.query.filters;
  /** Why the filters are not sent (the API would refuse them), or null. */
  protected readonly problem = computed(() => filtersProblem(this.filters()));

  private readonly filter = computed<SpendingsFilter | undefined>(
    () => {
      const filters = this.filters();
      if (filtersProblem(filters) !== null) return undefined;
      // Searching every month sends no date at all, and does not follow the month switcher.
      const month = filters.allMonths ? null : this.month();
      if (month === undefined) return undefined;
      const { q, budgetId, tagId, minAmount, maxAmount } = filters;
      return { month, q, budgetId, tagId, minAmount, maxAmount };
    },
    { equal: (a, b) => keyOf(a) === keyOf(b) },
  );
  protected readonly first = this.api.firstPage(this.filter);
  protected readonly firstState = resourceState(this.first);
  protected readonly viewState = resourceState(this.view);

  private readonly extras = signal<Extras>(NO_EXTRAS);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal<string | null>(null);

  /** The spending being edited in the dialog. */
  protected readonly editing = signal<SpendingDto | null>(null);
  /** The month it is dated in. Searching every month lists spendings of any month. */
  protected readonly editMonth = computed(() => this.editing()?.date.slice(0, 7));
  /** The view of that month, when it is not the one on show (the form offers that month's budgets). */
  private readonly otherView = this.monthsApi.view(() => {
    const month = this.editMonth();
    return month !== undefined && month !== this.month() ? month : undefined;
  });
  /**
   * The budgets the edit form offers: those of the month the spending is dated in, so its date and
   * its budget are what they were unless the person changes them. undefined while that month loads.
   */
  protected readonly editLines = computed<readonly MonthBudgetLine[] | undefined>(() => {
    const month = this.editMonth();
    if (month === undefined) return undefined;
    if (month === this.month()) return this.lines();
    return this.otherView.hasValue() ? this.otherView.value().budgets : undefined;
  });
  protected readonly added = signal<Added | null>(null);

  protected readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  /** The budgets that exist in the shown month: the choices of the form. */
  protected readonly lines = computed<readonly MonthBudgetLine[]>(
    () => this.monthView()?.budgets ?? [],
  );

  /**
   * Every budget, once it is needed: when searching every month (a spending can belong to a budget
   * that has ended), or when the URL names a budget the shown month does not have.
   */
  private readonly budgetList = inject(BudgetsApi).list(() => {
    const { allMonths, budgetId } = this.filters();
    if (allMonths) return true;
    return (
      budgetId !== null &&
      this.monthView() !== undefined &&
      !this.lines().some((line) => line.id === budgetId)
    );
  });

  /** What a row calls its budget: the month's lines, then the full list. */
  private readonly budgetNames = computed(() => {
    const names = new Map<number, { name: string; color: string | null }>();
    if (this.budgetList.hasValue()) {
      for (const budget of this.budgetList.value()) {
        names.set(budget.id, { name: budget.name, color: budget.color });
      }
    }
    for (const line of this.lines()) names.set(line.id, { name: line.name, color: line.color });
    return names;
  });

  /** The choices of the budget filter: this month's budgets, or all of them when searching every month. */
  protected readonly budgetOptions = computed<readonly BudgetOption[]>(() => {
    const { allMonths, budgetId } = this.filters();
    const options: BudgetOption[] = allMonths
      ? (this.budgetList.hasValue() ? this.budgetList.value() : []).map((budget) => ({
          id: budget.id,
          name: budget.name,
        }))
      : this.lines().map((line) => ({ id: line.id, name: line.name }));
    // The budget the URL names stays on offer, so the filter can be seen and removed.
    if (budgetId !== null && !options.some((option) => option.id === budgetId)) {
      options.push({
        id: budgetId,
        name: this.budgetNames().get(budgetId)?.name ?? `Budget ${budgetId}`,
      });
    }
    return options;
  });

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });
  /** The page's subtitle: what the page is for, and which month it shows. */
  protected readonly subtitle = computed(() => {
    const month = this.monthLabel();
    if (!month) return '';
    return this.filters().allMonths
      ? 'Every expense, linked to a budget, in every month. The form adds to ' + month + '.'
      : 'Every expense, linked to a budget, for ' + month + '.';
  });
  /** What the list covers, for its heading: "October 2026", or "all months". */
  protected readonly scopeLabel = computed(() =>
    this.filters().allMonths ? 'all months' : this.monthLabel(),
  );

  /**
   * The list of the filter on show, once its first page is in: every row loaded so far (the first page,
   * then what "Load more" added), how many rows match and their net total, as the API counts them.
   */
  private readonly current = computed<Shown | undefined>(() => {
    const filter = this.filter();
    if (filter === undefined || !this.first.hasValue()) return undefined;
    const page = this.first.value();
    const extras = this.extras();
    return {
      scope: filter.month,
      items: extras.key === keyOf(filter) ? [...page.items, ...extras.items] : page.items,
      total: page.total,
      totalAmount: page.totalAmount,
    };
  });
  /** The last list that was complete: what stays on screen while the next one loads. */
  private readonly settled = linkedSignal<Shown | undefined, Shown | undefined>({
    source: this.current,
    computation: (current, previous) => current ?? previous?.value,
  });
  /**
   * The list on screen. A new search or filter does not blank the page with "Loading…" on every
   * keystroke: the previous rows stay (dimmed, and marked busy) until the new first page arrives. That
   * is only for the same month or scope and for a list that has rows; another month, an empty list or
   * a failure shows what it always did.
   */
  protected readonly shown = computed<Shown | undefined>(() => {
    // Read first, always: a linked signal only has a previous value once it has computed one, and it
    // computes when it is read, so this is what keeps the last complete list while the next one loads.
    const kept = this.settled();
    const current = this.current();
    if (current !== undefined) return current;
    const filter = this.filter();
    if (kept === undefined || filter === undefined || this.first.status() === 'error') {
      return undefined;
    }
    return kept.scope === filter.month && kept.items.length > 0 ? kept : undefined;
  });
  /** What the list is: loading, failed, or there (a list that is only the previous one counts as there). */
  protected readonly listState = computed(() =>
    this.shown() === undefined ? this.firstState() : 'ready',
  );
  protected readonly staleLook = STALE_LOOK;
  /** The rows on screen are the previous search's: the new first page is on its way. */
  protected readonly refreshing = computed(
    () => this.current() === undefined && this.shown() !== undefined,
  );
  protected readonly items = computed<readonly SpendingDto[]>(() => this.shown()?.items ?? []);
  protected readonly groups = computed(() => groupByDay(this.items()));
  /** How many rows match the filters, and their net total: the API counts all of them. */
  protected readonly total = computed(() => this.shown()?.total ?? 0);
  protected readonly totalAmount = computed(() => this.shown()?.totalAmount ?? 0);
  /** There are more rows to load. Not while the rows are the previous search's: they are not this list's. */
  protected readonly hasMore = computed(
    () => !this.refreshing() && this.items().length < this.total(),
  );

  /** The budget the list is limited to, by name. */
  protected readonly filterName = computed(() => {
    const { budgetId } = this.filters();
    return budgetId === null ? undefined : this.budgetNames().get(budgetId)?.name;
  });

  /** Which empty state fits: one budget, other filters, or no filter at all. */
  protected readonly emptyKind = computed<EmptyKind>(() => {
    const filters = this.filters();
    const narrowing = narrowingCount(filters);
    if (narrowing === 1 && filters.budgetId !== null && !filters.allMonths) return 'budget';
    if (narrowing > 0) return 'filtered';
    return filters.allMonths ? 'nowhere' : 'month';
  });

  /** The server refused the filters (a 400): what it said, instead of a bare error. */
  protected readonly refusal = computed(() => {
    const error = this.first.error();
    if (!(error instanceof HttpErrorResponse) || error.status !== 400) return null;
    const parsed = parseApiError(error);
    const reasons = Object.values(parsed.fieldErrors);
    return reasons.length > 0 ? reasons.join(' ') : parsed.message;
  });

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
    // Another month is another list: forget the confirmation of the last spending added.
    effect(() => {
      this.month();
      untracked(() => this.added.set(null));
    });
    // The month of a spending to edit could not be loaded: say so instead of doing nothing.
    effect(() => {
      if (this.otherView.status() !== 'error') return;
      untracked(() => {
        const month = this.editMonth();
        const label = month ? formatMonth(month, this.settings.locale()) : 'that month';
        this.toast.error(
          `Couldn't load ${label} to edit this spending. ${parseApiError(this.otherView.error()).message}`,
        );
        this.editing.set(null);
      });
    });
    // So is another filter, or month: forget the failure of "Load more" and the rows it added, which
    // belong to the list they were loaded for.
    effect(() => {
      this.filter();
      untracked(() => {
        this.moreError.set(null);
        this.extras.set(NO_EXTRAS);
      });
    });
  }

  protected dateLabel(date: string): string {
    return formatDate(date, this.settings.locale(), 'full');
  }

  /** The name and color of a budget, as the shown month (or the full budget list) knows it. */
  protected budgetOf(id: number): { name: string; color: string | null } | undefined {
    return this.budgetNames().get(id);
  }

  /** The tags of a row that the list knows. A tag it does not know (yet) is left out. */
  protected tagsOf(spending: SpendingDto) {
    const known = this.tags.byId();
    return spending.tagIds.flatMap((id) => {
      const tag = known.get(id);
      return tag ? [tag] : [];
    });
  }

  /** What a row is called: "Coffee, €3.50". */
  private rowText(spending: SpendingDto): string {
    const money = formatMoney(spending.amount, this.settings.locale(), this.settings.currency());
    return `${spending.description || 'Spending'}, ${money}`;
  }

  /**
   * What a row is called to a screen reader, for its buttons: "Coffee, €3.50". Searching every month
   * lists the same coffee many times over, so then the date tells them apart: "Coffee, €3.50, Oct 2, 2026".
   */
  protected rowLabel(spending: SpendingDto): string {
    const date = formatDate(spending.date, this.settings.locale(), 'medium');
    return this.filters().allMonths ? `${this.rowText(spending)}, ${date}` : this.rowText(spending);
  }

  protected showAllBudgets(): void {
    void this.query.update({ budgetId: null });
  }

  /** Every filter off, and focus on the list heading: the button that was pressed is gone. */
  protected async clearFilters(): Promise<void> {
    await this.query.clear();
    this.focus(() => this.heading()?.nativeElement ?? null);
  }

  /** Something changed on the server: load the list from its first page again, and the month view. */
  protected async reload(): Promise<void> {
    this.extras.set(NO_EXTRAS);
    this.moreError.set(null);
    await Promise.all([reloaded(this.first, this.injector), reloaded(this.view, this.injector)]);
  }

  protected async onAdded(spending: SpendingDto): Promise<void> {
    this.added.set(null);
    this.refreshSavingsFor(spending.date);
    await this.reload();
    // Said after the month view has reloaded, so the budget's figures are the fresh ones.
    this.added.set({ budgetId: spending.budgetId, amount: spending.amount });
  }

  protected async onEdited(spending: SpendingDto): Promise<void> {
    const before = this.editing();
    this.editing.set(null);
    this.refreshSavingsFor(spending.date, before?.date);
    this.toast.success('Spending updated.');
    await this.reload();
  }

  /**
   * A spending in a closed month moves what that month owes savings, and the badge on the navigation
   * counts the months to settle. The navigation only looks again when the person moves to another
   * page, so a change made here asks for the overview at once. A spending in the current or a later
   * month cannot change it, and the most common action of the page, adding one today, must not make
   * the server work out the savings for nothing. The overview is looked up only when it is needed.
   */
  private refreshSavingsFor(...dates: readonly (string | undefined)[]): void {
    const current = this.today.month();
    const affected =
      current === undefined ||
      dates.some((date) => date !== undefined && date.slice(0, 7) < current);
    if (affected) this.injector.get(SavingsStore).refresh();
  }

  protected async remove(spending: SpendingDto): Promise<void> {
    const budget = this.budgetOf(spending.budgetId);
    const label = this.rowText(spending);
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
      this.refreshSavingsFor(spending.date);
      await this.reload();
      // The row that had focus is gone.
      this.focus(() => this.heading()?.nativeElement ?? null);
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }

  protected async loadMore(): Promise<void> {
    const filter = this.filter();
    if (!filter || this.loadingMore() || this.refreshing()) return;
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
