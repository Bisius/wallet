import { Component, computed, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { Amount } from '../../shared/ui/amount';

/**
 * The year in one strip: income, fixed costs, budgeted, spent and saved, each exactly as the report
 * gives it. Saved is what is **due** to savings (what the months leave over, or are short), not
 * what was moved, and says so. Below it, the income split into salary and extra income, and what
 * the saved figure is made of.
 */
@Component({
  selector: 'app-report-glance',
  imports: [Amount],
  template: `
    <section aria-labelledby="report-glance-heading" class="card space-y-4">
      <div>
        <h2 id="report-glance-heading" class="text-lg font-semibold">
          {{ report().year }} at a glance
        </h2>
        @if (projected() > 0) {
          <p class="mt-1 text-sm text-muted">
            The totals include {{ projected() }} projected
            {{ projected() === 1 ? 'month' : 'months' }}: they assume the current month ends as it
            stands.
          </p>
        }
      </div>

      <dl class="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Income</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="report().income.total" /></dd>
        </div>
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Fixed costs</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="report().fixedCosts.total" /></dd>
        </div>
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Budgeted</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="report().allocated" /></dd>
        </div>
        <div class="rounded-control bg-subtle p-3">
          <dt class="text-sm text-muted">Spent</dt>
          <dd class="text-lg font-semibold"><app-amount [cents]="report().spent" /></dd>
        </div>
        <div class="col-span-2 rounded-control bg-subtle p-3 lg:col-span-1">
          <dt class="text-sm text-muted">Saved</dt>
          <dd class="text-lg font-semibold">
            <app-amount [cents]="report().saved" [signed]="true" plain />
          </dd>
          <dd class="text-xs text-muted">Due to savings</dd>
        </div>
      </dl>

      <div class="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="report-income-heading">
          <h3 id="report-income-heading" class="font-semibold">Income</h3>
          <dl class="mt-2 divide-y divide-line text-sm">
            <div class="flex justify-between gap-4 py-2">
              <dt class="text-muted">Salary</dt>
              <dd><app-amount [cents]="report().income.salary" /></dd>
            </div>
            <div class="flex justify-between gap-4 py-2">
              <dt class="text-muted">Extra income</dt>
              <dd><app-amount [cents]="report().income.extra" /></dd>
            </div>
            <div class="flex justify-between gap-4 py-2 font-semibold">
              <dt>Total income</dt>
              <dd><app-amount [cents]="report().income.total" /></dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="report-saved-heading">
          <h3 id="report-saved-heading" class="font-semibold">Saved, due to savings</h3>
          <p class="mt-1 text-sm text-muted">
            What moves to savings as each month closes, whether or not you have settled it yet. A
            negative amount is money taken from savings.
          </p>
          <dl class="mt-2 divide-y divide-line text-sm">
            <div class="flex justify-between gap-4 py-2">
              <dt class="text-muted">Left unallocated</dt>
              <dd>
                <app-amount [cents]="report().savedBreakdown.unallocated" [signed]="true" plain />
              </dd>
            </div>
            <div class="flex justify-between gap-4 py-2">
              <dt class="text-muted">Budgets settled to savings</dt>
              <dd>
                <app-amount
                  [cents]="report().savedBreakdown.budgetsSettled"
                  [signed]="true"
                  plain
                />
              </dd>
            </div>
            <div class="flex justify-between gap-4 py-2">
              <dt class="text-muted">Subscription reserves released</dt>
              <dd>
                <app-amount
                  [cents]="report().savedBreakdown.reservesReleased"
                  [signed]="true"
                  plain
                />
              </dd>
            </div>
            <div class="flex justify-between gap-4 py-2 font-semibold">
              <dt>Saved in {{ report().year }}</dt>
              <dd><app-amount [cents]="report().saved" [signed]="true" plain /></dd>
            </div>
          </dl>
        </section>
      </div>
    </section>
  `,
  host: { class: 'block' },
})
export class ReportGlance {
  readonly report = input.required<YearlyReportDto>();

  /** How many of the included months have not started: their figures are projections. */
  protected readonly projected = computed(
    () => this.report().months.filter((month) => month.status === 'future').length,
  );
}
