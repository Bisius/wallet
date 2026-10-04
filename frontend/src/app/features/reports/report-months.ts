import { Component, computed, inject, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { Amount } from '../../shared/ui/amount';
import {
  LineChart,
  type LineChartCategory,
  type LineChartSeries,
} from '../../shared/ui/charts/line-chart';
import { MONTH_STATUS_LABELS, MonthStatusBadge } from '../../shared/ui/month-status';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { TableScroll } from '../../shared/ui/table-scroll';

/**
 * The year month by month: a line chart of income, spent and saved (the shared chart, the same
 * measures and colors as the Dashboard) and a table with every figure of every month. A month that
 * has not started is marked "Projection" in words, in the table and the chart, and its chart
 * markers are hollow. The last row is the report's own total.
 */
@Component({
  selector: 'app-report-months',
  imports: [Amount, AppSection, LineChart, MonthStatusBadge, SectionHelp, TableScroll],
  template: `
    <app-section
      heading="Month by month"
      description="Figures for each month, and the year's total at the end."
    >
      <p sectionHelp>
        Saved is what is due to savings when a month closes: below zero, money is taken from
        savings. A month marked Projection has not started, so its figures assume the current month
        ends as it stands.
      </p>
      <app-line-chart
        [label]="'Income, spent and saved per month, ' + report().year"
        [categories]="categories()"
        [series]="series()"
        categoryLabel="Month"
        noteLabel="Status"
        pointsLabel="Months"
        hint="Use the left and right arrow keys to move between months. Home and End go to the first and the last."
      />

      <app-table-scroll label="Figures per month">
        <table class="data-table min-w-[40rem]">
          <caption class="sr-only">
            Figures per month in
            {{
              report().year
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" class="cell-num">Income</th>
              <th scope="col" class="cell-num">Fixed costs</th>
              <th scope="col" class="cell-num">Budgeted</th>
              <th scope="col" class="cell-num">Spent</th>
              <th scope="col" class="cell-num">Saved</th>
            </tr>
          </thead>
          <tbody>
            @for (month of rows(); track month.key) {
              <tr [class.bg-subtle]="month.status === 'future'">
                <th scope="row" class="whitespace-nowrap">
                  {{ month.name }}
                  @if (month.status !== 'closed') {
                    <app-month-status class="ml-1" [status]="month.status" />
                  }
                </th>
                <td class="cell-num">
                  <app-amount [cents]="month.income.total" />
                </td>
                <td class="cell-num">
                  <app-amount [cents]="month.fixedCosts" />
                </td>
                <td class="cell-num">
                  <app-amount [cents]="month.allocated" />
                </td>
                <td class="cell-num">
                  <app-amount [cents]="month.spent" />
                </td>
                <td class="cell-num">
                  <app-amount [cents]="month.saved" [signed]="true" plain />
                </td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total {{ report().year }}</th>
              <td class="cell-num">
                <app-amount [cents]="report().income.total" />
              </td>
              <td class="cell-num">
                <app-amount [cents]="report().fixedCosts.total" />
              </td>
              <td class="cell-num">
                <app-amount [cents]="report().allocated" />
              </td>
              <td class="cell-num">
                <app-amount [cents]="report().spent" />
              </td>
              <td class="cell-num">
                <app-amount [cents]="report().saved" [signed]="true" plain />
              </td>
            </tr>
          </tfoot>
        </table>
      </app-table-scroll>
    </app-section>
  `,
  host: { class: 'block' },
})
export class ReportMonths {
  private readonly settings = inject(SettingsStore);

  readonly report = input.required<YearlyReportDto>();

  protected readonly rows = computed(() => {
    const locale = this.settings.locale();
    return this.report().months.map((month) => ({
      ...month,
      key: month.month,
      name: formatMonth(month.month, locale),
    }));
  });

  protected readonly categories = computed<LineChartCategory[]>(() => {
    const locale = this.settings.locale();
    return this.report().months.map((month) => ({
      key: month.month,
      label: formatMonth(month.month, locale, 'monthOnly'),
      group: formatMonth(month.month, locale, 'yearOnly'),
      name: formatMonth(month.month, locale, 'long'),
      note: MONTH_STATUS_LABELS[month.status],
      projected: month.status === 'future',
    }));
  });

  // The same measure keeps the same color, line style and marker as on the Dashboard.
  protected readonly series = computed<LineChartSeries[]>(() => {
    const months = this.report().months;
    return [
      { key: 'income', label: 'Income', slot: 1, values: months.map((m) => m.income.total) },
      { key: 'spent', label: 'Spent', slot: 2, values: months.map((m) => m.spent) },
      {
        key: 'saved',
        label: 'Saved',
        slot: 3,
        values: months.map((m) => m.saved),
        signed: true,
      },
    ];
  });
}
