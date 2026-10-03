import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import type { BudgetDto, MonthBudgetLine } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatMonth } from '../../shared/format';
import { MoneyPipe } from '../../shared/money.pipe';
import { PageHeader } from '../../shared/page-header';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { MonthsApi } from '../months/months.api';
import { BudgetCard } from './budget-card';
import { BudgetForm } from './budget-form';
import { planSwap } from './budget-order';
import { BudgetSummary } from './budget-summary';
import { BudgetsApi } from './budgets.api';

/** A card: one line of the month view, with the budget behind it once the list has loaded. */
interface Card {
  line: MonthBudgetLine;
  budget: BudgetDto | undefined;
}

/**
 * The budgets of the selected month. The strip and the cards show the month view
 * (`GET /api/months/:month`) exactly as the API computed it. The budget list
 * (`GET /api/budgets`) adds what the cards need to be acted on, and holds the budgets that are not
 * active in this month (upcoming or ended), so they can still be edited or deleted.
 */
@Component({
  selector: 'app-budgets-page',
  imports: [
    PageHeader,
    Button,
    Icon,
    EmptyState,
    ErrorState,
    LoadingState,
    MoneyPipe,
    BudgetSummary,
    BudgetCard,
    BudgetForm,
  ],
  templateUrl: './budgets-page.html',
})
export class BudgetsPage {
  private readonly api = inject(BudgetsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly month = inject(SelectedMonth).month;

  // Resources belong to the page: each visit loads fresh data.
  protected readonly view = inject(MonthsApi).view(this.month);
  protected readonly budgets = this.api.list();

  protected readonly viewState = resourceState(this.view);
  protected readonly budgetsState = resourceState(this.budgets);

  protected readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  private readonly budgetList = computed(() =>
    this.budgets.hasValue() ? this.budgets.value() : undefined,
  );

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** The month's budget lines in the API's order, each with its budget when that is known. */
  protected readonly cards = computed<Card[]>(() => {
    const lines = this.monthView()?.budgets ?? [];
    const byId = new Map((this.budgetList() ?? []).map((budget) => [budget.id, budget]));
    return lines.map((line) => ({ line, budget: byId.get(line.id) }));
  });

  /**
   * The budgets that have no card in the shown month: they start after it or ended before it. For the
   * current month these are exactly the upcoming and ended ones. Listing them keeps every budget
   * within reach, so it can still be edited or deleted.
   */
  protected readonly inactive = computed(() => {
    const shown = new Set(this.cards().map((card) => card.line.id));
    return (this.budgetList() ?? []).filter((budget) => !shown.has(budget.id));
  });

  /** The form dialog: creating (`budget` unset) or editing. `null` while it is closed. */
  protected readonly form = signal<{ budget: BudgetDto | undefined } | null>(null);
  /** A reorder is being saved. */
  protected readonly moving = signal(false);
  /** Said to screen readers after a budget moves, because the card's place is its only signal. */
  protected readonly announcement = signal('');

  protected openCreate(): void {
    this.form.set({ budget: undefined });
  }

  protected openEdit(budget: BudgetDto | undefined): void {
    if (budget) this.form.set({ budget });
  }

  protected closeForm(): void {
    this.form.set(null);
  }

  /** Something changed on the server: load what this page shows again. */
  protected async reload(): Promise<void> {
    await Promise.all([reloaded(this.view, this.injector), reloaded(this.budgets, this.injector)]);
  }

  /** Why a budget has no card in the shown month, in a line: it starts later or ended earlier. */
  protected describe(budget: BudgetDto): string {
    const locale = this.settings.locale();
    const month = this.month();
    if (month && budget.startMonth > month) {
      return `Starts ${formatMonth(budget.startMonth, locale)}`;
    }
    return budget.endMonth
      ? `Ended ${formatMonth(budget.endMonth, locale)}`
      : `Started ${formatMonth(budget.startMonth, locale)}`;
  }

  /** The amount a budget list row mentions: what applies now, or what it starts with. */
  protected version(budget: BudgetDto) {
    return budget.current ?? budget.versions[0];
  }

  protected async archive(budget: BudgetDto | undefined): Promise<void> {
    if (!budget) return;
    const locale = this.settings.locale();
    const current = this.today.month();
    const last = current ? formatMonth(current, locale) : 'this month';
    const confirmed = await this.confirm.confirm({
      title: `Archive "${budget.name}"?`,
      message:
        `It stays active through ${last}, its last month, and is not part of the months after it. ` +
        `Whatever is left in it when ${last} closes is released to savings, or taken from savings if ` +
        `it is overspent. An archived budget can't be reopened.` +
        (budget.hasHistory ? ' It has spendings, so it can only be archived, not deleted.' : ''),
      confirmLabel: 'Archive budget',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.archive(budget.id));
      this.toast.success(`${budget.name} archived.`);
      await this.reload();
      // The Archive button that had focus is gone: go back to the card.
      this.focus(() => this.byAction(`edit-${budget.id}`));
    } catch (error) {
      this.toast.error(parseApiError(error).message);
      await this.reload();
    }
  }

  protected async remove(budget: BudgetDto | undefined): Promise<void> {
    if (!budget) return;
    const confirmed = await this.confirm.confirm({
      title: `Delete "${budget.name}"?`,
      message:
        'It has no spendings or transfers, so nothing else changes. The budget and its amounts ' +
        'are removed from every month. This cannot be undone.',
      confirmLabel: 'Delete budget',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(budget.id));
      this.toast.success(`${budget.name} deleted.`);
      await this.reload();
      // The card that had focus is gone.
      this.focus(() => this.heading()?.nativeElement ?? null);
    } catch (error) {
      // 409 `has_history`: spendings were added since the list was loaded. The message says so.
      this.toast.error(parseApiError(error).message);
      await this.reload();
    }
  }

  /** Moves a card up or down by trading places with its neighbour (`PATCH sortOrder`). */
  protected async move(card: Card, direction: 'up' | 'down'): Promise<void> {
    const list = this.budgetList();
    const cards = this.cards();
    const index = cards.findIndex((other) => other.line.id === card.line.id);
    const neighbour = cards[index + (direction === 'up' ? -1 : 1)];
    if (!list || !neighbour || this.moving()) return;

    const changes = planSwap(list, card.line.id, neighbour.line.id);
    if (changes.length === 0) return;

    this.moving.set(true);
    let saved = false;
    try {
      await Promise.all(
        changes.map((change) =>
          firstValueFrom(this.api.update(change.id, { sortOrder: change.sortOrder })),
        ),
      );
      saved = true;
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
    try {
      await this.reload();
    } finally {
      this.moving.set(false);
    }
    if (!saved) return;

    const now = this.cards();
    const position = now.findIndex((other) => other.line.id === card.line.id) + 1;
    this.announcement.set(
      `${card.line.name} moved ${direction}. It is now number ${position} of ${now.length}.`,
    );
    // The card keeps its identity but may have moved in the page: keep the keyboard where it was.
    this.focus(() => this.byAction(`${direction}-${card.line.id}`));
  }

  private byAction(action: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[data-action="${action}"]`);
  }

  private focus(find: () => HTMLElement | null): void {
    afterNextRender(() => find()?.focus(), { injector: this.injector });
  }
}
