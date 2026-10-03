import { Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import {
  type ControlValueAccessor,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
// Zod-free deep imports: they keep zod out of the pages that only need an amount field.
import { MAX_CENTS } from '@wallet/shared/limits';
import { type Cents, parseCents } from '@wallet/shared/money';
import { SettingsStore } from '../../core/settings.store';
import { AppInput } from './app-input';

let nextUnitId = 0;

/** Parses what the user typed ("12,50", "12.5", "-3") into integer cents. null when it is not an amount. */
export function parseAmount(text: string): Cents | null {
  const cents = parseCents(text);
  // parseCents("-0") gives -0, which would travel as a "negative zero" amount.
  return cents === 0 ? 0 : cents;
}

const separators = new Map<string, '.' | ','>();

/** The decimal separator to show for a locale. Only "." and "," can be typed back (see `parseCents`). */
export function decimalSeparator(locale: string): '.' | ',' {
  let separator = separators.get(locale);
  if (!separator) {
    let found = '.';
    try {
      found =
        new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ??
        '.';
    } catch {
      // An ill-formed locale falls back to ".".
    }
    separator = found === ',' ? ',' : '.';
    separators.set(locale, separator);
  }
  return separator;
}

/** Cents as plain text for an input: 1250 becomes "12.50". Integer arithmetic only. */
export function formatAmountInput(cents: Cents, separator: '.' | ','): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const fraction = absolute % 100;
  const whole = (absolute - fraction) / 100;
  return `${sign}${whole}${separator}${String(fraction).padStart(2, '0')}`;
}

/**
 * An amount of money as a form control that holds **integer cents** (or null when empty or not
 * a valid amount). The user types "12,50" or "12.50"; the control value is 1250. It reports an
 * `invalidAmount` error for text that is not an amount, so it works with `Validators.required`,
 * `positiveAmount` and the other validators, and it shows the error state of its `app-field`.
 *
 *     <app-field label="Amount">
 *       <app-money-input formControlName="amount" />
 *     </app-field>
 */
@Component({
  selector: 'app-money-input',
  imports: [AppInput],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MoneyInput), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => MoneyInput), multi: true },
  ],
  template: `
    <div
      class="flex items-stretch rounded-control has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
    >
      <input
        appInput
        type="text"
        autocomplete="off"
        spellcheck="false"
        class="min-w-0 rounded-r-none text-right tabular-nums focus-visible:outline-none"
        [extraDescribedBy]="unitId"
        [attr.inputmode]="keyboard()"
        [attr.aria-label]="ariaLabel() ?? null"
        [attr.placeholder]="placeholder()"
        [value]="text()"
        [disabled]="disabled()"
        (input)="onInput($event)"
        (blur)="onBlur()"
      />
      <span
        [id]="unitId"
        class="flex items-center rounded-r-control border border-l-0 border-line-strong bg-subtle px-3 text-sm font-medium text-muted"
        >{{ unit() }}</span
      >
    </div>
  `,
  host: { class: 'block' },
})
export class MoneyInput implements ControlValueAccessor, Validator {
  private readonly settings = inject(SettingsStore);

  /** Currency shown after the amount. Defaults to the one of the settings. */
  readonly currency = input<string>();
  /** Locale that decides the decimal separator shown. Defaults to the one of the settings. */
  readonly locale = input<string>();
  /** Accessible name, for a money input that has no `app-field` around it. */
  readonly ariaLabel = input<string>();
  /**
   * The on-screen keyboard a phone shows. The digits keypad (`decimal`) has no minus sign, so an
   * amount that may be negative (a refund bound in a filter) asks for the full keyboard (`text`).
   */
  readonly keyboard = input<'decimal' | 'text'>('decimal');

  protected readonly unitId = `money-unit-${nextUnitId++}`;
  protected readonly unit = computed(() => this.currency() ?? this.settings.currency());
  private readonly separator = computed(() =>
    decimalSeparator(this.locale() ?? this.settings.locale()),
  );
  protected readonly placeholder = computed(() => formatAmountInput(0, this.separator()));

  protected readonly text = signal('');
  protected readonly disabled = signal(false);

  private onChange: (value: Cents | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: Cents | null): void {
    this.text.set(typeof value === 'number' ? formatAmountInput(value, this.separator()) : '');
  }

  registerOnChange(fn: (value: Cents | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  validate(): ValidationErrors | null {
    const text = this.text().trim();
    if (text === '') return null;
    const cents = parseAmount(text);
    if (cents === null) {
      return { invalidAmount: { message: 'Enter an amount like 12.50 or 12,50.' } };
    }
    if (Math.abs(cents) > MAX_CENTS) {
      return { amountTooLarge: { message: 'That amount is too large.' } };
    }
    return null;
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.text.set(text);
    const trimmed = text.trim();
    this.onChange(trimmed === '' ? null : parseAmount(trimmed));
  }

  protected onBlur(): void {
    this.onTouched();
    // Tidy up what was typed: "12,5" becomes "12,50".
    const trimmed = this.text().trim();
    const cents = trimmed === '' ? null : parseAmount(trimmed);
    if (cents !== null) this.text.set(formatAmountInput(cents, this.separator()));
  }
}
