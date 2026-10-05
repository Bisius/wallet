import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, type ValidatorFn } from '@angular/forms';
import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  TELEGRAM_RENEWAL_DAYS_MAX,
  TELEGRAM_RENEWAL_DAYS_MIN,
  type TelegramNotificationSettingsDto,
  type TelegramNotificationSettingsInput,
  telegramNotifyAtSchema,
  telegramRenewalDaysSchema,
} from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { applyApiErrors, focusFirstInvalidOrSubmit } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Toggle } from '../../shared/forms/toggle';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppSection } from '../../shared/ui/section';
import { ToastService } from '../../shared/ui/toast.service';
import { TelegramApi } from './telegram.api';

/** The API's range for a reminder lead, said plainly (the schema's own message is not meant for people). */
const DAYS_PROBLEM = `Enter a whole number from ${TELEGRAM_RENEWAL_DAYS_MIN} to ${TELEGRAM_RENEWAL_DAYS_MAX}.`;

/** A whole number of days, 0 (off) to 30: the same rule as the API, from the shared schema. */
const wholeDays: ValidatorFn = (control) =>
  telegramRenewalDaysSchema.safeParse(control.value).success ? null : { days: DAYS_PROBLEM };

/** `HH:MM`, 24-hour: the same rule as the API, from the shared schema. */
const timeOfDay: ValidatorFn = (control) =>
  telegramNotifyAtSchema.safeParse(control.value).success
    ? null
    : { time: 'Enter a time of day, like 09:00.' };

/**
 * What the bot sends, and when (`PUT /api/telegram/notifications`): budget alerts, the yearly and the
 * monthly renewal reminders ("days before", 0 turns one off), the recap of the month that closed, and
 * the time of day from which the reminders and the recap go out, in the server's time zone. All five
 * are saved together.
 *
 * It is a block of the Telegram section, so its heading is a level 3 one. The preferences come in
 * `settings` (what the server holds) and fill the form once: a later refresh of the section never
 * overwrites what is being typed. `saved` fires after the API accepted them, for the section to read
 * them again.
 */
@Component({
  selector: 'app-telegram-notifications',
  imports: [Alert, ReactiveFormsModule, AppSection, Field, AppInput, Toggle, Button],
  template: `
    <app-section
      level="3"
      landmark
      heading="Notifications"
      description="What the bot sends you, and when."
    >
      <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-4">
        <app-toggle
          formControlName="budgetAlerts"
          label="Budget alerts"
          hint="A message when a spending, from anywhere, takes a budget to a higher alert level."
        />

        <div class="grid gap-4 sm:grid-cols-2">
          <app-field
            label="Yearly renewals: days before"
            [hint]="'0 turns the reminder off. Default: ' + defaults.renewalYearlyDays + '.'"
          >
            <input
              appInput
              type="number"
              formControlName="renewalYearlyDays"
              [min]="daysMin"
              [max]="daysMax"
              step="1"
              inputmode="numeric"
              autocomplete="off"
            />
          </app-field>

          <app-field
            label="Monthly renewals: days before"
            [hint]="'0 turns the reminder off. Default: ' + defaults.renewalMonthlyDays + '.'"
          >
            <input
              appInput
              type="number"
              formControlName="renewalMonthlyDays"
              [min]="daysMin"
              [max]="daysMax"
              step="1"
              inputmode="numeric"
              autocomplete="off"
            />
          </app-field>
        </div>

        <app-toggle
          formControlName="monthlyRecap"
          label="Monthly recap"
          hint="On the 1st, how the month that just closed went."
        />

        <app-field
          label="Time of day (server's time zone)"
          hint="Renewal reminders and the recap go out from this time. It is the server's clock, which may differ from your device's."
        >
          <input appInput type="time" formControlName="notifyAt" />
        </app-field>

        @if (formError(); as error) {
          <app-alert tone="error">{{ error }}</app-alert>
        }

        <div class="form-actions">
          <button appButton type="submit" [loading]="saving()">Save notification settings</button>
        </div>
      </form>
    </app-section>
  `,
  host: { class: 'block' },
})
export class TelegramNotifications implements OnInit {
  private readonly api = inject(TelegramApi);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** What the server holds now. Read once, when the form is made. */
  readonly settings = input.required<TelegramNotificationSettingsDto>();
  /** The preferences were saved. */
  readonly saved = output<void>();

  protected readonly defaults = DEFAULT_TELEGRAM_NOTIFICATIONS;
  protected readonly daysMin = TELEGRAM_RENEWAL_DAYS_MIN;
  protected readonly daysMax = TELEGRAM_RENEWAL_DAYS_MAX;

  protected readonly saving = signal(false);
  /** An error that belongs to no field. */
  protected readonly formError = signal<string | null>(null);

  /** The control names are the request's field names, so a field error from the API lands on its control. */
  protected readonly form = new FormGroup({
    budgetAlerts: new FormControl(DEFAULT_TELEGRAM_NOTIFICATIONS.budgetAlerts, {
      nonNullable: true,
    }),
    renewalYearlyDays: new FormControl<number | null>(
      DEFAULT_TELEGRAM_NOTIFICATIONS.renewalYearlyDays,
      [wholeDays],
    ),
    renewalMonthlyDays: new FormControl<number | null>(
      DEFAULT_TELEGRAM_NOTIFICATIONS.renewalMonthlyDays,
      [wholeDays],
    ),
    monthlyRecap: new FormControl(DEFAULT_TELEGRAM_NOTIFICATIONS.monthlyRecap, {
      nonNullable: true,
    }),
    notifyAt: new FormControl(DEFAULT_TELEGRAM_NOTIFICATIONS.notifyAt, {
      nonNullable: true,
      validators: [timeOfDay],
    }),
  });

  ngOnInit(): void {
    this.form.setValue({ ...this.settings() });
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (
      this.form.invalid ||
      value.renewalYearlyDays === null ||
      value.renewalMonthlyDays === null
    ) {
      this.focusFirstInvalidAfterRender();
      return;
    }

    const input: TelegramNotificationSettingsInput = {
      budgetAlerts: value.budgetAlerts,
      renewalYearlyDays: value.renewalYearlyDays,
      renewalMonthlyDays: value.renewalMonthlyDays,
      monthlyRecap: value.monthlyRecap,
      notifyAt: value.notifyAt,
    };

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.saveNotifications(input));
      this.toast.success('Notification settings saved.');
      if (!this.alive()) return;
      this.form.markAsPristine();
      this.saved.emit();
    } catch (error) {
      if (!this.alive()) return;
      this.formError.set(applyApiErrors(this.form, parseApiError(error)));
    } finally {
      this.saving.set(false);
      // The button was disabled while the request was out, which took focus away: a field that the
      // API refused gets it, and else the button does.
      if (this.alive()) this.focusFirstInvalidAfterRender();
    }
  }

  private focusFirstInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalidOrSubmit(this.host.nativeElement), {
      injector: this.injector,
    });
  }
}
