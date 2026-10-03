import { inject, Injectable } from '@angular/core';
import type {
  Cents,
  MonthKey,
  OutstandingMonthDto,
  RuleViolationRule,
  SavingsAllocationInput,
} from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { apiErrorDetails, parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { formatMoney } from '../../shared/money.pipe';
import { ToastService } from '../../shared/ui/toast.service';
import { SavingsData } from './savings-data';
import { SavingsApi } from './savings.api';

/** "move €312.40 to savings" or "take €85.00 from savings", for a signed outstanding amount. */
export function settlementPhrase(outstanding: Cents, money: (cents: Cents) => string): string {
  return outstanding < 0
    ? `take ${money(-outstanding)} from savings`
    : `move ${money(outstanding)} to savings`;
}

/** The shape `outstanding_changed` carries in its `details` (`OutstandingChangedDetails`). */
function currentOutstanding(details: unknown): Cents | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const value = (details as { outstanding?: unknown }).outstanding;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** How an attempt to settle a month ended. The toasts for a success and for a month that is gone are already shown. */
export type SettleOutcome =
  | { status: 'settled' }
  /**
   * 409 `outstanding_changed`: an edit moved the amount since the user looked. `current` is the
   * API's current value (undefined if the response did not carry one). The data is loaded again,
   * so what is on screen is the new amount, and the user confirms it again.
   */
  | { status: 'changed'; current: Cents | undefined }
  /** The month cannot be settled any more (nothing to settle, not closed, not found). The data is loaded again. */
  | { status: 'gone' }
  /** Anything else: `message` is for the user, and `rule` is the rule a 422 broke. */
  | { status: 'failed'; message: string; rule: RuleViolationRule | null };

/**
 * Settling and un-settling months, with the answers a person needs: Done and Split in the inbox, and
 * "Undo settlement" in the history all go through here. It is provided by the page, next to the data
 * it reloads.
 *
 * The amount sent is always the one the user saw (`entry.outstanding`): the API refuses it with
 * `outstanding_changed` when an edit has moved it since, and the user then confirms the new figure.
 */
@Injectable()
export class Settlement {
  private readonly api = inject(SavingsApi);
  private readonly data = inject(SavingsData);
  private readonly settings = inject(SettingsStore);
  private readonly toast = inject(ToastService);

  monthLabel(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  money(cents: Cents): string {
    return formatMoney(cents, this.settings.locale(), this.settings.currency());
  }

  /**
   * Settles `entry`: the whole amount to unassigned savings, or split as `allocations` say (each with
   * the sign of the amount). On success the data is loaded again and a toast says what was recorded,
   * with an Undo for a first settlement. An Undo undoes the whole month, so a correction of an
   * earlier settlement does not offer one: it would also remove the earlier settlement.
   */
  async settle(
    entry: OutstandingMonthDto,
    allocations?: SavingsAllocationInput[],
  ): Promise<SettleOutcome> {
    const label = this.monthLabel(entry.month);
    try {
      await firstValueFrom(
        this.api.settle(entry.month, {
          amount: entry.outstanding,
          ...(allocations ? { allocations } : {}),
        }),
      );
    } catch (error) {
      return this.explain(error, label);
    }

    const done =
      entry.outstanding < 0
        ? `${this.money(-entry.outstanding)} taken from savings`
        : `${this.money(entry.outstanding)} moved to savings`;
    if (entry.adjustment) {
      this.toast.success(`Correction for ${label} recorded: ${done}.`);
    } else {
      this.toast.success(`${label} is done: ${done}.`, {
        label: 'Undo',
        run: () => void this.undo(entry.month),
      });
    }
    await this.data.reload();
    return { status: 'settled' };
  }

  /** Removes every settlement of a month: it is outstanding by its whole amount again. Resolves to whether it went through. */
  async undo(month: MonthKey): Promise<boolean> {
    const label = this.monthLabel(month);
    let undone = false;
    try {
      await firstValueFrom(this.api.undoSettlement(month));
      undone = true;
      this.toast.success(`Settlement of ${label} undone. The month is back in the list.`);
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'not_found') {
        this.toast.info(`${label} has no settlement to undo. It may already have been undone.`);
      } else {
        this.toast.error(`Couldn't undo the settlement of ${label}. ${parsed.message}`);
      }
    }
    await this.data.reload();
    return undone;
  }

  /** Turns a failed settle into an outcome, loading the data again when what was on screen is out of date. */
  private async explain(error: unknown, label: string): Promise<SettleOutcome> {
    const parsed = parseApiError(error);

    if (parsed.code === 'outstanding_changed') {
      await this.data.reload();
      return { status: 'changed', current: currentOutstanding(apiErrorDetails(error)) };
    }
    if (parsed.code === 'nothing_to_settle') {
      this.toast.info(
        `${label} has nothing left to move. It may have been settled in another window.`,
      );
      await this.data.reload();
      return { status: 'gone' };
    }
    if (parsed.rule === 'month_not_closed') {
      this.toast.error(`${label} has not closed yet, so it can't be settled.`);
      await this.data.reload();
      return { status: 'gone' };
    }
    if (parsed.code === 'not_found') {
      this.toast.error(`${label} can't be settled. ${parsed.message}`);
      await this.data.reload();
      return { status: 'gone' };
    }
    if (parsed.rule === 'unknown_goal' || parsed.rule === 'goal_archived') {
      // A goal was archived or deleted since the list was loaded: show the current goals.
      await this.data.reload();
    }
    return { status: 'failed', message: parsed.message, rule: parsed.rule };
  }
}
