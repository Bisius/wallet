import { Component, computed, inject } from '@angular/core';
// Zod-free deep import: keeps zod out of the initial bundle (see "exports" in shared/package.json).
import { addMonths, type MonthKey } from '@wallet/shared/month';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../format';
import { Icon } from './icon';

const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-3 text-sm font-medium text-ink ' +
  'hover:bg-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-surface';

/**
 * Previous month, the selected month, next month, and a jump back to this month. The selection is
 * `SelectedMonth`, so it lives in the URL (`?month=2026-10`).
 *
 * A button at the edge of the allowed range stays focusable and is marked `aria-disabled` instead of
 * `disabled`: a button that disables itself while it has focus would drop the keyboard user's place.
 */
@Component({
  selector: 'app-month-switcher',
  imports: [Icon],
  template: `
    @if (selected.month()) {
      <div role="group" aria-label="Month" class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-1">
          <button
            type="button"
            [class]="button"
            [attr.aria-label]="previousName()"
            [attr.aria-disabled]="!selected.canGoPrevious()"
            (click)="previous()"
          >
            <app-icon name="chevron-left" />
          </button>
          <p aria-live="polite" class="min-w-28 text-center font-semibold">
            <span aria-hidden="true">{{ shortLabel() }}</span>
            <span class="sr-only">{{ longLabel() }}</span>
          </p>
          <button
            type="button"
            [class]="button"
            [attr.aria-label]="nextName()"
            [attr.aria-disabled]="!selected.canGoNext()"
            (click)="next()"
          >
            <app-icon name="chevron-right" />
          </button>
        </div>
        <button
          type="button"
          [class]="button"
          [attr.aria-label]="'Go to this month, ' + currentLabel()"
          [attr.aria-disabled]="selected.isCurrent()"
          (click)="goToCurrent()"
        >
          This month
        </button>
      </div>
    }
  `,
  host: { class: 'block' },
})
export class MonthSwitcher {
  protected readonly selected = inject(SelectedMonth);
  private readonly settings = inject(SettingsStore);

  protected readonly button = BUTTON;

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
