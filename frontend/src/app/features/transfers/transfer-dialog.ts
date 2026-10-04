import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import type { BudgetDto, Cents, MonthKey, MonthView, TransferCreateInput } from '@wallet/shared';
import { MAX_MONTHS_AHEAD, NOTES_MAX_LENGTH } from '@wallet/shared/limits';
import { addMonths } from '@wallet/shared/month';
import { firstValueFrom } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { firstDayOf, formatMonth, lastDayOf } from '../../shared/format';
import { applyApiErrors, focusFirstInvalidOrSubmit } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { positiveAmount } from '../../shared/forms/validators';
import { formatMoney } from '../../shared/money.pipe';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { AppDialog } from '../../shared/ui/dialog';
import { ToastService } from '../../shared/ui/toast.service';
import { MonthsApi } from '../months/months.api';
import { closedMonthEffect, POOL_LABEL } from './transfer-text';
import { TransfersApi } from './transfers.api';

/** The value of the "Unallocated" choice of a side. A budget's choice is its id; `''` is no choice yet. */
const POOL = 'unallocated';

/** A side as the API wants it: a budget's id, or `null` for the unallocated pool. */
const sideOf = (value: string): number | null => (value === POOL ? null : Number(value));

/** One choice of a side picker. */
interface Choice {
  value: string;
  label: string;
}

/**
 * The warning for an amount above what the source holds, in the two parts that are told differently.
 * `lead` is what the source holds in the month: it does not depend on the amount, so it is what a
 * screen reader is told, once, when the warning appears or the source or the month changes.
 * `consequence` is what the amount would do, and changes with every digit typed: it is only shown.
 */
interface Warning {
  lead: string;
  consequence: string;
}

/**
 * Moves money inside a month: from a budget to another, or between a budget and the month's
 * unallocated pool (`POST /api/transfers`). The date decides the month, and starts as today when the
 * page shows the current month, else as the 1st of the shown month.
 *
 * What the pickers offer is what can be stored: the budgets that are active in the month of the date
 * (the API refuses the rest, `outside_active_months`). A budget that was chosen and is not active in
 * the month of a date picked afterwards stays chosen, marked as not active and with a message on its
 * field that stops the sending: a date typed digit by digit passes through months nobody means, and
 * must not throw the choices away on the way. One side at least has to be a budget and the two have
 * to differ; the dialog says so before it sends. The API stays the authority: what it refuses
 * (`unknown_budget`, `before_start_month`, `outside_active_months`) is shown on the field it names.
 *
 * A transfer is never refused for lack of money, so this does not either. It warns when the amount is
 * more than the source holds in that month (read from the month view: `remaining` of the budget,
 * `unallocated` of the pool) and says what would happen. A screen reader is told once, when the
 * warning appears or the source or the month changes, which source falls short and what it holds; what
 * the amount would do changes with every digit typed, so it is shown but not announced (see
 * `Warning`). A date in a closed month asks for confirmation first: it rewrites that month, and its
 * savings amount with it.
 *
 * `changed` fires when something was saved, or when the API's answer shows that the budgets on screen
 * are out of date (the page reloads); `finished` closes the dialog.
 */
@Component({
  selector: 'app-transfer-dialog',
  imports: [Alert, ReactiveFormsModule, AppDialog, Field, AppInput, MoneyInput, Button],
  templateUrl: './transfer-dialog.html',
  host: { class: 'block' },
})
export class TransferDialog implements OnInit {
  private readonly api = inject(TransfersApi);
  private readonly months = inject(MonthsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** Every budget, of every status (`GET /api/budgets`): the dialog picks the ones active at the date. */
  readonly budgets = input.required<readonly BudgetDto[]>();
  /** The month the page shows. The date starts in it. */
  readonly month = input.required<MonthKey>();
  /** The month view of that month, when the page has it: the dialog reads it instead of asking again. */
  readonly monthView = input<MonthView | undefined>();
  /** The budget to take the money from (the card whose button was used). null: nothing chosen yet. */
  readonly fromBudgetId = input<number | null>(null);

  readonly changed = output<void>();
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly notesMaxLength = NOTES_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** The control names are the request's field names, so a field error from the API lands on its control. */
  protected readonly form = new FormGroup({
    fromBudgetId: new FormControl('', { nonNullable: true }),
    toBudgetId: new FormControl('', { nonNullable: true }),
    amount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    date: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    note: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(NOTES_MAX_LENGTH)],
    }),
  });
  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  /** The first day that can be picked: the first day of the start month. */
  protected readonly firstDay = computed(() => {
    const start = this.settings.startMonth();
    return start ? firstDayOf(start) : undefined;
  });
  /** The last month the app has: the current month and `MAX_MONTHS_AHEAD` more. */
  private readonly lastMonth = computed(() => {
    const current = this.today.month();
    return current === undefined ? undefined : addMonths(current, MAX_MONTHS_AHEAD);
  });
  /**
   * The last day that can be picked. The API takes any date from the start month on, but a transfer
   * dated past this day (2062 for 2026, say) would be in no month the app shows: it would not be listed,
   * and its budget could neither be archived nor deleted.
   */
  protected readonly lastDay = computed(() => {
    const month = this.lastMonth();
    return month === undefined ? undefined : lastDayOf(month);
  });

  /** The month of the date being typed, or null while it is not a whole date. */
  private readonly dateMonth = computed<MonthKey | null>(() => {
    const date = this.draft().date ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : null;
  });

  /**
   * The date is in a month before the current one that the app tracks: closed, its figures are final.
   * A month before the start month is not closed, it does not exist, and the date field says so: it
   * must not be described as a month that "changes what is due to savings".
   */
  protected readonly closed = computed(() => {
    const month = this.dateMonth();
    const current = this.today.month();
    const first = this.settings.startMonth();
    return (
      month !== null &&
      current !== undefined &&
      month < current &&
      (first === undefined || month >= first)
    );
  });

  protected readonly dateHint = computed(() => {
    const month = this.dateMonth();
    return this.closed() && month
      ? `${this.monthName(month)} is closed. A transfer in it changes that month's budgets and what is due to savings.`
      : undefined;
  });

  /** The budgets that are active in the month of the date: the only ones the API accepts. */
  private readonly offered = computed<readonly BudgetDto[]>(() => {
    const month = this.dateMonth();
    // While the date is not a whole date there is no month to judge by: offer them all.
    if (month === null) return this.budgets();
    return this.budgets().filter(
      (budget) =>
        budget.startMonth <= month && (budget.endMonth === null || month <= budget.endMonth),
    );
  });

  // --- what each side holds, from the month view of the date's month ---------------------------------

  /**
   * The month whose view this dialog loads itself: any month but the one the page already has. Not a
   * month that does not exist (before the start month, or beyond the projection): the API answers 404.
   */
  private readonly ownMonth = computed(() => {
    const month = this.dateMonth();
    if (month === null) return undefined;
    const first = this.settings.startMonth();
    const last = this.lastMonth();
    if (first !== undefined && month < first) return undefined;
    if (last !== undefined && month > last) return undefined;
    return month !== this.month() || this.monthView() === undefined ? month : undefined;
  });
  private readonly ownView = this.months.view(this.ownMonth);

  /** The month view of the date's month, or undefined while it is not known (loading, or refused). */
  private readonly sourceView = computed<MonthView | undefined>(() => {
    const month = this.dateMonth();
    if (month === null) return undefined;
    const shown = this.monthView();
    if (month === this.month() && shown) return shown;
    return this.ownView.hasValue() ? this.ownView.value() : undefined;
  });

  /** "Unallocated" and the budgets on offer, each with what it holds when that is known. */
  protected readonly choices = computed<readonly Choice[]>(() => {
    const view = this.sourceView();
    const lines = new Map((view?.budgets ?? []).map((line) => [line.id, line]));
    const holds = (cents: Cents, over: string) =>
      cents < 0 ? `${over} ${this.money(-cents)}` : `${this.money(cents)} left`;
    const offered = this.offered();
    const month = this.dateMonth();
    // A budget that is chosen stays in its picker even when it is not active at the date, so the
    // picker still shows what was chosen (and the field says what is wrong with it).
    const { fromBudgetId, toBudgetId } = this.draft();
    const kept = [...new Set([fromBudgetId, toBudgetId])].filter(
      (value): value is string =>
        !!value &&
        value !== POOL &&
        !offered.some((budget) => String(budget.id) === value) &&
        this.budgets().some((budget) => String(budget.id) === value),
    );
    return [
      {
        value: POOL,
        label: view
          ? `${POOL_LABEL} · ${holds(view.unallocated, 'over-allocated by')}`
          : POOL_LABEL,
      },
      ...offered.map((budget) => {
        const line = lines.get(budget.id);
        return {
          value: String(budget.id),
          label: line ? `${budget.name} · ${holds(line.remaining, 'over by')}` : budget.name,
        };
      }),
      ...kept.map((value) => ({
        value,
        label:
          this.activityMessage(value) !== undefined && month !== null
            ? `${this.budgetName(value)} (not active in ${this.monthName(month)})`
            : this.budgetName(value),
      })),
    ];
  });

  /** Why the two sides cannot be, said before sending: only once both are chosen. */
  protected readonly sidesProblem = computed<string | undefined>(() => {
    const { fromBudgetId, toBudgetId } = this.draft();
    return this.sidesMessage(fromBudgetId ?? '', toBudgetId ?? '') ?? undefined;
  });

  /** Why the budget chosen as the source cannot be used at the date, said on its field. */
  protected readonly fromProblem = computed<string | undefined>(() =>
    this.activityMessage(this.draft().fromBudgetId),
  );
  /** Why the destination cannot be: the two sides together, or the budget at the date. */
  protected readonly toProblem = computed<string | undefined>(
    () => this.sidesProblem() ?? this.activityMessage(this.draft().toBudgetId),
  );

  /**
   * The warning for an amount above what the source holds, and what would happen. It never stops the
   * transfer: moving more than a budget holds just takes it over budget (docs/DOMAIN.md, "Transfers").
   */
  protected readonly warning = computed<Warning | null>(() => {
    this.draft();
    const { fromBudgetId, amount } = this.form.controls;
    const view = this.sourceView();
    const cents = amount.value;
    if (!view || typeof cents !== 'number' || cents <= 0 || fromBudgetId.value === '') return null;

    const when = formatMonth(view.month, this.settings.locale());
    if (fromBudgetId.value === POOL) {
      const left = view.unallocated;
      if (cents <= left) return null;
      return {
        lead:
          left >= 0
            ? `Only ${this.money(left)} is unallocated in ${when}.`
            : `${when} is already over-allocated by ${this.money(-left)}.`,
        consequence: `The month would be over-allocated by ${this.money(cents - left)}.`,
      };
    }
    const line = view.budgets.find((candidate) => String(candidate.id) === fromBudgetId.value);
    if (!line || cents <= line.remaining) return null;
    return {
      lead:
        line.remaining >= 0
          ? `${line.name} holds only ${this.money(line.remaining)} in ${when}.`
          : `${line.name} is already ${this.money(-line.remaining)} over budget in ${when}.`,
      consequence: `${line.name} would be ${this.money(cents - line.remaining)} over budget.`,
    };
  });

  /**
   * What the live region holds. A string, so it only changes when the words do: a screen reader speaks
   * of what changes in a live region, and the amount changes with every digit typed while the source
   * and the month stay the same. null while there is no warning.
   */
  protected readonly warningLead = computed<string | null>(() => this.warning()?.lead ?? null);

  constructor() {
    const { fromBudgetId, toBudgetId } = this.form.controls;
    // The two sides depend on each other.
    fromBudgetId.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      toBudgetId.updateValueAndValidity();
    });
  }

  ngOnInit(): void {
    const { fromBudgetId, toBudgetId, date, amount } = this.form.controls;

    // The validators read the inputs and the other controls, which are only set from here on.
    fromBudgetId.addValidators(this.fromChosen);
    toBudgetId.addValidators(this.toChosen);
    date.addValidators(this.inTrackedRange);

    const from = this.fromBudgetId();
    if (from !== null) fromBudgetId.setValue(String(from));
    // The default is the shown month: today (the server's, never the browser's) when that is the
    // current month, else its 1st, so the transfer lands in the month the person is looking at.
    const shown = this.month();
    const today = this.today.date();
    date.setValue(shown === this.today.month() && today ? today : firstDayOf(shown));
    amount.updateValueAndValidity();
    date.updateValueAndValidity();
    toBudgetId.updateValueAndValidity();
  }

  protected monthName(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  private money(cents: Cents): string {
    return formatMoney(cents, this.settings.locale(), this.settings.currency());
  }

  /** What a side is called: "Unallocated", or the budget's name. */
  private budgetName(value: string): string {
    if (value === POOL) return POOL_LABEL;
    return this.budgets().find((budget) => String(budget.id) === value)?.name ?? `Budget ${value}`;
  }

  /**
   * Why a budget that is chosen cannot be used at the date: it is not active in that month. undefined
   * when it can, when no budget is chosen, and while the date is before the start month (it has a
   * message of its own, and a date typed digit by digit passes through months that mean nothing).
   */
  private activityMessage(value: string | undefined): string | undefined {
    const month = this.dateMonth();
    if (month === null || !value || value === POOL) return undefined;
    const first = this.settings.startMonth();
    if (first !== undefined && month < first) return undefined;
    const budget = this.budgets().find((candidate) => String(candidate.id) === value);
    if (
      budget &&
      budget.startMonth <= month &&
      (budget.endMonth === null || month <= budget.endMonth)
    ) {
      return undefined;
    }
    return `${this.budgetName(value)} isn't active in ${this.monthName(month)}. Choose another.`;
  }

  /** The rule the two sides break, in words, or null. A side that is not chosen yet breaks none. */
  private sidesMessage(from: string, to: string): string | null {
    if (from === '' || to === '') return null;
    if (from === POOL && to === POOL) {
      return `One side has to be a budget: ${POOL_LABEL} can't be moved to itself.`;
    }
    if (from === to) return 'Choose two different budgets to move the money between.';
    return null;
  }

  // --- validators: the checks the API makes too, so the answer comes before the request ----------------

  private readonly fromChosen: ValidatorFn = (control) =>
    control.value === '' ? { side: { message: 'Choose where the money comes from.' } } : null;

  private readonly toChosen: ValidatorFn = (control) => {
    if (control.value === '') return { side: { message: 'Choose where the money goes.' } };
    const message = this.sidesMessage(this.form.controls.fromBudgetId.value, String(control.value));
    return message ? { side: { message } } : null;
  };

  /**
   * The date is in the months the app tracks, from the start month to `MAX_MONTHS_AHEAD` months past
   * the current one, so the transfer shows up in a month someone can look at. The `min` and `max` of
   * the input do not stop a typed date everywhere, so the range is checked here as well.
   */
  private readonly inTrackedRange: ValidatorFn = (control) => {
    const value: unknown = control.value;
    if (typeof value !== 'string' || value === '') return null;
    const first = this.firstDay();
    const last = this.lastDay();
    // A year of five digits, which a date field takes if the typing goes on, compares as text with
    // the bounds like no date at all: it is out of range as well.
    const whole = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const outside =
      !whole || (first !== undefined && value < first) || (last !== undefined && value > last);
    return outside ? { date: { message: this.rangeMessage() } } : null;
  };

  /** The months a date can be in, in words: "Pick a date between June 2026 and October 2036." */
  private rangeMessage(): string {
    const locale = this.settings.locale();
    const first = this.settings.startMonth();
    const last = this.lastMonth();
    const from = first === undefined ? undefined : formatMonth(first, locale);
    const to = last === undefined ? undefined : formatMonth(last, locale);
    if (from && to) return `Pick a date between ${from} and ${to}.`;
    if (from) return `Pick a date from ${from} on.`;
    return to ? `Pick a date up to ${to}.` : 'Pick a date in the months that are tracked.';
  }

  // --- saving -------------------------------------------------------------------------------------------

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.amount === null || this.fromProblem() || this.toProblem()) {
      this.focusInvalidAfterRender();
      return;
    }

    if (this.closed()) {
      const label = this.monthName(value.date.slice(0, 7));
      const confirmed = await this.confirm.confirm({
        title: 'Move money in a closed month?',
        message: closedMonthEffect(label),
        confirmLabel: 'Move money anyway',
      });
      if (!confirmed || !this.alive()) return;
    }

    const note = value.note.trim();
    const body: TransferCreateInput = {
      date: value.date,
      fromBudgetId: sideOf(value.fromBudgetId),
      toBudgetId: sideOf(value.toBudgetId),
      amount: value.amount,
      ...(note ? { note } : {}),
    };

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.create(body));
      this.toast.success(this.confirmation(value));
      if (this.alive()) {
        this.changed.emit();
        this.finished.emit();
      }
    } catch (error) {
      if (!this.alive()) return;
      const parsed = parseApiError(error);
      this.formError.set(applyApiErrors(this.form, parsed));
      this.focusInvalidAfterRender();
      // A budget was archived, moved or deleted since the page loaded: show the current ones.
      if (
        parsed.rule === 'unknown_budget' ||
        parsed.rule === 'outside_active_months' ||
        parsed.rule === 'before_start_month'
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
    fromBudgetId: string;
    toBudgetId: string;
    date: string;
  }): string {
    const month = value.date.slice(0, 7);
    const where = month === this.month() ? '' : ` in ${this.monthName(month)}`;
    return (
      `Moved ${this.money(value.amount ?? 0)} from ${this.budgetName(value.fromBudgetId)} ` +
      `to ${this.budgetName(value.toBudgetId)}${where}.`
    );
  }

  /** Puts focus on the first field with a message, or on the button that was pressed when there is none. */
  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalidOrSubmit(this.host.nativeElement), {
      injector: this.injector,
    });
  }
}
