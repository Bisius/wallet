import { Component, inject } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import type { MonthView, SavingsDto } from '@wallet/shared';
import { a11yProblems } from '../testing/a11y';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../testing/dom';
import {
  budgetLine,
  monthView,
  outstandingMonth,
  savingsDto,
  spendingDto,
} from '../testing/fixtures';
import { flushError, SETTINGS, settle, TODAY } from '../testing/harness';
import { App } from './app';
import { onboardedGuard, onboardingGuard } from './core/guards';
import type { AppRouteData } from './core/route-data';
import { SelectedMonth } from './core/selected-month';
import { MonthsApi } from './features/months/months.api';
import { ToastService } from './shared/ui/toast.service';

@Component({
  selector: 'app-page-one',
  template: '<h1 tabindex="-1">Page one</h1><p>content</p>',
})
class PageOne {}

@Component({ selector: 'app-page-two', template: '<h1 tabindex="-1">Page two</h1>' })
class PageTwo {}

/** A page that shows the month's spent figure, as the month pages do: it owns a month view. */
@Component({
  selector: 'app-spent-page',
  template: `
    <h1 tabindex="-1">Spent page</h1>
    <p data-testid="spent">{{ spent() }}</p>
  `,
})
class SpentPage {
  private readonly view = inject(MonthsApi).view(inject(SelectedMonth).month);
  protected readonly spent = () => (this.view.hasValue() ? this.view.value().totals.spent : '…');
}

const month: AppRouteData = { period: 'month' };

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
      { path: 'dashboard', data: month, component: PageOne },
      { path: 'budgets', data: month, component: SpentPage },
      {
        path: 'spendings',
        data: { ...month, hideAddSpending: true } satisfies AppRouteData,
        component: PageTwo,
      },
      { path: 'subscriptions', data: month, component: PageTwo },
      { path: 'income', data: month, component: PageTwo },
      { path: 'savings', component: PageTwo },
      { path: 'report', data: { period: 'year' } satisfies AppRouteData, component: PageTwo },
      { path: 'import', component: PageTwo },
      { path: 'settings', component: PageTwo },
    ],
  },
];

/** The API status is the polite live region in the sidebar (the toasts have one too). */
const apiStatus = (element: HTMLElement) =>
  getByRole(element.querySelector('aside') as Element, 'status');

const SIDEBAR = [
  'Dashboard',
  'Report',
  'Budgets',
  'Spendings',
  'Subscriptions',
  'Income',
  'Savings',
  'Settings',
];
const TABS = ['Dashboard', 'Budgets', 'Spendings', 'Savings'];
const MORE = ['Subscriptions', 'Income', 'Report', 'Settings', 'Import CSV'];

const linkNames = (root: ParentNode) =>
  queryAllByRole(root, 'link').map((link) => textOf(link).replace(/ ,.*$/, ''));

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

  /** Goes to another page, as a link does, and answers what the shell asks on the way. */
  async function goTo(fixture: ComponentFixture<App>, url: string) {
    await router.navigateByUrl(url);
    await settle(fixture);
    await answerSavingsRefresh(fixture);
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
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      element,
      sidebar: () => getByRole(element, 'navigation', 'Main'),
      tabs: () => getByRole(element, 'navigation', 'Main (tabs)'),
      topBar: () => element.querySelector('header') as HTMLElement,
      more: () => getByRole(getByRole(element, 'navigation', 'Main (tabs)'), 'button', /^More/),
    };
  }

  it('has the skeleton of the page: a skip link, the navigation, the top bar and one main', async () => {
    const { element } = await start('/dashboard');

    expect(getByRole(element, 'main').id).toBe('main');
    expect(getByRole(element, 'main').getAttribute('tabindex')).toBe('-1');
    expect(element.querySelectorAll('header')).toHaveLength(1);
    expect(element.querySelectorAll('aside')).toHaveLength(1);
    expect(a11yProblems(element)).toEqual([]);
  });

  it('applies the theme of the settings to the page', async () => {
    await start('/dashboard', { settings: { ...SETTINGS, theme: 'dark' } });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.documentElement.classList.remove('dark');
  });

  it('has a skip link that moves focus to the main content', async () => {
    const { element } = await start('/dashboard');

    const skip = getByRole(element, 'link', 'Skip to main content');
    skip.click();

    expect(document.activeElement).toBe(getByRole(element, 'main'));
  });

  describe('the sidebar', () => {
    it('keeps the eight pages, in two labelled groups with Settings apart at the bottom', async () => {
      const { element, sidebar } = await start('/dashboard');

      expect(linkNames(sidebar())).toEqual(SIDEBAR);
      const overview = getByRole(sidebar(), 'list', 'Overview');
      const money = getByRole(sidebar(), 'list', 'Money');
      expect(linkNames(overview)).toEqual(['Dashboard', 'Report']);
      expect(linkNames(money)).toEqual([
        'Budgets',
        'Spendings',
        'Subscriptions',
        'Income',
        'Savings',
      ]);
      // The last list holds Settings alone, and nothing is a heading: the page's outline is its own.
      const lists = sidebar().querySelectorAll(':scope > ul, :scope > div > ul');
      expect(Array.from(lists).map((list) => linkNames(list).join())).toEqual([
        'Dashboard,Report',
        'Budgets,Spendings,Subscriptions,Income,Savings',
        'Settings',
      ]);
      expect(sidebar().querySelector('h1, h2, h3')).toBeNull();
      expect(element.querySelector('aside nav')).toBe(sidebar());
    });

    it('puts an icon before every label, and nothing but the name in the name of the link', async () => {
      const { sidebar } = await start('/dashboard');

      for (const link of queryAllByRole(sidebar(), 'link')) {
        expect(link.querySelector('app-icon svg[aria-hidden="true"]'), textOf(link)).not.toBeNull();
      }
      expect(queryAllByRole(sidebar(), 'link').map(textOf)).toEqual(SIDEBAR);
    });

    it('marks the page the user is on, softly, and says so to a screen reader', async () => {
      const { sidebar } = await start('/income');

      const current = sidebar().querySelectorAll('a[aria-current="page"]');
      expect(Array.from(current).map((a) => textOf(a))).toEqual(['Income']);
      const classes = (current[0] as HTMLElement).className;
      expect(classes).toContain('aria-[current=page]:bg-accent-soft');
      expect(classes).toContain('aria-[current=page]:text-accent-text');
      expect(classes).not.toContain('bg-accent ');
    });

    it('has the brand, which goes to the dashboard and keeps the month', async () => {
      const { fixture, element } = await start('/dashboard?month=2026-08');
      const brand = getByRole(element.querySelector('aside') as Element, 'link', 'Wallet');

      expect(brand.getAttribute('href')).toBe('/dashboard?month=2026-08');
      await goTo(fixture, '/income?month=2026-08');
      expect(brand.getAttribute('href')).toBe('/dashboard?month=2026-08');
    });

    it('has the API status and the date of the server in its footer', async () => {
      const { element } = await start('/dashboard');

      const aside = element.querySelector('aside') as HTMLElement;
      expect(textOf(getByRole(aside, 'status'))).toContain('API online');
      expect(textOf(getByRole(aside, 'status'))).toContain('Server date: Oct 2, 2026');
      // The footer comes after the navigation, and so does the notice of a new version.
      const notice = aside.querySelector('app-update-notice') as HTMLElement;
      expect(notice).not.toBeNull();
      const nav = aside.querySelector('nav') as HTMLElement;
      expect(nav.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the selected month when moving between pages', async () => {
      const { fixture, element, sidebar } = await start('/dashboard?month=2026-08');

      const hrefs = queryAllByRole(sidebar(), 'link').map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(
        [
          '/dashboard',
          '/report',
          '/budgets',
          '/spendings',
          '/subscriptions',
          '/income',
          '/savings',
          '/settings',
        ].map((path) => `${path}?month=2026-08`),
      );

      getByRole(sidebar(), 'link', 'Income').click();
      await settle(fixture);
      await answerSavingsRefresh(fixture);
      expect(router.url).toBe('/income?month=2026-08');
      expect(textOf(getByRole(element, 'group', 'Month'))).toContain('August 2026');
    });

    it('adds nothing to the links while on the current month', async () => {
      const { sidebar, tabs } = await start('/dashboard');

      for (const nav of [sidebar(), tabs()]) {
        const hrefs = queryAllByRole(nav, 'link').map((a) => a.getAttribute('href'));
        expect(hrefs.every((href) => !href?.includes('?'))).toBe(true);
      }
    });
  });

  describe('the tab bar of a phone', () => {
    it('has Dashboard, Budgets, Spendings and Savings, and More', async () => {
      const { tabs, more } = await start('/dashboard');

      expect(linkNames(tabs())).toEqual(TABS);
      expect(textOf(more())).toBe('More');
      expect(more().getAttribute('aria-haspopup')).toBe('dialog');
      for (const link of queryAllByRole(tabs(), 'link')) {
        expect(link.querySelector('app-icon svg'), textOf(link)).not.toBeNull();
      }
      // A navigation of its own, named so that it is not the sidebar's twin.
      expect(tabs()).not.toBe(getByRole(tabs().ownerDocument.body, 'navigation', 'Main'));
    });

    it('is fixed to the bottom, with a top border, room for the home indicator and tabs of 56 px', async () => {
      const { tabs } = await start('/dashboard');

      const classes = tabs().className;
      for (const name of ['fixed', 'bottom-0', 'border-t', 'bg-surface-raised', 'md:hidden']) {
        expect(classes, name).toContain(name);
      }
      expect(classes).toContain('pb-[env(safe-area-inset-bottom)]');
      for (const control of [
        ...queryAllByRole(tabs(), 'link'),
        ...queryAllByRole(tabs(), 'button'),
      ]) {
        expect(control.className, textOf(control)).toContain('min-h-(--tab-bar-height)');
      }
    });

    it('marks the page the user is on', async () => {
      const { tabs, more } = await start('/budgets?month=2026-08');
      http.expectOne('/api/months/2026-08').flush(monthView({ month: '2026-08' }));

      const current = tabs().querySelectorAll('a[aria-current="page"]');
      expect(Array.from(current).map((a) => textOf(a))).toEqual(['Budgets']);
      expect(more().hasAttribute('data-current')).toBe(false);
    });

    it('says "More" is the page when the page is one of its items, in words and in looks, not aria-current', async () => {
      const { fixture, tabs, more } = await start('/dashboard');
      expect(textOf(more())).toBe('More');
      expect(more().hasAttribute('data-current')).toBe(false);

      await goTo(fixture, '/income');

      expect(textOf(more())).toBe('More , current page: Income');
      expect(more().hasAttribute('data-current')).toBe(true);
      expect(more().hasAttribute('aria-current')).toBe(false);
      expect(tabs().querySelector('a[aria-current="page"]')).toBeNull();

      await goTo(fixture, '/savings');
      expect(textOf(more())).toBe('More');
    });

    it('carries the selected month on its links', async () => {
      const { tabs } = await start('/dashboard?month=2026-08');

      const hrefs = queryAllByRole(tabs(), 'link').map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(
        ['/dashboard', '/budgets', '/spendings', '/savings'].map((p) => `${p}?month=2026-08`),
      );
    });

    it('goes to a page and takes focus to its heading, as any navigation does', async () => {
      const { fixture, element, tabs } = await start('/dashboard');

      getByRole(tabs(), 'link', 'Savings').click();
      await settle(fixture);
      await answerSavingsRefresh(fixture);

      expect(router.url).toBe('/savings');
      expect(document.activeElement).toBe(element.querySelector('h1'));
    });
  });

  describe('the "More" sheet', () => {
    async function openSheet(url = '/dashboard') {
      const app = await start(url);
      app.more().focus();
      app.more().click();
      await settle(app.fixture);
      const sheet = () => getByRole(app.element, 'dialog', 'More');
      return { ...app, sheet };
    }

    it('is not in the page until More is pressed', async () => {
      const { element } = await start('/dashboard');

      expect(queryByRole(element, 'dialog', 'More')).toBeNull();
    });

    it('opens as a modal sheet with Subscriptions, Income, Report, Settings and Import, as links', async () => {
      const { sheet } = await openSheet();

      const dialog = sheet() as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute('data-variant')).toBe('sheet');
      expect(linkNames(dialog)).toEqual(MORE);
      for (const link of queryAllByRole(dialog, 'link')) {
        expect(link.querySelector('app-icon svg'), textOf(link)).not.toBeNull();
      }
      expect(queryAllByRole(dialog, 'link').map((link) => link.getAttribute('href'))).toEqual([
        '/subscriptions',
        '/income',
        '/report',
        '/settings',
        '/import',
      ]);
    });

    it('moves focus into the sheet, onto its first link', async () => {
      const { sheet } = await openSheet();

      expect(document.activeElement).toBe(getByRole(sheet(), 'link', 'Subscriptions'));
    });

    it('closes on Escape and gives focus back to the More button', async () => {
      const { fixture, element, more } = await openSheet();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(fixture);

      expect(queryByRole(element, 'dialog', 'More')).toBeNull();
      expect(document.activeElement).toBe(more());
    });

    it('closes with its Close button, and on a tap on the backdrop', async () => {
      const { fixture, element, more, sheet } = await openSheet();

      getByRole(sheet(), 'button', 'Close').click();
      await settle(fixture);
      expect(queryByRole(element, 'dialog', 'More')).toBeNull();
      expect(document.activeElement).toBe(more());

      more().click();
      await settle(fixture);
      // The backdrop is the dialog element itself: the content fills the rest.
      sheet().click();
      await settle(fixture);
      expect(queryByRole(element, 'dialog', 'More')).toBeNull();
      expect(document.activeElement).toBe(more());
    });

    it('stays open for a tap inside it', async () => {
      const { fixture, element, sheet } = await openSheet();

      getByRole(sheet(), 'heading', 'More').click();
      await settle(fixture);

      expect(queryByRole(element, 'dialog', 'More')).not.toBeNull();
    });

    it('closes, navigates and lands on the heading of the page when a link is chosen', async () => {
      const { fixture, element, sheet } = await openSheet('/dashboard?month=2026-08');
      // The month travels with the link, as everywhere.
      expect(getByRole(sheet(), 'link', 'Income').getAttribute('href')).toBe(
        '/income?month=2026-08',
      );

      getByRole(sheet(), 'link', 'Income').click();
      await settle(fixture);
      await answerSavingsRefresh(fixture);

      expect(router.url).toBe('/income?month=2026-08');
      expect(queryByRole(element, 'dialog', 'More')).toBeNull();
      expect(document.activeElement).toBe(element.querySelector('h1'));
    });

    it('marks the page the user is on among its links', async () => {
      const { sheet } = await openSheet('/income');

      const current = sheet().querySelectorAll('a[aria-current="page"]');
      expect(Array.from(current).map((a) => textOf(a))).toEqual(['Income']);
    });

    it('has nothing wrong with its markup', async () => {
      const { element } = await openSheet();

      expect(a11yProblems(element)).toEqual([]);
    });
  });

  describe('the top bar', () => {
    it('has the month switcher on a page that shows a month', async () => {
      const { element, topBar } = await start('/dashboard');

      expect(getByRole(topBar(), 'group', 'Month')).toBeTruthy();
      expect(queryByRole(element, 'group', 'Year')).toBeNull();
    });

    it('has the year switcher on the report, and no month switcher', async () => {
      const { element, topBar } = await start('/report');

      expect(textOf(getByRole(topBar(), 'group', 'Year'))).toContain('2026');
      expect(queryByRole(element, 'group', 'Month')).toBeNull();
    });

    it('has no switcher on a page with no period, and keeps the Add spending button', async () => {
      const { fixture, element, topBar } = await start('/settings');

      expect(queryByRole(element, 'group', 'Month')).toBeNull();
      expect(queryByRole(element, 'group', 'Year')).toBeNull();
      expect(getByRole(topBar(), 'button', 'Add spending')).toBeTruthy();

      await goTo(fixture, '/savings');
      expect(queryByRole(element, 'group', 'Month')).toBeNull();
      expect(queryByRole(element, 'group', 'Year')).toBeNull();
    });

    it('follows the page: month, none, year, month again', async () => {
      const { fixture, element } = await start('/dashboard');
      expect(queryByRole(element, 'group', 'Month')).not.toBeNull();

      await goTo(fixture, '/settings');
      expect(queryByRole(element, 'group', 'Month')).toBeNull();

      await goTo(fixture, '/report');
      expect(queryByRole(element, 'group', 'Year')).not.toBeNull();

      await goTo(fixture, '/income');
      expect(queryByRole(element, 'group', 'Month')).not.toBeNull();
      expect(queryByRole(element, 'group', 'Year')).toBeNull();
    });

    it('is the banner of the page, the only one, with the brand and the status of a phone in it', async () => {
      const { element, topBar } = await start('/dashboard');

      expect(element.querySelectorAll('header')).toHaveLength(1);
      expect(topBar().closest('main, aside, nav, section, article')).toBeNull();
      expect(getByRole(topBar(), 'link', 'Wallet').getAttribute('href')).toBe('/dashboard');
      // The same words as the sidebar's: the dot has them for a screen reader.
      expect(textOf(getByRole(topBar(), 'status'))).toContain('API online');
      expect(topBar().className).toContain('sticky');
      expect(topBar().className).toContain('top-0');
      expect(topBar().className).toContain('bg-surface/95');
    });

    it('keeps the selected month: the month switcher drives the URL, and focus stays on its button', async () => {
      const { fixture, topBar } = await start('/dashboard');
      const next = getByRole(topBar(), 'button', /Next month/);
      next.focus();

      next.click();
      await settle(fixture);

      expect(router.url).toBe('/dashboard?month=2026-11');
      expect(document.activeElement).toBe(next);
    });

    it('moves the year by putting it in the URL, and keeps the other parameters', async () => {
      const { fixture, topBar } = await start('/report?month=2026-08');

      getByRole(topBar(), 'button', 'Next year, 2027').click();
      await settle(fixture);

      expect(router.url).toContain('month=2026-08');
      expect(router.url).toContain('year=2027');
      expect(textOf(getByRole(topBar(), 'group', 'Year'))).toContain('2027');

      getByRole(topBar(), 'button', 'Go to this year, 2026').click();
      await settle(fixture);
      expect(router.url).toBe('/report?month=2026-08');
    });

    it('does not offer a year before the start month or beyond ten years ahead', async () => {
      const { fixture, topBar } = await start('/report');
      const previous = getByRole(topBar(), 'button', 'Previous year, not available');
      expect(previous.getAttribute('aria-disabled')).toBe('true');
      previous.click();
      await settle(fixture);
      expect(router.url).toBe('/report');

      await goTo(fixture, '/report?year=2036');
      expect(
        getByRole(topBar(), 'button', 'Next year, not available').getAttribute('aria-disabled'),
      ).toBe('true');
    });
  });

  describe('the focus layout (onboarding)', () => {
    it('keeps the brand and the API status and drops the navigation, the tab bar and the add buttons', async () => {
      const { element } = await start('/dashboard', { settings: null });

      expect(router.url).toBe('/onboarding');
      expect(queryByRole(element, 'navigation', 'Main')).toBeNull();
      expect(queryByRole(element, 'navigation', 'Main (tabs)')).toBeNull();
      expect(queryByRole(element, 'group', 'Month')).toBeNull();
      expect(queryByRole(element, 'group', 'Year')).toBeNull();
      expect(queryByRole(element, 'button', 'Add spending')).toBeNull();
      expect(element.querySelector('app-add-spending-fab')).toBeNull();
      expect(getByRole(element.querySelector('aside') as Element, 'link', 'Wallet')).toBeTruthy();
      expect(textOf(apiStatus(element))).toContain('API online');
    });

    it('draws the top bar for a phone only (the sidebar has the brand on a wide screen)', async () => {
      const { topBar } = await start('/dashboard', { settings: null });

      expect(topBar().className).toContain('md:hidden');
      expect(getByRole(topBar(), 'link', 'Wallet')).toBeTruthy();
    });
  });

  describe('moving between pages', () => {
    it('moves focus to the heading of the new page, so the move is noticed', async () => {
      const { fixture, element } = await start('/dashboard');
      expect(document.activeElement).not.toBe(element.querySelector('h1'));

      await goTo(fixture, '/income');

      expect(document.activeElement).toBe(element.querySelector('h1'));
      expect(textOf(document.activeElement as Element)).toBe('Page two');
    });

    it('leaves focus alone when only the month changes', async () => {
      const { fixture, element } = await start('/dashboard');
      const next = getByRole(
        element.querySelector('header') as HTMLElement,
        'button',
        /Next month/,
      );
      next.focus();

      next.click();
      await settle(fixture);

      expect(router.url).toBe('/dashboard?month=2026-11');
      expect(document.activeElement).toBe(next);
    });
  });

  describe('API status', () => {
    it('says in words that the API is reachable, and shows the date the server uses', async () => {
      const { element } = await start('/dashboard');

      const status = apiStatus(element);
      expect(textOf(status)).toContain('API online');
      expect(textOf(status)).toContain('Server date: Oct 2, 2026');
    });

    it('says when the API cannot be reached, with a way to check again, in both places', async () => {
      const { fixture, element, topBar } = await start('/dashboard');
      window.dispatchEvent(new Event('offline'));
      await settle(fixture);
      flushError(http.expectOne('/api/health'), 500, 'internal_error', 'Down');
      await settle(fixture);

      const status = apiStatus(element);
      expect(textOf(status)).toContain('API offline');
      // The dot of the top bar has no room for words while all is well, but shows them now.
      const compact = getByRole(topBar(), 'status');
      expect(textOf(compact)).toContain('API offline');
      expect(compact.querySelector('.sr-only')).toBeNull();

      getByRole(status, 'button', 'Check again').click();
      await settle(fixture);
      http.expectOne('/api/health').flush({ status: 'ok', time: '2026-10-02T10:01:00.000Z' });
      await settle(fixture);
      expect(textOf(apiStatus(element))).toContain('API online');
    });

    it('is a dot with words for a screen reader in the top bar while the API is online, with no server date', async () => {
      const { topBar } = await start('/dashboard');

      const compact = getByRole(topBar(), 'status');
      expect(textOf(compact)).toBe('API online');
      expect(compact.querySelector('.sr-only')?.textContent).toBe('API online');
    });
  });

  it('shows that it is starting until the first page is ready', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const navigation = router.navigateByUrl('/dashboard');
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    expect(textOf(element.querySelector('main') as Element)).toContain('Loading Wallet…');
    // Nothing to add to yet: it is not known whether this is the onboarding.
    expect(queryByRole(element, 'button', 'Add spending')).toBeNull();

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
    const savingsLink = (nav: HTMLElement) => getByRole(nav, 'link', /^Savings/);

    it('shows no badge when no month waits to be moved to savings, in either navigation', async () => {
      const { sidebar, tabs } = await start('/dashboard');

      for (const nav of [sidebar(), tabs()]) {
        expect(textOf(savingsLink(nav))).toBe('Savings');
        expect(savingsLink(nav).querySelector('app-badge')).toBeNull();
      }
    });

    it('shows how many months wait, with words for a screen reader, in both navigations', async () => {
      const { sidebar, tabs } = await start('/dashboard', {
        savings: savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08' }),
            outstandingMonth({ month: '2026-09' }),
          ],
        }),
      });

      for (const nav of [sidebar(), tabs()]) {
        const link = savingsLink(nav);
        // The number is a picture of the words, which the screen reader gets instead.
        const visible = link.querySelector('app-badge[aria-hidden="true"]') as HTMLElement;
        expect(visible.textContent?.trim()).toBe('2');
        expect(visible.className).toContain('bg-accent-soft');
        expect(textOf(link)).toBe('Savings , 2 months to move to savings');
        expect(link.getAttribute('aria-current')).toBeNull();
      }
    });

    it('says "month" for one', async () => {
      const { sidebar, tabs } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      for (const nav of [sidebar(), tabs()]) {
        expect(textOf(savingsLink(nav))).toBe('Savings , 1 month to move to savings');
      }
    });

    it('stays on the link of the page the user is on', async () => {
      const { sidebar, tabs } = await start('/savings', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      for (const nav of [sidebar(), tabs()]) {
        const link = savingsLink(nav);
        expect(link.getAttribute('aria-current')).toBe('page');
        expect(link.querySelector('app-badge')?.textContent?.trim()).toBe('1');
      }
    });

    it('loads the overview again when the user moves to another page, and the badge follows', async () => {
      const { fixture, sidebar } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });
      expect(savingsLink(sidebar()).querySelector('app-badge')).not.toBeNull();

      await router.navigateByUrl('/income');
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto());
      await settle(fixture);

      expect(savingsLink(sidebar()).querySelector('app-badge')).toBeNull();
    });

    it('keeps the old badge while the new figures are on their way', async () => {
      const { fixture, sidebar } = await start('/dashboard', {
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      await router.navigateByUrl('/income');
      await settle(fixture);

      expect(savingsLink(sidebar()).querySelector('app-badge')?.textContent?.trim()).toBe('1');
      http.expectOne('/api/savings').flush(savingsDto({ outstanding: [outstandingMonth()] }));
      await settle(fixture);
    });

    it('does not ask again when only the month changes', async () => {
      const { fixture, topBar } = await start('/dashboard');

      getByRole(topBar(), 'button', /Next month/).click();
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

  describe('Add spending, from any page', () => {
    const OCTOBER = monthView({
      month: '2026-10',
      budgets: [budgetLine({ id: 1, name: 'Groceries', spent: 10000, remaining: 30000 })],
    });

    /** The top bar's button, or the floating one: both open the same dialog. */
    const buttons = (element: HTMLElement) => queryAllByRole(element, 'button', 'Add spending');

    /** Opens the dialog from the top bar and answers what it asks for: the month's budgets and the tags. */
    async function openDialog(
      fixture: ComponentFixture<App>,
      element: HTMLElement,
      view: MonthView = OCTOBER,
    ) {
      const opener = getByRole(
        element.querySelector('header') as HTMLElement,
        'button',
        'Add spending',
      );
      opener.focus();
      opener.click();
      await untilDialog(fixture);
      http.expectOne(`/api/months/${view.month}`).flush(view);
      await settle(fixture);
      // The form is there now, and asks for the tags (once: the store keeps them).
      for (const request of http.match('/api/tags')) request.flush([]);
      await settle(fixture);
      return { opener, dialog: () => getByRole(element, 'dialog', 'Add spending') };
    }

    /** The dialog's code loads on demand (`@defer`): give it the turns it needs. */
    async function untilDialog(fixture: ComponentFixture<App>) {
      for (let turn = 0; turn < 20; turn++) {
        await settle(fixture);
        if (fixture.nativeElement.querySelector('app-add-spending-dialog')) return;
      }
      throw new Error('The Add spending dialog did not open');
    }

    it('has a button in the top bar and a floating one for a phone, both named "Add spending"', async () => {
      const { element, topBar } = await start('/dashboard');

      expect(getByRole(topBar(), 'button', 'Add spending').className).toContain('max-md:hidden');
      const fab = element.querySelector('app-add-spending-fab button') as HTMLElement;
      expect(fab.getAttribute('aria-label')).toBe('Add spending');
      expect(fab.className).toContain('fixed');
      expect(fab.className).toContain('size-14');
      expect(fab.className).toContain('md:hidden');
      expect(fab.closest('main')).not.toBeNull();
      expect(buttons(element)).toHaveLength(2);
    });

    it('is offered on every page but Spendings, which has its own form', async () => {
      const { fixture, element } = await start('/dashboard');
      for (const url of ['/savings', '/report', '/settings', '/import', '/income']) {
        await goTo(fixture, url);
        expect(buttons(element), url).toHaveLength(2);
      }

      await goTo(fixture, '/spendings');
      expect(buttons(element)).toHaveLength(0);
      expect(element.querySelector('app-add-spending-fab')).toBeNull();
    });

    it('leaves room under the content of a phone for the tab bar, and for the button when there is one', async () => {
      const { fixture, element } = await start('/dashboard');
      const main = getByRole(element, 'main');
      expect(main.className).toContain('--fab-zone');

      await goTo(fixture, '/spendings');
      expect(main.className).toContain('--tab-bar-height');
      expect(main.className).not.toContain('--fab-zone');
    });

    it('opens the form in a dialog, with the budgets of the month, and the cursor on the amount', async () => {
      const { fixture, element } = await start('/dashboard?month=2026-08');
      const { dialog } = await openDialog(
        fixture,
        element,
        monthView({ month: '2026-08', budgets: OCTOBER.budgets }),
      );

      expect(getByRole(dialog(), 'heading', 'Add spending')).toBeTruthy();
      expect(textOf(dialog())).toContain('Adding to August 2026.');
      expect(getByLabel(dialog(), 'Amount')).toBeTruthy();
      expect(textOf(getByLabel(dialog(), 'Budget'))).toContain('Groceries · €300.00 left');
      // Today's date, kept inside the month shown (the server's "today" is October).
      expect((getByLabel(dialog(), 'Date') as HTMLInputElement).value).toBe('2026-08-31');
      expect(document.activeElement).toBe(getByLabel(dialog(), 'Amount'));
      expect(a11yProblems(element)).toEqual([]);
    });

    it('says when the month is closed, or has not started', async () => {
      const closed = await start('/dashboard?month=2026-09');
      await openDialog(
        closed.fixture,
        closed.element,
        monthView({ month: '2026-09', status: 'closed', budgets: OCTOBER.budgets }),
      );
      expect(textOf(getByRole(closed.element, 'dialog', 'Add spending'))).toContain(
        'September 2026 is closed. A spending added to it changes what is due to savings.',
      );
    });

    it('says when the month has not started yet', async () => {
      const future = await start('/dashboard?month=2026-12');
      await openDialog(
        future.fixture,
        future.element,
        monthView({ month: '2026-12', status: 'future', budgets: OCTOBER.budgets }),
      );
      expect(textOf(getByRole(future.element, 'dialog', 'Add spending'))).toContain(
        'December 2026 has not started yet. A spending dated in it counts towards its projection.',
      );
    });

    it('says there is nothing to add to when the month has no budget', async () => {
      const { fixture, element } = await start('/dashboard');
      const { dialog } = await openDialog(fixture, element, monthView({ budgets: [] }));

      expect(textOf(dialog())).toContain('No budgets in October 2026');
      expect(getByRole(dialog(), 'link', 'Go to budgets').getAttribute('href')).toBe('/budgets');
      expect(queryByRole(dialog(), 'button', 'Add spending')).toBeNull();
    });

    it('says what went wrong when the budgets cannot be loaded, and can try again', async () => {
      const { fixture, element } = await start('/dashboard');
      getByRole(element.querySelector('header') as HTMLElement, 'button', 'Add spending').click();
      await untilDialog(fixture);
      flushError(
        http.expectOne('/api/months/2026-10'),
        500,
        'internal_error',
        'The ledger is down',
      );
      await settle(fixture);

      const dialog = getByRole(element, 'dialog', 'Add spending');
      expect(textOf(getByRole(dialog, 'alert'))).toContain('The ledger is down');

      getByRole(dialog, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      for (const request of http.match('/api/tags')) request.flush([]);
      await settle(fixture);
      expect(getByLabel(getByRole(element, 'dialog', 'Add spending'), 'Amount')).toBeTruthy();
    });

    it('closes with Cancel or Escape and gives focus back to the button that opened it', async () => {
      const { fixture, element } = await start('/dashboard');
      const { opener, dialog } = await openDialog(fixture, element);

      getByRole(dialog(), 'button', 'Cancel').click();
      await settle(fixture);
      expect(queryByRole(element, 'dialog', 'Add spending')).toBeNull();
      expect(document.activeElement).toBe(opener);

      opener.click();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(fixture);
      expect(queryByRole(element, 'dialog', 'Add spending')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it('opens from the floating button too', async () => {
      const { fixture, element } = await start('/savings');
      (element.querySelector('app-add-spending-fab button') as HTMLElement).click();
      await untilDialog(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      for (const request of http.match('/api/tags')) request.flush([]);
      await settle(fixture);

      expect(getByRole(element, 'dialog', 'Add spending')).toBeTruthy();
    });

    it("saves, closes, confirms with the budget's new figures, and the page behind shows the new numbers", async () => {
      const { fixture, element } = await start('/budgets');
      const spent = () =>
        (element.querySelector('[data-testid="spent"]') as HTMLElement).textContent;
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      expect(spent()).toBe('10000');

      const { opener, dialog } = await openDialog(fixture, element);
      typeInto(getByLabel(dialog(), 'Amount'), '12,50');
      getByRole(dialog(), 'button', 'Add spending').click();
      await settle(fixture);

      const request = http.expectOne('/api/spendings');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ date: '2026-10-02', amount: 1250, budgetId: 1 });
      request.flush(spendingDto({ id: 9, amount: 1250 }), { status: 201, statusText: 'Created' });
      await settle(fixture);

      // The dialog loads the month again for the budget's figures after the spending (11250 spent).
      const after = monthView({
        month: '2026-10',
        budgets: [
          budgetLine({
            id: 1,
            name: 'Groceries',
            spent: 11250,
            remaining: 28750,
            available: 40000,
          }),
        ],
        totals: { allocated: 40000, spent: 11250, remaining: 28750, transfersNet: 0 },
      });
      http.expectOne('/api/months/2026-10').flush(after);
      await settle(fixture);

      expect(queryByRole(element, 'dialog', 'Add spending')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      ).toEqual(['Added €12.50 to Groceries. €287.50 left of €400.00.']);

      // The page behind loads its own month again, keeping what it shows until the answer is here.
      expect(spent()).toBe('10000');
      http.expectOne('/api/months/2026-10').flush(after);
      await settle(fixture);
      expect(spent()).toBe('11250');
      // A spending in the current month cannot change what is due to savings: no overview asked for.
      http.expectNone('/api/savings');
    });

    it('asks for the savings overview again after a spending in a closed month', async () => {
      const { fixture, element } = await start('/dashboard?month=2026-09');
      const september = monthView({ month: '2026-09', status: 'closed', budgets: OCTOBER.budgets });
      const { dialog } = await openDialog(fixture, element, september);
      typeInto(getByLabel(dialog(), 'Amount'), '5');
      getByRole(dialog(), 'button', 'Add spending').click();
      await settle(fixture);
      http
        .expectOne('/api/spendings')
        .flush(spendingDto({ id: 9, date: '2026-09-30', amount: 500 }), {
          status: 201,
          statusText: 'Created',
        });
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto({ outstanding: [outstandingMonth()] }));
      http.expectOne('/api/months/2026-09').flush(september);
      await settle(fixture);

      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message)[0],
      ).toContain('Added €5.00 to Groceries.');
      // The month view of the page behind (the dashboard stub has none) and the badge follow.
      expect(
        getByRole(getByRole(element, 'navigation', 'Main'), 'link', /^Savings/).querySelector(
          'app-badge',
        ),
      ).not.toBeNull();
    });

    it('keeps the dialog open and shows what the server refused', async () => {
      const { fixture, element } = await start('/dashboard');
      const { dialog } = await openDialog(fixture, element);
      typeInto(getByLabel(dialog(), 'Amount'), '5');
      getByRole(dialog(), 'button', 'Add spending').click();
      await settle(fixture);

      flushError(http.expectOne('/api/spendings'), 500, 'internal_error', 'The ledger is busy');
      await settle(fixture);

      expect(textOf(getByRole(dialog(), 'alert'))).toContain('The ledger is busy');
      expect(TestBed.inject(ToastService).toasts()).toEqual([]);
    });
  });
});
