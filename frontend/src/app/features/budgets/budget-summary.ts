import { Component, computed, input } from '@angular/core';
import type { Cents, MonthStatus, MonthView } from '@wallet/shared';
import { MoneyPipe } from '../../shared/money.pipe';
import { Alert } from '../../shared/ui/alert';
import { Icon } from '../../shared/ui/icon';
import { MonthStatusBadge } from '../../shared/ui/month-status';
import { SectionHelp } from '../../shared/ui/section';
import { Stat, StatNote, type StatSize } from '../../shared/ui/stat';
import { StatGrid, type StatColumns } from '../../shared/ui/stat-grid';
import { StatStrip } from '../../shared/ui/stat-strip';

/** What a month's status means for the figures below it, in a sentence. */
const STATUS_EXPLANATIONS: Record<MonthStatus, string> = {
  closed:
    'This month is over, so its figures are final. Changing something in it now changes what is due to savings.',
  current:
    'This month is still running, so these figures update as you add spendings. What carries over or moves to savings is a projection, as if the month ended today.',
  future:
    'This month has not started yet. These figures are a projection that assumes the current month ends as it stands now.',
};

/** The figures of the month view that a strip can show: each is one field of it. */
type Figure = 'income' | 'spent' | 'unallocated' | 'fixedCosts' | 'budgeted';

const LABELS: Record<Figure, string> = {
  income: 'Income',
  spent: 'Spent',
  unallocated: 'Unallocated',
  fixedCosts: 'Fixed costs',
  budgeted: 'Budgeted',
};

interface Layout {
  columns: StatColumns;
  /** The figures in the order they are shown, each with its size. */
  figures: readonly { key: Figure; size: StatSize }[];
}

/**
 * `full` is the Dashboard's strip: what came in, what went out and what is left are the big figures,
 * what was set aside for fixed costs and budgets are smaller. `slim` is the Budgets page's: only what
 * the budgets add up to and what is left to give a job (the rest is on the Dashboard, and the cards
 * show what each budget spent).
 */
const LAYOUTS = {
  full: {
    columns: 5,
    figures: [
      { key: 'income', size: 'lg' },
      { key: 'spent', size: 'lg' },
      { key: 'unallocated', size: 'lg' },
      { key: 'fixedCosts', size: 'md' },
      { key: 'budgeted', size: 'md' },
    ],
  },
  slim: {
    columns: 2,
    figures: [
      { key: 'budgeted', size: 'md' },
      { key: 'unallocated', size: 'md' },
    ],
  },
} satisfies Record<string, Layout>;

export type BudgetSummaryLayout = keyof typeof LAYOUTS;

/**
 * The month at a glance: a strip of figures from the month view, the status of the month in words,
 * and what the status means folded away under them. When more is planned than the month earns the
 * strip says so in an alert, and by how much. Every number is a field of the month view.
 *
 * The Dashboard and the Budgets page both show it, each with the figures that suit it (`layout`), so
 * the two never disagree about what a figure is called or says.
 */
@Component({
  selector: 'app-budget-summary',
  imports: [
    Alert,
    Icon,
    MoneyPipe,
    MonthStatusBadge,
    SectionHelp,
    Stat,
    StatGrid,
    StatNote,
    StatStrip,
  ],
  template: `
    <app-stat-strip [heading]="monthLabel() + ' at a glance'">
      <app-month-status stripStatus [status]="view().status" />

      <dl appStatGrid [columns]="shown().columns">
        @for (figure of shown().figures; track figure.key) {
          <div
            appStat
            [label]="labels[figure.key]"
            [size]="figure.size"
            [cents]="cents(figure.key)"
          >
            @if (figure.key === 'unallocated' && view().overAllocated) {
              <dd statNote tone="negative">
                <app-icon name="alert" />
                Over-allocated
              </dd>
            }
          </div>
        }
      </dl>

      @if (view().overAllocated) {
        <app-alert tone="error" [title]="'Over-allocated by ' + (-view().unallocated | money)">
          @if (view().status === 'closed') {
            Fixed costs and budgets added up to more than this month's income, so that amount is
            taken from savings.
          } @else {
            Fixed costs and budgets add up to more than this month's income. Lower a budget or add
            income, or that amount will be taken from savings when the month closes.
          }
        </app-alert>
      }

      <p sectionHelp>{{ explanation() }}</p>
    </app-stat-strip>
  `,
  host: { class: 'block' },
})
export class BudgetSummary {
  readonly view = input.required<MonthView>();
  /** The month's name, as the page shows it ("October 2026"). */
  readonly monthLabel = input.required<string>();
  /** Which figures to show: all of them (`full`, the Dashboard) or only the budgeted and the unallocated (`slim`). */
  readonly layout = input<BudgetSummaryLayout>('full');

  protected readonly labels = LABELS;
  protected readonly shown = computed<Layout>(() => LAYOUTS[this.layout()]);
  protected readonly explanation = computed(() => STATUS_EXPLANATIONS[this.view().status]);

  protected cents(figure: Figure): Cents {
    const view = this.view();
    switch (figure) {
      case 'income':
        return view.income.total;
      case 'spent':
        return view.totals.spent;
      case 'unallocated':
        return view.unallocated;
      case 'fixedCosts':
        return view.fixedCosts;
      case 'budgeted':
        return view.totals.allocated;
    }
  }
}
