import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { SettingsInput } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { flushError, primeStores, SETTINGS, settle } from '../../testing/harness';
import { SettingsStore } from './settings.store';

describe('SettingsStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('is loading until the API answers', async () => {
    const store = TestBed.inject(SettingsStore);
    await settle();
    expect(store.state()).toBe('loading');
    expect(store.onboarded()).toBe(false);
    http.expectOne('/api/settings').flush(SETTINGS);
    await settle();
    expect(store.state()).toBe('onboarded');
  });

  it('treats a 404 as "not onboarded", with display fallbacks', async () => {
    const { settings } = await primeStores(http, { settings: null });

    expect(settings.state()).toBe('not-onboarded');
    expect(settings.onboarded()).toBe(false);
    expect(settings.settings()).toBeUndefined();
    expect(settings.startMonth()).toBeUndefined();
    // Until there are settings, formatting falls back to something sensible.
    expect(settings.currency()).toBe('EUR');
    expect(settings.locale()).toBe('en-US');
    expect(settings.theme()).toBe('system');
    expect(settings.alertWarnPercent()).toBe(80);
  });

  it('exposes currency, locale, theme, alert threshold and start month once onboarded', async () => {
    const { settings } = await primeStores(http, {
      settings: {
        currency: 'USD',
        locale: 'it-IT',
        startMonth: '2025-01',
        theme: 'dark',
        alertWarnPercent: 65,
      },
    });

    expect(settings.state()).toBe('onboarded');
    expect(settings.onboarded()).toBe(true);
    expect(settings.currency()).toBe('USD');
    expect(settings.locale()).toBe('it-IT');
    expect(settings.theme()).toBe('dark');
    expect(settings.alertWarnPercent()).toBe(65);
    expect(settings.startMonth()).toBe('2025-01');
  });

  it('reports a failing server as an error, not as "not onboarded"', async () => {
    const { settings } = await primeStores(http, { settings: 'error' });

    expect(settings.state()).toBe('error');
    expect(settings.onboarded()).toBe(false);
    expect(settings.error()).toBeDefined();
  });

  it('can be reloaded after an error', async () => {
    const { settings } = await primeStores(http, { settings: 'error' });

    settings.reload();
    expect(settings.state()).toBe('loading');
    await settle();
    http.expectOne('/api/settings').flush(SETTINGS);
    await settle();
    expect(settings.state()).toBe('onboarded');
  });

  it('takes settings it is given (the response of onboarding)', async () => {
    const { settings } = await primeStores(http, { settings: null });

    settings.seed({ ...SETTINGS, currency: 'GBP' });

    expect(settings.state()).toBe('onboarded');
    expect(settings.currency()).toBe('GBP');
  });

  it('forgets the settings when told the app is not onboarded', async () => {
    const { settings } = await primeStores(http);
    expect(settings.onboarded()).toBe(true);

    settings.markNotOnboarded();

    expect(settings.state()).toBe('not-onboarded');
    expect(settings.settings()).toBeUndefined();
  });

  it('saves with PUT /api/settings and holds what the API returned', async () => {
    const { settings } = await primeStores(http);
    const input: SettingsInput = {
      currency: 'CHF',
      locale: 'de-CH',
      startMonth: '2026-01',
      theme: 'light',
      alertWarnPercent: 90,
    };

    const saved = firstValueFrom(settings.save(input));
    const request = http.expectOne('/api/settings');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual(input);
    request.flush(input);

    expect(await saved).toEqual(input);
    expect(settings.currency()).toBe('CHF');
    expect(settings.theme()).toBe('light');
    expect(settings.alertWarnPercent()).toBe(90);
  });

  it('keeps the settings when a save fails', async () => {
    const { settings } = await primeStores(http);

    const saved = firstValueFrom(settings.save({ ...SETTINGS, currency: 'USD' }));
    flushError(http.expectOne('/api/settings'), 422, 'rule_violation', 'No', {
      rule: 'start_month_in_future',
    });

    await expect(saved).rejects.toBeDefined();
    expect(settings.currency()).toBe('EUR');
  });

  describe('settled()', () => {
    it('resolves once the answer is known', async () => {
      const store = TestBed.inject(SettingsStore);
      await settle();
      const answer = store.settled();
      let resolved: string | undefined;
      void answer.then((state) => (resolved = state));

      await settle();
      expect(resolved).toBeUndefined();

      flushError(http.expectOne('/api/settings'), 404, 'not_found', 'Settings not found');
      await settle();
      expect(resolved).toBe('not-onboarded');
    });

    it('resolves right away when the state is already final', async () => {
      const { settings } = await primeStores(http);
      await expect(settings.settled()).resolves.toBe('onboarded');
    });
  });
});
