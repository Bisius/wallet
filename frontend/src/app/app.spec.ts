import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import type { SavingsDto } from '@wallet/shared';
import { getByRole, queryByRole, textOf } from '../testing/dom';
import { outstandingMonth, savingsDto } from '../testing/fixtures';
import { flushError, SETTINGS, settle, TODAY } from '../testing/harness';
import { App } from './app';
import { onboardedGuard, onboardingGuard } from './core/guards';
import type { AppRouteData } from './core/route-data';

@Component({
  selector: 'app-page-one',
  template: '<h1 tabindex="-1">Page one</h1><p>content</p>',
})
class PageOne {}

@Component({ selector: 'app-page-two', template: '<h1 tabindex="-1">Page two</h1>' })
class PageTwo {}

const routes: Routes = [
  {
    path: 'onboarding',
    canActivate: [onboardingGuard],
    data: { focusLayout: true } satisfies AppRouteData,
    component: PageOne,
  },
  {
    path: '',
    canActivateChild: [onboardedGuard],
    children: [
      { path: 'dashboard', data: { monthScoped: true } satisfies AppRouteData, component: PageOne },
      { path: 'income', data: { monthScoped: true } satisfies AppRouteData, component: PageTwo },
      { path: 'savings', component: PageTwo },
      { path: 'settings', component: PageTwo },
    ],
  },
];

/** The API status is the polite live region in the sidebar (the toasts have one too). */
const apiStatus = (element: HTMLElement) =>
  getByRole(element.querySelector('aside') as Element, 'status');

const NAV = ['Dashboard', 'Budgets', 'Spendings', 'Subscriptions', 'Income', 'Savings', 'Settings'];

describe('App shell', () => {
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

  /** Moving to another page loads the savings overview again (for the badge): answer it. */
  async function answerSavingsRefresh(fixture: { detectChanges(): void }) {
    for (const request of http.match('/api/savings')) request.flush(savingsDto());
    await settle(fixture as never);
  }

  /** Starts the app: creates the shell, answers the startup requests, and opens a page. */
  async function start(
    url: string,
    options: { settings?: typeof SETTINGS | null; savings?: SavingsDto } = {},
  ) {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const navigation = router.navigateByUrl(url);
    await settle(fixture);

    const settings = options.settings === undefined ? SETTINGS : options.settings;
    if (settings === null)
      flushError(http.expectOne('/api/settings'), 404, 'not_found', 'Settings not found');
    else http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/today').flush(TODAY);
    http.expectOne('/api/health').flush({ status: 'ok', time: '2026-10-02T10:00:00.000Z' });
    await navigation;
    await settle(fixture);
    // Once the app is onboarded the shell loads the savings overview, for the badge.
    if (settings !== null) http.expectOne('/api/savings').flush(options.savings ?? savingsDto());
    await settle(fixture);
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('keeps the seven main navigation items', async () => {
    const { element } = await start('/dashboard');

    const nav = getByRole(element, 'navigation', 'Main');
    const links = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(links).toEqual(NAV);
    expect(getByRole(element, 'main')).toBeTruthy();
  });

  it('marks the page the user is on', async () => {
    const { element } = await start('/income');

    const current = element.querySelectorAll('nav a[aria-current="page"]');
    expect(Array.from(current).map((a) => a.textContent?.trim())).toEqual(['Income']);
  });

  it('has a skip link that moves focus to the main content', async () => {
    const { element } = await start('/dashboard');

    const skip = getByRole(element, 'link', 'Skip to main content');
    skip.click();

    expect(document.activeElement).toBe(getByRole(element, 'main'));
  });

  describe('month switcher', () => {
    it('shows on a page that uses the month, hides on the others', async () => {
      const { fixture, element } = await start('/dashboard');
      expect(queryByRole(element, 'group', 'Month')).not.toBeNull();

      await router.navigateByUrl('/settings');
      await settle(fixture);
      await answerSavingsRefresh(fixture);
      expect(queryByRole(element, 'group', 'Month')).toBeNull();

      await router.navigateByUrl('/savings');
      await settle(fixture);
      await answerSavingsRefresh(fixture);
      expect(queryByRole(element, 'group', 'Month')).toBeNull();

      await router.navigateByUrl('/income');
      await settle(fixture);
      await answerSavingsRefresh(fixture);
      expect(queryByRole(element, 'group', 'Month')).not.toBeNull();
    });

    it('is a landmark, so no content sits outside one', async () => {
      const { element } = await start('/dashboard');
      expect(getByRole(element, 'region', 'Month selection')).toBeTruthy();
    });

    it('keeps the selected month when moving between pages', async () => {
      const { fixture, element } = await start('/dashboard?month=2026-08');

      const hrefs = Array.from(element.querySelectorAll('nav a')).map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs).toEqual(
        [
          '/dashboard',
          '/budgets',
          '/spendings',
          '/subscriptions',
          '/income',
          '/savings',
          '/settings',
        ].map((path) => `${path}?month=2026-08`),
      );

      getByRole(element, 'link', 'Income').click();
      await settle(fixture);
      await answerSavingsRefresh(fixture);
      expect(router.url).toBe('/income?month=2026-08');
      expect(textOf(getByRole(element, 'group', 'Month'))).toContain('August 2026');
    });

    it('adds nothing to the links while on the current month', async () => {
      const { element } = await start('/dashboard');
      const hrefs = Array.from(element.querySelectorAll('nav a')).map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs.every((href) => !href?.includes('?'))).toBe(true);
    });
  });

  describe('moving between pages', () => {
    it('moves focus to the heading of the new page, so the move is noticed', async () => {
      const { fixture, element } = await start('/dashboard');
      expect(document.activeElement).not.toBe(element.querySelector('h1'));

      await router.navigateByUrl('/income');
      await settle(fixture);
      await answerSavingsRefresh(fixture);

      expect(document.activeElement).toBe(element.querySelector('h1'));
      expect(textOf(document.activeElement as Element)).toBe('Page two');
    });

    it('leaves focus alone when only the month changes', async () => {
      const { fixture, element } = await start('/dashboard');
      const next = getByRole(element, 'button', /Next month/);
      next.focus();

      next.click();
      await settle(fixture);

      expect(router.url).toBe('/dashboard?month=2026-11');
      expect(document.activeElement).toBe(next);
    });
  });

  describe('onboarding layout', () => {
    it('hides the main navigation and the month switcher, keeping the brand and the API status', async () => {
      const { element } = await start('/dashboard', { settings: null });

      expect(router.url).toBe('/onboarding');
      expect(queryByRole(element, 'navigation', 'Main')).toBeNull();
      expect(queryByRole(element, 'group', 'Month')).toBeNull();
      expect(getByRole(element, 'link', 'Wallet')).toBeTruthy();
      expect(textOf(apiStatus(element))).toContain('API online');
    });
  });

  describe('API status', () => {
    it('says in words that the API is reachable, and shows the date the server uses', async () => {
      const { element } = await start('/dashboard');

      const status = apiStatus(element);
      expect(textOf(status)).toContain('API online');
      expect(textOf(status)).toContain('Server date: Oct 2, 2026');
    });

    it('says when the API cannot be reached, with a way to check again', async () => {
      const { fixture, element } = await start('/dashboard');
      window.dispatchEvent(new Event('offline'));
      await settle(fixture);
      flushError(http.expectOne('/api/health'), 500, 'internal_error', 'Down');
      await settle(fixture);

      const status = apiStatus(element);
      expect(textOf(status)).toContain('API offline');

      getByRole(status, 'button', 'Check again').click();
      await settle(fixture);
      http.expectOne('/api/health').flush({ status: 'ok', time: '2026-10-02T10:01:00.000Z' });
      await settle(fixture);
      expect(textOf(apiStatus(element))).toContain('API online');
    });
  });

  it('shows that it is starting until the first page is ready', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const navigation = router.navigateByUrl('/dashboard');
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    expect(textOf(element.querySelector('main') as Element)).toContain('Loading Wallet…');

    http.expectOne('/api/settings').flush(SETTINGS);
    http.expectOne('/api/today').flush(TODAY);
    http.expectOne('/api/health').flush({ status: 'ok', time: '2026-10-02T10:00:00.000Z' });
    await navigation;
    await settle(fixture);
    http.expectOne('/api/savings').flush(savingsDto());
    await settle(fixture);

    expect(textOf(element.querySelector('main') as Element)).not.toContain('Loading Wallet…');
    expect(textOf(element.querySelector('main') as Element)).toContain('Page one');
  });

  describe('the savings badge', () => {
    const savingsLink = (element: HTMLElement) =>
      getByRole(getByRole(element, 'navigation', 'Main'), 'link', /^Savings/);

    it('shows no badge when no month waits to be moved to savings', async () => {
      const { element } = await start('/dashboard');

      expect(textOf(savingsLink(element))).toBe('Savings');
      expect(savingsLink(element).querySelector('span')).toBeNull();
    });

    it('shows how many months wait, with words for a screen reader', async () => {
      const { element } = await start('/dashboard', {
        savings: savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08' }),
            outstandingMonth({ month: '2026-09' }),
          ],
        }),
      });

      const link = savingsLink(element);
      // The number is a picture of the words, which the screen reader gets instead.
      const visible = link.querySelector('span[aria-hidden="true"]') as HTMLElement;
      expect(visible.textContent?.trim()).toBe('2');
      expect(textOf(link)).toBe('Savings , 2 months to move to savings');
      expect(link.getAttribute('aria-current')).toBeNull();
    });

    it('says "month" for one', async () => {
      const { element } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      expect(textOf(savingsLink(element))).toBe('Savings , 1 month to move to savings');
    });

    it('stays on the link of the page the user is on', async () => {
      const { element } = await start('/savings', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      const link = savingsLink(element);
      expect(link.getAttribute('aria-current')).toBe('page');
      expect(link.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('1');
    });

    it('loads the overview again when the user moves to another page, and the badge follows', async () => {
      const { fixture, element } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });
      expect(savingsLink(element).querySelector('span')).not.toBeNull();

      await router.navigateByUrl('/income');
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto());
      await settle(fixture);

      expect(savingsLink(element).querySelector('span')).toBeNull();
    });

    it('keeps the old badge while the new figures are on their way', async () => {
      const { fixture, element } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      await router.navigateByUrl('/income');
      await settle(fixture);

      expect(
        savingsLink(element).querySelector('span[aria-hidden="true"]')?.textContent?.trim(),
      ).toBe('1');
      http.expectOne('/api/savings').flush(savingsDto({ outstanding: [outstandingMonth()] }));
      await settle(fixture);
    });

    it('does not ask again when only the month changes', async () => {
      const { fixture, element } = await start('/dashboard');

      getByRole(element, 'button', /Next month/).click();
      await settle(fixture);

      expect(router.url).toBe('/dashboard?month=2026-11');
      http.expectNone('/api/savings');
    });

    it('asks for nothing during onboarding, where the navigation is hidden', async () => {
      const { element } = await start('/dashboard', { settings: null });

      expect(router.url).toBe('/onboarding');
      expect(queryByRole(element, 'navigation', 'Main')).toBeNull();
      http.expectNone('/api/savings');
    });
  });
});
