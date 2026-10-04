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
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Cents, MonthKey, SalaryEntryDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { ToastService } from '../../shared/ui/toast.service';
import { formatMonth } from '../../shared/format';
import { applyApiErrors, focusFirstInvalid } from '../../shared/forms/api-errors';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { MonthInput } from '../../shared/forms/month-input';
import { nonNegativeAmount } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { SalaryApi } from './salary.api';

/**
 * The dialog that adds or changes a salary entry. A salary entry applies **from its month onward**;
 * it never rewrites earlier months, and the form says so. The month starts as the selected one and
 * follows it until the user picks another; a month that already has an entry says that saving
 * replaces it. `entry` loads an existing entry (the Change of its row) with its month and amount.
 */
@Component({
  selector: 'app-salary-form',
  imports: [
    Alert,
    AppDialog,
    Button,
    Field,
    Icon,
    MoneyInput,
    MoneyPipe,
    MonthInput,
    ReactiveFormsModule,
  ],
  template: `
    <app-dialog heading="Change salary" [locked]="saving()" (closed)="cancelled.emit()">
      <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <app-field label="Applies from" hint="The first month with this salary.">
            <app-month-input formControlName="month" [min]="startMonth()" />
          </app-field>
          <app-field label="Monthly net salary">
            <app-money-input formControlName="amount" />
          </app-field>
        </div>

        <p class="flex items-start gap-2 text-sm text-muted">
          <app-icon name="info" class="mt-0.5" />
          <span>
            @if (fromLabel(); as from) {
              This salary applies from {{ from }} onward. Earlier months are not changed.
              @if (replaced(); as entry) {
                It replaces the {{ entry.amount | money }} salary that starts in {{ from }}.
              }
            } @else {
              Pick the first month the new salary applies to. Earlier months are not changed.
            }
          </span>
        </p>

        @if (formError(); as error) {
          <app-alert tone="error">{{ error }}</app-alert>
        }

        <div class="dialog-footer">
          <button appButton variant="secondary" [disabled]="saving()" (click)="cancelled.emit()">
            Cancel
          </button>
          <button appButton type="submit" [loading]="saving()">
            {{ replaced() ? 'Save the change' : 'Save salary' }}
          </button>
        </div>
      </form>
    </app-dialog>
  `,
  host: { class: 'block' },
})
export class SalaryForm implements OnInit {
  private readonly api = inject(SalaryApi);
  private readonly settings = inject(SettingsStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The selected month: where the form starts. */
  readonly month = input.required<MonthKey>();
  /** Every salary change, ascending by month (`GET /api/salary`). */
  readonly entries = input.required<readonly SalaryEntryDto[]>();
  /** The entry to change, from its row. Leave unset to start from the selected month. */
  readonly entry = input<SalaryEntryDto>();

  /** The salary was saved. */
  readonly saved = output<void>();
  readonly cancelled = output<void>();

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

  protected readonly fromLabel = computed(() => {
    const month = this.formMonth();
    return month ? formatMonth(month, this.settings.locale()) : null;
  });

  /** The entry that starts exactly in the month of the form: saving would replace it. */
  protected readonly replaced = computed(() => {
    const month = this.formMonth();
    return month ? this.entries().find((entry) => entry.effectiveMonth === month) : undefined;
  });

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

  ngOnInit(): void {
    const entry = this.entry();
    if (!entry) return;
    this.form.setValue({ month: entry.effectiveMonth, amount: entry.amount });
    this.form.controls.month.markAsDirty();
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const { month, amount } = this.form.getRawValue();
    if (this.form.invalid || month === null || amount === null) {
      this.focusInvalidAfterRender();
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await firstValueFrom(this.api.upsert(month, { amount }));
      this.toast.success(`Salary saved from ${formatMonth(month, this.settings.locale())} onward.`);
      if (this.alive()) this.saved.emit();
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
