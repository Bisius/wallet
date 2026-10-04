import { Component, computed, inject, input, signal } from '@angular/core';
import type { Cents } from '@wallet/shared';
import { SettingsStore } from '../../../core/settings.store';
import { formatMoney } from '../../money.pipe';
import { Button } from '../button';
import { Icon } from '../icon';
import { chartId } from './chart-id';
import { barSpan, type Domain, extent, zeroPosition } from './chart-math';
import { ChartTable, type ChartTableRow } from './chart-table';
import { SeriesKey } from './series-key';
import { SERIES_STYLES, type SeriesSlot } from './series-style';

/** A state the data reported for a row, in words. The chart shows it; it never works it out. */
export interface BarChartStatus {
  /** "On track", "Warning", "Over budget". */
  label: string;
  tone: 'ok' | 'warning' | 'danger';
}

export interface BarChartRow {
  key: string | number;
  label: string;
  /** Decoration before the label (an emoji). Hidden from assistive technology. */
  icon?: string | null;
  /** The bar: from zero to this amount, in cents. Negative when refunds outweigh spendings. */
  value: Cents;
  /**
   * What the bar is measured against (what was available), or null. A track is drawn only when it
   * is above zero. The bar runs on past the end of its track when the value is greater, which is how
   * overspending is seen.
   */
  track: Cents | null;
  /** The state the data reported, shown in words with an icon (never only as a color). */
  status?: BarChartStatus | null;
  /** More about the row, in muted text under it ("by €300.00", "Nothing available"). */
  note?: string | null;
}

/**
 * Horizontal bars, one row per category, for amounts: each bar runs from zero to its value, over a
 * track that shows what it is measured against, so a bar that leaves its track is plainly over. All
 * rows share one scale, so bar lengths compare across rows; a negative value runs left of a zero
 * line.
 *
 * Every row says its figures in text (name, value, "of" the track), so the bars are never the only
 * way to read the numbers, and states are written with an icon besides their color. The marks are
 * SVG sized in percent of their row, so there is no measuring and no scaling of text. For assistive
 * technology the picture is replaced by a real table (shown to everyone with "Show table"). The bars
 * do not animate.
 */
@Component({
  selector: 'app-bar-chart',
  imports: [Button, ChartTable, Icon, SeriesKey],
  template: `
    <figure class="space-y-3" [attr.aria-label]="label()">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ul aria-label="Legend" class="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          <li class="inline-flex items-center gap-2">
            <app-series-key kind="bar" [slot]="slot()" />
            <span class="text-muted">{{ valueLabel() }}</span>
          </li>
          @if (hasTrack()) {
            <li class="inline-flex items-center gap-2">
              <app-series-key kind="track" />
              <span class="text-muted">{{ trackLabel() }}</span>
            </li>
          }
        </ul>
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

      <ul aria-hidden="true" class="space-y-4">
        @for (row of rowViews(); track row.key) {
          <li class="space-y-1.5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span class="min-w-0 flex-1 basis-32 font-medium break-words">
                @if (row.icon) {
                  <span class="mr-1 font-emoji">{{ row.icon }}</span>
                }
                {{ row.label }}
              </span>
              <span class="ml-auto text-right text-sm tabular-nums">
                <span class="font-semibold">{{ row.valueText }}</span>
                @if (row.trackText) {
                  <span class="text-muted"> of {{ row.trackText }}</span>
                }
              </span>
            </div>

            <svg focusable="false" class="block h-4 w-full overflow-visible">
              @if (zero() > 0 && zero() < 100) {
                <line
                  [attr.x1]="zero() + '%'"
                  [attr.x2]="zero() + '%'"
                  y1="0"
                  y2="16"
                  class="stroke-line-strong"
                />
              }
              @if (row.trackSpan; as span) {
                <rect
                  [attr.x]="span.start + '%'"
                  [attr.width]="span.size + '%'"
                  y="0.5"
                  height="15"
                  rx="7.5"
                  fill="none"
                  class="stroke-line-strong"
                />
              }
              @if (row.barSpan.size > 0) {
                <rect
                  [attr.x]="row.barSpan.start + '%'"
                  [attr.width]="row.barSpan.size + '%'"
                  y="4"
                  height="8"
                  rx="4"
                  [class]="barFill()"
                />
              }
            </svg>

            @if (row.alert || row.note) {
              <p class="flex flex-wrap items-center gap-x-1.5 text-sm">
                @if (row.alert; as alert) {
                  <span
                    class="inline-flex items-center gap-1 font-semibold"
                    [class]="alert.tone === 'danger' ? 'text-negative' : 'text-warning'"
                  >
                    <app-icon name="alert" />
                    {{ alert.label }}
                  </span>
                }
                @if (row.note) {
                  <span class="text-muted">{{ row.note }}</span>
                }
              </p>
            }
          </li>
        }
      </ul>

      <app-chart-table
        [tableId]="tableId"
        [caption]="label()"
        [columns]="tableColumns()"
        [rows]="tableRows()"
        [visible]="showTable()"
      />
    </figure>
  `,
  host: { class: 'block' },
})
export class BarChart {
  private readonly settings = inject(SettingsStore);

  /** What the chart shows, as its accessible name and the caption of its table. */
  readonly label = input.required<string>();
  readonly rows = input.required<readonly BarChartRow[]>();
  /** The series color of the bars (a measure keeps its color on every chart). */
  readonly slot = input<SeriesSlot>(1);
  /** Names the bars in the legend and the table: "Spent". */
  readonly valueLabel = input('Value');
  /** Names the tracks in the legend and the table: "Available". */
  readonly trackLabel = input('Available');
  /** The heading of the first column of the table: "Budget". */
  readonly nameLabel = input('Name');
  /** The heading of the table's column for each row's state and note. */
  readonly statusLabel = input('State');

  protected readonly tableId = chartId('bar-chart-table');
  protected readonly showTable = signal(false);

  protected readonly barFill = computed(() => SERIES_STYLES[this.slot()].fill);

  private money(cents: Cents): string {
    return formatMoney(cents, this.settings.locale(), this.settings.currency());
  }

  /** One scale for every row, from the lowest bar (or 0) to the longest bar or track. */
  private readonly domain = computed<Domain>(() => {
    const range = extent(
      this.rows().flatMap((row) =>
        row.track !== null && row.track > 0 ? [row.value, row.track] : [row.value],
      ),
    );
    return [Math.min(0, range?.[0] ?? 0), Math.max(0, range?.[1] ?? 0)];
  });

  /** Where the zero line is, in percent. Only shown when some bar runs to its left. */
  protected readonly zero = computed(() => zeroPosition(this.domain()));

  protected readonly hasTrack = computed(() =>
    this.rows().some((row) => row.track !== null && row.track > 0),
  );

  protected readonly rowViews = computed(() => {
    const domain = this.domain();
    return this.rows().map((row) => {
      const hasTrack = row.track !== null && row.track > 0;
      return {
        key: row.key,
        label: row.label,
        icon: row.icon ?? null,
        // A state that needs attention is written under the bar. "On track" is only in the table.
        alert: row.status && row.status.tone !== 'ok' ? row.status : null,
        note: row.note ?? null,
        valueText: this.money(row.value),
        trackText: hasTrack && row.track !== null ? this.money(row.track) : null,
        barSpan: barSpan(row.value, domain),
        trackSpan: hasTrack && row.track !== null ? barSpan(row.track, domain) : null,
      };
    });
  });

  private readonly withState = computed(() => this.rows().some((row) => row.status || row.note));

  protected readonly tableColumns = computed(() => [
    this.nameLabel(),
    this.valueLabel(),
    this.trackLabel(),
    ...(this.withState() ? [this.statusLabel()] : []),
  ]);

  protected readonly tableRows = computed<ChartTableRow[]>(() =>
    this.rows().map((row) => ({
      header: row.label,
      cells: [
        this.money(row.value),
        row.track === null ? 'None' : this.money(row.track),
        ...(this.withState() ? [[row.status?.label, row.note].filter(Boolean).join(' ')] : []),
      ],
    })),
  );
}
