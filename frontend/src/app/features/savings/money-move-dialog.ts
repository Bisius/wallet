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
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import type { Cents, SavingsDto, SavingsTransactionCreateInput } from '@wallet/shared';
import { NOTES_MAX_LENGTH } from '@wallet/shared/limits';
import { firstValueFrom } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { firstDayOf, formatDate } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { positiveAmount } from '../../shared/forms/validators';
import { formatMoney, MoneyPipe } from '../../shared/money.pipe';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { ToastService } from '../../shared/ui/toast.service';
import { UNASSIGNED_LABEL } from './savings-data';
import { SavingsApi } from './savings.api';

export type MoneyMoveKind = 'deposit' | 'withdrawal' | 'reallocation';

/** The value of the "unassigned savings" choice in a picker. A goal's choice is its id. */
const UNASSIGNED = 'unassigned';

/** A place that holds savings and can be picked: the unassigned savings, or a goal. */
interface Place {
  value: string;
  /** null: unassigned savings. */
  goalId: number | null;
  label: string;
  /** What it holds now, as the overview says. */
  balance: Cents;
  /** An archived goal can give money (a source) but not receive any (a destination). */
  archived: boolean;
}

const HEADINGS: Record<MoneyMoveKind, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdraw',
  reallocation: 'Reallocate',
};

const INTROS: Record<MoneyMoveKind, string> = {
  deposit: 'Money you put into your savings: into a goal, or into unassigned savings.',
  withdrawal:
    'Money you took out of your savings, for example to pay for the holiday from its goal.',
  reallocation:
    'Move money between goals, or between a goal and unassigned savings. Your savings balance does not change.',
};

const toGoalId = (value: string): number | null => (value === UNASSIGNED ? null : Number(value));

/**
 * One dialog for the three ways to move money by hand: a deposit, a withdrawal and a reallocation
 * (money between two places that already hold savings). The date starts as today (the server's, from
 * `TodayStore`) and cannot be in the future or before the start month; a note is optional.
 *
 * What the pickers offer is what the overview says: unassigned savings and the goals, each with its
 * balance. An archived goal can only give money: it is offered as the source of a withdrawal and of a
 * reallocation, and never as the place a deposit or a reallocation puts money into (the API says
 * `goal_archived`). A withdrawal or a reallocation that would take more than the source holds is
 * blocked here, and the API's `insufficient_balance` (the balance moved since the page loaded) is
 * shown on the amount as well.
 *
 * `changed` fires when something was saved, or when the API's answer shows that the balances on
 * screen are out of date (the page reloads); `finished` closes the dialog.
 */
@Component({
  selector: 'app-money-move-dialog',
  imports: [Alert, ReactiveFormsModule, AppDialog, Field, AppInput, MoneyInput, Button, MoneyPipe],
  templateUrl: './money-move-dialog.html',
  host: { class: 'block' },
})
export class MoneyMoveDialog implements OnInit {
  private readonly api = inject(SavingsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  readonly kind = input.required<MoneyMoveKind>();
  /** The savings overview, for the places and what they hold. It may be reloaded while the dialog is open. */
  readonly savings = input.required<SavingsDto>();
  /** The goal to start with (the one whose card was used). Unassigned savings when unset. */
  readonly goalId = input<number | null>(null);

  readonly changed = output<void>();
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly notesMaxLength = NOTES_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** The control names are the request's field names, so a field error from the API lands on its control. */
  protected readonly form = new FormGroup({
    amount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    /** Deposit and withdrawal: where the money goes, or comes from. */
    goalId: new FormControl(UNASSIGNED, { nonNullable: true }),
    /** Reallocation: where the money comes from, and where it goes. */
    fromGoalId: new FormControl(UNASSIGNED, { nonNullable: true }),
    toGoalId: new FormControl(UNASSIGNED, { nonNullable: true }),
    date: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    note: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(NOTES_MAX_LENGTH)],
    }),
  });
  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  protected readonly heading = computed(() => HEADINGS[this.kind()]);
  protected readonly intro = computed(() => INTROS[this.kind()]);

  /** Where money can come from: unassigned savings first, then every goal, archived ones too. */
  protected readonly sources = computed<readonly Place[]>(() => {
    const savings = this.savings();
    return [
      {
        value: UNASSIGNED,
        goalId: null,
        label: UNASSIGNED_LABEL,
        balance: savings.unassigned,
        archived: false,
      },
      ...savings.goals.map((goal) => ({
        value: String(goal.id),
        goalId: goal.id,
        label: goal.archived ? `${goal.name} (archived)` : goal.name,
        balance: goal.balance,
        archived: goal.archived,
      })),
    ];
  });
  /** Where money can go: the same, without the archived goals. */
  protected readonly destinations = computed(() =>
    this.sources().filter((place) => !place.archived),
  );

  protected readonly firstDay = computed(() => {
    const start = this.settings.startMonth();
    return start ? firstDayOf(start) : undefined;
  });
  protected readonly lastDay = this.today.date;

  /**
   * The place the money comes from, for a withdrawal or a reallocation. It reads the pickers
   * themselves, not the form's value: a control tells its own listeners before its form does, so the
   * form's value is still the old one when a picker change makes the amount check itself again.
   */
  private source(): Place | undefined {
    const { goalId, fromGoalId } = this.form.controls;
    const kind = this.kind();
    const picked =
      kind === 'withdrawal' ? goalId.value : kind === 'reallocation' ? fromGoalId.value : undefined;
    return picked === undefined
      ? undefined
      : this.sources().find((place) => place.value === picked);
  }

  /** What the source holds, said under its picker so the limit is known before the amount is typed. */
  protected readonly sourceHint = computed(() => {
    this.draft();
    const source = this.source();
    if (!source) return undefined;
    return source.balance > 0
      ? `${source.label} holds ${this.money(source.balance)}.`
      : `${source.label} holds ${this.money(source.balance)}: there is nothing to take from it.`;
  });

  constructor() {
    // The balances can change while the dialog is open (the page loads them again): check the amount
    // against the new ones.
    effect(() => {
      this.sources();
      untracked(() => this.form.controls.amount.updateValueAndValidity());
    });

    // The two pickers of a reallocation must differ, and the amount depends on the source.
    const { fromGoalId, toGoalId, goalId, amount } = this.form.controls;
    fromGoalId.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      toGoalId.updateValueAndValidity();
      amount.updateValueAndValidity();
    });
    goalId.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => amount.updateValueAndValidity());
  }

  ngOnInit(): void {
    const kind = this.kind();
    const { amount, goalId, fromGoalId, toGoalId, date } = this.form.controls;

    // The validators read the inputs, which are only set from here on.
    if (kind !== 'deposit') amount.addValidators(this.withinBalance);
    if (kind === 'reallocation') toGoalId.addValidators(this.differFromSource);
    date.addValidators([this.notInTheFuture, this.notBeforeStart]);

    const sources = this.sources();
    const destinations = this.destinations();
    const wanted = this.goalId();
    const pick = (places: readonly Place[]) =>
      places.find((place) => place.goalId === wanted)?.value ?? UNASSIGNED;
    if (kind === 'reallocation') {
      goalId.disable();
      let from = pick(sources);
      let to = destinations.find((place) => place.value !== from)?.value;
      if (to === undefined) {
        // Only unassigned savings can receive money (every goal is archived): take it from a goal.
        const goal = sources.find((place) => place.value !== UNASSIGNED);
        if (goal) {
          from = goal.value;
          to = UNASSIGNED;
        }
      }
      fromGoalId.setValue(from);
      toGoalId.setValue(to ?? UNASSIGNED);
    } else {
      fromGoalId.disable();
      toGoalId.disable();
      goalId.setValue(pick(kind === 'withdrawal' ? sources : destinations));
    }
    // The default is today according to the server, never the browser clock.
    date.setValue(this.today.date() ?? this.firstDay() ?? '');
    amount.updateValueAndValidity();
    date.updateValueAndValidity();
  }

  private money(cents: Cents): string {
    return formatMoney(cents, this.settings.locale(), this.settings.currency());
  }

  // --- validators: the checks the API makes too, so the answer comes before the request ----------

  private readonly withinBalance: ValidatorFn = (control) => {
    const amount: unknown = control.value;
    const source = this.source();
    if (typeof amount !== 'number' || amount <= 0 || !source || amount <= source.balance) {
      return null;
    }
    return {
      amount: {
        message:
          source.balance > 0
            ? `${source.label} holds only ${this.money(source.balance)}.`
            : `${source.label} has nothing to take.`,
      },
    };
  };

  private readonly differFromSource: ValidatorFn = (control) =>
    control.value === this.form.controls.fromGoalId.value
      ? { place: { message: 'Choose two different places to move the money between.' } }
      : null;

  private readonly notInTheFuture: ValidatorFn = (control) => {
    const today = this.today.date();
    const value: unknown = control.value;
    return today && typeof value === 'string' && value > today
      ? { date: { message: "The date can't be in the future." } }
      : null;
  };

  private readonly notBeforeStart: ValidatorFn = (control) => {
    const first = this.firstDay();
    const value: unknown = control.value;
    return first && typeof value === 'string' && value !== '' && value < first
      ? {
          date: {
            message: `The date can't be before the start month (${formatDate(first, this.settings.locale(), 'medium')}).`,
          },
        }
      : null;
  };

  // --- saving ------------------------------------------------------------------------------------

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.amount === null) {
      this.focusInvalidAfterRender();
      return;
    }

    const kind = this.kind();
    const note = value.note.trim();
    const common = { amount: value.amount, date: value.date, ...(note ? { note } : {}) };
    let body: SavingsTransactionCreateInput;
    switch (kind) {
      case 'deposit':
        body = { kind, goalId: toGoalId(value.goalId), ...common };
        break;
      case 'withdrawal':
        body = { kind, goalId: toGoalId(value.goalId), ...common };
        break;
      case 'reallocation':
        body = {
          kind,
          fromGoalId: toGoalId(value.fromGoalId),
          toGoalId: toGoalId(value.toGoalId),
          ...common,
        };
        break;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.addTransaction(body));
      this.toast.success(this.confirmation(value));
      if (this.alive()) {
        this.changed.emit();
        this.finished.emit();
      }
    } catch (error) {
      if (!this.alive()) return;
      const parsed = parseApiError(error);
      // The API words this one in raw cents ("holds 100 cents"): say it in money, on the amount.
      const source = this.source();
      const shown =
        parsed.rule === 'insufficient_balance' && source
          ? {
              ...parsed,
              fieldErrors: {
                amount: `${source.label} no longer holds ${this.money(value.amount)}. Its current balance is shown below.`,
              },
            }
          : parsed;
      this.formError.set(applyApiErrors(this.form, shown));
      this.focusInvalidAfterRender();
      // The balance or a goal moved since the page loaded: show the current ones.
      if (
        parsed.rule === 'insufficient_balance' ||
        parsed.rule === 'unknown_goal' ||
        parsed.rule === 'goal_archived'
      ) {
        this.changed.emit();
      }
    } finally {
      this.saving.set(false);
    }
  }

  /** What was recorded, in a sentence. */
  private confirmation(value: {
    amount: Cents | null;
    goalId: string;
    fromGoalId: string;
    toGoalId: string;
  }): string {
    const places = this.sources();
    const name = (id: string) => places.find((place) => place.value === id)?.label ?? 'a goal';
    const amount = this.money(value.amount ?? 0);
    switch (this.kind()) {
      case 'deposit':
        return `Deposited ${amount} into ${name(value.goalId)}.`;
      case 'withdrawal':
        return `Withdrew ${amount} from ${name(value.goalId)}.`;
      case 'reallocation':
        return `Moved ${amount} from ${name(value.fromGoalId)} to ${name(value.toGoalId)}.`;
    }
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }
}
