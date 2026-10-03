import { Component, computed, input } from '@angular/core';
import type { MonthStatus } from '@wallet/shared';

/** How a month is named on screen. The status itself comes from the API (`MonthView.status`). */
export const MONTH_STATUS_LABELS: Record<MonthStatus, string> = {
  closed: 'Closed month',
  current: 'Current month',
  future: 'Projection',
};

/** A small pill with the status of a month, in words: closed, current or a projection. */
@Component({
  selector: 'app-month-status',
  template: `<span
    class="inline-block rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-medium"
    >{{ label() }}</span
  >`,
})
export class MonthStatusBadge {
  readonly status = input.required<MonthStatus>();

  protected readonly label = computed(() => MONTH_STATUS_LABELS[this.status()]);
}
