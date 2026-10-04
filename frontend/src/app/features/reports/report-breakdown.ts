import { Component, input } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { Amount } from '../../shared/ui/amount';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
import { AppSection, SectionHelp } from '../../shared/ui/section';

/**
 * What the year's figures are made of, side by side: the income split into salary and extra income,
 * and the saved figure split into what is left unallocated, the budgets settled to savings and the
 * subscription reserves released. Every figure is the report's own.
 */
@Component({
  selector: 'app-report-breakdown',
  imports: [Amount, AppSection, KeyValue, KeyValues, SectionHelp],
  template: `
    <div class="grid gap-6 md:grid-cols-2">
      <app-section class="*:h-full" heading="Income">
        <dl appKeyValues>
          <div appKeyValue label="Salary"><app-amount [cents]="report().income.salary" /></div>
          <div appKeyValue label="Extra income"><app-amount [cents]="report().income.extra" /></div>
          <div appKeyValue label="Total income" strong>
            <app-amount [cents]="report().income.total" />
          </div>
        </dl>
      </app-section>

      <app-section
        class="*:h-full"
        heading="Saved, due to savings"
        description="What moves to savings as each month closes."
      >
        <p sectionHelp>
          It counts whether or not you have settled it yet. A negative amount is money taken from
          savings.
        </p>
        <dl appKeyValues>
          <div appKeyValue label="Left unallocated">
            <app-amount [cents]="report().savedBreakdown.unallocated" [signed]="true" plain />
          </div>
          <div appKeyValue label="Budgets settled to savings">
            <app-amount [cents]="report().savedBreakdown.budgetsSettled" [signed]="true" plain />
          </div>
          <div appKeyValue label="Subscription reserves released">
            <app-amount [cents]="report().savedBreakdown.reservesReleased" [signed]="true" plain />
          </div>
          <div appKeyValue [label]="'Saved in ' + report().year" strong>
            <app-amount [cents]="report().saved" [signed]="true" plain />
          </div>
        </dl>
      </app-section>
    </div>
  `,
  host: { class: 'block' },
})
export class ReportBreakdown {
  readonly report = input.required<YearlyReportDto>();
}
