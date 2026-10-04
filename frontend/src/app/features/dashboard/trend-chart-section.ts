import { Component, computed, inject } from '@angular/core';
import type { MonthSummary } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { AsyncSection } from '../../shared/ui/async-section';
import {
  LineChart,
  type LineChartCategory,
  type LineChartSeries,
} from '../../shared/ui/charts/line-chart';
import { MONTH_STATUS_LABELS } from '../../shared/ui/month-status';
import { SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { DashboardData } from './dashboard-data';

/**
 * Income, spent and saved over the 12 months that end with the selected month (fewer when Wallet
 * started tracking later). Three lines from the compact rows of `GET /api/months`: `income`,
 * `spent` and `savingsDue`. The last one is what moves to savings when a month closes, so it goes
 * below zero when money is taken from savings; a month that is not over yet is a projection.
 */
@Component({
  selector: 'app-trend-chart-section',
  imports: [AsyncSection, EmptyState, LineChart, SectionHelp],
  template: `
    <app-async-section
      heading="Income, spent and saved"
      [description]="'Month by month, up to ' + data.monthLabel() + '.'"
      [state]="data.summariesState()"
      [error]="data.summaries.error()"
      loadingLabel="Loading the monthly trend…"
      errorTitle="Couldn't load the monthly trend"
      (retry)="data.summaries.reload()"
    >
      @if (chart()?.categories?.length) {
        <p sectionHelp>
          Saved is what moves to savings when a month closes: below zero, money is taken from
          savings.
        </p>
      }

      @if (chart(); as chart) {
        @if (chart.categories.length === 0) {
          <app-empty-state
            title="No months to show yet"
            description="The trend appears once Wallet has a month to report."
          />
        } @else {
          <app-line-chart
            [label]="chart.label"
            [categories]="chart.categories"
            [series]="chart.series"
            categoryLabel="Month"
            noteLabel="Status"
            pointsLabel="Months"
            hint="Use the left and right arrow keys to move between months. Home and End go to the first and the last."
          />
        }
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class TrendChartSection {
  protected readonly data = inject(DashboardData);
  private readonly settings = inject(SettingsStore);

  protected readonly chart = computed(() => {
    const months = this.data.months();
    return months ? this.toChart(months) : undefined;
  });

  private toChart(months: readonly MonthSummary[]) {
    const locale = this.settings.locale();
    const categories: LineChartCategory[] = months.map((month) => ({
      key: month.month,
      label: formatMonth(month.month, locale, 'monthOnly'),
      group: formatMonth(month.month, locale, 'yearOnly'),
      name: formatMonth(month.month, locale, 'long'),
      note: MONTH_STATUS_LABELS[month.status],
      projected: month.status === 'future',
    }));

    // Each measure keeps its color, line style and marker wherever it is drawn.
    const series: LineChartSeries[] = [
      { key: 'income', label: 'Income', slot: 1, values: months.map((month) => month.income) },
      { key: 'spent', label: 'Spent', slot: 2, values: months.map((month) => month.spent) },
      {
        key: 'saved',
        label: 'Saved',
        slot: 3,
        values: months.map((month) => month.savingsDue),
        signed: true,
      },
    ];

    const first = categories.at(0)?.name;
    const last = categories.at(-1)?.name;
    const range = first === undefined || first === last ? (last ?? '') : `${first} to ${last}`;
    return { categories, series, label: `Income, spent and saved, ${range}` };
  }
}
