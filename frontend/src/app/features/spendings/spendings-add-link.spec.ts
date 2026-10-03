import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { getByLabel } from '../../../testing/dom';
import { budgetLine, monthView } from '../../../testing/fixtures';
import { StubPage } from '../../../testing/harness';
import { openSpendingsPage } from '../../../testing/spendings-harness';

/**
 * `/spendings?add=1` is the address of the "Add spending" shortcut of the installed app (the web app
 * manifest): the page opens with the cursor on the amount of the form, and the parameter goes away.
 */
describe('SpendingsPage: the "Add spending" shortcut (?add=1)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'spendings', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    http.verify();
    localStorage.clear();
  });

  it('puts the cursor on the amount and takes ?add=1 out of the address', async () => {
    const p = await openSpendingsPage(http, { url: '/spendings?add=1' });

    expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));
    expect(p.router.url).toBe('/spendings');
  });

  it('keeps the month and the filters of the address', async () => {
    // Leaving the filters alone also means that the list is not asked for again: `http.verify()`
    // in afterEach fails on a second request for it.
    const p = await openSpendingsPage(http, {
      url: '/spendings?month=2026-09&q=lunch&add=1',
      month: '2026-09',
      firstPage: { month: '2026-09', q: 'lunch' },
      view: monthView({ month: '2026-09', status: 'closed', budgets: [budgetLine({ id: 1 })] }),
    });

    expect(document.activeElement).toBe(getByLabel(p.form(), 'Amount'));
    expect(p.params()).toEqual({ month: '2026-09', q: 'lunch' });
  });

  it('does nothing without it', async () => {
    const p = await openSpendingsPage(http);

    expect(document.activeElement).not.toBe(getByLabel(p.form(), 'Amount'));
    expect(p.router.url).toBe('/spendings');
  });

  it('does nothing for another value, and leaves the address alone', async () => {
    const p = await openSpendingsPage(http, { url: '/spendings?add=yes' });

    expect(document.activeElement).not.toBe(getByLabel(p.form(), 'Amount'));
    expect(p.router.url).toBe('/spendings?add=yes');
  });
});
