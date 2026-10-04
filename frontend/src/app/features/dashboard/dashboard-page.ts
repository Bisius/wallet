import { Component, computed, inject } from '@angular/core';
import { PageHeader } from '../../shared/page-header';
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
 * It is a list of independent blocks. Each block handles its own loading, empty and error states,
 * so adding one is adding its component below; the data the blocks share is in `DashboardData`.
 */
@Component({
  selector: 'app-dashboard-page',
  imports: [
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
    <app-page-header title="Dashboard" [subtitle]="subtitle()" />

    @if (data.month()) {
      <div class="space-y-6">
        <app-glance-section />
        <app-savings-to-move-section />
        <app-upcoming-renewals-section />
        <app-budget-progress-section />
        <div class="grid grid-cols-1 items-start gap-6 2xl:grid-cols-2">
          <app-spending-chart-section />
          <app-trend-chart-section />
        </div>
      </div>
    }
  `,
})
export class DashboardPage {
  protected readonly data = inject(DashboardData);

  protected readonly subtitle = computed(() =>
    this.data.monthLabel() ? `Income, budgets and trends for ${this.data.monthLabel()}.` : '',
  );
}
