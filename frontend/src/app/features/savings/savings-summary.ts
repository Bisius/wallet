import { Component, computed, inject, output } from '@angular/core';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { AppSection } from '../../shared/ui/section';
import { Stat, StatNote } from '../../shared/ui/stat';
import { StatGrid } from '../../shared/ui/stat-grid';
import type { MoneyMoveKind } from './money-move-dialog';
import { SavingsData } from './savings-data';

/**
 * The top of the page: the savings balance and how much of it is unassigned (in no goal), as a strip
 * of figures, and the three ways to move money by hand as a group of buttons beside the heading. Both figures can be below zero (a settlement that takes money
 * from savings is never refused for lack of balance): they are shown as they are, with the minus
 * sign and a short explanation, not as an error.
 */
@Component({
  selector: 'app-savings-summary',
  imports: [AppSection, Button, Icon, Stat, StatGrid, StatNote],
  template: `
    @if (data.savings(); as savings) {
      <app-section variant="plain" heading="Your savings">
        <div
          sectionAction
          role="group"
          aria-label="Move money by hand"
          class="flex flex-wrap gap-2"
        >
          <button appButton variant="secondary" (click)="move.emit('deposit')">
            <app-icon name="plus" />
            Deposit
          </button>
          <button appButton variant="secondary" (click)="move.emit('withdrawal')">
            <app-icon name="arrow-down" />
            Withdraw
          </button>
          @if (hasGoals()) {
            <button appButton variant="secondary" (click)="move.emit('reallocation')">
              <app-icon name="arrows-left-right" />
              Reallocate
            </button>
          }
        </div>

        <dl appStatGrid [columns]="2">
          <div
            appStat
            size="lg"
            label="Savings balance"
            [cents]="savings.balance"
            plain
            hint="Everything you have set aside, goals included."
          >
            @if (savings.balance < 0) {
              <dd statNote tone="ink">
                <app-icon name="info" class="mt-0.5" />
                <span>
                  <span class="font-medium">Below zero.</span>
                  More has been taken out of savings than was put in. It rises again as you move
                  money to savings.
                </span>
              </dd>
            }
          </div>
          <div
            appStat
            size="lg"
            label="Unassigned"
            [cents]="savings.unassigned"
            plain
            hint="Savings that are not in any goal."
          >
            @if (savings.unassigned < 0) {
              <dd statNote tone="ink">
                <app-icon name="info" class="mt-0.5" />
                <span>
                  <span class="font-medium">Below zero.</span>
                  More was taken out of unassigned savings than it held, so your goals hold more
                  than the whole balance.
                </span>
              </dd>
            }
          </div>
        </dl>
      </app-section>
    }
  `,
  host: { class: 'block' },
})
export class SavingsSummary {
  protected readonly data = inject(SavingsData);

  /** The user wants to move money by hand. */
  readonly move = output<MoneyMoveKind>();

  /** Reallocating needs a goal to move money to or from (an archived goal can still give it). */
  protected readonly hasGoals = computed(() => (this.data.savings()?.goals ?? []).length > 0);
}
