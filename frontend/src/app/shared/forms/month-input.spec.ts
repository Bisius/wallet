import { Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { blur, fieldError, getByLabel, typeInto } from '../../../testing/dom';
import { primeStores, render, settle } from '../../../testing/harness';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Field } from './field';
import { MonthInput } from './month-input';

@Component({
  selector: 'app-month-host',
  imports: [ReactiveFormsModule, Field, MonthInput],
  template: `
    <app-field label="Start month">
      <app-month-input [formControl]="month" [min]="min()" [max]="max()" />
    </app-field>
  `,
})
class MonthHost {
  readonly month = new FormControl<string | null>(null, [Validators.required]);
  readonly min = signal<string | undefined>('2026-06');
  readonly max = signal<string | undefined>('2026-10');
}

describe('MonthInput', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    await primeStores(http);
    const fixture = await render(MonthHost);
    const element = fixture.nativeElement as HTMLElement;
    const input = getByLabel(element, 'Start month');
    const type = async (text: string) => {
      typeInto(input, text);
      blur(input);
      await settle(fixture);
    };
    return {
      fixture,
      input,
      type,
      control: fixture.componentInstance.month,
      host: fixture.componentInstance,
    };
  }

  it('holds a month key, and shows one that is written to it', async () => {
    const { fixture, input, control, type } = await setup();

    await type('2026-09');
    expect(control.value).toBe('2026-09');
    expect(control.valid).toBe(true);

    control.setValue('2026-07');
    await settle(fixture);
    expect(input.value).toBe('2026-07');

    control.setValue(null);
    await settle(fixture);
    expect(input.value).toBe('');
  });

  it('is a month picker, with the bounds on the control', async () => {
    const { input } = await setup();
    expect(input.type).toBe('month');
    expect(input.getAttribute('min')).toBe('2026-06');
    expect(input.getAttribute('max')).toBe('2026-10');
  });

  it('reports text that is not a month (a browser without a month picker shows a plain text box)', async () => {
    const { fixture, input, control, type } = await setup();
    input.type = 'text';

    await type('banana');
    expect(control.value).toBeNull();
    expect(fieldError(input)).toBe('Enter a month like 2026-10.');

    await type('2026-13');
    expect(fieldError(input)).toBe('Enter a month like 2026-10.');

    await type('2026-10');
    await settle(fixture);
    expect(fieldError(input)).toBe('');
  });

  it('keeps the month between min and max, naming the bound in words', async () => {
    const { input, control, type } = await setup();

    await type('2026-05');
    expect(control.errors).toHaveProperty('monthRange');
    expect(fieldError(input)).toBe('Choose June 2026 or later.');

    await type('2026-11');
    expect(fieldError(input)).toBe('Choose October 2026 or earlier.');

    await type('2026-06');
    expect(control.valid).toBe(true);
    await type('2026-10');
    expect(control.valid).toBe(true);
  });

  it('re-checks the value when a bound changes', async () => {
    const { fixture, input, control, type, host } = await setup();
    await type('2026-10');
    expect(control.valid).toBe(true);

    host.max.set('2026-09');
    await settle(fixture);

    expect(control.valid).toBe(false);
    expect(fieldError(input)).toBe('Choose September 2026 or earlier.');
  });

  it('is required when the form says so', async () => {
    const { fixture, input } = await setup();
    blur(input);
    await settle(fixture);
    expect(fieldError(input)).toBe('Start month is required.');
  });
});
