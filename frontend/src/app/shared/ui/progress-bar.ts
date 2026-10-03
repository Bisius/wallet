import { Component, computed, input } from '@angular/core';

export type ProgressTone = 'neutral' | 'warning' | 'danger';

/**
 * A horizontal progress bar with the semantics of `role="progressbar"`. The bar is only a picture of
 * a number that is also written in words next to it (`valueText` is what a screen reader says), so
 * the tone is never the only signal.
 *
 * `percent` is not capped: 150 means 50% over. The bar fills to 100% at most, and
 * `aria-valuenow` stays within 0 to 100 as the role requires.
 */
@Component({
  selector: 'app-progress-bar',
  template: `
    <div
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      class="h-2.5 w-full overflow-hidden rounded-full bg-subtle ring-1 ring-line-strong ring-inset"
      [attr.aria-label]="label()"
      [attr.aria-valuenow]="width()"
      [attr.aria-valuetext]="valueText()"
    >
      <div
        class="h-full rounded-full"
        [class.bg-accent]="tone() === 'neutral'"
        [class.bg-warning]="tone() === 'warning'"
        [class.bg-negative]="tone() === 'danger'"
        [style.width.%]="width()"
      ></div>
    </div>
  `,
  host: { class: 'block' },
})
export class ProgressBar {
  /** What the bar measures, as its accessible name: "Groceries usage". */
  readonly label = input.required<string>();
  /** Progress in percent. Not capped, see above. */
  readonly percent = input.required<number>();
  readonly tone = input<ProgressTone>('neutral');
  /** The value in words for a screen reader: "85% used, warning". */
  readonly valueText = input<string>();

  protected readonly width = computed(() => Math.min(100, Math.max(0, this.percent())));
}
