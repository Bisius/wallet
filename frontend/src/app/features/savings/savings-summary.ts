import { Component, computed, inject, output } from '@angular/core';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import type { MoneyMoveKind } from './money-move-dialog';
import { SavingsData } from './savings-data';

/**
 * The top of the page: the savings balance and how much of it is unassigned (in no goal), and the
 * three ways to move money by hand. Both figures can be below zero (a settlement that takes money
 * from savings is never refused for lack of balance): they are shown as they are, with the minus
 * sign and a short explanation, not as an error.
 */
@Component({
  selector: 'app-savings-summary',
  imports: [Amount, Button, Icon],
  template: `
    @if (data.savings(); as savings) {
      <section aria-labelledby="savings-summary-heading" class="card space-y-4">
        <h2 id="savings-summary-heading" class="text-lg font-semibold">Your savings</h2>

        <dl class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-control bg-subtle p-3">
            <dt class="text-sm text-muted">Savings balance</dt>
            <dd class="text-2xl font-semibold">
              <app-amount [cents]="savings.balance" plain />
            </dd>
            <dd class="mt-0.5 text-sm text-muted">
              Everything you have set aside, goals included.
            </dd>
            @if (savings.balance < 0) {
              <dd class="mt-1 flex items-start gap-1.5 text-sm text-ink">
                <app-icon name="info" class="mt-0.5" />
                <span>
                  <span class="font-medium">Below zero.</span>
                  More has been taken out of savings than was put in. It rises again as you move
                  money to savings.
                </span>
              </dd>
            }
          </div>
          <div class="rounded-control bg-subtle p-3">
            <dt class="text-sm text-muted">Unassigned</dt>
            <dd class="text-2xl font-semibold">
              <app-amount [cents]="savings.unassigned" plain />
            </dd>
            <dd class="mt-0.5 text-sm text-muted">Savings that are not in any goal.</dd>
            @if (savings.unassigned < 0) {
              <dd class="mt-1 flex items-start gap-1.5 text-sm text-ink">
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

        <div class="flex flex-wrap gap-2">
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
      </section>
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
