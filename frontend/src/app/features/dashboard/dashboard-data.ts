import { computed, inject, Injectable } from '@angular/core';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { resourceState } from '../../core/resource-state';
import { formatMonth } from '../../shared/format';
import { MonthsApi } from '../months/months.api';
import { trendWindow } from './trend-window';

/**
 * What the Dashboard reads, for the month the switcher selects. It is provided by the page, so its
 * resources live and die with it (each visit loads fresh data) and every block of the page shares
 * them instead of asking for the same month again.
 *
 * Each source is a resource of its own with its own state, so a failing request only takes down the
 * blocks that need it. A block that needs something else (savings, upcoming renewals) brings its own
 * resource and does not have to touch this class.
 */
@Injectable()
export class DashboardData {
  private readonly api = inject(MonthsApi);
  private readonly settings = inject(SettingsStore);

  /** The selected month. undefined until today's month is known. */
  readonly month = inject(SelectedMonth).month;
  readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** `GET /api/months/:month`: the figures of the month, its budgets and its subscriptions. */
  readonly view = this.api.view(this.month);
  readonly viewState = resourceState(this.view);
  readonly monthView = computed(() => (this.view.hasValue() ? this.view.value() : undefined));

  /** The months of the trend chart: up to 12, ending with the selected one. */
  private readonly range = computed(() => {
    const month = this.month();
    return month ? trendWindow(month, this.settings.startMonth()) : undefined;
  });

  /** `GET /api/months?from=&to=`: one compact row per month of the trend chart. */
  readonly summaries = this.api.summaries(this.range);
  readonly summariesState = resourceState(this.summaries);
  readonly months = computed(() =>
    this.summaries.hasValue() ? this.summaries.value() : undefined,
  );
}
