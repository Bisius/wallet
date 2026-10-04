import { Component, inject } from '@angular/core';
import { SavingsStore } from '../core/savings.store';
import { Badge } from '../shared/ui/badge';

/**
 * How many closed months wait to be moved to savings, for the end of the Savings link of a
 * navigation (sidebar, tab bar, the "More" sheet). Nothing at all while none does.
 *
 * The number is a picture of the words: it is hidden from assistive technology, which gets the words
 * instead (`, 2 months to move to savings`, after the name of the link, so the link is still found
 * by "Savings").
 */
@Component({
  selector: 'app-savings-badge',
  imports: [Badge],
  template: `
    @if (months() > 0) {
      <app-badge tone="accent" aria-hidden="true">{{ months() }}</app-badge>
      <span class="sr-only"
        >, {{ months() }} {{ months() === 1 ? 'month' : 'months' }} to move to savings</span
      >
    }
  `,
})
export class SavingsBadge {
  protected readonly months = inject(SavingsStore).outstandingCount;
}
