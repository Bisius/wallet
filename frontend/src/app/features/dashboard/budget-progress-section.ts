import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SelectedMonth } from '../../core/selected-month';
import { Amount } from '../../shared/ui/amount';
import { AsyncSection } from '../../shared/ui/async-section';
import { LinkButton } from '../../shared/ui/link-button';
import { AppList, ListRow } from '../../shared/ui/list';
import { SectionHelp } from '../../shared/ui/section';
import { SeeAllLink } from '../../shared/ui/see-all-link';
import { EmptyState } from '../../shared/ui/states';
import { BudgetUsage } from '../budgets/budget-usage';
import { sortByAlert } from './alert-order';
import { DashboardData } from './dashboard-data';

/**
 * One row per budget of the month: its progress bar and alert state (in words, with an icon and a
 * color), what is left, and a "See all" link to the Budgets page for that month. Budgets that are
 * over, then in warning, come first. A month with no budgets says what to do next.
 */
@Component({
  selector: 'app-budget-progress-section',
  imports: [
    Amount,
    AppList,
    AsyncSection,
    BudgetUsage,
    EmptyState,
    LinkButton,
    ListRow,
    RouterLink,
    SectionHelp,
    SeeAllLink,
  ],
  template: `
    <app-async-section
      heading="Budget progress"
      description="What each budget has left."
      [state]="data.viewState()"
      [error]="data.view.error()"
      loadingLabel="Loading budget progress…"
      errorTitle="Couldn't load budget progress"
      (retry)="data.view.reload()"
    >
      @if (hasBudgets()) {
        <app-see-all-link
          sectionAction
          route="/budgets"
          what="budgets"
          [queryParams]="selected.linkParams()"
        />
      }
      @if (hasBudgets()) {
        <p sectionHelp>The budgets that are over, then the ones in warning, come first.</p>
      }

      @if (lines(); as lines) {
        @if (lines.length === 0) {
          <app-empty-state
            [title]="'No budgets in ' + data.monthLabel()"
            description="Create a budget to give part of your income a job. As you add spendings to it, its progress shows up here."
          >
            <a
              appLinkButton
              variant="primary"
              routerLink="/budgets"
              [queryParams]="selected.linkParams()"
            >
              Go to budgets
            </a>
          </app-empty-state>
        } @else {
          <ul appList density="compact">
            @for (line of lines; track line.id) {
              <li appListRow [color]="line.color" amountNote="remaining">
                <span rowTitle>
                  @if (line.icon) {
                    <span aria-hidden="true" class="mr-1 font-emoji">{{ line.icon }}</span>
                  }
                  {{ line.name }}
                </span>
                <p rowMeta>
                  <span>
                    Spent
                    <span class="font-medium text-ink"><app-amount [cents]="line.spent" /></span>
                    · Available
                    <span class="font-medium text-ink"
                      ><app-amount [cents]="line.available"
                    /></span>
                  </span>
                </p>
                <app-amount rowAmount [cents]="line.remaining" />
                <app-budget-usage [line]="line" />
              </li>
            }
          </ul>
        }
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class BudgetProgressSection {
  protected readonly data = inject(DashboardData);
  protected readonly selected = inject(SelectedMonth);

  /** The month's budgets, most urgent first. undefined until the month has loaded. */
  protected readonly lines = computed(() => {
    const view = this.data.monthView();
    return view ? sortByAlert(view.budgets) : undefined;
  });

  /** The link to the Budgets page sits in the card's corner, except where the empty state has one. */
  protected readonly hasBudgets = computed(() => (this.lines()?.length ?? 0) > 0);
}
