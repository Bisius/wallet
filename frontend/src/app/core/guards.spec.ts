import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { flushError, primeStores, SETTINGS, settle, StubPage, TODAY } from '../../testing/harness';
import { onboardedGuard, onboardingGuard, unavailableGuard } from './guards';

const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'onboarding', canActivate: [onboardingGuard], component: StubPage },
  { path: 'unavailable', canActivate: [unavailableGuard], component: StubPage },
  {
    path: '',
    canActivateChild: [onboardedGuard],
    children: [
      { path: 'dashboard', component: StubPage },
      { path: 'budgets', component: StubPage },
    ],
  },
];

describe('route guards', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  it('waits for the settings and today before deciding', async () => {
    let done = false;
    const navigation = router.navigateByUrl('/dashboard').then(() => (done = true));
    await settle();
    expect(done).toBe(false);

    http.expectOne('/api/settings').flush(SETTINGS);
    await settle();
    expect(done).toBe(false); // today is still unknown

    http.expectOne('/api/today').flush(TODAY);
    await navigation;
    expect(router.url).toBe('/dashboard');
  });

  it('lets an onboarded user into the app', async () => {
    await primeStores(http);
    await router.navigateByUrl('/budgets?month=2026-09');
    expect(router.url).toBe('/budgets?month=2026-09');
  });

  it('sends a user who is not onboarded to /onboarding, from any page', async () => {
    await primeStores(http, { settings: null });

    await router.navigateByUrl('/budgets');
    expect(router.url).toBe('/onboarding');

    await router.navigateByUrl('/dashboard');
    expect(router.url).toBe('/onboarding');
  });

  it('lets a user who is not onboarded open /onboarding', async () => {
    await primeStores(http, { settings: null });
    await router.navigateByUrl('/onboarding');
    expect(router.url).toBe('/onboarding');
  });

  it('sends an onboarded user away from /onboarding', async () => {
    await primeStores(http);
    await router.navigateByUrl('/onboarding');
    expect(router.url).toBe('/dashboard');
  });

  it('treats a 409 not_onboarded as "go to onboarding": the store forgets the settings first', async () => {
    const { settings } = await primeStores(http);
    settings.markNotOnboarded();

    await router.navigateByUrl('/budgets');

    expect(router.url).toBe('/onboarding');
  });

  it('sends the user to /unavailable when the settings cannot be loaded, remembering the page', async () => {
    await primeStores(http, { settings: 'error' });

    await router.navigateByUrl('/budgets?month=2026-09');

    expect(router.url).toBe('/unavailable?next=%2Fbudgets%3Fmonth%3D2026-09');
  });

  it('also treats a failing "today" as unavailable', async () => {
    await primeStores(http, { today: 'error' });

    await router.navigateByUrl('/dashboard');
    expect(router.url).toBe('/unavailable?next=%2Fdashboard');

    await router.navigateByUrl('/onboarding');
    expect(router.url).toBe('/unavailable?next=%2Fonboarding');
  });

  it('does not keep /unavailable as the page to come back to', async () => {
    await primeStores(http, { settings: 'error' });

    await router.navigateByUrl('/unavailable?next=%2Fbudgets');
    expect(router.url).toBe('/unavailable?next=%2Fbudgets');
  });

  describe('/unavailable', () => {
    it('goes back to the requested page once everything loads', async () => {
      await primeStores(http);
      await router.navigateByUrl('/unavailable?next=%2Fbudgets%3Fmonth%3D2026-09');
      expect(router.url).toBe('/budgets?month=2026-09');
    });

    it('goes to the start page when no page was requested', async () => {
      await primeStores(http);
      await router.navigateByUrl('/unavailable');
      expect(router.url).toBe('/dashboard');
    });

    it('never redirects to itself or outside the app', async () => {
      await primeStores(http);
      await router.navigateByUrl('/unavailable?next=%2Funavailable');
      expect(router.url).toBe('/dashboard');

      await router.navigateByUrl('/unavailable?next=https%3A%2F%2Fexample.com');
      expect(router.url).toBe('/dashboard');
    });

    it('stays when the server is still failing', async () => {
      const { settings } = await primeStores(http, { settings: 'error' });
      await router.navigateByUrl('/unavailable');
      expect(router.url).toBe('/unavailable');

      settings.reload();
      await settle();
      flushError(http.expectOne('/api/settings'), 500, 'internal_error', 'Still down');
      await settle();
      expect(settings.state()).toBe('error');
    });
  });
});
