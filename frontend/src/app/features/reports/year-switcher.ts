import { Component, computed, input, output } from '@angular/core';
import { Icon } from '../../shared/ui/icon';

const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-3 text-sm font-medium text-ink ' +
  'hover:bg-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-surface';

/**
 * Previous year, the year in view, next year, and a jump back to this year. It only asks: the page
 * decides what a change of year does (it puts the year in the URL).
 *
 * A button at the edge of the allowed range stays focusable and is marked `aria-disabled` instead of
 * `disabled`, like the month switcher: a button that disables itself while it has focus would drop
 * the keyboard user's place.
 */
@Component({
  selector: 'app-year-switcher',
  imports: [Icon],
  template: `
    <div role="group" aria-label="Year" class="flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-1">
        <button
          type="button"
          [class]="button"
          [attr.aria-label]="previousName()"
          [attr.aria-disabled]="!canGoPrevious()"
          (click)="previous()"
        >
          <app-icon name="chevron-left" />
        </button>
        <p aria-live="polite" class="min-w-20 text-center font-semibold tabular-nums">
          {{ year() }}
        </p>
        <button
          type="button"
          [class]="button"
          [attr.aria-label]="nextName()"
          [attr.aria-disabled]="!canGoNext()"
          (click)="next()"
        >
          <app-icon name="chevron-right" />
        </button>
      </div>
      <button
        type="button"
        [class]="button"
        [attr.aria-label]="'Go to this year, ' + current()"
        [attr.aria-disabled]="isCurrent()"
        (click)="goToCurrent()"
      >
        This year
      </button>
    </div>
  `,
})
export class YearSwitcher {
  readonly year = input.required<number>();
  /** The earliest year that can be opened. */
  readonly min = input.required<number>();
  /** The latest year that can be opened. */
  readonly max = input.required<number>();
  /** The current year, for the jump back. */
  readonly current = input.required<number>();
  readonly yearChange = output<number>();

  protected readonly button = BUTTON;

  protected readonly canGoPrevious = computed(() => this.year() > this.min());
  protected readonly canGoNext = computed(() => this.year() < this.max());
  protected readonly isCurrent = computed(() => this.year() === this.current());

  // A button at the edge of the range says so, instead of naming a year that cannot be opened.
  protected readonly previousName = computed(() =>
    this.canGoPrevious() ? `Previous year, ${this.year() - 1}` : 'Previous year, not available',
  );
  protected readonly nextName = computed(() =>
    this.canGoNext() ? `Next year, ${this.year() + 1}` : 'Next year, not available',
  );

  protected previous(): void {
    if (this.canGoPrevious()) this.yearChange.emit(this.year() - 1);
  }

  protected next(): void {
    if (this.canGoNext()) this.yearChange.emit(this.year() + 1);
  }

  protected goToCurrent(): void {
    if (!this.isCurrent()) this.yearChange.emit(this.current());
  }
}
