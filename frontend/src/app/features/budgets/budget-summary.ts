import { Component, computed, input } from '@angular/core';
import type { MonthStatus, MonthView } from '@wallet/shared';
import { MoneyPipe } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Icon } from '../../shared/ui/icon';
import { MonthStatusBadge } from '../../shared/ui/month-status';

/** What a month's status means for the figures below it, in a sentence. */
const STATUS_EXPLANATIONS: Record<MonthStatus, string> = {
  closed:
    'This month is over, so its figures are final. Changing something in it now changes what is due to savings.',
  current:
    'This month is still running, so these figures update as you add spendings. What carries over or moves to savings is a projection, as if the month ended today.',
  future:
    'This month has not started yet. These figures are a projection that assumes the current month ends as it stands now.',
};

/**
 * The month at a glance: income, fixed costs, what the budgets add up to and what is left
 * unassigned, plus the status of the month in words. When more is planned than the month earns the
 * strip says so in an alert, and by how much. Every number is a field of the month view.
 *
 * The Dashboard also wants what has been spent so far (`showSpent`), which the Budgets page shows
 * on every card instead.
 */
@Component({
  selector: 'app-budget-summary',
  imports: [Amount, Icon, MoneyPipe, MonthStatusBadge],
  template: `
    <section aria-labelledby="month-summary-heading" class="card space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="month-summary-heading" class="text-lg font-semibold">
          {{ monthLabel() }} at a glance
        </h2>
        <app-month-status [status]="view().status" />
      </div>
      <p class="text-sm text-muted">{{ explanation() }}</p>

      <dl [class]="gridClass()">
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Income</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="view().income.total" /></dd>
        </div>
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Fixed costs</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="view().fixedCosts" /></dd>
        </div>
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Budgeted</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="view().totals.allocated" /></dd>
        </div>
        @if (showSpent()) {
          <div class="rounded-control bg-subtle p-3">
            <dt class="text-sm text-muted">Spent</dt>
            <dd class="text-lg font-semibold"><app-amount [cents]="view().totals.spent" /></dd>
          </div>
        }
        <div class="rounded-control bg-subtle p-3" [class]="lastTileClass()">
          <dt class="text-sm text-muted">Unallocated</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="view().unallocated" /></dd>
          @if (view().overAllocated) {
            <dd class="mt-0.5 flex items-center gap-1 text-sm font-medium text-negative">
              <app-icon name="alert" />
              Over-allocated
            </dd>
          }
        </div>
      </dl>

      @if (view().overAllocated) {
        <div role="alert" class="rounded-card border border-negative bg-negative-soft p-4 text-ink">
          <p class="flex items-center gap-2 font-semibold text-negative">
            <app-icon name="alert" />
            Over-allocated by {{ -view().unallocated | money }}
          </p>
          <p class="mt-1 text-sm">
            @if (view().status === 'closed') {
              Fixed costs and budgets added up to more than this month's income, so that amount is
              taken from savings.
            } @else {
              Fixed costs and budgets add up to more than this month's income. Lower a budget or add
              income, or that amount will be taken from savings when the month closes.
            }
          </p>
        </div>
      }
    </section>
  `,
  host: { class: 'block' },
})
export class BudgetSummary {
  readonly view = input.required<MonthView>();
  /** The month's name, as the page shows it ("October 2026"). */
  readonly monthLabel = input.required<string>();
  /** Also show what has been spent from the budgets (`totals.spent`). */
  readonly showSpent = input(false);

  protected readonly explanation = computed(() => STATUS_EXPLANATIONS[this.view().status]);

  /**
   * On a phone the tiles are a wrapping row: two to a row, and an amount too wide for half the row
   * (a million or more) takes a row of its own instead of pushing the page sideways. From `sm` up
   * they are a grid: four tiles in two columns or four, five (with `spent`) in three or five.
   */
  protected readonly gridClass = computed(() =>
    this.showSpent()
      ? 'flex flex-wrap gap-3 *:grow *:basis-32 sm:grid sm:grid-cols-3 xl:grid-cols-5'
      : 'flex flex-wrap gap-3 *:grow *:basis-32 sm:grid sm:grid-cols-2 lg:grid-cols-4',
  );
  /** With five tiles the last one takes the leftover cell(s) of its row. */
  protected readonly lastTileClass = computed(() =>
    this.showSpent() ? 'col-span-2 xl:col-span-1' : '',
  );
}
