import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SelectedMonth } from '../../core/selected-month';
import { Amount } from '../../shared/ui/amount';
import { Icon } from '../../shared/ui/icon';
import { EmptyState } from '../../shared/ui/states';
import { BudgetUsage } from '../budgets/budget-usage';
import { sortByAlert } from './alert-order';
import { DashboardCard } from './dashboard-card';
import { DashboardData } from './dashboard-data';

/**
 * One row per budget of the month: its progress bar and alert state (in words, with an icon and a
 * color), what is left, and a link to the Budgets page for that month. Budgets that are over, then
 * in warning, come first. A month with no budgets says what to do next.
 */
@Component({
  selector: 'app-budget-progress-section',
  imports: [Amount, BudgetUsage, DashboardCard, EmptyState, Icon, RouterLink],
  template: `
    <app-dashboard-card
      title="Budget progress"
      description="What each budget has left. The ones over budget, then in warning, come first."
      [state]="data.viewState()"
      [error]="data.view.error()"
      loadingLabel="Loading budget progress…"
      errorTitle="Couldn't load budget progress"
      (retry)="data.view.reload()"
    >
      @if (hasBudgets()) {
        <a
          cardAction
          routerLink="/budgets"
          [queryParams]="selected.linkParams()"
          class="inline-flex min-h-9 items-center gap-1 rounded-control px-3 py-1.5 text-sm font-semibold text-accent hover:bg-subtle"
        >
          Open budgets
          <app-icon name="chevron-right" />
        </a>
      }

      @if (lines(); as lines) {
        @if (lines.length === 0) {
          <app-empty-state
            [title]="'No budgets in ' + data.monthLabel()"
            description="Create a budget to give part of your income a job. As you add spendings to it, its progress shows up here."
          >
            <a
              routerLink="/budgets"
              [queryParams]="selected.linkParams()"
              class="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover"
            >
              Go to budgets
            </a>
          </app-empty-state>
        } @else {
          <ul class="grid gap-x-8 gap-y-5 lg:grid-cols-2">
            @for (line of lines; track line.id) {
              <li
                class="space-y-2 border-l-4 border-line pl-3"
                [style.border-left-color]="line.color"
              >
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 class="min-w-0 font-semibold break-words">
                    @if (line.icon) {
                      <span aria-hidden="true" class="mr-1">{{ line.icon }}</span>
                    }
                    {{ line.name }}
                  </h3>
                  <p class="text-sm">
                    <span class="text-muted">Remaining</span>
                    <span class="ml-1 font-semibold"><app-amount [cents]="line.remaining" /></span>
                  </p>
                </div>
                <p class="text-sm text-muted">
                  Spent
                  <span class="font-medium text-ink"><app-amount [cents]="line.spent" /></span>
                  · Available
                  <span class="font-medium text-ink"><app-amount [cents]="line.available" /></span>
                </p>
                <app-budget-usage [line]="line" />
              </li>
            }
          </ul>
        }
      }
    </app-dashboard-card>
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
