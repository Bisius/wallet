import {
  afterNextRender,
  Component,
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
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, IncomeDto, IncomeUpdateInput, MonthKey } from '@wallet/shared';
// Zod-free deep import: keeps zod out of this page's chunk.
import { DESCRIPTION_MAX_LENGTH } from '@wallet/shared/limits';
import { firstValueFrom, type Observable } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { clampDateToMonth, firstDayOf, lastDayOf } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { dateInMonth, positiveAmount } from '../../shared/forms/validators';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { ToastService } from '../../shared/ui/toast.service';
import { IncomesApi } from './incomes.api';

/**
 * The dialog that adds a one-off income, or edits one when `income` is given. The date starts as
 * today (from the server) and has to stay inside the selected month, so the income ends up on the
 * page it was added from.
 */
@Component({
  selector: 'app-income-form',
  imports: [Alert, AppDialog, ReactiveFormsModule, Field, AppInput, MoneyInput, Button],
  template: `
    <app-dialog
      [heading]="income() ? 'Edit income' : 'Add income'"
      [locked]="saving()"
      (closed)="cancelled.emit()"
    >
      <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-4">
        <app-field label="Description">
          <input
            appInput
            formControlName="description"
            autocomplete="off"
            [attr.maxlength]="descriptionMaxLength"
          />
        </app-field>

        <div class="grid gap-4 sm:grid-cols-2">
          <app-field label="Amount">
            <app-money-input formControlName="amount" />
          </app-field>
          <app-field label="Date">
            <input
              appInput
              type="date"
              formControlName="date"
              [attr.min]="firstDay()"
              [attr.max]="lastDay()"
            />
          </app-field>
        </div>

        @if (formError(); as error) {
          <app-alert tone="error">{{ error }}</app-alert>
        }

        <div class="dialog-footer">
          <button appButton variant="secondary" [disabled]="saving()" (click)="cancelled.emit()">
            Cancel
          </button>
          <button appButton type="submit" [loading]="saving()">
            {{ income() ? 'Save changes' : 'Add income' }}
          </button>
        </div>
      </form>
    </app-dialog>
  `,
  host: { class: 'block' },
})
export class IncomeForm implements OnInit {
  private readonly api = inject(IncomesApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The month the income belongs to: its date must be inside it. */
  readonly month = input.required<MonthKey>();
  /** The income to edit. Leave unset to add a new one. */
  readonly income = input<IncomeDto>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly descriptionMaxLength = DESCRIPTION_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected firstDay = () => firstDayOf(this.month());
  protected lastDay = () => lastDayOf(this.month());

  protected readonly form = new FormGroup({
    description: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(DESCRIPTION_MAX_LENGTH)],
    }),
    amount: new FormControl<Cents | null>(null, [Validators.required, positiveAmount]),
    date: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        dateInMonth(
          () => this.month(),
          () => this.settings.locale(),
        ),
      ],
    }),
  });

  constructor() {
    // The month can change while the form is open (the month switcher is always there): keep the
    // date inside it.
    effect(() => {
      const month = this.month();
      untracked(() => {
        const date = this.form.controls.date;
        if (date.value) date.setValue(clampDateToMonth(date.value, month));
      });
    });
  }

  ngOnInit(): void {
    const income = this.income();
    if (income) {
      this.form.setValue({
        description: income.description,
        amount: income.amount,
        date: income.date,
      });
    } else {
      const today = this.today.date() ?? firstDayOf(this.month());
      this.form.controls.date.setValue(clampDateToMonth(today, this.month()));
    }
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.amount === null) {
      afterNextRender(() => focusFirstInvalid(this.host.nativeElement), {
        injector: this.injector,
      });
      return;
    }

    const description = value.description.trim();
    const income = this.income();
    let request: Observable<IncomeDto>;
    if (income) {
      const changes: IncomeUpdateInput = {};
      if (value.date !== income.date) changes.date = value.date;
      if (value.amount !== income.amount) changes.amount = value.amount;
      if (description !== income.description) changes.description = description;
      if (Object.keys(changes).length === 0) {
        this.cancelled.emit();
        return;
      }
      request = this.api.update(income.id, changes);
    } else {
      request = this.api.create({ date: value.date, amount: value.amount, description });
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(request);
      this.toast.success(income ? 'Income updated.' : 'Income added.');
      if (this.alive()) this.saved.emit();
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
