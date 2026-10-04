import { Component, computed, inject } from '@angular/core';
import type { MonthBudgetLine } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatMoney } from '../../shared/money.pipe';
import { AsyncSection } from '../../shared/ui/async-section';
import { BarChart, type BarChartRow } from '../../shared/ui/charts/bar-chart';
import { SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { ALERT_LABELS } from '../budgets/budget-utils';
import { DashboardData } from './dashboard-data';

/**
 * Spending per budget in the selected month: a bar of what was spent for each budget over a track of
 * what it had available, so a bar that runs past its track is over budget. The figures are the month
 * view's and so are the alert states; the chart only draws them.
 */
@Component({
  selector: 'app-spending-chart-section',
  imports: [AsyncSection, BarChart, EmptyState, SectionHelp],
  template: `
    <app-async-section
      heading="Spending per budget"
      [description]="
        'What you spent from each budget in ' +
        data.monthLabel() +
        ', against what it had available.'
      "
      [state]="data.viewState()"
      [error]="data.view.error()"
      loadingLabel="Loading the spending chart…"
      errorTitle="Couldn't load the spending chart"
      (retry)="data.view.reload()"
    >
      @if (rows()?.length) {
        <p sectionHelp>A bar that runs past its outline is over budget.</p>
      }

      @if (rows(); as rows) {
        @if (rows.length === 0) {
          <app-empty-state
            title="Nothing to compare yet"
            [description]="
              'Create a budget in ' +
              data.monthLabel() +
              ' and add spendings to it. This chart then compares what you spent from each budget with what it had available.'
            "
          />
        } @else {
          <app-bar-chart
            [label]="'Spending per budget, ' + data.monthLabel()"
            [rows]="rows"
            [slot]="2"
            valueLabel="Spent"
            trackLabel="Available"
            nameLabel="Budget"
            statusLabel="Alert"
          />
        }
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class SpendingChartSection {
  protected readonly data = inject(DashboardData);
  private readonly settings = inject(SettingsStore);

  protected readonly rows = computed<BarChartRow[] | undefined>(() => {
    const view = this.data.monthView();
    return view?.budgets.map((line) => this.row(line));
  });

  private row(line: MonthBudgetLine): BarChartRow {
    return {
      key: line.id,
      label: line.name,
      icon: line.icon,
      value: line.spent,
      track: line.available,
      status: {
        label: ALERT_LABELS[line.alert],
        tone: line.alert === 'over' ? 'danger' : line.alert,
      },
      note: this.note(line),
    };
  }

  /** What the bar and its words leave unsaid. The state itself is the API's `alert`. */
  private note(line: MonthBudgetLine): string | null {
    if (line.alert === 'over') {
      const over = formatMoney(-line.remaining, this.settings.locale(), this.settings.currency());
      return `by ${over}`;
    }
    return line.available <= 0 ? 'Nothing available this month.' : null;
  }
}
