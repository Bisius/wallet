import { Component, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { Amount } from '../../shared/ui/amount';
import { ColorDot } from '../../shared/ui/color-dot';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { TableScroll } from '../../shared/ui/table-scroll';

/**
 * What the subscriptions cost in the year, one line per subscription. **Set aside** is what came off
 * the income (for a yearly subscription the top-ups into its reserve) and **paid** is what the
 * provider received (a yearly one only in its renewal month). Both are the report's figures.
 */
@Component({
  selector: 'app-report-fixed-costs',
  imports: [Amount, AppSection, ColorDot, EmptyState, SectionHelp, TableScroll],
  template: `
    <app-section
      heading="Fixed costs"
      description="What each subscription took off your income and what its provider received."
    >
      <p sectionHelp>
        Set aside is what the subscription took off your income. Paid is what the provider got: a
        yearly subscription is set aside month by month and paid in the month it renews.
      </p>
      @if (report().fixedCosts.subscriptions.length === 0) {
        <app-empty-state
          [title]="'No subscriptions in ' + report().year"
          description="Subscriptions you add show up here with what they cost over the year."
        />
      } @else {
        <app-table-scroll label="Fixed costs per subscription">
          <table class="data-table">
            <caption class="sr-only">
              Fixed costs per subscription in
              {{
                report().year
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Subscription</th>
                <th scope="col" class="cell-num">Set aside</th>
                <th scope="col" class="cell-num">Paid</th>
              </tr>
            </thead>
            <tbody>
              @for (line of report().fixedCosts.subscriptions; track line.id) {
                <tr>
                  <th scope="row">
                    <span appColorDot class="mr-2 align-middle" [color]="line.color"></span>
                    <span class="break-words">{{ line.name }}</span>
                    <span class="ml-1 text-xs font-normal text-muted">
                      {{ line.frequency === 'yearly' ? 'Yearly' : 'Monthly' }}
                    </span>
                  </th>
                  <td class="cell-num">
                    <app-amount [cents]="line.cost" />
                  </td>
                  <td class="cell-num">
                    <app-amount [cents]="line.paid" />
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td class="cell-num">
                  <app-amount [cents]="report().fixedCosts.total" />
                </td>
                <td class="cell-num">
                  <app-amount [cents]="report().fixedCosts.paid" />
                </td>
              </tr>
            </tfoot>
          </table>
        </app-table-scroll>
      }
    </app-section>
  `,
  host: { class: 'block' },
})
export class ReportFixedCosts {
  readonly report = input.required<YearlyReportDto>();
}
