import { Component, inject, signal } from '@angular/core';
import { PageHeader } from '../../shared/page-header';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { GoalsSection } from './goals-section';
import { MoneyMoveDialog, type MoneyMoveKind } from './money-move-dialog';
import { OpeningBalanceCard } from './opening-balance-card';
import { OpeningBalanceDialog } from './opening-balance-dialog';
import { SavingsData } from './savings-data';
import { SavingsSummary } from './savings-summary';
import { SettleInbox } from './settle-inbox';
import { Settlement } from './settlement';
import { TransactionHistory } from './transaction-history';

/** The money dialog that is open: what kind, and the goal whose card asked for it. */
interface MoveRequest {
  kind: MoneyMoveKind;
  goalId: number | null;
}

/**
 * Savings: the balance, the months waiting to be moved to savings, the goals, the opening balance
 * and the history. Savings are not tied to a month, so there is no month switcher here. Every figure
 * is what the API returned (`GET /api/savings` and friends): the page never works out a balance, an
 * outstanding amount, a progress or a monthly amount itself.
 *
 * It is a list of blocks. Each handles its own loading, empty and error states; the data they share
 * is in `SavingsData`, and the settling of months in `Settlement`, both provided here so they live
 * and die with the page. Whatever the user changes, `SavingsData.reload()` loads it all again.
 */
@Component({
  selector: 'app-savings-page',
  imports: [
    PageHeader,
    ErrorState,
    LoadingState,
    SavingsSummary,
    SettleInbox,
    GoalsSection,
    OpeningBalanceCard,
    OpeningBalanceDialog,
    TransactionHistory,
    MoneyMoveDialog,
  ],
  providers: [SavingsData, Settlement],
  template: `
    <app-page-header
      title="Savings"
      subtitle="Your balance, your goals, and the months waiting to be moved to savings."
    />

    @switch (data.state()) {
      @case ('loading') {
        <app-loading-state label="Loading your savings…" />
      }
      @case ('error') {
        <app-error-state
          title="Couldn't load your savings"
          [error]="data.error()"
          (retry)="data.reloadOverview()"
        />
      }
      @default {
        @if (data.savings(); as savings) {
          <div class="max-w-5xl space-y-6">
            <app-savings-summary (move)="openMove($event, null)" />
            <app-settle-inbox />
            <app-goals-section (moveMoney)="openMove($event.kind, $event.goalId)" />
            <app-opening-balance-card (edit)="editingOpening.set(true)" />
            <app-transaction-history (editOpening)="editingOpening.set(true)" />
          </div>

          @if (move(); as request) {
            <app-money-move-dialog
              [kind]="request.kind"
              [savings]="savings"
              [goalId]="request.goalId"
              (changed)="data.reload()"
              (finished)="move.set(null)"
              (cancelled)="move.set(null)"
            />
          }
        }
      }
    }

    @if (editingOpening()) {
      <app-opening-balance-dialog
        [opening]="data.openingValue()"
        [state]="data.openingState()"
        [error]="data.opening.error()"
        intro="Moving the start month never changes this amount, so check that it is still what you had on that day."
        (saved)="openingSaved()"
        (cancelled)="editingOpening.set(false)"
        (retry)="data.opening.reload()"
      />
    }
  `,
})
export class SavingsPage {
  protected readonly data = inject(SavingsData);

  /** The money dialog, or `null` while none is open. */
  protected readonly move = signal<MoveRequest | null>(null);
  protected readonly editingOpening = signal(false);

  protected openMove(kind: MoneyMoveKind, goalId: number | null): void {
    this.move.set({ kind, goalId });
  }

  protected async openingSaved(): Promise<void> {
    this.editingOpening.set(false);
    await this.data.reload();
  }
}
