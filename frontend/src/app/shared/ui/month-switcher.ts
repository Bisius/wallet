import { Component, computed, inject } from '@angular/core';
// Zod-free deep import: keeps zod out of the initial bundle (see "exports" in shared/package.json).
import { addMonths, type MonthKey } from '@wallet/shared/month';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../format';
import { PeriodSwitcher } from './period-switcher';

/**
 * Previous month, the selected month, next month, and a jump back to this month: the period
 * switcher, worded for months. The selection is `SelectedMonth`, so it lives in the URL
 * (`?month=2026-10`). Each button says where it goes ("Previous month, September 2026"), or that it
 * is not available at the edge of the range.
 */
@Component({
  selector: 'app-month-switcher',
  imports: [PeriodSwitcher],
  template: `
    @if (selected.month()) {
      <app-period-switcher
        label="Month"
        [text]="shortLabel()"
        [spokenText]="longLabel()"
        [previousLabel]="previousName()"
        [nextLabel]="nextName()"
        [currentLabel]="'Go to this month, ' + currentLabel()"
        currentText="This month"
        [canGoPrevious]="selected.canGoPrevious()"
        [canGoNext]="selected.canGoNext()"
        [isCurrent]="selected.isCurrent()"
        (goPrevious)="previous()"
        (goNext)="next()"
        (goCurrent)="goToCurrent()"
      />
    }
  `,
  host: { class: 'block' },
})
export class MonthSwitcher {
  protected readonly selected = inject(SelectedMonth);
  private readonly settings = inject(SettingsStore);

  protected readonly shortLabel = computed(() => this.format(this.selected.month(), 'short'));
  protected readonly longLabel = computed(() => this.format(this.selected.month(), 'long'));
  // A button at the edge of the range says so, instead of naming a month that cannot be opened.
  protected readonly previousName = computed(() =>
    this.selected.canGoPrevious()
      ? `Previous month, ${this.format(this.shifted(-1), 'long')}`
      : 'Previous month, not available',
  );
  protected readonly nextName = computed(() =>
    this.selected.canGoNext()
      ? `Next month, ${this.format(this.shifted(1), 'long')}`
      : 'Next month, not available',
  );
  protected readonly currentLabel = computed(() => this.format(this.selected.current(), 'long'));

  protected previous(): void {
    void this.selected.previous();
  }

  protected next(): void {
    void this.selected.next();
  }

  protected goToCurrent(): void {
    if (!this.selected.isCurrent()) void this.selected.goToCurrent();
  }

  private shifted(delta: number): MonthKey | undefined {
    const month = this.selected.month();
    return month === undefined ? undefined : addMonths(month, delta);
  }

  private format(month: MonthKey | undefined, style: 'short' | 'long'): string {
    return month === undefined ? '' : formatMonth(month, this.settings.locale(), style);
  }
}
