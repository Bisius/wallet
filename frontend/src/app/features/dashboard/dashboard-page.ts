import { Component, computed, inject } from '@angular/core';
import { AppPage } from '../../shared/ui/page';
import { PageHeader } from '../../shared/ui/page-header';
import { BudgetProgressSection } from './budget-progress-section';
import { DashboardData } from './dashboard-data';
import { GlanceSection } from './glance-section';
import { SavingsToMoveSection } from './savings-to-move-section';
import { SpendingChartSection } from './spending-chart-section';
import { TrendChartSection } from './trend-chart-section';
import { UpcomingRenewalsSection } from './upcoming-renewals-section';

/**
 * The Dashboard: how the selected month is going. Every number comes from the month view
 * (`GET /api/months/:month`) or the compact month rows (`GET /api/months`), exactly as the API
 * computed them; the page honours the month switcher and never works out a balance, a rollover or
 * an alert itself.
 *
 * It is a strip of figures and then independent blocks. Each block handles its own loading, empty and
 * error states, so adding one is adding its component below; the data the blocks share is in
 * `DashboardData`. From `xl` the short lists sit in two columns (savings to move and renewals beside
 * the budget progress), and the two charts take the whole width under them.
 */
@Component({
  selector: 'app-dashboard-page',
  imports: [
    AppPage,
    PageHeader,
    GlanceSection,
    SavingsToMoveSection,
    BudgetProgressSection,
    SpendingChartSection,
    TrendChartSection,
    UpcomingRenewalsSection,
  ],
  providers: [DashboardData],
  template: `
    <app-page width="wide">
      <app-page-header title="Dashboard" [subtitle]="subtitle()" />

      @if (data.month()) {
        <app-glance-section />
        <div class="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
          <div class="space-y-6">
            <app-savings-to-move-section />
            <app-upcoming-renewals-section />
          </div>
          <app-budget-progress-section />
          <app-spending-chart-section class="xl:col-span-2" />
          <app-trend-chart-section class="xl:col-span-2" />
        </div>
      }
    </app-page>
  `,
})
export class DashboardPage {
  protected readonly data = inject(DashboardData);

  protected readonly subtitle = computed(() =>
    this.data.monthLabel() ? `Income, budgets and trends for ${this.data.monthLabel()}.` : '',
  );
}
