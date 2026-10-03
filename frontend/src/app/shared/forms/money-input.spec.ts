import { Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAX_CENTS } from '@wallet/shared';
import { blur, fieldError, getByLabel, typeInto } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Field } from './field';
import { decimalSeparator, formatAmountInput, MoneyInput, parseAmount } from './money-input';
import { nonNegativeAmount, positiveAmount } from './validators';

@Component({
  selector: 'app-money-host',
  imports: [ReactiveFormsModule, Field, MoneyInput],
  template: `
    <app-field label="Amount" hint="What you paid">
      <app-money-input [formControl]="amount" [currency]="currency()" [locale]="locale()" />
    </app-field>
  `,
})
class MoneyHost {
  readonly amount = new FormControl<number | null>(null, [Validators.required, positiveAmount]);
  readonly currency = signal<string | undefined>('EUR');
  readonly locale = signal<string | undefined>('en-US');
}

describe('MoneyInput', () => {
  async function setup() {
    const fixture = await render(MoneyHost);
    const element = fixture.nativeElement as HTMLElement;
    const input = getByLabel(element, 'Amount');
    const control = fixture.componentInstance.amount;
    const type = async (text: string) => {
      typeInto(input, text);
      await settle(fixture);
    };
    return { fixture, element, input, control, type, host: fixture.componentInstance };
  }

  describe('what the user types becomes integer cents', () => {
    it.each([
      ['12.50', 1250],
      ['12,50', 1250],
      ['12.5', 1250],
      ['12,5', 1250],
      ['12', 1200],
      ['0.05', 5],
      ['7', 700],
      ['  7,25  ', 725],
      ['1 234,50', 123450],
      // Decimals that fail when multiplied as floating point numbers (8.2 * 100 = 819.9999999999999).
      ['8.2', 820],
      ['1.15', 115],
      ['4.35', 435],
      ['0.57', 57],
      ['19.99', 1999],
      ['100000000.01', 10_000_000_001],
    ])('%s → %i cents', async (text, cents) => {
      const { control, type } = await setup();
      await type(text);
      expect(control.value).toBe(cents);
      expect(Number.isInteger(control.value)).toBe(true);
      expect(control.valid).toBe(true);
    });

    it('allows a negative amount (a refund)', async () => {
      const { control, type } = await setup();
      control.removeValidators(positiveAmount);
      control.updateValueAndValidity();
      await type('-3');
      expect(control.value).toBe(-300);
    });

    it('never produces a negative zero', async () => {
      const { control, type } = await setup();
      await type('-0');
      expect(Object.is(control.value, 0)).toBe(true);
    });
  });

  describe('invalid text', () => {
    it.each(['abc', '12.345', '1.2.3', '12,', '--1', '€5', '1,234.56', '.5'])(
      'rejects "%s": the value is null and the field says why',
      async (text) => {
        const { fixture, input, control, type } = await setup();
        await type(text);
        blur(input);
        await settle(fixture);

        expect(control.value).toBeNull();
        expect(control.errors).toHaveProperty('invalidAmount');
        expect(fieldError(input)).toBe('Enter an amount like 12.50 or 12,50.');
        expect(input.getAttribute('aria-invalid')).toBe('true');
      },
    );

    it('is an amount that is too large, not just a number', async () => {
      const { fixture, input, control, type } = await setup();
      await type('99999999999.99'); // 1e13 cents: more than the API accepts
      blur(input);
      await settle(fixture);

      expect(Math.abs(control.value as number)).toBeGreaterThan(MAX_CENTS);
      expect(fieldError(input)).toBe('That amount is too large.');
    });

    it('is simply "required" when empty', async () => {
      const { fixture, input, control, type } = await setup();
      await type('5');
      await type('');
      blur(input);
      await settle(fixture);

      expect(control.value).toBeNull();
      expect(fieldError(input)).toBe('Amount is required.');
    });

    it('works with the other amount validators', async () => {
      const { fixture, input, control, type } = await setup();
      await type('0');
      blur(input);
      await settle(fixture);
      expect(fieldError(input)).toBe('Enter an amount greater than zero.');

      control.setValidators([nonNegativeAmount]);
      await type('-1');
      await settle(fixture);
      expect(fieldError(input)).toBe('Enter an amount of zero or more.');
    });
  });

  describe('showing a value', () => {
    it('writes cents as plain text', async () => {
      const { fixture, input, control } = await setup();

      control.setValue(1250);
      await settle(fixture);
      expect(input.value).toBe('12.50');

      control.setValue(5);
      await settle(fixture);
      expect(input.value).toBe('0.05');

      control.setValue(-1999);
      await settle(fixture);
      expect(input.value).toBe('-19.99');

      control.setValue(null);
      await settle(fixture);
      expect(input.value).toBe('');
    });

    it('uses the decimal separator of the locale, and reads it back', async () => {
      const { fixture, input, control, host } = await setup();
      host.locale.set('it-IT');
      await settle(fixture);

      control.setValue(1250);
      await settle(fixture);
      expect(input.value).toBe('12,50');
      expect(input.placeholder).toBe('0,00');
    });

    it('tidies what was typed when the field is left', async () => {
      const { fixture, input, type } = await setup();
      await type('12,5');
      expect(input.value).toBe('12,5'); // left alone while typing

      blur(input);
      await settle(fixture);

      expect(input.value).toBe('12.50');
    });

    it('leaves text that is not an amount for the user to fix', async () => {
      const { fixture, input, type } = await setup();
      await type('twelve');
      blur(input);
      await settle(fixture);
      expect(input.value).toBe('twelve');
    });

    it('shows the currency next to the amount, and describes the control with it', async () => {
      const { element, input, host, fixture } = await setup();
      const unit = element.querySelector('app-money-input span') as HTMLElement;
      expect(unit.textContent?.trim()).toBe('EUR');
      expect(input.getAttribute('aria-describedby')).toContain(unit.id);

      host.currency.set('USD');
      await settle(fixture);
      expect(unit.textContent?.trim()).toBe('USD');
    });

    it('can be disabled', async () => {
      const { fixture, input, control } = await setup();
      control.disable();
      await settle(fixture);
      expect(input.disabled).toBe(true);
    });
  });
});

describe('amount helpers', () => {
  it('parses like the shared parseCents, minus the negative zero', () => {
    expect(parseAmount('12,50')).toBe(1250);
    expect(parseAmount('-0')).toBe(0);
    expect(Object.is(parseAmount('-0'), 0)).toBe(true);
    expect(parseAmount('nope')).toBeNull();
  });

  it('formats with integer arithmetic only', () => {
    expect(formatAmountInput(0, '.')).toBe('0.00');
    expect(formatAmountInput(7, '.')).toBe('0.07');
    expect(formatAmountInput(100, ',')).toBe('1,00');
    expect(formatAmountInput(-1, '.')).toBe('-0.01');
    expect(formatAmountInput(10_000_000_001, '.')).toBe('100000000.01');
    expect(formatAmountInput(MAX_CENTS, '.')).toBe('10000000000.00');
  });

  it('round-trips every amount around the awkward ones', () => {
    for (const cents of [
      0, 1, 9, 10, 99, 100, 101, 819, 820, 1999, 123456789, -1, -820, -123456789,
    ]) {
      expect(parseAmount(formatAmountInput(cents, '.'))).toBe(cents);
      expect(parseAmount(formatAmountInput(cents, ','))).toBe(cents);
    }
  });

  it('picks "," or "." as the separator for a locale', () => {
    expect(decimalSeparator('en-US')).toBe('.');
    expect(decimalSeparator('it-IT')).toBe(',');
    expect(decimalSeparator('de-DE')).toBe(',');
    expect(decimalSeparator('fr-FR')).toBe(',');
    expect(decimalSeparator('not a locale')).toBe('.');
    // A separator that cannot be typed back falls back to ".".
    expect(decimalSeparator('ar-EG')).toBe('.');
  });
});
