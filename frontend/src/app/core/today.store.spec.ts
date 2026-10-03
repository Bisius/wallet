import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { flushError, settle, TODAY } from '../../testing/harness';
import { TodayStore } from './today.store';

describe('TodayStore', () => {
  let http: HttpTestingController;
  let store: TodayStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(TodayStore);
  });

  afterEach(() => http.verify());

  it('has no date until the server has said what today is', async () => {
    await settle();
    expect(store.state()).toBe('loading');
    expect(store.date()).toBeUndefined();
    expect(store.month()).toBeUndefined();
    http.expectOne('/api/today').flush(TODAY);
    await settle();
  });

  it('exposes the date and month of the server, not of the browser', async () => {
    await settle();
    // A date nowhere near the real one: the browser clock must not leak in.
    http.expectOne('/api/today').flush({ date: '2031-03-31', month: '2031-03' });
    await settle();

    expect(store.state()).toBe('ready');
    expect(store.date()).toBe('2031-03-31');
    expect(store.month()).toBe('2031-03');
    await expect(store.settled()).resolves.toBe('ready');
  });

  it('reports an error when the server cannot say', async () => {
    await settle();
    flushError(http.expectOne('/api/today'), 500, 'internal_error', 'Boom');
    await settle();

    expect(store.state()).toBe('error');
    expect(store.date()).toBeUndefined();
    await expect(store.settled()).resolves.toBe('error');
  });

  it('asks again when the page becomes visible, so an app left open overnight is not a day behind', async () => {
    await settle();
    http.expectOne('/api/today').flush(TODAY);
    await settle();

    const doc = TestBed.inject(DOCUMENT);
    vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false);
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    http.expectOne('/api/today').flush({ date: '2026-10-03', month: '2026-10' });
    await settle();

    expect(store.date()).toBe('2026-10-03');
  });

  it('does not ask while the page is hidden', async () => {
    await settle();
    http.expectOne('/api/today').flush(TODAY);
    await settle();

    const doc = TestBed.inject(DOCUMENT);
    vi.spyOn(doc, 'hidden', 'get').mockReturnValue(true);
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();

    http.expectNone('/api/today');
  });
});
