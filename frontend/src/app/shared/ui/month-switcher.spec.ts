import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { getByRole, textOf } from '../../../testing/dom';
import { primeStores, render, SETTINGS, settle, StubPage } from '../../../testing/harness';
import { MonthSwitcher } from './month-switcher';

describe('MonthSwitcher', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'budgets', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  async function setup(query = '', options: Parameters<typeof primeStores>[1] = {}) {
    await primeStores(http, options);
    await router.navigateByUrl(`/budgets${query}`);
    const fixture = await render(MonthSwitcher);
    const element = fixture.nativeElement as HTMLElement;
    const button = (name: string | RegExp) => getByRole(element, 'button', name);
    const click = async (name: string | RegExp) => {
      button(name).click();
      await settle(fixture);
    };
    return { fixture, element, button, click };
  }

  it('is a labelled group with the month in words for screen readers', async () => {
    const { element } = await setup();

    const group = getByRole(element, 'group', 'Month');
    // Visible: short. Read aloud: long.
    expect(textOf(group)).toContain('October 2026');
    expect(group.querySelector('[aria-live="polite"]')?.textContent).toContain('Oct 2026');
    expect(group.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe('Oct 2026');
  });

  it('labels each button with where it goes', async () => {
    const { button } = await setup();

    expect(button('Previous month, September 2026')).toBeTruthy();
    expect(button('Next month, November 2026')).toBeTruthy();
    expect(button('Go to this month, October 2026')).toBeTruthy();
  });

  it('says that the previous button is not available at the start month, instead of naming a month it cannot open', async () => {
    const { button } = await setup('?month=2026-06');

    expect(button(/Previous month/).getAttribute('aria-label')).toBe(
      'Previous month, not available',
    );
    expect(button(/Next month/).getAttribute('aria-label')).toBe('Next month, July 2026');
  });

  it('says that the next button is not available at the end of the range', async () => {
    const { button } = await setup('?month=2036-10');

    expect(button(/Next month/).getAttribute('aria-label')).toBe('Next month, not available');
    expect(button(/Previous month/).getAttribute('aria-label')).toBe(
      'Previous month, September 2036',
    );
  });

  it('steps through the months, keeping the choice in the URL', async () => {
    const { element, click } = await setup();

    await click(/Previous month/);
    expect(router.url).toBe('/budgets?month=2026-09');
    expect(textOf(getByRole(element, 'group', 'Month'))).toContain('September 2026');
    expect(getByRole(element, 'button', 'Previous month, August 2026')).toBeTruthy();

    await click(/Next month/);
    await click(/Next month/);
    expect(router.url).toBe('/budgets?month=2026-11');
  });

  it('jumps back to this month, and is inert while already there', async () => {
    const { button, click } = await setup('?month=2026-04');
    expect(button(/Go to this month/).getAttribute('aria-disabled')).toBe('false');

    await click(/Go to this month/);
    expect(router.url).toBe('/budgets');
    expect(button(/Go to this month/).getAttribute('aria-disabled')).toBe('true');

    await click(/Go to this month/);
    expect(router.url).toBe('/budgets');
  });

  it('cannot go before the start month: the button says so and does nothing', async () => {
    const { button, click } = await setup('?month=2026-06');

    expect(button(/Previous month/).getAttribute('aria-disabled')).toBe('true');
    await click(/Previous month/);
    expect(router.url).toBe('/budgets?month=2026-06');
    // It stays a focusable button, so the keyboard user does not lose their place.
    expect((button(/Previous month/) as HTMLButtonElement).disabled).toBe(false);
    expect(button(/Next month/).getAttribute('aria-disabled')).toBe('false');
  });

  it('cannot go beyond the current month plus 120 months', async () => {
    const { button, click } = await setup('?month=2036-10');

    expect(button(/Next month/).getAttribute('aria-disabled')).toBe('true');
    await click(/Next month/);
    expect(router.url).toBe('/budgets?month=2036-10');
  });

  it('writes the month in the language of the settings', async () => {
    const { element, button } = await setup('', { settings: { ...SETTINGS, locale: 'it-IT' } });

    expect(textOf(getByRole(element, 'group', 'Month'))).toContain('ottobre 2026');
    expect(button(/Previous month/).getAttribute('aria-label')).toBe(
      'Previous month, settembre 2026',
    );
  });

  it('shows nothing until the current month is known', async () => {
    const fixture = await render(MonthSwitcher);
    expect(fixture.nativeElement.querySelector('[role="group"]')).toBeNull();
    await primeStores(http);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[role="group"]')).not.toBeNull();
  });
});
