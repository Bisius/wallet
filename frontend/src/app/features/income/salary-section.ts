import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, MonthKey, SalaryEntryDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import { nonNegativeAmount } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { SalaryApi } from './salary.api';

/**
 * The salary history, and the form to add or change an entry. A salary entry applies **from its
 * month onward**; it never rewrites earlier months, and the form says so. The amount shown for the
 * selected month is the one the month view reports (`salary` input), not a calculation of ours.
 */
@Component({
  selector: 'app-salary-section',
  imports: [
    ReactiveFormsModule,
    Field,
    MoneyInput,
    MonthInput,
    Button,
    Icon,
    Amount,
    EmptyState,
    MoneyPipe,
  ],
  templateUrl: './salary-section.html',
  host: { class: 'block' },
})
export class SalarySection {
  private readonly api = inject(SalaryApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The selected month. */
  readonly month = input.required<MonthKey>();
  /** Every salary change, ascending by month (`GET /api/salary`). */
  readonly entries = input.required<readonly SalaryEntryDto[]>();
  /** The salary in effect in the selected month, as the month view reports it. */
  readonly salary = input<Cents>();

  /** Something was saved or deleted: the page reloads what it shows. */
  readonly changed = output<void>();

  protected readonly startMonth = this.settings.startMonth;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    month: new FormControl<MonthKey | null>(null, [Validators.required]),
    amount: new FormControl<Cents | null>(null, [Validators.required, nonNegativeAmount]),
  });

  private readonly formMonth = toSignal(this.form.controls.month.valueChanges, {
    initialValue: this.form.controls.month.value,
  });

  protected readonly monthLabel = computed(() => this.label(this.month()));
  protected readonly fromLabel = computed(() => {
    const month = this.formMonth();
    return month ? this.label(month) : null;
  });

  /** The entry that starts exactly in the month of the form: saving would replace it. */
  protected readonly replaced = computed(() => {
    const month = this.formMonth();
    return month ? this.entries().find((entry) => entry.effectiveMonth === month) : undefined;
  });

  /**
   * Marks the entry that covers the selected month, as the contract describes it ("the entry with
   * the latest effectiveMonth <= M"). Only a marker: the amount shown comes from the month view.
   */
  protected readonly inEffectMonth = computed(
    () =>
      this.entries()
        .filter((entry) => entry.effectiveMonth <= this.month())
        .at(-1)?.effectiveMonth,
  );

  constructor() {
    // The form starts on the selected month and follows it until the user picks another one.
    effect(() => {
      const month = this.month();
      untracked(() => {
        const control = this.form.controls.month;
        if (!control.dirty) control.setValue(month);
      });
    });
  }

  protected label(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  /** Loads an entry into the form to change its amount. */
  protected edit(entry: SalaryEntryDto): void {
    this.form.setValue({ month: entry.effectiveMonth, amount: entry.amount });
    this.form.controls.month.markAsDirty();
    this.formError.set(null);
    afterNextRender(
      () => {
        const form = this.host.nativeElement.querySelector<HTMLElement>('form');
        form?.scrollIntoView?.({ block: 'nearest' });
        form?.querySelector<HTMLElement>('app-money-input input')?.focus();
      },
      { injector: this.injector },
    );
  }

  protected async remove(entry: SalaryEntryDto): Promise<void> {
    const from = this.label(entry.effectiveMonth);
    const confirmed = await this.confirm.confirm({
      title: 'Delete this salary change?',
      message:
        `The salary change from ${from} will be removed. Months from ${from} on use the previous ` +
        'salary entry instead; with none before it they have no salary.',
      confirmLabel: 'Delete salary change',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(entry.effectiveMonth));
      this.toast.success(`Salary change from ${from} deleted.`);
      this.changed.emit();
      // The row that had focus is gone.
      afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const { month, amount } = this.form.getRawValue();
    if (this.form.invalid || month === null || amount === null) {
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.upsert(month, { amount }));
      this.toast.success(`Salary saved from ${this.label(month)} onward.`);
      this.form.reset({ month: this.month(), amount: null });
      this.changed.emit();
    } catch (error) {
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
    } finally {
      this.saving.set(false);
    }
  }
}
