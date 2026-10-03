import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { primeStores, SETTINGS, settle, StubPage, TODAY } from '../../testing/harness';
import { SelectedMonth } from './selected-month';
import { SettingsStore } from './settings.store';

describe('SelectedMonth', () => {
  let http: HttpTestingController;
  let router: Router;
  let selected: SelectedMonth;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'budgets', component: StubPage },
          { path: 'settings', component: StubPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    selected = TestBed.inject(SelectedMonth);
  });

  afterEach(() => http.verify());

  async function openWith(query = '', options: Parameters<typeof primeStores>[1] = {}) {
    await primeStores(http, options);
    await router.navigateByUrl(`/budgets${query}`);
    await settle();
  }

  it('has no month until the server has said what the current month is', async () => {
    await router.navigateByUrl('/budgets');
    expect(selected.month()).toBeUndefined();
    expect(selected.canGoPrevious()).toBe(false);
    expect(selected.canGoNext()).toBe(false);
    await primeStores(http);
  });

  it('is the current month when the URL says nothing', async () => {
    await openWith();

    expect(selected.month()).toBe('2026-10');
    expect(selected.current()).toBe('2026-10');
    expect(selected.isCurrent()).toBe(true);
    expect(selected.linkParams()).toEqual({});
  });

  it('reads the month from ?month= and offers it to links', async () => {
    await openWith('?month=2026-09');

    expect(selected.month()).toBe('2026-09');
    expect(selected.isCurrent()).toBe(false);
    expect(selected.linkParams()).toEqual({ month: '2026-09' });
  });

  it('follows the URL when it changes (back and forward buttons)', async () => {
    await openWith('?month=2026-09');
    await router.navigateByUrl('/settings?month=2026-07');
    await settle();
    expect(selected.month()).toBe('2026-07');

    await router.navigateByUrl('/budgets');
    await settle();
    expect(selected.month()).toBe('2026-10');
  });

  it.each(['abc', '2026-13', '202610', '2026-1', '', '2026-10-01', '0000-00'])(
    'ignores a month that is not a month: "%s"',
    async (value) => {
      await openWith(`?month=${value}`);
      expect(selected.month()).toBe('2026-10');
    },
  );

  describe('bounds', () => {
    it('cannot go before the start month', async () => {
      await openWith('?month=2025-01');

      expect(selected.min()).toBe('2026-06');
      expect(selected.month()).toBe('2026-06');
      expect(selected.canGoPrevious()).toBe(false);
    });

    it('cannot go beyond the current month plus the horizon', async () => {
      await openWith('?month=2040-01');

      expect(selected.max()).toBe('2036-10'); // October 2026 + 120 months
      expect(selected.month()).toBe('2036-10');
      expect(selected.canGoNext()).toBe(false);
    });

    it('allows both edges themselves', async () => {
      await openWith('?month=2026-06');
      expect(selected.month()).toBe('2026-06');
      expect(selected.canGoNext()).toBe(true);

      await router.navigateByUrl('/budgets?month=2036-10');
      await settle();
      expect(selected.month()).toBe('2036-10');
      expect(selected.canGoPrevious()).toBe(true);
    });

    it('moves the lower bound when the start month changes', async () => {
      await openWith('?month=2026-03');
      expect(selected.month()).toBe('2026-06');

      const settings = TestBed.inject(SettingsStore);
      settings.seed({ ...SETTINGS, startMonth: '2026-01' });
      await settle();

      expect(selected.month()).toBe('2026-03');
    });
  });

  describe('moving', () => {
    it('goes to the previous and next month in the URL, on the same page', async () => {
      await openWith();

      await selected.previous();
      expect(router.url).toBe('/budgets?month=2026-09');
      expect(selected.month()).toBe('2026-09');

      await selected.next();
      await selected.next();
      expect(router.url).toBe('/budgets?month=2026-11');
    });

    it('does not move past the start month or the horizon', async () => {
      await openWith('?month=2026-06');
      expect(await selected.previous()).toBe(false);
      expect(router.url).toBe('/budgets?month=2026-06');

      await router.navigateByUrl('/budgets?month=2036-10');
      await settle();
      expect(await selected.next()).toBe(false);
      expect(router.url).toBe('/budgets?month=2036-10');
    });

    it('leaves out the parameter for the current month, which is the default', async () => {
      await openWith('?month=2026-09');

      await selected.next();

      expect(router.url).toBe('/budgets');
      expect(selected.isCurrent()).toBe(true);
    });

    it('jumps back to this month', async () => {
      await openWith('?month=2026-02');
      await selected.goToCurrent();
      expect(router.url).toBe('/budgets');
    });

    it('selects any month, clamped to the range', async () => {
      await openWith();

      await selected.select('2026-08');
      expect(router.url).toBe('/budgets?month=2026-08');

      await selected.select('2020-01');
      expect(router.url).toBe('/budgets?month=2026-06');

      await selected.select('2099-01');
      expect(router.url).toBe('/budgets?month=2036-10');
    });

    it('keeps the other query parameters', async () => {
      await openWith('?month=2026-09&q=rent');

      await selected.next();
      expect(router.url).toBe('/budgets?q=rent');

      await selected.previous();
      expect(router.url).toBe('/budgets?q=rent&month=2026-09');

      await selected.goToCurrent();
      expect(router.url).toBe('/budgets?q=rent');
    });
  });

  it('takes the current month from the server, not the browser', async () => {
    await openWith('', { today: { date: '2031-03-31', month: '2031-03' } });
    expect(selected.month()).toBe('2031-03');
    expect(TODAY.month).not.toBe('2031-03');
  });
});
