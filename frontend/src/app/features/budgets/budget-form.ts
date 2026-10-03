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
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type {
  BudgetCreateInput,
  BudgetDto,
  BudgetUpdateInput,
  Cents,
  MonthKey,
} from '@wallet/shared';
// Zod-free deep import: keeps zod out of this page's chunk.
import { ICON_MAX_LENGTH, NAME_MAX_LENGTH, NOTES_MAX_LENGTH } from '@wallet/shared/limits';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { clampMonth, formatMonth } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { ColorPicker } from '../../shared/forms/color-picker';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import {
  appliesFromNote,
  defaultStartMonth,
  type MonthNote,
  startsNote,
} from '../../shared/forms/month-notes';
import { Toggle } from '../../shared/forms/toggle';
import { nonNegativeAmount, wholePercent } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { BudgetsApi } from './budgets.api';
import { versionAt } from './budget-utils';

/** Emoji offered next to the icon field. The field takes anything, they are only shortcuts. */
const ICON_SUGGESTIONS: readonly { icon: string; name: string }[] = [
  { icon: '🛒', name: 'shopping cart' },
  { icon: '🏠', name: 'house' },
  { icon: '🚗', name: 'car' },
  { icon: '🍽️', name: 'dining' },
  { icon: '🎬', name: 'cinema' },
  { icon: '✈️', name: 'airplane' },
  { icon: '👕', name: 'clothes' },
  { icon: '💊', name: 'health' },
  { icon: '🎁', name: 'gift' },
  { icon: '📚', name: 'books' },
];

/**
 * Creates a budget, or edits one when `budget` is given.
 *
 * Creating is one request (`POST /api/budgets`). Editing is up to two: the name, color, icon,
 * threshold and notes go to `PATCH /api/budgets/:id`, and a new amount or mode goes to
 * `PUT /api/budgets/:id/versions/:month`, which applies **from that month on**. That month starts
 * as the current month, so closed months never change by accident. Choosing an earlier one is
 * allowed, but the form says plainly what that does.
 *
 * `changed` fires whenever something was saved (the page reloads); `finished` when everything was
 * (the page closes the dialog). After a failure the dialog stays open with the message on the
 * field the API named.
 */
@Component({
  selector: 'app-budget-form',
  imports: [
    ReactiveFormsModule,
    AppDialog,
    Field,
    AppInput,
    MoneyInput,
    MonthInput,
    Toggle,
    ColorPicker,
    Button,
    Icon,
    MoneyPipe,
  ],
  templateUrl: './budget-form.html',
  host: { class: 'block' },
})
export class BudgetForm implements OnInit {
  private readonly api = inject(BudgetsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The budget to edit. Leave unset to create one. */
  readonly budget = input<BudgetDto>();
  /** The month the page shows: a new budget starts there unless that month is already closed. */
  readonly month = input.required<MonthKey>();

  /** Something was saved on the server: reload what is shown. */
  readonly changed = output<void>();
  /** Everything was saved: close the dialog. */
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly iconMaxLength = ICON_MAX_LENGTH;
  protected readonly notesMaxLength = NOTES_MAX_LENGTH;
  protected readonly iconSuggestions = ICON_SUGGESTIONS;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** What is stored now: the budget given, then whatever the last successful request returned. */
  protected readonly stored = signal<BudgetDto | undefined>(undefined);
  protected readonly editing = computed(() => this.budget() !== undefined);

  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(NAME_MAX_LENGTH)],
    }),
    amount: new FormControl<Cents | null>(null, [Validators.required, nonNegativeAmount]),
    incremental: new FormControl(false, { nonNullable: true }),
    /** Creating: the first month of the budget. */
    startMonth: new FormControl<MonthKey | null>(null, [Validators.required]),
    /** Editing: the month the new amount and mode apply from. */
    month: new FormControl<MonthKey | null>(null, [Validators.required]),
    color: new FormControl<string | null>(null),
    icon: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(ICON_MAX_LENGTH)],
    }),
    alertWarnPercent: new FormControl<number | null>(null, [wholePercent]),
    notes: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(NOTES_MAX_LENGTH)],
    }),
  });

  /** Ticks whenever any control changes, so the computed values below re-read the plain controls. */
  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  protected readonly currentMonth = this.today.month;
  protected readonly firstMonth = this.settings.startMonth;

  /** Editing: the first and last month the budget exists in. A version must fall within them. */
  protected readonly minMonth = computed(() => this.budget()?.startMonth);
  protected readonly maxMonth = computed(() => this.budget()?.endMonth ?? undefined);

  protected readonly incrementalHint = computed(() => {
    this.draft();
    return this.form.controls.incremental.value
      ? 'Leftover money, or overspending, carries into the next month.'
      : 'At month end the leftover goes to savings, and overspending is taken from savings.';
  });

  protected readonly alertHint = computed(
    () =>
      `Warn once this share of the available amount is spent. Empty: use your default of ${this.settings.alertWarnPercent()}%.`,
  );

  /** The month the amount applies from (editing) or the budget starts (creating), as typed. */
  private readonly chosenMonth = computed<MonthKey | null>(() => {
    this.draft();
    const control = this.editing() ? this.form.controls.month : this.form.controls.startMonth;
    return control.value;
  });

  /** Says what the chosen month means. Backdating gets a warning: it changes a closed month. */
  protected readonly monthNote = computed<MonthNote | null>(() => {
    const chosen = this.chosenMonth();
    const current = this.currentMonth();
    if (!chosen || !current) return null;
    const locale = this.settings.locale();
    return this.editing()
      ? appliesFromNote({ chosen, current, locale, noun: 'amount' })
      : startsNote({ chosen, current, locale, subject: 'budget' });
  });

  constructor() {
    // Choosing another "applies from" month shows what is in effect then, as long as the amount and
    // mode have not been touched: so scheduling a change starts from the planned values.
    this.form.controls.month.valueChanges.pipe(takeUntilDestroyed()).subscribe((month) => {
      const stored = this.stored();
      const { amount, incremental } = this.form.controls;
      if (!stored || !month || amount.dirty || incremental.dirty) return;
      const version = versionAt(stored.versions, month);
      if (!version) return;
      amount.setValue(version.amount);
      incremental.setValue(version.incremental);
    });
  }

  ngOnInit(): void {
    const budget = this.budget();
    this.stored.set(budget);

    if (budget) {
      this.form.controls.startMonth.disable();
      const month = clampMonth(
        this.currentMonth() ?? budget.startMonth,
        budget.startMonth,
        budget.endMonth,
      );
      const version = versionAt(budget.versions, month);
      this.form.setValue({
        name: budget.name,
        amount: version?.amount ?? null,
        incremental: version?.incremental ?? false,
        startMonth: budget.startMonth,
        month,
        color: budget.color,
        icon: budget.icon ?? '',
        alertWarnPercent: budget.alertWarnPercent,
        notes: budget.notes ?? '',
      });
    } else {
      this.form.controls.month.disable();
      // A closed month never gets a new budget by accident: start in the current month instead.
      const selected = this.month();
      const current = this.currentMonth();
      this.form.controls.startMonth.setValue(
        current ? defaultStartMonth(selected, current) : selected,
      );
    }
  }

  protected monthLabel(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  protected pickIcon(icon: string): void {
    const control = this.form.controls.icon;
    control.setValue(control.value === icon ? '' : icon);
    control.markAsDirty();
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    const month = this.editing() ? value.month : value.startMonth;
    if (this.form.invalid || value.amount === null || month === null) {
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
      return;
    }

    const fields = {
      name: value.name.trim(),
      color: value.color,
      icon: value.icon.trim() || null,
      alertWarnPercent: value.alertWarnPercent,
      notes: value.notes.trim() || null,
    };

    this.saving.set(true);
    this.formError.set(null);
    try {
      const stored = this.stored();
      if (stored) {
        // `changed` is emitted by `saveChanges`, once for each request that went through.
        const saved = await this.saveChanges(stored, fields, {
          amount: value.amount,
          incremental: value.incremental,
          month,
        });
        if (saved) this.toast.success(`${fields.name} updated.`);
      } else {
        const input: BudgetCreateInput = {
          name: fields.name,
          amount: value.amount,
          incremental: value.incremental,
          startMonth: month,
          ...(fields.color ? { color: fields.color } : {}),
          ...(fields.icon ? { icon: fields.icon } : {}),
          ...(fields.alertWarnPercent !== null
            ? { alertWarnPercent: fields.alertWarnPercent }
            : {}),
          ...(fields.notes ? { notes: fields.notes } : {}),
        };
        await firstValueFrom(this.api.create(input));
        this.toast.success(`${fields.name} created.`);
        this.changed.emit();
      }
      this.finished.emit();
    } catch (error) {
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Sends what differs from what is stored: a PATCH for the fields, then a PUT for the amount and
   * mode. If the second one fails the first one is already saved: the page is told (`changed`),
   * and the form compares against the new stored values from then on. Resolves to whether anything
   * was sent at all.
   */
  private async saveChanges(
    stored: BudgetDto,
    fields: {
      name: string;
      color: string | null;
      icon: string | null;
      alertWarnPercent: number | null;
      notes: string | null;
    },
    version: { amount: Cents; incremental: boolean; month: MonthKey },
  ): Promise<boolean> {
    const patch: BudgetUpdateInput = {};
    if (fields.name !== stored.name) patch.name = fields.name;
    if (fields.color !== stored.color) patch.color = fields.color;
    if (fields.icon !== stored.icon) patch.icon = fields.icon;
    if (fields.alertWarnPercent !== stored.alertWarnPercent) {
      patch.alertWarnPercent = fields.alertWarnPercent;
    }
    if (fields.notes !== stored.notes) patch.notes = fields.notes;

    let latest = stored;
    let sent = false;
    if (Object.keys(patch).length > 0) {
      latest = await firstValueFrom(this.api.update(stored.id, patch));
      this.stored.set(latest);
      this.changed.emit();
      sent = true;
    }

    const inEffect = versionAt(latest.versions, version.month);
    if (
      inEffect === undefined ||
      inEffect.amount !== version.amount ||
      inEffect.incremental !== version.incremental
    ) {
      latest = await firstValueFrom(
        this.api.putVersion(stored.id, version.month, {
          amount: version.amount,
          incremental: version.incremental,
        }),
      );
      this.stored.set(latest);
      this.changed.emit();
      sent = true;
    }
    return sent;
  }
}
