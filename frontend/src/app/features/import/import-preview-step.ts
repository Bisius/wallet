import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { Alert } from '../../shared/ui/alert';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Stat } from '../../shared/ui/stat';
import { StatGrid } from '../../shared/ui/stat-grid';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { REJECTION_TEXT } from './import-text';
import { ImportPreviewTable } from './import-preview-table';
import { ImportReviewStore, ROW_FILTERS, type RowFilter } from './import-review.store';
import { ImportWizardStore } from './import-wizard.store';

/**
 * Step 3: the server's verdict on every row, and the person's decisions: which rows to import and
 * which budget each goes to. A row that is ready to import and has a suggested budget starts ticked;
 * credits, duplicates and rows with errors start unticked (duplicates and errors cannot be ticked).
 * The counts, the badges and the suggestions are the server's. Import is off until at least one row
 * is ticked and every ticked row has a budget, and it stores all the ticked rows or none.
 */
@Component({
  selector: 'app-import-preview-step',
  imports: [
    AppSection,
    SectionHelp,
    Alert,
    Field,
    AppInput,
    Amount,
    Button,
    Stat,
    StatGrid,
    EmptyState,
    ErrorState,
    LoadingState,
    RouterLink,
    ImportPreviewTable,
  ],
  template: `
    <app-section
      heading="Review the rows"
      description="Tick the rows to import and check the budget of each. Nothing is stored until you press Import."
      focusable
    >
      <p sectionHelp>
        The counts overlap: a row can be a credit and a duplicate at once. A credit is a row on the
        other side of your sign setting, usually a salary or a transfer in. It stays unticked unless
        you tick it, and then it is stored as a refund that lowers its budget's spending.
      </p>
      <p sectionHelp>
        "All shown rows" means every row of this filter, on every page. Duplicates and rows with
        errors can't be ticked, and credits are only ticked when you show Credits.
      </p>

      @if (review.summary()) {
        <dl appStatGrid [columns]="5">
          @for (stat of stats(); track stat.label) {
            <div appStat variant="plain" [label]="stat.label">{{ stat.value }}</div>
          }
        </dl>
      }

      @if (review.rejected().length > 0) {
        <app-alert tone="error" title="Nothing was imported">
          <p>
            The server refused {{ review.rejected().length }}
            {{ review.rejected().length === 1 ? 'row' : 'rows' }}, so it stored none of them. The
            table below is up to date: fix them or untick them, then import again.
          </p>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            @for (row of review.rejected(); track row.line) {
              <li>Line {{ row.line }}: {{ rejectionText(row.codes) }}</li>
            }
          </ul>
        </app-alert>
      }

      @if (review.commitFailure(); as failure) {
        <app-alert tone="error" title="Nothing was imported">
          <p>{{ failure.message }}</p>
          <p class="mt-1">
            @if (failure.status === 413 || failure.status === 400) {
              Go back to change the file or the columns, then try again.
            } @else {
              Nothing was stored, so you can try again.
            }
          </p>
        </app-alert>
      }

      @switch (review.budgetsState()) {
        @case ('loading') {
          <app-loading-state label="Loading your budgets…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load your budgets"
            [error]="review.budgetsError()"
            (retry)="reloadBudgets()"
          />
        }
        @default {
          @if (review.budgets().length === 0) {
            <app-empty-state
              title="You have no budgets yet"
              description="A spending belongs to a budget. Create one, then import the file."
            >
              <a appLinkButton variant="primary" routerLink="/budgets">Go to budgets</a>
            </app-empty-state>
          } @else {
            <div role="group" aria-label="Choose rows" class="space-y-4">
              <div class="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-end">
                <app-field label="Show">
                  <select appInput (change)="onFilter($event)">
                    @for (option of filters(); track option.id) {
                      <option [value]="option.id" [selected]="option.id === review.filter()">
                        {{ option.label }} ({{ option.count }})
                      </option>
                    }
                  </select>
                </app-field>
                <div class="flex flex-wrap gap-2">
                  <button appButton variant="secondary" size="sm" (click)="review.selectMatching()">
                    Tick all shown rows
                  </button>
                  <button
                    appButton
                    variant="secondary"
                    size="sm"
                    (click)="review.unselectMatching()"
                  >
                    Untick all shown rows
                  </button>
                </div>
              </div>

              <div class="grid gap-4 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
                <app-field label="Budget for the ticked rows">
                  <select appInput (change)="onBulkBudget($event)">
                    <option value="" [selected]="bulkBudget() === null">Choose a budget</option>
                    @for (budget of bulkOptions(); track budget.id) {
                      <option [value]="budget.id" [selected]="budget.id === bulkBudget()">
                        {{ budget.label }}
                      </option>
                    }
                  </select>
                </app-field>
                <div>
                  <button
                    appButton
                    variant="secondary"
                    [disabled]="review.selectedCount() === 0 || bulkBudget() === null"
                    (click)="applyBulk()"
                  >
                    Set budget for the ticked rows
                  </button>
                </div>
              </div>
              <div role="status" class="empty:hidden">
                @if (review.bulkNotice(); as notice) {
                  <app-alert tone="info">{{ notice }}</app-alert>
                }
              </div>
            </div>

            <app-import-preview-table />
          }
        }
      }

      <p role="status" class="text-sm">
        <span class="font-semibold tabular-nums">{{ review.selectedCount() }}</span>
        {{ review.selectedCount() === 1 ? 'row' : 'rows' }} selected of {{ total() }}.
        @if (review.selectedCount() > 0) {
          Together
          <span class="font-semibold"
            ><app-amount [cents]="review.selectedTotal()" [plain]="true"
          /></span>
          (refunds and credits are subtracted).
        }
      </p>

      <div class="wizard-actions">
        <button
          appButton
          variant="secondary"
          [disabled]="review.committing()"
          (click)="wizard.back()"
        >
          Back
        </button>
        <div class="flex flex-wrap items-center justify-end gap-3">
          @if (review.commitBlocker(); as blocker) {
            <p id="import-blocker" class="text-sm text-muted">
              {{ blocker }}
              @if (review.selectedWithoutBudget() > 0) {
                <button appButton variant="ghost" size="sm" (click)="showNeedsBudget()">
                  Show them
                </button>
              }
            </p>
          }
          <button
            appButton
            [loading]="review.committing()"
            [disabled]="!review.canCommit()"
            [attr.aria-describedby]="review.commitBlocker() ? 'import-blocker' : null"
            (click)="review.commit()"
          >
            Import {{ review.selectedCount() }}
            {{ review.selectedCount() === 1 ? 'spending' : 'spendings' }}
          </button>
        </div>
      </div>
    </app-section>
  `,
  host: { class: 'block' },
})
export class ImportPreviewStep {
  protected readonly review = inject(ImportReviewStore);
  protected readonly wizard = inject(ImportWizardStore);
  private readonly settings = inject(SettingsStore);

  /** The budget chosen for "set the budget of the ticked rows". */
  protected readonly bulkBudget = signal<number | null>(null);

  private readonly number = computed(() => new Intl.NumberFormat(this.settings.locale()));

  protected readonly total = computed(() =>
    this.number().format(this.review.summary()?.total ?? 0),
  );

  /** The counts of the summary, as the server gave them. */
  protected readonly stats = computed(() => {
    const summary = this.review.summary();
    if (!summary) return [];
    const n = this.number();
    return [
      { label: 'Rows', value: n.format(summary.total) },
      { label: 'Ready to import', value: n.format(summary.importable) },
      { label: 'Already imported', value: n.format(summary.duplicates) },
      { label: 'Credits', value: n.format(summary.credits) },
      { label: 'With errors', value: n.format(summary.invalid) },
    ];
  });

  protected readonly filters = computed(() =>
    ROW_FILTERS.map((filter) => ({ ...filter, count: this.review.filterCounts()[filter.id] })),
  );

  /** Every budget, as the choices of the bulk action. An ended one says when. */
  protected readonly bulkOptions = computed(() =>
    this.review.budgets().map((budget) => ({
      id: budget.id,
      label:
        budget.endMonth === null
          ? budget.name
          : `${budget.name} (ended ${formatMonth(budget.endMonth, this.settings.locale())})`,
    })),
  );

  protected rejectionText(codes: readonly string[]): string {
    return codes
      .map((code) => REJECTION_TEXT[code as keyof typeof REJECTION_TEXT] ?? code)
      .join('; ');
  }

  protected onFilter(event: Event): void {
    this.review.setFilter((event.target as HTMLSelectElement).value as RowFilter);
  }

  protected onBulkBudget(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.bulkBudget.set(value === '' ? null : Number(value));
  }

  protected applyBulk(): void {
    const budgetId = this.bulkBudget();
    if (budgetId !== null) this.review.applyBudgetToSelected(budgetId);
  }

  protected showNeedsBudget(): void {
    this.review.setFilter('needs-budget');
  }

  protected reloadBudgets(): void {
    this.review.reloadBudgets();
  }
}
