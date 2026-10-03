import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { onboardedGuard, onboardingGuard } from '../../core/guards';
import { getByRole, textOf } from '../../../testing/dom';
import {
  flushError,
  primeStores,
  SETTINGS,
  settle,
  StubPage,
  TODAY,
} from '../../../testing/harness';
import { UnavailablePage } from './unavailable-page';

const HEALTH_OK = { status: 'ok', time: '2026-10-02T10:00:00.000Z' };

const routes: Routes = [
  { path: 'unavailable', component: UnavailablePage },
  { path: 'onboarding', canActivate: [onboardingGuard], component: StubPage },
  {
    path: '',
    canActivateChild: [onboardedGuard],
    children: [{ path: 'budgets', component: StubPage }],
  },
];

describe('UnavailablePage', () => {
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

  /** A retry loads the settings, today and the API status again. */
  function answerRetry(
    answers: { settings?: () => void; today?: () => void; health?: () => void } = {},
  ) {
    (answers.settings ?? (() => http.expectOne('/api/settings').flush(SETTINGS)))();
    (answers.today ?? (() => http.expectOne('/api/today').flush(TODAY)))();
    (answers.health ?? (() => http.expectOne('/api/health').flush(HEALTH_OK)))();
  }

  async function open(options: Parameters<typeof primeStores>[1] = { settings: 'error' }) {
    await primeStores(http, options);
    await router.navigateByUrl('/unavailable?next=%2Fbudgets%3Fmonth%3D2026-09');
    const fixture = TestBed.createComponent(UnavailablePage);
    fixture.detectChanges();
    await settle(fixture);
    // The page creates the API status service, which checks the API once.
    http.expectOne('/api/health').flush(HEALTH_OK);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, element };
  }

  it('says what failed, in the words of the API, and offers to try again', async () => {
    const { element } = await open();

    expect(getByRole(element, 'heading', "Wallet can't load")).toBeTruthy();
    expect(textOf(getByRole(element, 'alert'))).toContain('Boom');
    expect(getByRole(element, 'button', 'Try again')).toBeTruthy();
  });

  it('says what failed when it was the date of the server, not the settings', async () => {
    const { element } = await open({ today: 'error' });

    expect(textOf(getByRole(element, 'alert'))).toContain('Boom');
  });

  it('loads everything again and goes back to the page the user asked for', async () => {
    const { fixture, element } = await open();

    getByRole(element, 'button', 'Try again').click();
    await settle(fixture);
    expect((getByRole(element, 'button', 'Try again') as HTMLButtonElement).disabled).toBe(true);
    answerRetry();
    await settle(fixture);

    expect(router.url).toBe('/budgets?month=2026-09');
  });

  it('goes to onboarding when it turns out the wallet is not set up', async () => {
    const { fixture, element } = await open();

    getByRole(element, 'button', 'Try again').click();
    await settle(fixture);
    answerRetry({
      settings: () =>
        flushError(http.expectOne('/api/settings'), 404, 'not_found', 'Settings not found'),
    });
    await settle(fixture);

    expect(router.url).toBe('/onboarding');
  });

  it('asks for today again too when that was what failed', async () => {
    const { fixture, element } = await open({ today: 'error' });

    getByRole(element, 'button', 'Try again').click();
    await settle(fixture);
    answerRetry();
    await settle(fixture);

    expect(router.url).toBe('/budgets?month=2026-09');
  });

  it('stays, ready to try again, while the server is still down', async () => {
    const { fixture, element } = await open();

    getByRole(element, 'button', 'Try again').click();
    await settle(fixture);
    answerRetry({
      settings: () =>
        flushError(http.expectOne('/api/settings'), 500, 'internal_error', 'Still down'),
      health: () => http.expectOne('/api/health').error(new ProgressEvent('error')),
    });
    await settle(fixture);

    expect(router.url).toMatch(/^\/unavailable/);
    expect((getByRole(element, 'button', 'Try again') as HTMLButtonElement).disabled).toBe(false);
    expect(textOf(getByRole(element, 'alert'))).toContain('Still down');
  });
});
