import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppRouteData } from '../core/route-data';
import { SelectedMonth } from '../core/selected-month';
import { SelectedYear } from '../features/reports/selected-year';
import { YearSwitcher } from '../features/reports/year-switcher';
import { ApiStatusIndicator } from '../shared/ui/api-status-indicator';
import { Button } from '../shared/ui/button';
import { Icon } from '../shared/ui/icon';
import { MonthSwitcher } from '../shared/ui/month-switcher';
import { AddSpending } from './add-spending';

/**
 * The one bar at the top of every page, sticky. What is in it depends on the page and the screen:
 *
 *  - on a phone (below `md`), the brand and, next to it, the API status as a dot (the sidebar that
 *    holds both on a wide screen is not there). The bar is about 60 px tall: the brand and the tab bar
 *    at the bottom replace the old two rows of brand and navigation;
 *  - the period switcher of the page: the month (`period: 'month'`), the year of the report
 *    (`period: 'year'`), nothing for a page that has none (route data, `app.routes.ts`);
 *  - from `md` up, the primary "Add spending" button at the end. On a phone the floating button does
 *    that. The Spendings page has its own form, and so leaves it out (`showAdd`).
 *
 * In a focus layout (the onboarding) a wide screen has only the sidebar, so the bar is not drawn there.
 * It is the page's `banner`; the period is a labelled group inside it.
 */
@Component({
  selector: 'app-top-bar',
  imports: [RouterLink, MonthSwitcher, YearSwitcher, ApiStatusIndicator, Button, Icon],
  template: `
    <header [class]="classes()">
      <div class="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 md:px-8">
        <a
          routerLink="/dashboard"
          [queryParams]="selectedMonth.linkParams()"
          class="rounded-control text-base font-semibold tracking-tight md:hidden"
        >
          Wallet
        </a>
        <app-api-status-indicator [compact]="true" class="md:hidden" />

        @switch (period()) {
          @case ('month') {
            <app-month-switcher class="ml-auto md:ml-0" />
          }
          @case ('year') {
            @if (selectedYear.switcher(); as year) {
              <app-year-switcher
                class="ml-auto md:ml-0"
                [year]="year.year"
                [min]="year.min"
                [max]="year.max"
                [current]="year.current"
                (yearChange)="selectedYear.select($event)"
              />
            }
          }
        }

        @if (showAdd()) {
          <button appButton class="ml-auto max-md:hidden" (click)="add.open()">
            <app-icon name="plus" />
            Add spending
          </button>
        }
      </div>
    </header>
  `,
  host: { class: 'contents' },
})
export class TopBar {
  /** The switcher the page has, from its route data. */
  readonly period = input<AppRouteData['period']>();
  /** The global "Add spending" button is wanted (not on the Spendings page, not in a focus layout). */
  readonly showAdd = input(false);
  /** The onboarding and the page that cannot load: a phone has the brand here, a wide screen nothing. */
  readonly focusLayout = input(false);

  protected readonly selectedMonth = inject(SelectedMonth);
  protected readonly selectedYear = inject(SelectedYear);
  protected readonly add = inject(AddSpending);

  protected readonly classes = computed(
    () =>
      'sticky top-0 z-20 border-b border-line-soft bg-surface/95 backdrop-blur' +
      (this.focusLayout() ? ' md:hidden' : ''),
  );
}
