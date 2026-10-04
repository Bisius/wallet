import { Component, computed, inject } from '@angular/core';
import { resourceState } from '../../core/resource-state';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { AsyncSection } from '../../shared/ui/async-section';
import { MonthStatusBadge } from '../../shared/ui/month-status';
import { AppPage } from '../../shared/ui/page';
import { PageHeader } from '../../shared/ui/page-header';
import { Stat } from '../../shared/ui/stat';
import { StatGrid } from '../../shared/ui/stat-grid';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { MonthsApi } from '../months/months.api';
import { IncomesApi } from './incomes.api';
import { IncomesSection } from './incomes-section';
import { SalaryApi } from './salary.api';
import { SalarySection } from './salary-section';

/**
 * Income of the selected month: the totals the month view reports, the salary history (add, change,
 * delete) and the month's one-off incomes. Every figure shown is what the API returned.
 */
@Component({
  selector: 'app-income-page',
  imports: [
    AppPage,
    PageHeader,
    AsyncSection,
    LoadingState,
    ErrorState,
    MonthStatusBadge,
    SalarySection,
    IncomesSection,
    Stat,
    StatGrid,
  ],
  templateUrl: './income-page.html',
})
export class IncomePage {
  private readonly settings = inject(SettingsStore);

  protected readonly month = inject(SelectedMonth).month;

  // Resources belong to the page: each visit loads fresh data, so a change made on another page
  // (or device) is never shown stale.
  protected readonly view = inject(MonthsApi).view(this.month);
  protected readonly salary = inject(SalaryApi).history();
  protected readonly incomes = inject(IncomesApi).forMonth(this.month);

  protected readonly viewState = resourceState(this.view);
  protected readonly salaryState = resourceState(this.salary);
  protected readonly incomesState = resourceState(this.incomes);

  protected readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  protected readonly salaryEntries = computed(() =>
    this.salary.hasValue() ? this.salary.value() : undefined,
  );
  protected readonly incomeList = computed(() =>
    this.incomes.hasValue() ? this.incomes.value() : undefined,
  );

  /** What the month's status means for these figures, when it is not the running month. */
  protected readonly monthNote = computed(() => {
    switch (this.monthView()?.status) {
      case 'closed':
        return 'This month is closed. Changing its income changes what is due to savings.';
      case 'future':
        return 'This month has not started yet, so these figures are a projection.';
      default:
        return undefined;
    }
  });

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** Something changed on the server: load what this page shows again. */
  protected reload(): void {
    this.view.reload();
    this.salary.reload();
    this.incomes.reload();
  }
}
