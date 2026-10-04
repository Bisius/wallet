import { Component, inject } from '@angular/core';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { BudgetSummary } from '../budgets/budget-summary';
import { DashboardData } from './dashboard-data';

/**
 * This month at a glance: income, spent and unallocated as the big figures, fixed costs and budgeted
 * beside them, the status of the month in words (closed, current, projection) and the
 * over-allocation warning. It is the same strip the Budgets page shows (`BudgetSummary`), with every
 * figure, so the two never disagree.
 */
@Component({
  selector: 'app-glance-section',
  imports: [BudgetSummary, ErrorState, LoadingState],
  template: `
    @switch (data.viewState()) {
      @case ('loading') {
        <app-loading-state label="Loading this month's figures…" />
      }
      @case ('error') {
        <app-error-state
          title="Couldn't load this month's figures"
          [error]="data.view.error()"
          (retry)="data.view.reload()"
        />
      }
      @default {
        @if (data.monthView(); as view) {
          <app-budget-summary [view]="view" [monthLabel]="data.monthLabel()" layout="full" />
        }
      }
    }
  `,
  host: { class: 'block' },
})
export class GlanceSection {
  protected readonly data = inject(DashboardData);
}
