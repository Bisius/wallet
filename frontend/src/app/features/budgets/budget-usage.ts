import { Component, computed, input } from '@angular/core';
import type { BudgetAlert, MonthBudgetLine } from '@wallet/shared';
import { MoneyPipe } from '../../shared/money.pipe';
import { Icon, type IconName } from '../../shared/ui/icon';
import { ProgressBar, type ProgressTone } from '../../shared/ui/progress-bar';
import { ALERT_LABELS } from './budget-utils';

/** How the bar of a budget is colored in each alert state. */
const TONES: Record<BudgetAlert, ProgressTone> = {
  ok: 'neutral',
  warning: 'warning',
  over: 'danger',
};

/** The color of the alert words, which always come with an icon and the label itself. */
const TEXT_CLASSES: Record<BudgetAlert, string> = {
  ok: 'text-positive',
  warning: 'text-warning',
  over: 'text-negative',
};

const ICONS: Record<BudgetAlert, IconName> = {
  ok: 'check-circle',
  warning: 'alert',
  over: 'alert',
};

/**
 * How far along a budget is in one month: the progress bar and, under it, the alert state in words
 * ("On track", "Warning", "Over budget") with an icon, then what the percentage means. The Budgets
 * cards and the Dashboard show the same block, so the two never disagree.
 *
 * It only shows what the month view says: `usagePercent`, `alert` and `warnPercent` are the API's.
 * Nothing here compares an amount with a threshold.
 */
@Component({
  selector: 'app-budget-usage',
  imports: [Icon, MoneyPipe, ProgressBar],
  template: `
    <div class="space-y-1.5">
      @if (line().usagePercent !== null) {
        <app-progress-bar
          [label]="line().name + ' usage'"
          [percent]="line().usagePercent ?? 0"
          [tone]="tone()"
          [valueText]="progressText()"
        />
      }
      <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span class="inline-flex items-center gap-1 font-semibold" [class]="alertClass()">
          <app-icon [name]="alertIcon()" />
          {{ alertLabel() }}
        </span>
        <span class="text-muted">
          @if (line().alert === 'over') {
            by {{ -line().remaining | money }}
            @if (line().usagePercent !== null) {
              · {{ line().usagePercent }}% used
            }
          } @else if (line().usagePercent === null) {
            Nothing available this month.
          } @else {
            {{ line().usagePercent }}% used, warns at {{ line().warnPercent }}%
          }
        </span>
      </p>
    </div>
  `,
  host: { class: 'block' },
})
export class BudgetUsage {
  /** The month's figures for the budget (`MonthView.budgets[]`). */
  readonly line = input.required<MonthBudgetLine>();

  protected readonly alertLabel = computed(() => ALERT_LABELS[this.line().alert]);
  protected readonly tone = computed(() => TONES[this.line().alert]);
  protected readonly alertIcon = computed(() => ICONS[this.line().alert]);
  protected readonly alertClass = computed(() => TEXT_CLASSES[this.line().alert]);

  /** "85% used, warning": the bar in words, for a screen reader. */
  protected readonly progressText = computed(() => {
    const percent = this.line().usagePercent;
    return percent === null ? '' : `${percent}% used, ${this.alertLabel().toLowerCase()}`;
  });
}
