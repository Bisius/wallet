import { Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import type { Cents } from '@wallet/shared';
import { SettingsStore } from '../../../core/settings.store';
import { formatMoney } from '../../money.pipe';
import { Button } from '../button';
import { chartId } from './chart-id';
import {
  estimateTextWidth,
  labelIndexes,
  labelStride,
  linearScale,
  linePath,
  markerPath,
  niceScaleOf,
  pointPositions,
} from './chart-math';
import { elementWidth } from './chart-size';
import { ChartTable, type ChartTableRow } from './chart-table';
import { SeriesKey } from './series-key';
import { SERIES_STYLES, type SeriesSlot } from './series-style';

/** One position along the x axis: a month. */
export interface LineChartCategory {
  /** Identifies the category across data changes (`2026-10`). */
  key: string;
  /** The short axis label: "Oct". */
  label: string;
  /** Written under the label when it changes along the axis, like the year. */
  group: string;
  /** The full name, for the readout, the table and screen readers: "October 2026". */
  name: string;
  /** What kind of point it is ("Closed month", "Projection"), or null. */
  note: string | null;
  /** The figures are a projection, not a result: its markers are drawn hollow. */
  projected: boolean;
}

/** One line: a measure over the categories. */
export interface LineChartSeries {
  key: string;
  /** Its name in the legend, the table and the readout: "Income". */
  label: string;
  /** Which series color, line style and marker it has. Follows the measure, never its rank. */
  slot: SeriesSlot;
  /** One amount, in cents, for each category. Negative amounts are drawn below the zero line. */
  values: readonly Cents[];
  /** Write a plus sign before a positive amount: for a figure whose sign says which way it goes. */
  signed?: boolean;
}

const HEIGHT = 256;
const TOP = 12;
/** Room under the plot for the month labels and, under them, the year. */
const AXIS_BAND = 44;
const RIGHT = 12;
const FONT_SIZE = 12;
const MARKER_RADIUS = 5;
const ACTIVE_MARKER_RADIUS = 6.5;
/** How far in from the edges of the plot the first and last points sit, so their markers fit. */
const POINT_PADDING = 14;
/** The width the chart assumes until it has been measured, and wherever it cannot be. */
const FALLBACK_WIDTH = 640;

/** A hairline drawn on the pixel grid, so it is one crisp pixel wide instead of two soft ones. */
const crisp = (position: number) => Math.round(position) + 0.5;

/**
 * Lines over categories (months), for amounts that can be negative. Hand-drawn SVG that lays itself
 * out in real pixels, so its text stays the size of the page's text on a phone.
 *
 * **Reading it.** A legend names each line and shows its value for the month in focus: by default the
 * last one (the selected month), then whichever the pointer is over or the keyboard is on (the one
 * used last wins), or a month a tap kept (let go by tapping it again, tapping outside the chart, or
 * Escape). A hairline marks that month on the plot. Hollow markers are projections.
 *
 * **Accessibility.** Each line is told apart by hue, by line style (solid, dashed, dotted) and by the
 * shape of its markers, in the plot and in the legend. Every month is a focusable stop (one tab stop
 * for the chart, the arrow keys, Home and End move between months) whose name lists all its values.
 * The same numbers are in a real table that screen readers always have and anyone can open with
 * "Show table". The picture itself is hidden from assistive technology: it adds nothing the stops and
 * the table do not say. Nothing animates, so there is nothing for reduced motion to switch off.
 *
 * The chart draws what it is given: amounts are in cents and are only formatted here, never summed.
 */
@Component({
  selector: 'app-line-chart',
  imports: [Button, ChartTable, SeriesKey],
  template: `
    <figure class="space-y-3" [attr.aria-label]="label()">
      <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        @if (readout(); as current) {
          <div class="space-y-1.5">
            <p class="text-sm font-medium">
              {{ current.name }}
              @if (current.note) {
                <span class="font-normal text-muted">· {{ current.note }}</span>
              }
            </p>
            <ul aria-label="Legend" class="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              @for (value of current.values; track value.key) {
                <li class="inline-flex items-center gap-2">
                  <app-series-key kind="line" [slot]="value.slot" />
                  <span class="text-muted">{{ value.label }}</span>
                  <span class="font-semibold tabular-nums">{{ value.text }}</span>
                </li>
              }
            </ul>
          </div>
        }
        <button
          appButton
          variant="ghost"
          size="sm"
          [attr.aria-expanded]="showTable()"
          [attr.aria-controls]="tableId"
          (click)="showTable.set(!showTable())"
        >
          {{ showTable() ? 'Hide table' : 'Show table' }}
        </button>
      </div>

      <div #frame class="relative" [style.height.px]="height">
        <svg
          aria-hidden="true"
          focusable="false"
          class="absolute inset-0 block size-full overflow-visible"
          [attr.viewBox]="'0 0 ' + width() + ' ' + height"
        >
          @for (tick of yAxis(); track tick.value) {
            <line
              [attr.x1]="plot().left"
              [attr.x2]="plot().right"
              [attr.y1]="tick.y"
              [attr.y2]="tick.y"
              [class]="tick.isZero ? 'stroke-line-strong' : 'stroke-line'"
            />
            <text
              [attr.x]="plot().left - 8"
              [attr.y]="tick.y"
              dy="0.32em"
              text-anchor="end"
              class="fill-muted text-xs tabular-nums"
            >
              {{ tick.text }}
            </text>
          }

          @for (label of xLabels(); track label.key) {
            <text
              [attr.x]="label.x"
              [attr.y]="plot().bottom + 16"
              text-anchor="middle"
              class="text-xs"
              [class]="label.active ? 'fill-ink font-semibold' : 'fill-muted'"
            >
              {{ label.text }}
            </text>
            @if (label.group) {
              <text
                [attr.x]="label.x"
                [attr.y]="plot().bottom + 31"
                text-anchor="middle"
                class="fill-muted text-xs"
              >
                {{ label.group }}
              </text>
            }
          }

          @if (crosshairX() !== null) {
            <line
              [attr.x1]="crosshairX()"
              [attr.x2]="crosshairX()"
              [attr.y1]="plot().top"
              [attr.y2]="plot().bottom"
              class="stroke-line-strong"
            />
          }

          @for (line of linePaths(); track line.key) {
            @if (line.path) {
              <path
                [attr.d]="line.path"
                fill="none"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                [class]="line.stroke"
                [attr.stroke-dasharray]="line.dash"
              />
            }
          }
          @for (series of markers(); track series.key) {
            @for (marker of series.markers; track marker.key) {
              <path [attr.d]="marker.d" stroke-width="2" [class]="marker.class" />
            }
          }
        </svg>

        <div
          role="group"
          class="absolute inset-0"
          [attr.aria-label]="pointsLabel()"
          [attr.aria-describedby]="hintId"
        >
          @for (stop of stops(); track stop.key; let index = $index) {
            <div
              role="img"
              data-stop
              class="absolute top-0 h-full cursor-default"
              [style.left.px]="stop.left"
              [style.width.px]="stop.width"
              [attr.tabindex]="index === tabIndex() ? 0 : -1"
              [attr.aria-label]="stop.label"
              (pointerenter)="hover(stop.key)"
              (pointerleave)="hover(null)"
              (click)="pin(stop.key)"
              (focus)="focusStop(stop.key)"
              (blur)="blurStop(stop.key)"
              (keydown)="onKeydown($event, index)"
            ></div>
          }
        </div>
      </div>

      <p [id]="hintId" class="sr-only">{{ hint() }}</p>
      @if (notes().length > 0) {
        <p class="text-sm text-muted">{{ notes().join(' ') }}</p>
      }

      <app-chart-table
        [tableId]="tableId"
        [caption]="label()"
        [columns]="tableColumns()"
        [rows]="tableRows()"
        [visible]="showTable()"
      />
    </figure>
  `,
  host: {
    class: 'block',
    // A month a tap kept in focus is let go of when the user taps anywhere else.
    '(document:pointerdown)': 'releaseOutside($event)',
  },
})
export class LineChart {
  private readonly settings = inject(SettingsStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** What the chart shows, as its accessible name and the caption of its table. */
  readonly label = input.required<string>();
  readonly categories = input.required<readonly LineChartCategory[]>();
  readonly series = input.required<readonly LineChartSeries[]>();
  /** The heading of the first column of the table: "Month". */
  readonly categoryLabel = input('Month');
  /** The heading of the table's column for each category's note: "Status". */
  readonly noteLabel = input('Status');
  /** The name of the group of stops, for screen readers: "Months". */
  readonly pointsLabel = input('Data points');
  /** How to move between the stops, for screen readers. */
  readonly hint = input('Use the left and right arrow keys to move between points.');

  protected readonly height = HEIGHT;
  protected readonly hintId = chartId('line-chart-hint');
  protected readonly tableId = chartId('line-chart-table');
  protected readonly showTable = signal(false);

  // Which category is in focus, as the category's key so it survives a change of the data. What is in
  // focus is whatever the user touched last: the pointer or the keyboard (`leader`), then the other,
  // then a month a tap pinned, then the last month.
  private readonly hoveredKey = signal<string | null>(null);
  private readonly focusedKey = signal<string | null>(null);
  private readonly pinnedKey = signal<string | null>(null);
  private readonly leader = signal<'hover' | 'focus'>('hover');
  /** The stop that is in the tab order: the last one that had focus, else the last category. */
  private readonly tabKey = signal<string | null>(null);

  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  protected readonly width = elementWidth(this.frame, FALLBACK_WIDTH);

  private readonly count = computed(() => this.categories().length);

  private indexOf(key: string | null): number {
    return key === null ? -1 : this.categories().findIndex((category) => category.key === key);
  }

  /** The category the readout and the hairline show. */
  private readonly activeIndex = computed(() => {
    const hovered = this.hoveredKey();
    const focused = this.focusedKey();
    const key =
      this.leader() === 'hover'
        ? (hovered ?? focused ?? this.pinnedKey())
        : (focused ?? hovered ?? this.pinnedKey());
    const index = this.indexOf(key);
    return index >= 0 ? index : this.count() - 1;
  });
  protected readonly tabIndex = computed(() => {
    const index = this.indexOf(this.tabKey());
    return index >= 0 ? index : this.count() - 1;
  });

  // --- text -------------------------------------------------------------------------------------

  private amount(cents: Cents, signed: boolean | undefined): string {
    const text = formatMoney(cents, this.settings.locale(), this.settings.currency());
    return signed && cents > 0 ? `+${text}` : text;
  }

  /** Every category's figures as text: the readout, the stops' names and the table all use it. */
  private readonly details = computed(() =>
    this.categories().map((category, index) => ({
      key: category.key,
      name: category.name,
      note: category.note,
      values: this.series().map((series) => ({
        key: series.key,
        label: series.label,
        slot: series.slot,
        text: this.amount(series.values[index] ?? 0, series.signed),
      })),
    })),
  );

  protected readonly readout = computed(() => this.details()[this.activeIndex()]);

  protected readonly tableColumns = computed(() => {
    const columns = [this.categoryLabel()];
    if (this.categories().some((category) => category.note)) columns.push(this.noteLabel());
    return [...columns, ...this.series().map((series) => series.label)];
  });

  protected readonly tableRows = computed<ChartTableRow[]>(() => {
    const withNotes = this.categories().some((category) => category.note);
    return this.details().map((detail) => ({
      header: detail.name,
      cells: [...(withNotes ? [detail.note ?? ''] : []), ...detail.values.map((v) => v.text)],
    }));
  });

  /** A line or two under the chart for what the picture alone does not say. */
  protected readonly notes = computed(() => {
    const notes: string[] = [];
    if (this.count() === 1) {
      notes.push('There is only one month to show, so there are no lines to draw yet.');
    }
    if (this.categories().some((category) => category.projected)) {
      notes.push('Hollow markers are projections.');
    }
    return notes;
  });

  // --- layout -----------------------------------------------------------------------------------

  private readonly scale = computed(() =>
    niceScaleOf(
      this.series().flatMap((series) => series.values),
      4,
    ),
  );

  private readonly tickLabels = computed(() => {
    const { ticks } = this.scale();
    // Whole currency units read better without decimals: "€2,000". Anything finer keeps its cents.
    const whole = ticks.every((tick) => tick % 100 === 0);
    return ticks.map((value) => ({
      value,
      text: formatMoney(value, this.settings.locale(), this.settings.currency(), whole),
    }));
  });

  protected readonly plot = computed(() => {
    const widest = Math.max(
      0,
      ...this.tickLabels().map((t) => estimateTextWidth(t.text, FONT_SIZE)),
    );
    const left = widest + 16;
    return {
      left,
      right: Math.max(left + 1, this.width() - RIGHT),
      top: TOP,
      bottom: HEIGHT - AXIS_BAND,
    };
  });

  private readonly y = computed(() => {
    const { min, max } = this.scale();
    const { top, bottom } = this.plot();
    return linearScale([min, max], [bottom, top]);
  });

  /** Where each category's point is along the x axis. */
  private readonly spread = computed(() => {
    const { left, right } = this.plot();
    return pointPositions(this.count(), left, right, POINT_PADDING);
  });

  protected readonly yAxis = computed(() =>
    this.tickLabels().map((tick) => ({
      value: tick.value,
      text: tick.text,
      y: crisp(this.y()(tick.value)),
      isZero: tick.value === 0,
    })),
  );

  protected readonly xLabels = computed(() => {
    const categories = this.categories();
    const { positions } = this.spread();
    const { left, right } = this.plot();
    const widest = Math.max(
      0,
      ...categories.map((c) =>
        Math.max(estimateTextWidth(c.label, FONT_SIZE), estimateTextWidth(c.group, FONT_SIZE)),
      ),
    );
    const stride = labelStride(categories.length, right - left, widest + 8);
    const active = this.activeIndex();

    let previousGroup: string | null = null;
    return labelIndexes(categories.length, stride).map((index) => {
      const category = categories[index];
      const group =
        category.group !== '' && category.group !== previousGroup ? category.group : null;
      previousGroup = category.group;
      return {
        key: category.key,
        x: positions[index],
        text: category.label,
        group,
        active: index === active,
      };
    });
  });

  protected readonly crosshairX = computed(() => {
    const x = this.spread().positions[this.activeIndex()];
    return x === undefined ? null : crisp(x);
  });

  /** The path of each line. One point has no line: its marker is all there is to draw. */
  protected readonly linePaths = computed(() =>
    this.series().map((series) => {
      const style = SERIES_STYLES[series.slot];
      const y = this.y();
      const points = this.spread().positions.map((x, index) => ({
        x,
        y: y(series.values[index] ?? 0),
      }));
      return {
        key: series.key,
        path: points.length > 1 ? linePath(points) : '',
        stroke: style.stroke,
        dash: style.dash,
      };
    }),
  );

  protected readonly markers = computed(() =>
    this.series().map((series) => {
      const style = SERIES_STYLES[series.slot];
      const y = this.y();
      const active = this.activeIndex();
      const categories = this.categories();
      return {
        key: series.key,
        markers: this.spread().positions.map((x, index) => ({
          key: categories[index].key,
          d: markerPath(
            style.marker,
            x,
            y(series.values[index] ?? 0),
            index === active ? ACTIVE_MARKER_RADIUS : MARKER_RADIUS,
          ),
          // A result is a filled marker with a ring of the surface color, so overlapping markers stay
          // legible. A projection is the same marker, hollow.
          class: categories[index].projected
            ? `fill-surface ${style.stroke}`
            : `${style.fill} stroke-surface`,
        })),
      };
    }),
  );

  /**
   * The invisible, focusable column over each month: the target for the pointer and the keyboard. The
   * columns tile the plot, each centered on its point, so the pointer only has to be near.
   */
  protected readonly stops = computed(() => {
    const { positions, step } = this.spread();
    const { left, right } = this.plot();
    return this.details().map((detail, index) => {
      const from = Math.max(left, positions[index] - step / 2);
      const to = Math.min(right, positions[index] + step / 2);
      return {
        key: detail.key,
        left: from,
        width: Math.max(0, to - from),
        label:
          `${detail.name}${detail.note ? `, ${detail.note.toLowerCase()}` : ''}: ` +
          detail.values.map((value) => `${value.label} ${value.text}`).join(', '),
      };
    });
  });

  // --- interaction ------------------------------------------------------------------------------

  protected hover(key: string | null): void {
    this.hoveredKey.set(key);
    if (key !== null) this.leader.set('hover');
  }

  protected focusStop(key: string): void {
    this.focusedKey.set(key);
    this.tabKey.set(key);
    this.leader.set('focus');
  }

  /**
   * A tap (or click) keeps its month in focus after the pointer has gone. The same month again lets
   * go, and so does a tap anywhere outside the chart (a finger has no Escape key).
   */
  protected pin(key: string): void {
    this.pinnedKey.update((current) => (current === key ? null : key));
  }

  protected releaseOutside(event: Event): void {
    if (this.pinnedKey() === null) return;
    if (event.target instanceof Node && this.host.nativeElement.contains(event.target)) return;
    this.pinnedKey.set(null);
  }

  protected blurStop(key: string): void {
    if (this.focusedKey() === key) this.focusedKey.set(null);
  }

  /** Left and right move between months, Home and End go to the ends, Escape lets go of a tap. */
  protected onKeydown(event: KeyboardEvent, index: number): void {
    const last = this.count() - 1;
    let target: number;
    switch (event.key) {
      case 'ArrowLeft':
        target = Math.max(0, index - 1);
        break;
      case 'ArrowRight':
        target = Math.min(last, index + 1);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = last;
        break;
      case 'Escape':
        this.pinnedKey.set(null);
        this.hoveredKey.set(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    this.host.nativeElement.querySelectorAll<HTMLElement>('[data-stop]')[target]?.focus();
  }
}
