import { Component, computed, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { BarChart, type BarChartRow } from '../../shared/ui/charts/bar-chart';
import { Amount } from '../../shared/ui/amount';
import { EmptyState } from '../../shared/ui/states';

/**
 * Spent per budget over the year: a bar of what was spent over a track of what the budget was given
 * (allocated), with the totals under it. The chart is the shared bar chart, so every row also says
 * its figures in words and the numbers are in its table. Nothing is worked out here.
 */
@Component({
  selector: 'app-report-budgets',
  imports: [Amount, BarChart, EmptyState],
  template: `
    <section aria-labelledby="report-budgets-heading" class="card space-y-4">
      <div>
        <h2 id="report-budgets-heading" class="text-lg font-semibold">Spent per budget</h2>
        <p class="mt-1 text-sm text-muted">
          What each budget was given in {{ report().year }} (allocated) and what was spent from it.
          A bar that runs past its outline spent more than was allocated.
        </p>
      </div>

      @if (rows().length === 0) {
        <app-empty-state
          [title]="'No budgets in ' + report().year"
          description="Budgets you create show up here with what was allocated and spent."
        />
      } @else {
        <app-bar-chart
          [label]="'Spent per budget, ' + report().year"
          [rows]="rows()"
          [slot]="2"
          valueLabel="Spent"
          trackLabel="Allocated"
          nameLabel="Budget"
        />
        <dl class="flex flex-wrap gap-x-8 gap-y-1 border-t border-line pt-3 text-sm">
          <div class="flex gap-2">
            <dt class="text-muted">Total allocated</dt>
            <dd class="font-semibold"><app-amount [cents]="report().allocated" /></dd>
          </div>
          <div class="flex gap-2">
            <dt class="text-muted">Total spent</dt>
            <dd class="font-semibold"><app-amount [cents]="report().spent" /></dd>
          </div>
        </dl>
      }
    </section>
  `,
  host: { class: 'block' },
})
export class ReportBudgets {
  readonly report = input.required<YearlyReportDto>();

  protected readonly rows = computed<BarChartRow[]>(() =>
    this.report().budgets.map((budget) => ({
      key: budget.id,
      label: budget.name,
      icon: budget.icon,
      value: budget.spent,
      track: budget.allocated,
    })),
  );
}
