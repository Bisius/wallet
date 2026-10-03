import { Component, effect, forwardRef, inject, input, signal } from '@angular/core';
import {
  type ControlValueAccessor,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import { isMonthKey, type MonthKey } from '@wallet/shared/month';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../format';
import { AppInput } from './app-input';

/**
 * A month (`YYYY-MM`) as a form control: `<app-month-input formControlName="startMonth" />`. It uses
 * the browser's month picker where there is one; elsewhere the user types `2026-10`. The value is a
 * `MonthKey`, or null when empty or not a valid month. `min` and `max` are validated too.
 */
@Component({
  selector: 'app-month-input',
  imports: [AppInput],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MonthInput), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => MonthInput), multi: true },
  ],
  template: `
    <input
      appInput
      type="month"
      autocomplete="off"
      placeholder="YYYY-MM"
      pattern="\\d{4}-(0[1-9]|1[0-2])"
      [attr.min]="min() ?? null"
      [attr.max]="max() ?? null"
      [attr.aria-label]="ariaLabel() ?? null"
      [value]="text()"
      [disabled]="disabled()"
      (input)="onInput($event)"
      (blur)="onTouched()"
    />
  `,
  host: { class: 'block' },
})
export class MonthInput implements ControlValueAccessor, Validator {
  private readonly settings = inject(SettingsStore);

  readonly min = input<MonthKey | undefined>();
  readonly max = input<MonthKey | undefined>();
  readonly ariaLabel = input<string>();

  protected readonly text = signal('');
  protected readonly disabled = signal(false);

  private onChange: (value: MonthKey | null) => void = () => undefined;
  protected onTouched: () => void = () => undefined;
  private onValidatorChange: () => void = () => undefined;

  constructor() {
    // The bounds can change while the control exists (for example when today's date arrives).
    effect(() => {
      this.min();
      this.max();
      this.onValidatorChange();
    });
  }

  writeValue(value: MonthKey | null): void {
    this.text.set(value ?? '');
  }

  registerOnChange(fn: (value: MonthKey | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  validate(): ValidationErrors | null {
    const text = this.text();
    if (text === '') return null;
    if (!isMonthKey(text)) return { invalidMonth: { message: 'Enter a month like 2026-10.' } };

    const locale = this.settings.locale();
    const min = this.min();
    const max = this.max();
    if (min && text < min) {
      return { monthRange: { message: `Choose ${formatMonth(min, locale)} or later.` } };
    }
    if (max && text > max) {
      return { monthRange: { message: `Choose ${formatMonth(max, locale)} or earlier.` } };
    }
    return null;
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.text.set(text);
    this.onChange(isMonthKey(text) ? text : null);
  }
}
