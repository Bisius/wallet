import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { resourceState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatMonth } from '../../shared/format';
import { PageHeader } from '../../shared/page-header';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ReportBudgets } from './report-budgets';
import { ReportFixedCosts } from './report-fixed-costs';
import { ReportGlance } from './report-glance';
import { ReportMonths } from './report-months';
import { parseYear, yearBounds, YEAR_PARAM, yearOf } from './report-year';
import { ReportsApi } from './reports.api';
import { YearSwitcher } from './year-switcher';

/**
 * The yearly report: a calendar year summed from the months by the API (`GET /api/reports/yearly/
 * :year`). The year lives in the URL (`/report?year=2026`) so it survives a reload and can be
 * shared; without it, or with one that is not a year, it is the current year as the server reports
 * it. Every figure is what the API returned: the page never adds, averages or projects anything.
 *
 * A year with no tracked month (before Wallet started, or beyond what it plans ahead) is a 404 from
 * the API, which this page words as an empty state rather than an error.
 */
@Component({
  selector: 'app-yearly-report-page',
  imports: [
    PageHeader,
    YearSwitcher,
    EmptyState,
    ErrorState,
    LoadingState,
    ReportGlance,
    ReportFixedCosts,
    ReportBudgets,
    ReportMonths,
    RouterLink,
  ],
  template: `
    <app-page-header title="Yearly report" [subtitle]="subtitle()">
      @if (switcher(); as switcher) {
        <app-year-switcher
          [year]="switcher.year"
          [min]="switcher.min"
          [max]="switcher.max"
          [current]="switcher.current"
          (yearChange)="select($event)"
        />
      }
    </app-page-header>

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
              routerLink="/report"
              [queryParams]="{ year: currentYear() }"
              queryParamsHandling="merge"
              class="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover"
            >
              Go to {{ currentYear() }}
            </a>
          }
        </app-empty-state>
      }
      @default {
        @if (data(); as data) {
          <div class="max-w-6xl space-y-6">
            <app-report-glance [report]="data" />
            <app-report-fixed-costs [report]="data" />
            <app-report-budgets [report]="data" />
            <app-report-months [report]="data" />
          </div>
        }
      }
    }
  `,
})
export class YearlyReportPage {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  protected readonly today = inject(TodayStore);

  private readonly queryYear = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get(YEAR_PARAM))),
    { initialValue: null },
  );

  /** The current year according to the server. undefined until loaded. */
  protected readonly currentYear = computed(() => {
    const month = this.today.month();
    return month === undefined ? undefined : yearOf(month);
  });

  /** The year in view: the one in the URL, else this year. undefined until today is known. */
  protected readonly year = computed(() => parseYear(this.queryYear()) ?? this.currentYear());

  /** What the year switcher needs. undefined until today is known. */
  protected readonly switcher = computed(() => {
    const month = this.today.month();
    const year = this.year();
    if (month === undefined || year === undefined) return undefined;
    return { year, current: yearOf(month), ...yearBounds(this.settings.startMonth(), month) };
  });

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
    return year === undefined
      ? ''
      : `Income, fixed costs, spending and savings for ${year}, month by month.`;
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

  protected select(year: number): void {
    void this.router.navigate([], {
      queryParams: { [YEAR_PARAM]: year === this.currentYear() ? null : year },
      queryParamsHandling: 'merge',
    });
  }
}
