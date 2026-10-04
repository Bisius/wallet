import { Component, computed, input, output } from '@angular/core';
import { PeriodSwitcher } from '../../shared/ui/period-switcher';

/**
 * Previous year, the year in view, next year, and a jump back to this year: the period switcher,
 * worded for years. It only asks: the page decides what a change of year does (it puts the year in
 * the URL).
 */
@Component({
  selector: 'app-year-switcher',
  imports: [PeriodSwitcher],
  template: `
    <app-period-switcher
      label="Year"
      [text]="'' + year()"
      [previousLabel]="previousName()"
      [nextLabel]="nextName()"
      [currentLabel]="'Go to this year, ' + current()"
      currentText="This year"
      [canGoPrevious]="canGoPrevious()"
      [canGoNext]="canGoNext()"
      [isCurrent]="isCurrent()"
      (goPrevious)="previous()"
      (goNext)="next()"
      (goCurrent)="goToCurrent()"
    />
  `,
  host: { class: 'block' },
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
