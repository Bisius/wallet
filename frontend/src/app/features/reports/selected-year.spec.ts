import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { primeStores, settle, StubPage } from '../../../testing/harness';
import { SelectedYear } from './selected-year';

describe('SelectedYear', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'report', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  /** The service on `/report` with the given query, once the stores know the settings and today. */
  async function open(query = '') {
    await primeStores(http);
    await router.navigateByUrl(`/report${query}`);
    const year = TestBed.inject(SelectedYear);
    await settle();
    return year;
  }

  it('is the current year, as the server says, until today is known', async () => {
    const year = TestBed.inject(SelectedYear);
    expect(year.year()).toBeUndefined();
    expect(year.switcher()).toBeUndefined();

    await primeStores(http);
    await router.navigateByUrl('/report');
    await settle();
    expect(year.current()).toBe(2026);
    expect(year.year()).toBe(2026);
  });

  it('is the year of the address', async () => {
    const year = await open('?year=2027');

    expect(year.year()).toBe(2027);
    expect(year.current()).toBe(2026);
  });

  it('is the current year for an address that does not name one', async () => {
    for (const bad of ['?year=abc', '?year=26', '?year=', '?year=0000']) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: 'report', component: StubPage }]),
          provideHttpClient(),
          provideHttpClientTesting(),
        ],
      });
      http = TestBed.inject(HttpTestingController);
      router = TestBed.inject(Router);
      const year = await open(bad);
      expect(year.year(), bad).toBe(2026);
      http.verify();
    }
  });

  it('gives the switcher its range: from the year of the start month to ten years ahead', async () => {
    // Wallet started in June 2026, and today is October 2026 (120 months ahead is October 2036).
    const year = await open('?year=2028');

    expect(year.switcher()).toEqual({ year: 2028, current: 2026, min: 2026, max: 2036 });
  });

  it('puts the year in the address, and leaves it out for the current one', async () => {
    const year = await open();

    await year.select(2027);
    expect(router.url).toBe('/report?year=2027');
    expect(year.year()).toBe(2027);

    await year.select(2026);
    expect(router.url).toBe('/report');
    expect(year.year()).toBe(2026);
  });

  it('keeps the other parameters of the address, such as the selected month', async () => {
    const year = await open('?month=2026-08');

    await year.select(2027);

    expect(router.url).toContain('month=2026-08');
    expect(router.url).toContain('year=2027');
  });
});
