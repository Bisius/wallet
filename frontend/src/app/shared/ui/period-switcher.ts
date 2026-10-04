import { Component, input, output } from '@angular/core';
import { buttonClasses } from './button';
import { Icon } from './icon';

/*
 * The buttons are the app's small secondary button, and on a phone they grow to 44 px: the "sm"
 * size is 36 px tall, which is right for a mouse and too small for a thumb, so `max-sm:` raises the
 * height (and the width of the icon-only ones, which are 42 px wide) to 44 px below 40rem.
 *
 * A button at the edge of the range is `aria-disabled`, not `disabled`: see `PeriodSwitcher`.
 */
const SWITCHER_BUTTON =
  `${buttonClasses('secondary', 'sm')} max-sm:min-h-11 max-sm:min-w-11 ` +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-surface';

/**
 * Previous, the period in view, next, and a jump back to the current one: the same control for a
 * month (`app-month-switcher`) and a year (`app-year-switcher`), which only decide what the buttons
 * say and what they do.
 *
 * ```html
 * <app-period-switcher
 *   label="Year"
 *   text="2026"
 *   previousLabel="Previous year, 2025"
 *   nextLabel="Next year, 2027"
 *   currentLabel="Go to this year, 2026"
 *   currentText="This year"
 *   [canGoPrevious]="true"
 *   [canGoNext]="true"
 *   [isCurrent]="true"
 *   (goPrevious)="…"
 *   (goNext)="…"
 *   (goCurrent)="…"
 * />
 * ```
 *
 * It is a group named by `label`, with the period in a polite live region so that a change is
 * announced. `text` is what is shown. When it is an abbreviation ("Oct 2026"), `spokenText` is what a
 * screen reader hears instead ("October 2026"). The three buttons are named by the caller (a
 * button says where it goes: "Previous month, September 2026"). Below 40rem the jump back is only a
 * calendar icon, because the shell's top bar has no room for its words next to the brand: its
 * `aria-label` still names it in full.
 *
 * A button at the edge of the allowed range stays focusable and is marked `aria-disabled` instead of
 * `disabled`: a button that disables itself while it has focus would drop the keyboard user's place.
 * It does nothing when pressed (the output is not emitted), and the caller names it "not available".
 */
@Component({
  selector: 'app-period-switcher',
  imports: [Icon],
  template: `
    <div role="group" [attr.aria-label]="label()" class="flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-1">
        <button
          type="button"
          [class]="buttonClass"
          [attr.aria-label]="previousLabel()"
          [attr.aria-disabled]="!canGoPrevious()"
          (click)="previous()"
        >
          <app-icon name="chevron-left" />
        </button>
        <p aria-live="polite" class="min-w-20 text-center font-semibold tabular-nums sm:min-w-28">
          @if (spokenText(); as spoken) {
            <span aria-hidden="true">{{ text() }}</span>
            <span class="sr-only">{{ spoken }}</span>
          } @else {
            {{ text() }}
          }
        </p>
        <button
          type="button"
          [class]="buttonClass"
          [attr.aria-label]="nextLabel()"
          [attr.aria-disabled]="!canGoNext()"
          (click)="next()"
        >
          <app-icon name="chevron-right" />
        </button>
      </div>
      <button
        type="button"
        [class]="buttonClass"
        [attr.aria-label]="currentLabel()"
        [attr.aria-disabled]="isCurrent()"
        (click)="current()"
      >
        <app-icon name="calendar" class="sm:hidden" />
        <span class="max-sm:hidden">{{ currentText() }}</span>
      </button>
    </div>
  `,
  host: { class: 'block' },
})
export class PeriodSwitcher {
  /** The name of the group: "Month", "Year". */
  readonly label = input.required<string>();
  /** The period in view, as it is shown: "Oct 2026", "2026". */
  readonly text = input.required<string>();
  /** The period in view, as it is read aloud when `text` is shortened: "October 2026". */
  readonly spokenText = input<string>();
  /** What the previous button is: "Previous month, September 2026" (or "…, not available"). */
  readonly previousLabel = input.required<string>();
  readonly nextLabel = input.required<string>();
  /** What the jump back is: "Go to this month, October 2026". */
  readonly currentLabel = input.required<string>();
  /** The words on the jump back: "This month", "This year". */
  readonly currentText = input.required<string>();
  readonly canGoPrevious = input(true);
  readonly canGoNext = input(true);
  /** The period in view is the current one: the jump back has nowhere to go. */
  readonly isCurrent = input(false);

  readonly goPrevious = output<void>();
  readonly goNext = output<void>();
  readonly goCurrent = output<void>();

  protected readonly buttonClass = SWITCHER_BUTTON;

  protected previous(): void {
    if (this.canGoPrevious()) this.goPrevious.emit();
  }

  protected next(): void {
    if (this.canGoNext()) this.goNext.emit();
  }

  protected current(): void {
    if (!this.isCurrent()) this.goCurrent.emit();
  }
}
