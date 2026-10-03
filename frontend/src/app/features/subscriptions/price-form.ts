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
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, MonthKey, SubscriptionDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { clampMonth, formatMonth } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import { appliesFromNote, type MonthNote } from '../../shared/forms/month-notes';
import { positiveAmount } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { SubscriptionsApi } from './subscriptions.api';

/**
 * Changes what a subscription costs, **from a month on** (`PUT /api/subscriptions/:id/prices/:month`).
 * The month starts as the current month, so closed months keep what they were charged. A later
 * month schedules the change; an earlier one is allowed but only as an explicit choice, with a
 * plain warning that it changes a month that is already closed.
 */
@Component({
  selector: 'app-price-form',
  imports: [ReactiveFormsModule, AppDialog, Field, MoneyInput, MonthInput, Button, Icon, MoneyPipe],
  templateUrl: './price-form.html',
  host: { class: 'block' },
})
export class PriceForm implements OnInit {
  private readonly api = inject(SubscriptionsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly subscription = input.required<SubscriptionDto>();

  readonly changed = output<void>();
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    amount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    /** Named like the path parameter the API reports its errors for. */
    month: new FormControl<MonthKey | null>(null, [Validators.required]),
  });

  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  protected readonly yearly = computed(() => this.subscription().frequency === 'yearly');
  protected readonly priceLabel = computed(() =>
    this.yearly() ? 'New price per year' : 'New price per month',
  );
  protected readonly minMonth = computed(() => this.subscription().startMonth);
  protected readonly maxMonth = computed(() => this.subscription().endMonth ?? undefined);
  /** What it costs now, or at the start for one that has not started. */
  protected readonly priceNow = computed(() => {
    const { currentPrice, prices } = this.subscription();
    return currentPrice ?? prices[0]?.amount ?? null;
  });

  protected readonly monthNote = computed<MonthNote | null>(() => {
    this.draft();
    const chosen = this.form.controls.month.value;
    const current = this.today.month();
    if (!chosen || !current) return null;
    return appliesFromNote({ chosen, current, locale: this.settings.locale(), noun: 'price' });
  });

  ngOnInit(): void {
    const { startMonth, endMonth } = this.subscription();
    const current = this.today.month() ?? startMonth;
    // The current month, so closed months never change by accident. A subscription that has not
    // started yet, or has ended, can only change within the months it exists in.
    this.form.controls.month.setValue(clampMonth(current, startMonth, endMonth));
  }

  protected monthLabel(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const { amount, month } = this.form.getRawValue();
    if (this.form.invalid || amount === null || month === null) {
      this.focusInvalidAfterRender();
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.putPrice(this.subscription().id, month, { amount }));
      this.toast.success(
        `${this.subscription().name} costs the new price from ${this.monthLabel(month)} on.`,
      );
      this.changed.emit();
      this.finished.emit();
    } catch (error) {
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
      this.focusInvalidAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalid(this.host.nativeElement), { injector: this.injector });
  }
}
