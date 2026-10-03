import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SavingsStore } from '../../core/savings.store';
import { SelectedMonth } from '../../core/selected-month';
import { Amount } from '../../shared/ui/amount';
import { Icon } from '../../shared/ui/icon';
import { DashboardCard } from './dashboard-card';

/**
 * How many closed months wait to be moved to savings, and the signed total (positive: money to move,
 * negative: money to take from savings), with a link to the Savings page where they are settled. When
 * none is waiting it says so. The figures are `SavingsDto.outstanding` and `outstandingTotal` from the
 * API, through the store that also feeds the badge on the navigation. It is not about the month the
 * switcher selects: it covers every closed month.
 */
@Component({
  selector: 'app-savings-to-move-section',
  imports: [Amount, DashboardCard, Icon, RouterLink],
  template: `
    <app-dashboard-card
      title="Savings to move"
      description="Closed months waiting to be moved to savings, whichever month you are looking at."
      [state]="savings.state()"
      [error]="savings.error()"
      loadingLabel="Loading the savings to move…"
      errorTitle="Couldn't load the savings to move"
      (retry)="savings.reload()"
    >
      <a
        cardAction
        routerLink="/savings"
        [queryParams]="selected.linkParams()"
        class="inline-flex min-h-9 items-center gap-1 rounded-control px-3 py-1.5 text-sm font-semibold text-accent hover:bg-subtle"
      >
        Open savings
        <app-icon name="chevron-right" />
      </a>

      @if (savings.savings()) {
        @if (count() === 0) {
          <p class="flex items-center gap-2 font-semibold">
            <app-icon name="check-circle" class="text-positive" />
            All settled
          </p>
          <p class="mt-1 text-sm text-muted">
            Every closed month has been moved to savings. A month shows up here once it closes with
            money left over, or short.
          </p>
        } @else {
          <p class="text-2xl font-semibold">
            <app-amount [cents]="savings.outstandingTotal()" [signed]="true" plain />
          </p>
          <p class="mt-1 text-sm text-muted">
            {{ count() }} {{ count() === 1 ? 'month' : 'months' }} to settle.
            {{ advice() }}
          </p>
        }
      }
    </app-dashboard-card>
  `,
  host: { class: 'block' },
})
export class SavingsToMoveSection {
  protected readonly savings = inject(SavingsStore);
  protected readonly selected = inject(SelectedMonth);

  protected readonly count = this.savings.outstandingCount;

  /** What the sign of the total asks for. */
  protected readonly advice = computed(() => {
    const total = this.savings.outstandingTotal();
    if (total > 0) return 'Move this to savings.';
    if (total < 0) return 'Take this from savings.';
    return 'They cancel each other out.';
  });
}
