import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { flushError, settle } from '../../testing/harness';
import { API_POLL_MS, ApiStatus } from './api-status';

const OK = { status: 'ok', time: '2026-10-02T10:00:00.000Z' };

describe('ApiStatus', () => {
  let http: HttpTestingController;
  let status: ApiStatus;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    status = TestBed.inject(ApiStatus);
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  it('is "checking" until the first answer, then "online"', async () => {
    await settle();
    expect(status.state()).toBe('checking');

    http.expectOne('/api/health').flush(OK);
    await settle();
    expect(status.state()).toBe('online');
  });

  it('is "offline" when the API cannot be reached', async () => {
    await settle();
    http.expectOne('/api/health').error(new ProgressEvent('error'));
    await settle();
    expect(status.state()).toBe('offline');
  });

  it('keeps the last answer while it checks again, instead of flickering', async () => {
    await settle();
    flushError(http.expectOne('/api/health'), 500, 'internal_error', 'Down');
    await settle();
    expect(status.state()).toBe('offline');

    status.check();
    await settle();
    expect(status.state()).toBe('offline'); // still the last answer, not "checking"

    http.expectOne('/api/health').flush(OK);
    await settle();
    expect(status.state()).toBe('online');
  });

  it('checks again by itself every 30 seconds', async () => {
    await settle();
    http.expectOne('/api/health').flush(OK);
    await settle();

    vi.useFakeTimers();
    vi.spyOn(TestBed.inject(DOCUMENT), 'hidden', 'get').mockReturnValue(false);
    // The interval was created with real timers; recreate the service under fake ones.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApiStatus);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/health').flush(OK);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(API_POLL_MS);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/health').flush(OK);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(API_POLL_MS);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/health').flush(OK);
  });

  it('checks straight away when the browser says it went offline or online', async () => {
    await settle();
    http.expectOne('/api/health').flush(OK);
    await settle();
    vi.spyOn(TestBed.inject(DOCUMENT), 'hidden', 'get').mockReturnValue(false);

    window.dispatchEvent(new Event('offline'));
    await settle();
    http.expectOne('/api/health').flush(OK);
    await settle();

    window.dispatchEvent(new Event('online'));
    await settle();
    http.expectOne('/api/health').flush(OK);
  });

  it('does not check while the page is hidden', async () => {
    await settle();
    http.expectOne('/api/health').flush(OK);
    await settle();
    vi.spyOn(TestBed.inject(DOCUMENT), 'hidden', 'get').mockReturnValue(true);

    window.dispatchEvent(new Event('online'));
    await settle();

    http.expectNone('/api/health');
  });
});
