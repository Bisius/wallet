import { Component, computed, inject, output } from '@angular/core';
import { SettingsStore } from '../../core/settings.store';
import { formatDate } from '../../shared/format';
import { Amount } from '../../shared/ui/amount';
import { AsyncSection } from '../../shared/ui/async-section';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { SavingsData } from './savings-data';

/**
 * "Opening balance: €1,000.00 on Oct 1, 2026": the savings balance on the first day of the start
 * month, which is where everything the app tracks begins. It is the one row of the history that is
 * changed here instead of deleted.
 */
@Component({
  selector: 'app-opening-balance-card',
  imports: [Amount, AsyncSection, Button, Icon],
  template: `
    <app-async-section
      heading="Starting point"
      description="This is the balance of your savings on the first day of your start month. Everything after it is tracked here as it happens."
      [state]="data.openingState()"
      [error]="data.opening.error()"
      loadingLabel="Loading your opening balance…"
      errorTitle="Couldn't load your opening balance"
      (retry)="data.opening.reload()"
    >
      @if (opening()) {
        <button sectionAction appButton variant="secondary" size="sm" (click)="edit.emit()">
          <app-icon name="pencil" />
          Edit opening balance
        </button>
      }

      @if (opening(); as opening) {
        <p>
          Opening balance:
          <span class="text-lg font-semibold"><app-amount [cents]="opening.amount" /></span>
          on {{ dateLabel() }}
        </p>
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class OpeningBalanceCard {
  protected readonly data = inject(SavingsData);
  private readonly settings = inject(SettingsStore);

  /** The user wants to change the opening balance. */
  readonly edit = output<void>();

  protected readonly opening = this.data.openingValue;
  protected readonly dateLabel = computed(() => {
    const opening = this.opening();
    return opening ? formatDate(opening.date, this.settings.locale(), 'medium') : '';
  });
}
