import { FormControl } from '@angular/forms';
import { alertWarnPercentSchema, currencySchema, localeSchema } from '@wallet/shared';
import {
  dateInMonth,
  nonNegativeAmount,
  positiveAmount,
  wholePercent,
  zodValidator,
} from './validators';

describe('zodValidator', () => {
  it('follows the rules of the shared schema and says what it says', () => {
    const control = new FormControl('eur', [zodValidator(currencySchema)]);
    expect(control.errors).toEqual({
      schema: { message: 'Expected a 3-letter upper-case currency code like EUR' },
    });

    control.setValue('EUR');
    expect(control.errors).toBeNull();
  });

  it('checks a locale tag', () => {
    const control = new FormControl('en_US', [zodValidator(localeSchema)]);
    expect(control.invalid).toBe(true);
    control.setValue('en-US');
    expect(control.valid).toBe(true);
  });

  it('checks a number', () => {
    const control = new FormControl<number | null>(0, [zodValidator(alertWarnPercentSchema)]);
    expect(control.invalid).toBe(true);
    control.setValue(101);
    expect(control.invalid).toBe(true);
    control.setValue(80);
    expect(control.valid).toBe(true);
  });

  it('leaves an empty value to Validators.required', () => {
    const schema = zodValidator(currencySchema);
    expect(schema(new FormControl(''))).toBeNull();
    expect(schema(new FormControl(null))).toBeNull();
  });
});

describe('amount validators', () => {
  it('nonNegativeAmount accepts zero and above', () => {
    expect(nonNegativeAmount(new FormControl(0))).toBeNull();
    expect(nonNegativeAmount(new FormControl(1))).toBeNull();
    expect(nonNegativeAmount(new FormControl(null))).toBeNull();
    expect(nonNegativeAmount(new FormControl(-1))).toEqual({
      amount: { message: 'Enter an amount of zero or more.' },
    });
  });

  it('positiveAmount needs more than zero', () => {
    expect(positiveAmount(new FormControl(1))).toBeNull();
    expect(positiveAmount(new FormControl(null))).toBeNull();
    expect(positiveAmount(new FormControl(0))).toEqual({
      amount: { message: 'Enter an amount greater than zero.' },
    });
    expect(positiveAmount(new FormControl(-5))).not.toBeNull();
  });
});

describe('wholePercent', () => {
  it('accepts a whole number from 1 to 100, and an empty control', () => {
    for (const value of [1, 80, 100, null, '']) {
      expect(wholePercent(new FormControl(value))).toBeNull();
    }
  });

  it('says plainly what is expected otherwise', () => {
    for (const value of [0, 101, 80.5, -3]) {
      expect(wholePercent(new FormControl(value))).toEqual({
        percent: { message: 'Enter a whole number from 1 to 100.' },
      });
    }
  });
});

describe('dateInMonth', () => {
  it('accepts a date in the month and an empty control', () => {
    const validator = dateInMonth(
      () => '2026-10',
      () => 'en-US',
    );

    expect(validator(new FormControl('2026-10-01'))).toBeNull();
    expect(validator(new FormControl('2026-10-31'))).toBeNull();
    expect(validator(new FormControl(''))).toBeNull();
    expect(validator(new FormControl(null))).toBeNull();
  });

  it('names the month when the date is outside it', () => {
    const validator = dateInMonth(
      () => '2026-10',
      () => 'en-US',
    );

    expect(validator(new FormControl('2026-09-30'))).toEqual({
      date: { message: 'Choose a date in October 2026.' },
    });
    expect(validator(new FormControl('2026-11-01'))).not.toBeNull();
  });

  it('reads the month and the locale each time, because the month switcher can change them', () => {
    let month = '2026-10';
    let locale = 'en-US';
    const validator = dateInMonth(
      () => month,
      () => locale,
    );
    const control = new FormControl('2026-11-05');

    expect(validator(control)).not.toBeNull();
    month = '2026-11';
    expect(validator(control)).toBeNull();
    locale = 'it-IT';
    month = '2026-12';
    expect(validator(control)).toEqual({ date: { message: 'Choose a date in dicembre 2026.' } });
  });
});
