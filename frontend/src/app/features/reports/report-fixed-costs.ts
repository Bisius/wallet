import { Component, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { Amount } from '../../shared/ui/amount';
import { EmptyState } from '../../shared/ui/states';

/**
 * What the subscriptions cost in the year, one line per subscription. **Set aside** is what came off
 * the income (for a yearly subscription the top-ups into its reserve) and **paid** is what the
 * provider received (a yearly one only in its renewal month). Both are the report's figures.
 */
@Component({
  selector: 'app-report-fixed-costs',
  imports: [Amount, EmptyState],
  template: `
    <section aria-labelledby="report-fixed-heading" class="card space-y-4">
      <div>
        <h2 id="report-fixed-heading" class="text-lg font-semibold">Fixed costs</h2>
        <p class="mt-1 text-sm text-muted">
          Set aside is what the subscription took off your income. Paid is what the provider got: a
          yearly subscription is set aside month by month and paid in the month it renews.
        </p>
      </div>

      @if (report().fixedCosts.subscriptions.length === 0) {
        <app-empty-state
          [title]="'No subscriptions in ' + report().year"
          description="Subscriptions you add show up here with what they cost over the year."
        />
      } @else {
        <div
          class="overflow-x-auto"
          role="region"
          aria-label="Fixed costs per subscription"
          tabindex="0"
        >
          <table class="w-full border-collapse text-left text-sm">
            <caption class="sr-only">
              Fixed costs per subscription in
              {{
                report().year
              }}
            </caption>
            <thead class="bg-subtle">
              <tr>
                <th scope="col" class="px-3 py-2 font-semibold">Subscription</th>
                <th scope="col" class="px-3 py-2 text-right font-semibold">Set aside</th>
                <th scope="col" class="px-3 py-2 text-right font-semibold">Paid</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (line of report().fixedCosts.subscriptions; track line.id) {
                <tr>
                  <th scope="row" class="px-3 py-2 font-medium">
                    <span
                      class="inline-block border-l-4 border-line-strong pl-2 break-words"
                      [style.border-left-color]="line.color"
                    >
                      {{ line.name }}
                    </span>
                    <span class="ml-1 text-xs font-normal text-muted">
                      {{ line.frequency === 'yearly' ? 'Yearly' : 'Monthly' }}
                    </span>
                  </th>
                  <td class="px-3 py-2 text-right tabular-nums">
                    <app-amount [cents]="line.cost" />
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    <app-amount [cents]="line.paid" />
                  </td>
                </tr>
              }
            </tbody>
            <tfoot class="border-t-2 border-line-strong font-semibold">
              <tr>
                <th scope="row" class="px-3 py-2">Total</th>
                <td class="px-3 py-2 text-right tabular-nums">
                  <app-amount [cents]="report().fixedCosts.total" />
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <app-amount [cents]="report().fixedCosts.paid" />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      }
    </section>
  `,
  host: { class: 'block' },
})
export class ReportFixedCosts {
  readonly report = input.required<YearlyReportDto>();
}
