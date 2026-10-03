import { Component, computed, inject, input, output } from '@angular/core';
import type { GoalDto, GoalStatus } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { MoneyPipe } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Icon, type IconName } from '../../shared/ui/icon';
import { ProgressBar, type ProgressTone } from '../../shared/ui/progress-bar';

interface StatusChip {
  label: string;
  icon: IconName | null;
  classes: string;
}

const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium';

/** A goal's status in words and an icon, with a color on top: the label is the signal. */
const STATUS_CHIPS: Record<GoalStatus, StatusChip> = {
  active: { label: 'Active', icon: null, classes: 'border-line-strong text-ink' },
  reached: { label: 'Reached', icon: 'check-circle', classes: 'border-positive text-positive' },
  overdue: {
    label: 'Overdue',
    icon: 'alert',
    classes: 'border-warning bg-warning-soft text-warning',
  },
  archived: {
    label: 'Archived',
    icon: 'archive',
    classes: 'border-line-strong bg-subtle text-muted',
  },
};

/**
 * One goal: how far along it is (the bar and the words come from `progressPercent`, which can pass
 * 100), what it holds against its target, its deadline and what to put aside each month to make it.
 *
 * Every figure is the API's (`GoalDto`): the progress, what is missing, the monthly amount and the
 * status are not worked out here. The buttons are only requests: the section does the work. An
 * archived goal cannot be deposited to, but what it holds can be withdrawn or reallocated, so that
 * money is never frozen.
 */
@Component({
  selector: 'app-goal-card',
  imports: [Amount, Button, Icon, MoneyPipe, ProgressBar],
  templateUrl: './goal-card.html',
  host: { class: 'block' },
})
export class GoalCard {
  private readonly settings = inject(SettingsStore);

  readonly goal = input.required<GoalDto>();
  /** A request is out (archive, delete): the buttons wait. */
  readonly busy = input(false);

  readonly deposit = output<void>();
  readonly withdraw = output<void>();
  /** Move what the goal holds to another goal or to unassigned savings. */
  readonly reallocate = output<void>();
  readonly edit = output<void>();
  /** Archive an active goal, or bring an archived one back. */
  readonly toggleArchive = output<void>();
  readonly remove = output<void>();

  protected readonly nameId = computed(() => `goal-name-${this.goal().id}`);
  protected readonly chip = computed(() => STATUS_CHIPS[this.goal().status]);
  protected readonly chipClasses = computed(() => `${CHIP_BASE} ${this.chip().classes}`);
  protected readonly tone = computed<ProgressTone>(() =>
    this.goal().status === 'overdue' ? 'warning' : 'neutral',
  );
  protected readonly progressText = computed(
    () => `${this.goal().progressPercent}% of the target saved`,
  );

  /** An archived goal takes no new money, but what it holds can still be taken out. */
  protected readonly canGiveMoney = computed(() => this.goal().archived && this.goal().balance > 0);

  /** The deadline's month: only the month counts. */
  protected readonly deadlineLabel = computed(() => {
    const deadline = this.goal().deadline;
    return deadline ? formatMonth(deadline.slice(0, 7), this.settings.locale()) : null;
  });
}
