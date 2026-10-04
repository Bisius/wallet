import { Component, computed, input } from '@angular/core';
import type { MonthStatus } from '@wallet/shared';
import { Badge, type BadgeTone } from './badge';

/** How a month is named on screen. The status itself comes from the API (`MonthView.status`). */
export const MONTH_STATUS_LABELS: Record<MonthStatus, string> = {
  closed: 'Closed month',
  current: 'Current month',
  future: 'Projection',
};

/** The month that is running stands out, the others (over, or not started) are plain labels. */
const MONTH_STATUS_TONES: Record<MonthStatus, BadgeTone> = {
  closed: 'neutral',
  current: 'accent',
  future: 'neutral',
};

/** A badge with the status of a month, in words: closed, current or a projection. */
@Component({
  selector: 'app-month-status',
  imports: [Badge],
  template: `<app-badge [tone]="tone()">{{ label() }}</app-badge>`,
})
export class MonthStatusBadge {
  readonly status = input.required<MonthStatus>();

  protected readonly label = computed(() => MONTH_STATUS_LABELS[this.status()]);
  protected readonly tone = computed(() => MONTH_STATUS_TONES[this.status()]);
}
