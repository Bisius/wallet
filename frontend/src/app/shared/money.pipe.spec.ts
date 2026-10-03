import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { primeStores, render, SETTINGS, settle } from '../../testing/harness';
import { formatMoney, MoneyPipe } from './money.pipe';

describe('formatMoney', () => {
  it('writes cents as currency with two decimals', () => {
    expect(formatMoney(123456, 'en-US', 'EUR')).toBe('€1,234.56');
    expect(formatMoney(-5, 'en-US', 'EUR')).toBe('-€0.05');
  });

  it('can leave the decimals out, for an axis whose ticks are whole currency units', () => {
    expect(formatMoney(200000, 'en-US', 'EUR', true)).toBe('€2,000');
    expect(formatMoney(-50000, 'en-US', 'EUR', true)).toBe('-€500');
    expect(formatMoney(0, 'en-US', 'EUR', true)).toBe('€0');
    expect(formatMoney(200000, 'it-IT', 'EUR', true).replace(/\s/g, ' ')).toBe('2000 €');
  });

  it('still formats when the currency is not valid, with or without decimals', () => {
    expect(formatMoney(1250, 'en-US', 'EU')).toBe('12.50 EU');
    expect(formatMoney(200000, 'en-US', 'EU', true)).toBe('2,000 EU');
  });
});

@Component({
  selector: 'app-money-host',
  imports: [MoneyPipe],
  template: `
    <p id="default">{{ 123456 | money }}</p>
    <p id="negative">{{ -5 | money }}</p>
    <p id="override">{{ 123456 | money: 'USD' : 'en-US' }}</p>
    <p id="missing">{{ missing | money }}</p>
  `,
})
class MoneyHost {
  missing: number | null = null;
}

describe('MoneyPipe', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LOCALE_ID, useValue: 'en-US' },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = (fixture: { nativeElement: HTMLElement }, id: string) =>
    (fixture.nativeElement.querySelector(`#${id}`) as HTMLElement).textContent?.replace(/ /g, ' ');

  it('formats cents as currency, with a minus sign for negative amounts', async () => {
    const fixture = await render(MoneyHost);
    await primeStores(http);
    await settle(fixture);

    expect(text(fixture, 'default')).toBe('€1,234.56');
    expect(text(fixture, 'negative')).toBe('-€0.05');
  });

  it('renders nothing for a missing amount', async () => {
    const fixture = await render(MoneyHost);
    await primeStores(http);
    await settle(fixture);

    expect(text(fixture, 'missing')).toBe('');
  });

  it('uses the currency and locale of the settings, as soon as they load', async () => {
    const fixture = await render(MoneyHost);
    // Before the settings arrive it falls back to EUR and the app's locale.
    expect(text(fixture, 'default')).toBe('€1,234.56');

    await primeStores(http, { settings: { ...SETTINGS, currency: 'USD', locale: 'it-IT' } });
    await settle(fixture);

    // The host is OnPush-style (signals only): the pipe re-ran without the host asking for it.
    expect(text(fixture, 'default')).toBe('1234,56 USD');
  });

  it('follows the settings when they change', async () => {
    const fixture = await render(MoneyHost);
    const { settings } = await primeStores(http);
    await settle(fixture);
    expect(text(fixture, 'default')).toBe('€1,234.56');

    settings.seed({ ...SETTINGS, currency: 'GBP', locale: 'en-GB' });
    await settle(fixture);

    expect(text(fixture, 'default')).toBe('£1,234.56');
  });

  it('lets a template pass its own currency and locale', async () => {
    const fixture = await render(MoneyHost);
    await primeStores(http, { settings: { ...SETTINGS, currency: 'EUR', locale: 'it-IT' } });
    await settle(fixture);

    expect(text(fixture, 'override')).toBe('$1,234.56');
  });

  it('survives a currency or locale that is not valid yet (a half-typed form field)', async () => {
    const pipe = TestBed.runInInjectionContext(() => new MoneyPipe());
    expect(pipe.transform(1250, 'EU', 'en-US')).toBe('12.50 EU');
    expect(() => pipe.transform(1250, 'EUR', 'not a locale')).not.toThrow();
  });
});
