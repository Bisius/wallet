import { Component, computed, inject } from '@angular/core';
import { SavingsStore } from '../../core/savings.store';
import { SelectedMonth } from '../../core/selected-month';
import { Amount } from '../../shared/ui/amount';
import { AsyncSection } from '../../shared/ui/async-section';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { SectionHelp } from '../../shared/ui/section';
import { SeeAllLink } from '../../shared/ui/see-all-link';

/**
 * How many closed months wait to be moved to savings, and the signed total (positive: money to move,
 * negative: money to take from savings), with a link to the Savings page where they are settled. When
 * none is waiting it says so. The figures are `SavingsDto.outstanding` and `outstandingTotal` from the
 * API, through the store that also feeds the badge on the navigation. It is not about the month the
 * switcher selects: it covers every closed month.
 */
@Component({
  selector: 'app-savings-to-move-section',
  imports: [Amount, AppList, AsyncSection, Icon, ListRow, SectionHelp, SeeAllLink],
  template: `
    <app-async-section
      heading="Savings to move"
      description="Closed months waiting to be moved to savings."
      [state]="savings.state()"
      [error]="savings.error()"
      loadingLabel="Loading the savings to move…"
      errorTitle="Couldn't load the savings to move"
      (retry)="savings.reload()"
    >
      <app-see-all-link
        sectionAction
        route="/savings"
        what="savings"
        [queryParams]="selected.linkParams()"
      />
      <p sectionHelp>
        It covers every closed month, whichever month you are looking at. A month shows up here once
        it closes with money left over, or short.
      </p>

      @if (savings.savings()) {
        @if (count() === 0) {
          <ul appList density="compact">
            <li appListRow>
              <app-icon rowLeading name="check-circle" class="text-positive" />
              <span rowTitle>All settled</span>
              <p rowMeta>Every closed month has been moved to savings.</p>
            </li>
          </ul>
        } @else {
          <ul appList density="compact">
            <li appListRow>
              <span rowTitle>
                {{ count() }} {{ count() === 1 ? 'month' : 'months' }} to settle. {{ advice() }}
              </span>
              <app-amount rowAmount [cents]="savings.outstandingTotal()" [signed]="true" plain />
            </li>
          </ul>
        }
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class SavingsToMoveSection {
  protected readonly savings = inject(SavingsStore);
  protected readonly selected = inject(SelectedMonth);

  protected readonly count = this.savings.outstandingCount;

  /** What the sign of the total asks for. */
  protected readonly advice = computed(() => {
    const total = this.savings.outstandingTotal();
    if (total > 0) return 'Move this to savings.';
    if (total < 0) return 'Take this from savings.';
    return 'They cancel each other out.';
  });
}
