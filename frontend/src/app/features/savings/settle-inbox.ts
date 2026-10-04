import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import type { Cents, MonthKey, OutstandingMonthDto } from '@wallet/shared';
import { Alert } from '../../shared/ui/alert';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Disclosure } from '../../shared/ui/disclosure';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
import { AppList, ListRow } from '../../shared/ui/list';
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { SavingsData } from './savings-data';
import { SettleSplitDialog } from './settle-split-dialog';
import { Settlement, settlementPhrase } from './settlement';

/**
 * The "Move to savings" inbox: one row per closed month with money to move to savings (or to take
 * from it), oldest first, exactly as the API lists them (`SavingsDto.outstanding`). Nothing is
 * worked out here: the amount, its direction, its breakdown and whether it corrects an earlier
 * settlement are the API's.
 *
 * Done settles the whole amount to unassigned savings, and Split opens a dialog to spread it over
 * goals. Both send the amount the row shows (see `Settlement`), so a month that was edited in the
 * meantime is refused and the user confirms the new figure.
 */
@Component({
  selector: 'app-settle-inbox',
  imports: [
    Alert,
    Amount,
    AppList,
    AppSection,
    Button,
    Disclosure,
    EmptyState,
    KeyValue,
    KeyValues,
    ListRow,
    SectionHelp,
    SettleSplitDialog,
  ],
  templateUrl: './settle-inbox.html',
  host: { class: 'block' },
})
export class SettleInbox {
  private readonly data = inject(SavingsData);
  private readonly settlement = inject(Settlement);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly section = viewChild(AppSection);

  protected readonly entries = computed<readonly OutstandingMonthDto[]>(
    () => this.data.savings()?.outstanding ?? [],
  );
  protected readonly total = computed(() => this.data.savings()?.outstandingTotal ?? 0);
  /** The goals a settlement may be split over: an archived goal takes no part in new transactions. */
  protected readonly goals = computed(() =>
    (this.data.savings()?.goals ?? []).filter((goal) => !goal.archived),
  );

  /** The month whose Done is being sent. */
  protected readonly busy = signal<MonthKey | null>(null);
  /** Rows whose amount changed while the user looked: what happened, in words. */
  protected readonly notices = signal<Record<MonthKey, string>>({});

  /** The row the Split dialog was opened for, as it was then. */
  private readonly splitting = signal<OutstandingMonthDto | null>(null);
  /**
   * The row the Split dialog is for. It follows the data, so the dialog shows the current amount. A
   * month that leaves the list while the dialog is open (it was settled, here or elsewhere) keeps its
   * last row: the dialog is closed by what happens in it (its own `finished`), never pulled away from
   * under the user's hands.
   */
  protected readonly splitEntry = computed(() => {
    const opened = this.splitting();
    if (opened === null) return undefined;
    return this.entries().find((entry) => entry.month === opened.month) ?? opened;
  });

  /** The total as a sentence: "move €412.40 to savings". */
  protected readonly totalPhrase = computed(() =>
    this.total() === 0
      ? 'the months cancel each other out'
      : settlementPhrase(this.total(), (cents) => this.settlement.money(cents)),
  );

  protected monthLabel(month: MonthKey): string {
    return this.settlement.monthLabel(month);
  }

  /** The amount without its sign: the words ("move", "take") say which way it goes. */
  protected abs(cents: Cents): number {
    return Math.abs(cents);
  }

  protected async done(entry: OutstandingMonthDto): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(entry.month);
    this.clearNotice(entry.month);
    try {
      const outcome = await this.settlement.settle(entry);
      switch (outcome.status) {
        case 'settled':
        case 'gone':
          // The row that had focus is gone.
          this.focusHeading();
          break;
        case 'changed':
          this.showChanged(entry, outcome.current);
          break;
        case 'failed':
          this.toast.error(
            `Couldn't mark ${this.monthLabel(entry.month)} as done. ${outcome.message}`,
          );
          break;
      }
    } finally {
      this.busy.set(null);
    }
  }

  protected openSplit(entry: OutstandingMonthDto): void {
    this.clearNotice(entry.month);
    this.splitting.set(entry);
  }

  protected closeSplit(settled: boolean): void {
    this.splitting.set(null);
    if (settled) this.focusHeading();
  }

  /** Says the amount moved, with the new one, and leaves the row (already reloaded) for a second look. */
  private showChanged(entry: OutstandingMonthDto, current: Cents | undefined): void {
    const money = (cents: Cents) => this.settlement.money(cents);
    const now =
      current ?? this.entries().find((candidate) => candidate.month === entry.month)?.outstanding;
    const text =
      now === undefined
        ? `The amount for ${this.monthLabel(entry.month)} changed while you were looking. Check the new amount, then press Done to confirm it.`
        : `The amount for ${this.monthLabel(entry.month)} changed while you were looking. It is now: ${settlementPhrase(now, money)} (it was: ${settlementPhrase(entry.outstanding, money)}). Check it, then press Done to confirm.`;
    this.notices.update((notices) => ({ ...notices, [entry.month]: text }));
  }

  private clearNotice(month: MonthKey): void {
    if (!(month in this.notices())) return;
    this.notices.update(({ [month]: _removed, ...rest }) => rest);
  }

  private focusHeading(): void {
    afterNextRender(() => this.section()?.focusHeading(), { injector: this.injector });
  }
}
