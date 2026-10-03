import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { goalDto, outstandingMonth, savingsDto } from '../../testing/fixtures';
import { flushError, primeStores, settle, TODAY } from '../../testing/harness';
import { SavingsStore } from './savings.store';

const TWO_MONTHS = savingsDto({
  unassigned: 5000,
  goals: [goalDto({ id: 1, balance: 20000 })],
  outstanding: [
    outstandingMonth({ month: '2026-08', savingsDue: 31240 }),
    outstandingMonth({ month: '2026-09', savingsDue: -8500 }),
  ],
});

describe('SavingsStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for nothing before the settings exist: a first-run user would only get not_onboarded', async () => {
    const store = TestBed.inject(SavingsStore);
    await primeStores(http, { settings: null });
    await settle();

    http.expectNone('/api/savings');
    expect(store.state()).toBe('loading');
    expect(store.outstandingCount()).toBe(0);
    expect(store.savings()).toBeUndefined();
  });

  it('loads the overview once the app is onboarded, and counts the months to settle as the API lists them', async () => {
    const store = TestBed.inject(SavingsStore);
    await primeStores(http);
    await settle();

    http.expectOne('/api/savings').flush(TWO_MONTHS);
    await settle();

    expect(store.state()).toBe('ready');
    expect(store.outstandingCount()).toBe(2);
    // The signed total is the API's own figure, never summed here.
    expect(store.outstandingTotal()).toBe(22740);
    expect(store.savings()?.goals).toHaveLength(1);
  });

  it('counts none for an overview with nothing to settle', async () => {
    const store = TestBed.inject(SavingsStore);
    await primeStores(http);
    await settle();
    http.expectOne('/api/savings').flush(savingsDto());
    await settle();

    expect(store.outstandingCount()).toBe(0);
    expect(store.outstandingTotal()).toBe(0);
  });

  it('reports an error without a count when the overview cannot be loaded', async () => {
    const store = TestBed.inject(SavingsStore);
    await primeStores(http);
    await settle();

    flushError(http.expectOne('/api/savings'), 500, 'internal_error', 'Boom');
    await settle();

    expect(store.state()).toBe('error');
    expect(store.error()).toBeDefined();
    expect(store.outstandingCount()).toBe(0);
  });

  describe('loading it again', () => {
    async function ready() {
      const store = TestBed.inject(SavingsStore);
      await primeStores(http);
      await settle();
      http.expectOne('/api/savings').flush(TWO_MONTHS);
      await settle();
      return store;
    }

    it('keeps the old figures on screen while a background refresh is on its way', async () => {
      const store = await ready();

      store.refresh();
      await settle();
      expect(store.outstandingCount()).toBe(2);
      expect(store.state()).toBe('ready');

      http
        .expectOne('/api/savings')
        .flush(savingsDto({ outstanding: [TWO_MONTHS.outstanding[0]] }));
      await settle();
      expect(store.outstandingCount()).toBe(1);
    });

    it('resolves reload() once the fresh answer is in', async () => {
      const store = await ready();

      let done = false;
      const reloading = store.reload().then(() => (done = true));
      await settle();
      expect(done).toBe(false);

      http.expectOne('/api/savings').flush(savingsDto());
      await settle();
      await reloading;

      expect(done).toBe(true);
      expect(store.outstandingCount()).toBe(0);
    });

    it('asks again when the tab becomes visible, so a month that closed meanwhile shows up', async () => {
      const store = await ready();
      const doc = TestBed.inject(DOCUMENT);
      vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false);

      doc.dispatchEvent(new Event('visibilitychange'));
      await settle();
      // The server's date is refreshed too, for the same reason.
      http.expectOne('/api/today').flush(TODAY);
      http
        .expectOne('/api/savings')
        .flush(savingsDto({ outstanding: [TWO_MONTHS.outstanding[0]] }));
      await settle();

      expect(store.outstandingCount()).toBe(1);
    });

    it('does not ask while the tab is hidden', async () => {
      await ready();
      const doc = TestBed.inject(DOCUMENT);
      vi.spyOn(doc, 'hidden', 'get').mockReturnValue(true);

      doc.dispatchEvent(new Event('visibilitychange'));
      await settle();

      http.expectNone('/api/savings');
      http.expectNone('/api/today');
    });
  });
});
