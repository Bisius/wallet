import { Component, computed, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { BarChart, type BarChartRow } from '../../shared/ui/charts/bar-chart';
import { Amount } from '../../shared/ui/amount';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';

/**
 * Spent per budget over the year: a bar of what was spent over a track of what the budget was given
 * (allocated), with the totals under it. The chart is the shared bar chart, so every row also says
 * its figures in words and the numbers are in its table. Nothing is worked out here.
 */
@Component({
  selector: 'app-report-budgets',
  imports: [Amount, AppSection, BarChart, EmptyState, KeyValue, KeyValues, SectionHelp],
  template: `
    <app-section
      heading="Spent per budget"
      [description]="
        'What each budget was given in ' + report().year + ' and what was spent from it.'
      "
    >
      <p sectionHelp>
        Allocated is what the budget was given. A bar that runs past its outline spent more than was
        allocated.
      </p>
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
        <dl appKeyValues>
          <div appKeyValue label="Total allocated" strong>
            <app-amount [cents]="report().allocated" />
          </div>
          <div appKeyValue label="Total spent" strong><app-amount [cents]="report().spent" /></div>
        </dl>
      }
    </app-section>
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
