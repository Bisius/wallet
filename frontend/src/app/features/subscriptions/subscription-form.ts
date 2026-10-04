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
import type {
  Cents,
  MonthKey,
  SubscriptionCreateInput,
  SubscriptionDto,
  SubscriptionUpdateInput,
} from '@wallet/shared';
// Zod-free deep import: keeps zod out of this page's chunk.
import {
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  SUBSCRIPTION_FREQUENCIES,
  type SubscriptionFrequency,
} from '@wallet/shared/limits';
import { firstValueFrom, type Observable } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { ColorPicker } from '../../shared/forms/color-picker';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import { defaultStartMonth, type MonthNote, startsNote } from '../../shared/forms/month-notes';
import { positiveAmount } from '../../shared/forms/validators';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { ToastService } from '../../shared/ui/toast.service';
import { SubscriptionsApi } from './subscriptions.api';

const FREQUENCY_LABELS: Record<SubscriptionFrequency, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/**
 * Adds a subscription, or edits one when `subscription` is given.
 *
 * Adding sends the name, frequency, charge date, price and start month. Editing only changes the
 * name, charge date, color and notes (`PATCH`): the frequency cannot change (cancel and add a new
 * one), and a new price goes through `PriceForm`, which says what it applies from.
 *
 * `changed` fires when the server's data changed (the page reloads), `finished` when the dialog can
 * close. A failure keeps the dialog open with the message on the field the API named.
 */
@Component({
  selector: 'app-subscription-form',
  imports: [
    ReactiveFormsModule,
    AppDialog,
    Field,
    AppInput,
    MoneyInput,
    MonthInput,
    ColorPicker,
    Alert,
    Button,
  ],
  templateUrl: './subscription-form.html',
  host: { class: 'block' },
})
export class SubscriptionForm implements OnInit {
  private readonly api = inject(SubscriptionsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The subscription to edit. Leave unset to add one. */
  readonly subscription = input<SubscriptionDto>();
  /** The month the page shows: a new subscription starts there unless that month is closed. */
  readonly month = input.required<MonthKey>();

  readonly changed = output<void>();
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly frequencies = SUBSCRIPTION_FREQUENCIES;
  protected readonly frequencyLabels = FREQUENCY_LABELS;
  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly notesMaxLength = NOTES_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly editing = computed(() => this.subscription() !== undefined);
  protected readonly firstMonth = this.settings.startMonth;

  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(NAME_MAX_LENGTH)],
    }),
    frequency: new FormControl<SubscriptionFrequency>('monthly', { nonNullable: true }),
    amount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    anchorDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    startMonth: new FormControl<MonthKey | null>(null, [Validators.required]),
    color: new FormControl<string | null>(null),
    notes: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(NOTES_MAX_LENGTH)],
    }),
  });

  /** Ticks whenever any control changes, so the computed values below re-read the plain controls. */
  private readonly draft = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  protected readonly priceLabel = computed(() => {
    this.draft();
    return this.form.controls.frequency.value === 'yearly' ? 'Price per year' : 'Price per month';
  });

  protected readonly startNote = computed<MonthNote | null>(() => {
    this.draft();
    const chosen = this.form.controls.startMonth.value;
    const current = this.today.month();
    if (this.editing() || !chosen || !current) return null;
    return startsNote({ chosen, current, locale: this.settings.locale(), subject: 'subscription' });
  });

  ngOnInit(): void {
    const subscription = this.subscription();
    if (subscription) {
      this.form.controls.frequency.disable();
      this.form.controls.amount.disable();
      this.form.controls.startMonth.disable();
      this.form.patchValue({
        name: subscription.name,
        frequency: subscription.frequency,
        anchorDate: subscription.anchorDate,
        color: subscription.color,
        notes: subscription.notes ?? '',
      });
    } else {
      const current = this.today.month();
      // A closed month never gets a new subscription by accident.
      this.form.controls.startMonth.setValue(
        current ? defaultStartMonth(this.month(), current) : this.month(),
      );
      // The date it is charged: most often a subscription is added the day it is paid.
      this.form.controls.anchorDate.setValue(this.today.date() ?? '');
    }
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    const editing = this.subscription();
    if (this.form.invalid || (!editing && (value.amount === null || value.startMonth === null))) {
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
      return;
    }

    const name = value.name.trim();
    const notes = value.notes.trim() || null;

    let request: Observable<SubscriptionDto>;
    if (editing) {
      const changes: SubscriptionUpdateInput = {};
      if (name !== editing.name) changes.name = name;
      if (value.anchorDate !== editing.anchorDate) changes.anchorDate = value.anchorDate;
      if (value.color !== editing.color) changes.color = value.color;
      if (notes !== editing.notes) changes.notes = notes;
      if (Object.keys(changes).length === 0) {
        this.finished.emit();
        return;
      }
      request = this.api.update(editing.id, changes);
    } else {
      const input: SubscriptionCreateInput = {
        name,
        frequency: value.frequency,
        anchorDate: value.anchorDate,
        amount: value.amount ?? 0,
        startMonth: value.startMonth ?? this.month(),
        ...(value.color ? { color: value.color } : {}),
        ...(notes ? { notes } : {}),
      };
      request = this.api.create(input);
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(request);
      this.toast.success(editing ? `${name} updated.` : `${name} added.`);
      this.changed.emit();
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
}
