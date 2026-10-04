import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import type { Cents, GoalDto, OutstandingMonthDto, SavingsAllocationInput } from '@wallet/shared';
import { aliveFlag } from '../../core/alive';
import { focusFirstInvalid } from '../../shared/forms/api-errors';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { nonNegativeAmount } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Alert, type AlertTone } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { UNASSIGNED_LABEL } from './savings-data';
import { Settlement, settlementPhrase } from './settlement';

/** One place the amount can go to, or come from: the unassigned savings, or a goal. */
interface SplitRow {
  key: string;
  /** null: unassigned savings. */
  goalId: number | null;
  label: string;
  control: FormControl<Cents | null>;
}

/**
 * Splits a month's outstanding amount over unassigned savings and goals, then settles it. The user
 * types plain amounts (never a minus sign) and the dialog shows how much is **left to allocate**; for
 * a month that is "take from savings" the same amounts are sent with the sign of the settlement
 * (negative), so each one is taken from its place.
 *
 * The amount sent is the one on screen (`entry`). If it changes while the dialog is open (an edit
 * moved it, and the page loaded it again), the dialog says so, and the user checks the split and
 * confirms again.
 */
@Component({
  selector: 'app-settle-split-dialog',
  imports: [Alert, ReactiveFormsModule, AppDialog, Field, MoneyInput, Button, MoneyPipe],
  templateUrl: './settle-split-dialog.html',
  host: { class: 'block' },
})
export class SettleSplitDialog implements OnInit {
  private readonly settlement = inject(Settlement);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The month being settled, as the data holds it now. */
  readonly entry = input.required<OutstandingMonthDto>();
  /** The goals that can take part (not archived). */
  readonly goals = input.required<readonly GoalDto[]>();

  /** The month was settled (or is gone): the dialog is done. */
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** Said when the amount changes while the dialog is open. */
  protected readonly notice = signal<string | null>(null);

  protected readonly form = new FormGroup<Record<string, FormControl<Cents | null>>>({});
  protected readonly rows = signal<readonly SplitRow[]>([]);
  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  protected readonly monthLabel = computed(() => this.settlement.monthLabel(this.entry().month));
  protected readonly taking = computed(() => this.entry().outstanding < 0);
  /** The amount to share out, without its sign. */
  protected readonly target = computed(() => Math.abs(this.entry().outstanding));
  protected readonly phrase = computed(() =>
    settlementPhrase(this.entry().outstanding, (cents) => this.settlement.money(cents)),
  );

  /** What has been given a place so far. */
  private readonly allocated = computed(() => {
    let sum = 0;
    for (const value of Object.values(this.draft())) {
      if (typeof value === 'number' && value > 0) sum += value;
    }
    return sum;
  });
  /** What is still to be given a place: positive is missing, negative is too much. */
  protected readonly left = computed(() => this.target() - this.allocated());
  /** Done, still something to share out, or too much: the tone of the line that says how much is left. */
  protected readonly leftTone = computed<AlertTone>(() => {
    const left = this.left();
    return left === 0 ? 'success' : left > 0 ? 'info' : 'error';
  });

  private lastAmount: Cents | null = null;

  constructor() {
    effect(() => {
      const entry = this.entry();
      untracked(() => {
        const previous = this.lastAmount;
        this.lastAmount = entry.outstanding;
        if (previous === null || previous === entry.outstanding) return;
        const money = (cents: Cents) => this.settlement.money(cents);
        this.notice.set(
          `The amount for ${this.monthLabel()} changed while you were looking. It is now: ${settlementPhrase(entry.outstanding, money)} (it was: ${settlementPhrase(previous, money)}). Check the split, then confirm again.`,
        );
      });
    });
  }

  ngOnInit(): void {
    const rows: SplitRow[] = [
      this.row('unassigned', null, UNASSIGNED_LABEL),
      ...this.goals().map((goal) => this.row(`goal-${goal.id}`, goal.id, goal.name)),
    ];
    for (const row of rows) this.form.addControl(row.key, row.control);
    this.rows.set(rows);
  }

  private row(key: string, goalId: number | null, label: string): SplitRow {
    return {
      key,
      goalId,
      label,
      control: new FormControl<Cents | null>(null, [nonNegativeAmount]),
    };
  }

  /** Puts what is left of the amount into a place. */
  protected fillRest(row: SplitRow): void {
    const left = this.left();
    if (left <= 0) return;
    row.control.setValue((row.control.value ?? 0) + left);
    row.control.markAsDirty();
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(`[data-split-row="${row.key}"] input`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected async submit(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    this.formError.set(null);
    if (this.form.invalid) {
      this.focusInvalidAfterRender();
      return;
    }

    const entry = this.entry();
    // The sign of the settlement: each part goes the same way as the whole.
    const sign = entry.outstanding < 0 ? -1 : 1;
    const allocations: SavingsAllocationInput[] = this.rows().flatMap((row) => {
      const value = row.control.value;
      return value ? [{ goalId: row.goalId, amount: sign * value }] : [];
    });

    const left = this.left();
    if (allocations.length === 0 || left !== 0) {
      this.formError.set(
        left > 0
          ? `Give the whole amount a place first: ${this.settlement.money(left)} is still left to allocate.`
          : `The amounts add up to more than ${this.settlement.money(this.target())}: lower one by ${this.settlement.money(-left)}.`,
      );
      return;
    }

    this.saving.set(true);
    try {
      const outcome = await this.settlement.settle(entry, allocations);
      switch (outcome.status) {
        case 'settled':
        case 'gone':
          if (this.alive()) this.finished.emit();
          break;
        case 'changed':
          // The data was loaded again: `entry` is the new amount, and the notice says so.
          break;
        case 'failed':
          this.formError.set(
            outcome.rule === 'unknown_goal' || outcome.rule === 'goal_archived'
              ? `${outcome.message} Close this dialog and open it again to see the goals as they are now.`
              : outcome.message,
          );
          break;
      }
    } finally {
      this.saving.set(false);
    }
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }
}
