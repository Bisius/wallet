import { Component, computed, input } from '@angular/core';
import { markerPath } from './chart-math';
import { SERIES_STYLES, type SeriesSlot } from './series-style';

/**
 * The swatch of a legend: it mirrors the mark it stands for, so the legend is read by shape and
 * style as well as by color. `line` is a short stretch of the series' line with its marker (solid,
 * dashed or dotted), `bar` a filled bar, and `track` the outline of the range a bar is measured
 * against. It is decoration: the words next to it name the series.
 */
@Component({
  selector: 'app-series-key',
  template: `
    <svg
      aria-hidden="true"
      focusable="false"
      width="28"
      height="14"
      viewBox="0 0 28 14"
      class="shrink-0 overflow-visible"
    >
      @switch (kind()) {
        @case ('line') {
          <path
            d="M2 7H26"
            fill="none"
            stroke-width="2"
            stroke-linecap="round"
            [class]="style().stroke"
            [attr.stroke-dasharray]="style().dash"
          />
          <path
            [attr.d]="marker()"
            stroke-width="2"
            class="stroke-surface"
            [class]="style().fill"
          />
        }
        @case ('bar') {
          <rect x="2" y="3" width="24" height="8" rx="4" [class]="style().fill" />
        }
        @case ('track') {
          <rect
            x="2.5"
            y="1.5"
            width="23"
            height="11"
            rx="5.5"
            fill="none"
            class="stroke-line-strong"
          />
        }
      }
    </svg>
  `,
  host: { class: 'inline-flex' },
})
export class SeriesKey {
  readonly kind = input<'line' | 'bar' | 'track'>('line');
  /** Which series color, line style and marker (ignored by `track`). */
  readonly slot = input<SeriesSlot>(1);

  protected readonly style = computed(() => SERIES_STYLES[this.slot()]);
  protected readonly marker = computed(() => markerPath(this.style().marker, 14, 7, 4.5));
}
