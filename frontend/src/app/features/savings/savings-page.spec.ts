import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { goalDto, savingsDto, transactionsPage } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { SavingsStore } from '../../core/savings.store';
import {
  HISTORY_URL,
  OPENING,
  openSavingsPage,
  SavingsHost,
  savingsPage,
} from '../../../testing/savings-harness';

describe('SavingsPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for the overview, the opening balance and the first page of the history, and nothing about a month', async () => {
    await primeStores(http);
    const fixture = TestBed.createComponent(SavingsHost);
    fixture.detectChanges();
    await settle(fixture);

    // Exactly these three, and none says anything about a month.
    http.expectOne('/api/savings').flush(savingsDto());
    http.expectOne('/api/savings/opening').flush(OPENING);
    http.expectOne(HISTORY_URL).flush(transactionsPage([]));
    await settle(fixture);
  });

  describe('loading and failing', () => {
    it('says it is loading until the overview is in', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(SavingsHost);
      fixture.detectChanges();
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;

      expect(textOf(getByRole(element, 'status', 'Loading your savings…'))).toBe(
        'Loading your savings…',
      );
      expect(queryByRole(element, 'region', 'Your savings')).toBeNull();

      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne('/api/savings/opening').flush(OPENING);
      http.expectOne(HISTORY_URL).flush(transactionsPage([]));
      await settle(fixture);

      expect(queryByRole(element, 'status', 'Loading your savings…')).toBeNull();
      expect(queryByRole(element, 'region', 'Your savings')).not.toBeNull();
    });

    it('shows what the API said when the overview cannot be loaded, and loads it again on request', async () => {
      await primeStores(http);
      const fixture = TestBed.createComponent(SavingsHost);
      fixture.detectChanges();
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;
      flushError(http.expectOne('/api/savings'), 500, 'internal_error', 'The ledger is down');
      http.expectOne('/api/savings/opening').flush(OPENING);
      http.expectOne(HISTORY_URL).flush(transactionsPage([]));
      await settle(fixture);

      const page = savingsPage(http, fixture);
      expect(page.alerts()).toHaveLength(1);
      expect(page.alerts()[0]).toContain("Couldn't load your savings");
      expect(page.alerts()[0]).toContain('The ledger is down');
      expect(queryByRole(element, 'region', 'Your savings')).toBeNull();

      await page.press('Try again');
      http.expectOne('/api/savings').flush(savingsDto({ unassigned: 5000 }));
      await settle(fixture);

      expect(page.alerts()).toEqual([]);
      expect(page.regionText('Your savings')).toContain('€50.00');
    });
  });

  describe('the balance', () => {
    it('shows the balance and the unassigned amount exactly as the API reports them', async () => {
      // The figures do not add up on purpose: the page must show what it is told, not work it out.
      const p = await openSavingsPage(http, {
        savings: savingsDto({
          balance: 123456,
          unassigned: 7890,
          goals: [goalDto({ id: 1, balance: 1000 })],
        }),
      });

      const summary = p.regionText('Your savings');
      expect(summary).toContain('Savings balance €1,234.56');
      expect(summary).toContain('Unassigned €78.90');
      expect(summary).not.toContain('Below zero');
    });

    it('shows a negative balance plainly: a minus sign, a label and an explanation, but no alert', async () => {
      const p = await openSavingsPage(http, {
        savings: savingsDto({ balance: -12000, unassigned: 3000 }),
      });

      const summary = p.regionText('Your savings');
      expect(summary).toContain('Savings balance -€120.00');
      expect(summary).toContain('Below zero.');
      expect(summary).toContain('More has been taken out of savings than was put in');
      expect(p.alerts()).toEqual([]);
      // Plainly: the sign and the label say it, there is no error color.
      expect(p.region('Your savings').querySelector('.text-negative')).toBeNull();
    });

    it('explains an unassigned amount below zero', async () => {
      const p = await openSavingsPage(http, {
        savings: savingsDto({
          balance: 50000,
          unassigned: -20000,
          goals: [goalDto({ id: 1, balance: 70000, targetAmount: 100000 })],
        }),
      });

      const summary = p.regionText('Your savings');
      expect(summary).toContain('Unassigned -€200.00');
      expect(summary).toContain('More was taken out of unassigned savings than it held');
    });

    it('offers to deposit and withdraw, but not to reallocate while there is no goal to move to or from', async () => {
      const p = await openSavingsPage(http, { savings: savingsDto() });

      const buttons = queryAllByRole(p.region('Your savings'), 'button').map((b) => textOf(b));
      expect(buttons).toEqual(['Deposit', 'Withdraw']);
    });

    it('offers to reallocate when every goal is archived: its money can still be moved out', async () => {
      const p = await openSavingsPage(http, {
        savings: savingsDto({ goals: [goalDto({ id: 1, archived: true, balance: 5000 })] }),
      });

      const buttons = queryAllByRole(p.region('Your savings'), 'button').map((b) => textOf(b));
      expect(buttons).toEqual(['Deposit', 'Withdraw', 'Reallocate']);
    });

    it('has the three buttons in one group, beside the heading, and the figures as a strip of their own', async () => {
      const p = await openSavingsPage(http, {
        savings: savingsDto({ balance: 50000, unassigned: 20000, goals: [goalDto({ id: 1 })] }),
      });

      const group = getByRole(p.region('Your savings'), 'group', 'Move money by hand');
      expect(queryAllByRole(group, 'button').map((b) => textOf(b))).toEqual([
        'Deposit',
        'Withdraw',
        'Reallocate',
      ]);
      // The figures are a list of terms and values, not part of the group, and not in a card.
      const strip = p.region('Your savings').querySelector('dl') as HTMLElement;
      expect(group.contains(strip)).toBe(false);
      expect(textOf(strip)).toContain('Savings balance €500.00');
      expect(textOf(strip)).toContain('Unassigned €200.00');
      expect(p.region('Your savings').classList).not.toContain('card');
    });

    it('offers to reallocate once there is a goal', async () => {
      const p = await openSavingsPage(http, {
        savings: savingsDto({ goals: [goalDto({ id: 1 })] }),
      });

      const buttons = queryAllByRole(p.region('Your savings'), 'button').map((b) => textOf(b));
      expect(buttons).toEqual(['Deposit', 'Withdraw', 'Reallocate']);
    });
  });

  describe('the page', () => {
    it('is organised in labelled sections, with the inbox right after the balance', async () => {
      const p = await openSavingsPage(http, { savings: savingsDto() });

      expect(textOf(getByRole(p.element, 'heading', 'Savings'))).toBe('Savings');
      const headings = queryAllByRole(p.element, 'heading')
        .filter((h) => h.tagName === 'H2')
        .map((h) => textOf(h));
      expect(headings).toEqual([
        'Your savings',
        'Move to savings',
        'Goals',
        'Starting point',
        'History',
      ]);
    });

    it('has no month switcher: savings are not tied to a month', async () => {
      const p = await openSavingsPage(http, { savings: savingsDto() });
      expect(queryByRole(p.element, 'group', 'Month')).toBeNull();
    });

    it('follows the shared overview when it is refreshed in the background', async () => {
      const p = await openSavingsPage(http, { savings: savingsDto({ unassigned: 1000 }) });
      expect(p.regionText('Your savings')).toContain('Unassigned €10.00');

      // The shell refreshes the overview when the user moves to another page.
      TestBed.inject(SavingsStore).refresh();
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(savingsDto({ unassigned: 2500 }));
      await settle(p.fixture);

      expect(p.regionText('Your savings')).toContain('Unassigned €25.00');
    });
  });
});
