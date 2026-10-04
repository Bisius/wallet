import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { parseApiError } from '../../core/api-error';
import { resourceState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatMonth } from '../../shared/format';
import { LinkButton } from '../../shared/ui/link-button';
import { AppPage } from '../../shared/ui/page';
import { PageHeader } from '../../shared/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ReportBreakdown } from './report-breakdown';
import { ReportBudgets } from './report-budgets';
import { ReportFixedCosts } from './report-fixed-costs';
import { ReportGlance } from './report-glance';
import { ReportMonths } from './report-months';
import { yearOf } from './report-year';
import { ReportsApi } from './reports.api';
import { SelectedYear } from './selected-year';

/**
 * The yearly report: a calendar year summed from the months by the API (`GET /api/reports/yearly/
 * :year`). The year lives in the URL (`/report?year=2026`) so it survives a reload and can be
 * shared; without it, or with one that is not a year, it is the current year as the server reports
 * it (`SelectedYear`, whose switcher is in the shell's top bar). Every figure is what the API
 * returned: the page never adds, averages or projects anything.
 *
 * A year with no tracked month (before Wallet started, or beyond what it plans ahead) is a 404 from
 * the API, which this page words as an empty state rather than an error.
 */
@Component({
  selector: 'app-yearly-report-page',
  imports: [
    AppPage,
    PageHeader,
    LinkButton,
    EmptyState,
    ErrorState,
    LoadingState,
    ReportGlance,
    ReportBreakdown,
    ReportFixedCosts,
    ReportBudgets,
    ReportMonths,
    RouterLink,
  ],
  template: `
    <app-page width="wide">
      <app-page-header title="Yearly report" [subtitle]="subtitle()" />

      @switch (stage()) {
        @case ('today-error') {
          <app-error-state
            title="Couldn't load today's date"
            [error]="today.error()"
            (retry)="today.reload()"
          />
        }
        @case ('loading') {
          <app-loading-state [label]="'Loading the report for ' + (year() ?? '') + '…'" />
        }
        @case ('error') {
          <app-error-state
            [title]="errorTitle()"
            [error]="report.error()"
            (retry)="report.reload()"
          />
        }
        @case ('none') {
          <app-empty-state
            [title]="'No months to report in ' + year()"
            [description]="noMonthsText()"
          >
            @if (year() !== currentYear()) {
              <a
                appLinkButton
                variant="primary"
                routerLink="/report"
                [queryParams]="{ year: currentYear() }"
                queryParamsHandling="merge"
              >
                Go to {{ currentYear() }}
              </a>
            }
          </app-empty-state>
        }
        @default {
          @if (data(); as data) {
            <app-report-glance [report]="data" />
            <app-report-breakdown [report]="data" />
            <app-report-fixed-costs [report]="data" />
            <app-report-budgets [report]="data" />
            <app-report-months [report]="data" />
          }
        }
      }
    </app-page>
  `,
})
export class YearlyReportPage {
  private readonly settings = inject(SettingsStore);
  private readonly selectedYear = inject(SelectedYear);
  protected readonly today = inject(TodayStore);

  /** The current year according to the server. undefined until loaded. */
  protected readonly currentYear = this.selectedYear.current;

  /** The year in view: the one in the URL, else this year. undefined until today is known. */
  protected readonly year = this.selectedYear.year;

  protected readonly report = inject(ReportsApi).yearly(this.year);
  private readonly state = resourceState(this.report);
  protected readonly data = computed(() =>
    this.report.hasValue() ? this.report.value() : undefined,
  );

  /** What to show: `none` is the API's 404 (no tracked month in the year). */
  protected readonly stage = computed<'today-error' | 'loading' | 'error' | 'none' | 'ready'>(
    () => {
      if (this.year() === undefined) {
        return this.today.state() === 'error' ? 'today-error' : 'loading';
      }
      const state = this.state();
      if (state === 'ready') return 'ready';
      if (state === 'loading') return 'loading';
      return parseApiError(this.report.error()).status === 404 ? 'none' : 'error';
    },
  );

  protected readonly errorTitle = computed(() => `Couldn't load the report for ${this.year()}`);

  protected readonly subtitle = computed(() => {
    const year = this.year();
    return year === undefined ? '' : `Income, spending and savings for ${year}.`;
  });

  protected readonly noMonthsText = computed(() => {
    const year = this.year();
    const start = this.settings.startMonth();
    if (year !== undefined && start !== undefined && year < yearOf(start)) {
      const since = formatMonth(start, this.settings.locale());
      return `Wallet tracks months from ${since} on, so there is nothing to report for ${year}.`;
    }
    return 'That is further ahead than Wallet plans, so there is nothing to report yet.';
  });
}
