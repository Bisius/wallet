import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MonthKey } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { LinkButton } from '../../shared/ui/link-button';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { ImportReviewStore } from './import-review.store';
import { ImportWizardStore } from './import-wizard.store';

/** How many months get a link of their own. A file of many years lists the latest ones. */
const MONTH_LINKS_MAX = 12;

/**
 * The last step: how many spendings were imported, and a link to each month they are dated in. The
 * spendings are ordinary ones. The pages that show them load fresh when opened, and the savings badge
 * in the navigation was asked to refresh by the commit (when a closed month changed).
 */
@Component({
  selector: 'app-import-done-step',
  imports: [Alert, AppSection, SectionHelp, RouterLink, Button, LinkButton],
  template: `
    <app-section
      heading="Import complete"
      description="Imported rows are ordinary spendings: edit or delete them like any other."
      focusable
    >
      <p sectionHelp>If you choose this file again, its rows are marked as already imported.</p>

      @if (review.result(); as result) {
        <app-alert tone="success" live="status">
          Imported {{ result.created }} {{ result.created === 1 ? 'spending' : 'spendings' }}.
        </app-alert>

        <app-section level="3" heading="See them in">
          <ul class="flex flex-wrap gap-2">
            @for (month of linkedMonths(); track month) {
              <li>
                <a
                  appLinkButton
                  size="sm"
                  routerLink="/spendings"
                  [queryParams]="{ month: month }"
                  >{{ monthName(month) }}</a
                >
              </li>
            }
          </ul>
          @if (hiddenMonths() > 0) {
            <p class="text-sm text-muted">
              and {{ hiddenMonths() }} earlier {{ hiddenMonths() === 1 ? 'month' : 'months' }}: use
              the month switcher on the Spendings page.
            </p>
          }
        </app-section>
      }

      <div class="wizard-actions">
        <button appButton variant="secondary" (click)="another()">Import another file</button>
        <a appLinkButton variant="primary" routerLink="/spendings">Go to spendings</a>
      </div>
    </app-section>
  `,
  host: { class: 'block' },
})
export class ImportDoneStep {
  protected readonly review = inject(ImportReviewStore);
  private readonly wizard = inject(ImportWizardStore);
  private readonly settings = inject(SettingsStore);

  /** The months to link, newest last. */
  protected readonly linkedMonths = computed<readonly MonthKey[]>(() =>
    (this.review.result()?.months ?? []).slice(-MONTH_LINKS_MAX),
  );
  protected readonly hiddenMonths = computed(() =>
    Math.max(0, (this.review.result()?.months.length ?? 0) - MONTH_LINKS_MAX),
  );

  protected monthName(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  protected another(): void {
    this.wizard.reset();
  }
}
