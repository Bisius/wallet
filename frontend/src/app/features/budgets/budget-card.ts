import { Component, computed, inject, input, output } from '@angular/core';
import type { BudgetDto, MonthBudgetLine, MonthKey, MonthStatus } from '@wallet/shared';
import { addMonths } from '@wallet/shared/month';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { BudgetUsage } from './budget-usage';

const BADGE = 'rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium';

/**
 * One budget in one month: what is available, spent and left, how far along it is (`BudgetUsage`:
 * the bar and the words come from `usagePercent` and `alert`), what carried in, and what happens at
 * month end.
 *
 * It only shows the figures of the month view. The rollover, the alert state and the savings amount
 * are the API's; nothing here is calculated. The actions (edit, archive, delete, move) show when the
 * `budget` is known, and they are only requests: the page does the work.
 */
@Component({
  selector: 'app-budget-card',
  imports: [Amount, BudgetUsage, Button, Icon],
  templateUrl: './budget-card.html',
  host: { class: 'block' },
})
export class BudgetCard {
  private readonly settings = inject(SettingsStore);

  /** The month's figures for this budget (`MonthView.budgets[]`). */
  readonly line = input.required<MonthBudgetLine>();
  /** The month the figures are for. */
  readonly month = input.required<MonthKey>();
  /** Whether that month is closed, current or a projection. */
  readonly status = input.required<MonthStatus>();
  /** The budget itself (`GET /api/budgets`). Without it the card shows figures only. */
  readonly budget = input<BudgetDto>();
  readonly canMoveUp = input(false);
  readonly canMoveDown = input(false);
  /** A reorder is being saved: moving again would race it. */
  readonly busy = input(false);

  readonly edit = output<void>();
  readonly archive = output<void>();
  readonly remove = output<void>();
  readonly moveUp = output<void>();
  readonly moveDown = output<void>();

  protected readonly badge = BADGE;
  protected readonly nameId = computed(() => `budget-name-${this.line().id}`);

  protected readonly previousMonthLabel = computed(() =>
    formatMonth(addMonths(this.month(), -1), this.settings.locale()),
  );
  protected readonly nextMonthLabel = computed(() =>
    formatMonth(addMonths(this.month(), 1), this.settings.locale()),
  );

  /** The budget has an end month. An archived budget is still active until that month is over. */
  protected readonly endLabel = computed(() => {
    const end = this.budget()?.endMonth;
    if (!end) return null;
    const label = formatMonth(end, this.settings.locale(), 'short');
    return this.budget()?.status === 'ended' ? `Ended ${label}` : `Ends ${label}`;
  });
  protected readonly startsLabel = computed(() => {
    const budget = this.budget();
    if (budget?.status !== 'upcoming') return null;
    return `Starts ${formatMonth(budget.startMonth, this.settings.locale(), 'short')}`;
  });

  /**
   * What the budget did (closed month) or is projected to do (current and future ones) when the
   * month ends. `carriedOut` and `toSavings` are the API's own figures.
   */
  protected readonly outcome = computed(() => {
    const { carriedOut, toSavings } = this.line();
    const items: { kind: 'carried' | 'saved' | 'taken'; cents: number }[] = [];
    if (carriedOut !== 0) items.push({ kind: 'carried', cents: carriedOut });
    if (toSavings > 0) items.push({ kind: 'saved', cents: toSavings });
    if (toSavings < 0) items.push({ kind: 'taken', cents: -toSavings });
    return items;
  });

  /** Only a budget that is not archived yet, and has started, can be archived. */
  protected readonly canArchive = computed(() => {
    const budget = this.budget();
    return budget !== undefined && budget.endMonth === null && budget.status === 'active';
  });

  protected move(direction: 'up' | 'down'): void {
    if (this.busy()) return;
    if (direction === 'up' && this.canMoveUp()) this.moveUp.emit();
    if (direction === 'down' && this.canMoveDown()) this.moveDown.emit();
  }
}
