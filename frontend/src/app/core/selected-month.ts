import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
// Zod-free deep imports: they keep zod out of the initial bundle.
import { MAX_MONTHS_AHEAD } from '@wallet/shared/limits';
import { addMonths, isMonthKey, type MonthKey } from '@wallet/shared/month';
import { map } from 'rxjs';
import { SettingsStore } from './settings.store';
import { TodayStore } from './today.store';

/** Query parameter that carries the selected month. */
export const MONTH_PARAM = 'month';

/**
 * The month the pages show. It lives in the URL (`?month=2026-10`), so it survives a reload, can be
 * bookmarked and is the same for every page. Without the parameter it is the current month (as
 * reported by the server), and it is always kept between `settings.startMonth` and the current month
 * plus `MAX_MONTHS_AHEAD`.
 */
@Injectable({ providedIn: 'root' })
export class SelectedMonth {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);

  private readonly queryMonth = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get(MONTH_PARAM))),
    { initialValue: null },
  );

  /** The current month according to the server. undefined until loaded. */
  readonly current = this.today.month;
  /** The earliest month that can be selected: `settings.startMonth`. */
  readonly min = this.settings.startMonth;
  /** The latest month that can be selected. */
  readonly max = computed(() => {
    const current = this.current();
    return current ? addMonths(current, MAX_MONTHS_AHEAD) : undefined;
  });

  /** The selected month. undefined until today's month is known. */
  readonly month = computed<MonthKey | undefined>(() => {
    const current = this.current();
    if (!current) return undefined;
    const requested = this.queryMonth();
    const wanted = requested !== null && isMonthKey(requested) ? requested : current;
    const min = this.min();
    const max = this.max();
    if (min && wanted < min) return min;
    if (max && wanted > max) return max;
    return wanted;
  });

  /** The selected month is the current month. */
  readonly isCurrent = computed(() => {
    const month = this.month();
    return month !== undefined && month === this.current();
  });

  readonly canGoPrevious = computed(() => {
    const month = this.month();
    const min = this.min();
    return month !== undefined && (min === undefined || month > min);
  });

  readonly canGoNext = computed(() => {
    const month = this.month();
    const max = this.max();
    return month !== undefined && (max === undefined || month < max);
  });

  /**
   * Query parameters that carry the selection to another page (`[queryParams]` of a link). Empty for
   * the current month, which is the default.
   */
  readonly linkParams = computed<Record<string, string>>(() => {
    const month = this.month();
    const params: Record<string, string> = {};
    if (month !== undefined && !this.isCurrent()) params[MONTH_PARAM] = month;
    return params;
  });

  previous(): Promise<boolean> {
    const month = this.month();
    return month !== undefined && this.canGoPrevious()
      ? this.select(addMonths(month, -1))
      : Promise.resolve(false);
  }

  next(): Promise<boolean> {
    const month = this.month();
    return month !== undefined && this.canGoNext()
      ? this.select(addMonths(month, 1))
      : Promise.resolve(false);
  }

  goToCurrent(): Promise<boolean> {
    return this.router.navigate([], {
      queryParams: { [MONTH_PARAM]: null },
      queryParamsHandling: 'merge',
    });
  }

  /** Selects a month (clamped to the allowed range). Keeps the page and its other query parameters. */
  select(month: MonthKey): Promise<boolean> {
    const min = this.min();
    const max = this.max();
    let target = month;
    if (min && target < min) target = min;
    if (max && target > max) target = max;
    return this.router.navigate([], {
      queryParams: { [MONTH_PARAM]: target === this.current() ? null : target },
      queryParamsHandling: 'merge',
    });
  }
}
