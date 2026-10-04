import { Component, computed, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { Alert } from '../../shared/ui/alert';
import { Stat } from '../../shared/ui/stat';
import { StatGrid } from '../../shared/ui/stat-grid';
import { StatStrip } from '../../shared/ui/stat-strip';

/**
 * The year in one strip, with no card around it: income, spent and saved large, fixed costs and
 * budgeted under them, each exactly as the report gives it. Saved is what is **due** to savings (what
 * the months leave over, or are short), not what was moved, and says so. When some of the months have
 * not started, the strip says how many of them its totals include. What a projected month assumes is
 * said once, in the help of "Month by month". What the income and the saved figure are made of is in
 * `ReportBreakdown`.
 */
@Component({
  selector: 'app-report-glance',
  imports: [Alert, Stat, StatGrid, StatStrip],
  template: `
    <app-stat-strip [heading]="report().year + ' at a glance'">
      <dl appStatGrid [columns]="3">
        <div appStat size="lg" label="Income" [cents]="report().income.total"></div>
        <div appStat size="lg" label="Spent" [cents]="report().spent"></div>
        <div
          appStat
          size="lg"
          label="Saved"
          [cents]="report().saved"
          [signed]="true"
          plain
          hint="Due to savings"
        ></div>
      </dl>
      <dl appStatGrid [columns]="2">
        <div appStat label="Fixed costs" [cents]="report().fixedCosts.total"></div>
        <div appStat label="Budgeted" [cents]="report().allocated"></div>
      </dl>
      @if (projectedNote(); as note) {
        <app-alert tone="info">{{ note }}</app-alert>
      }
    </app-stat-strip>
  `,
  host: { class: 'block' },
})
export class ReportGlance {
  readonly report = input.required<YearlyReportDto>();

  /** What the totals include, when some of the months have not started. */
  protected readonly projectedNote = computed(() => {
    const count = this.projected();
    if (count === 0) return undefined;
    return `The totals include ${count} projected ${count === 1 ? 'month' : 'months'}.`;
  });

  /** How many of the included months have not started: their figures are projections. */
  protected readonly projected = computed(
    () => this.report().months.filter((month) => month.status === 'future').length,
  );
}
