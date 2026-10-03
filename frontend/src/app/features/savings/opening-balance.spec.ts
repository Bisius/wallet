import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fieldError, getByLabel, getByRole, queryByRole, textOf } from '../../../testing/dom';
import { savingsDto, savingsTransaction as row, transactionsPage } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import {
  HISTORY_URL,
  OPENING,
  openSavingsPage,
  SavingsHost,
  savingsPage,
} from '../../../testing/savings-harness';

describe('the opening balance', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const open = () => openSavingsPage(http, { savings: savingsDto(), opening: OPENING });
  type Page = Awaited<ReturnType<typeof open>>;
  const card = (p: Page) => p.region('Starting point');
  const dialog = (p: Page) => p.dialog('app-opening-balance-dialog') as HTMLElement;

  it('says what the balance was on the first day of the start month', async () => {
    const p = await open();

    expect(textOf(card(p))).toContain('Opening balance: €1,000.00 on Jun 1, 2026');
    expect(textOf(card(p))).toContain(
      'the balance of your savings on the first day of your start month',
    );
  });

  it('shows the date the API gives: it follows the start month', async () => {
    const p = await openSavingsPage(http, {
      savings: savingsDto(),
      opening: { amount: 25000, date: '2026-03-01' },
    });

    expect(textOf(card(p))).toContain('Opening balance: €250.00 on Mar 1, 2026');
  });

  it('opens a dialog with the stored amount, labelled with the day it is for', async () => {
    const p = await open();

    await p.press('Edit opening balance', card(p));

    expect(textOf(getByRole(dialog(p), 'heading', 'Opening balance'))).toBe('Opening balance');
    expect(p.value('Savings balance on Jun 1, 2026', dialog(p))).toBe('1000.00');
    expect(document.activeElement).toBe(getByLabel(dialog(p), 'Savings balance on Jun 1, 2026'));
  });

  it('saves a new amount with PUT, then loads everything again and confirms', async () => {
    const p = await open();
    await p.press('Edit opening balance', card(p));
    await p.type('Savings balance on Jun 1, 2026', '1250,50', dialog(p));

    await p.press('Save opening balance', dialog(p));

    const request = http.expectOne('/api/savings/opening');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ amount: 125050 });
    request.flush({ amount: 125050, date: '2026-06-01' });
    await p.reload({
      savings: savingsDto({ unassigned: 125050 }),
      opening: { amount: 125050, date: '2026-06-01' },
    });

    expect(p.toasts()).toEqual(['Opening balance saved.']);
    expect(p.dialog('app-opening-balance-dialog')).toBeNull();
    expect(textOf(card(p))).toContain('Opening balance: €1,250.50 on Jun 1, 2026');
  });

  it('accepts zero', async () => {
    const p = await open();
    await p.press('Edit opening balance', card(p));
    await p.type('Savings balance on Jun 1, 2026', '0', dialog(p));

    await p.press('Save opening balance', dialog(p));

    expect(http.expectOne('/api/savings/opening').request.body).toEqual({ amount: 0 });
  });

  it('does not send a negative amount or an empty one', async () => {
    const p = await open();
    await p.press('Edit opening balance', card(p));
    const field = () => getByLabel(dialog(p), 'Savings balance on Jun 1, 2026');

    await p.type('Savings balance on Jun 1, 2026', '-5', dialog(p));
    await p.press('Save opening balance', dialog(p));
    expect(fieldError(field())).toBe('Enter an amount of zero or more.');

    await p.type('Savings balance on Jun 1, 2026', '', dialog(p));
    await p.press('Save opening balance', dialog(p));
    expect(fieldError(field())).toBe('Savings balance on Jun 1, 2026 is required.');
    expect(document.activeElement).toBe(field());
    http.expectNone('/api/savings/opening');
  });

  it('shows what the API said and keeps the dialog open when saving fails', async () => {
    const p = await open();
    await p.press('Edit opening balance', card(p));
    await p.type('Savings balance on Jun 1, 2026', '10', dialog(p));
    await p.press('Save opening balance', dialog(p));

    flushError(
      http.expectOne('/api/savings/opening'),
      500,
      'internal_error',
      'Something went wrong',
    );
    await settle(p.fixture);

    expect(textOf(dialog(p))).toContain('Something went wrong');
    expect(p.value('Savings balance on Jun 1, 2026', dialog(p))).toBe('10');
  });

  it('closes without a request when cancelled', async () => {
    const p = await open();
    await p.press('Edit opening balance', card(p));

    await p.press('Cancel', dialog(p));

    expect(p.dialog('app-opening-balance-dialog')).toBeNull();
    http.expectNone('/api/savings/opening');
  });

  it('is also reachable from the opening entry of the history', async () => {
    const p = await openSavingsPage(http, {
      savings: savingsDto(),
      history: transactionsPage([
        row({ id: 1, kind: 'opening', amount: 100000, date: '2026-06-01' }),
      ]),
    });

    await p.press('Edit opening balance', p.region('History'));

    expect(p.dialog('app-opening-balance-dialog')).not.toBeNull();
  });

  describe('loading and failing', () => {
    it('says it is loading, then shows the balance; the rest of the page does not wait for it', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(SavingsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne(HISTORY_URL).flush(transactionsPage([]));
      await settle(fixture);
      const p = savingsPage(http, fixture);

      expect(textOf(p.region('Starting point'))).toContain('Loading your opening balance…');
      expect(queryByRole(p.element, 'button', 'Edit opening balance')).toBeNull();
      expect(queryByRole(p.element, 'region', 'Your savings')).not.toBeNull();

      http.expectOne('/api/savings/opening').flush(OPENING);
      await settle(fixture);
      expect(textOf(p.region('Starting point'))).toContain('Opening balance: €1,000.00');
    });

    it('shows what the API said when the balance cannot be loaded, with a way to try again', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(SavingsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne(HISTORY_URL).flush(transactionsPage([]));
      flushError(
        http.expectOne('/api/savings/opening'),
        500,
        'internal_error',
        'The ledger is down',
      );
      await settle(fixture);
      const p = savingsPage(http, fixture);

      expect(textOf(p.region('Starting point'))).toContain("Couldn't load your opening balance");
      expect(textOf(p.region('Starting point'))).toContain('The ledger is down');

      await p.press('Try again', p.region('Starting point'));
      http.expectOne('/api/savings/opening').flush(OPENING);
      await settle(fixture);
      expect(textOf(p.region('Starting point'))).toContain('Opening balance: €1,000.00');
    });
  });
});
