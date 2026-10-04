import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { parseYear, yearBounds, YEAR_PARAM, yearOf } from './report-year';

/**
 * The year of the yearly report, the way `SelectedMonth` is the month of the other pages. It lives in
 * the URL (`/report?year=2026`), so it survives a reload and can be shared. Without the parameter, or
 * with one that is not a year, it is the current year as the server reports it.
 *
 * The year switcher is in the shell's top bar and the report page reads the year from here, so the
 * two are never out of step, and the address is what it always was.
 */
@Injectable({ providedIn: 'root' })
export class SelectedYear {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);

  private readonly queryYear = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get(YEAR_PARAM))),
    { initialValue: null },
  );

  /** The current year according to the server. undefined until loaded. */
  readonly current = computed(() => {
    const month = this.today.month();
    return month === undefined ? undefined : yearOf(month);
  });

  /** The year in view: the one in the URL, else this year. undefined until today is known. */
  readonly year = computed(() => parseYear(this.queryYear()) ?? this.current());

  /** What the year switcher needs. undefined until today is known. */
  readonly switcher = computed(() => {
    const month = this.today.month();
    const year = this.year();
    if (month === undefined || year === undefined) return undefined;
    return { year, current: yearOf(month), ...yearBounds(this.settings.startMonth(), month) };
  });

  /** Opens a year: the current one is the default, so it needs no parameter. Keeps the other parameters. */
  select(year: number): Promise<boolean> {
    return this.router.navigate([], {
      queryParams: { [YEAR_PARAM]: year === this.current() ? null : year },
      queryParamsHandling: 'merge',
    });
  }
}
