import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { MonthView, SubscriptionDto } from '@wallet/shared';
import {
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionPriceSchema,
  subscriptionUpdateSchema,
} from '@wallet/shared';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { monthView, subscriptionDto, subscriptionLine } from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import { menuItem, menuItemNames, rowAction } from '../../../testing/menu';
import { SubscriptionsPage } from './subscriptions-page';

@Component({
  selector: 'app-subscriptions-host',
  imports: [SubscriptionsPage, ConfirmDialog, ToastContainer],
  template: '<app-subscriptions-page /><app-confirm-dialog /><app-toast-container />',
})
class SubscriptionsHost {}

/** A monthly 10.00 subscription: its line in October. */
const STREAMING = subscriptionDto({ id: 1, name: 'Streaming', anchorDate: '2026-06-14' });
const STREAMING_LINE = subscriptionLine({
  id: 1,
  name: 'Streaming',
  frequency: 'monthly',
  price: 1000,
  charge: 1000,
  reserveBalance: 0,
  nextRenewalMonth: null,
  nextRenewalPrice: null,
});

/** A yearly 120.00 subscription renewing in March, with 60.00 set aside. */
const DOMAIN = subscriptionDto({
  id: 2,
  name: 'Domain',
  frequency: 'yearly',
  anchorDate: '2025-03-14',
  prices: [{ effectiveMonth: '2026-06', amount: 12000 }],
});
const DOMAIN_LINE = subscriptionLine({ id: 2, name: 'Domain' });

const GYM = subscriptionDto({
  id: 3,
  name: 'Gym',
  anchorDate: '2027-01-05',
  startMonth: '2027-01',
  status: 'upcoming',
  prices: [{ effectiveMonth: '2027-01', amount: 3000 }],
});
const MAGAZINE = subscriptionDto({
  id: 4,
  name: 'Old magazine',
  startMonth: '2026-06',
  endMonth: '2026-08',
  status: 'cancelled',
  prices: [{ effectiveMonth: '2026-06', amount: 900 }],
});

const ALL = [DOMAIN, GYM, MAGAZINE, STREAMING];
const OCTOBER = monthView({ subscriptions: [DOMAIN_LINE, STREAMING_LINE] });

describe('SubscriptionsPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'subscriptions', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  interface Data {
    view?: MonthView;
    subscriptions?: SubscriptionDto[];
  }

  /** Opens the page for a month and answers its two requests. */
  async function open(month = '2026-10', data: Data = {}) {
    await primeStores(http);
    await router.navigateByUrl(`/subscriptions${month === '2026-10' ? '' : `?month=${month}`}`);
    const fixture = TestBed.createComponent(SubscriptionsHost);
    fixture.detectChanges();
    await settle(fixture);
    await answer(fixture, month, data);
    return page(fixture);
  }

  async function answer(fixture: { detectChanges(): void }, month: string, data: Data = {}) {
    http.expectOne(`/api/months/${month}`).flush(data.view ?? { ...OCTOBER, month });
    http.expectOne('/api/subscriptions').flush(data.subscriptions ?? ALL);
    await settle(fixture as never);
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<SubscriptionsHost>>) {
    const element = fixture.nativeElement as HTMLElement;
    const helpers = {
      fixture,
      element,
      text: () => textOf(element),
      card: (name: string) => getByRole(element, 'article', name),
      cardText: (name: string) => textOf(getByRole(element, 'article', name)),
      section: (name: RegExp | string) => getByRole(element, 'region', name),
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      /** Opens the "More actions" menu called `menu` and presses its item: `menuAction('More actions for Gym', 'Delete')`. */
      menuAction: (menu: string | RegExp, item: string | RegExp) => rowAction(element, item, menu),
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(element, label), value);
        await settle(fixture);
      },
      choose: async (label: string | RegExp) => {
        getByLabel(element, label).click();
        await settle(fixture);
      },
      value: (label: string | RegExp) => (getByLabel(element, label) as HTMLInputElement).value,
      dialog: (name?: string | RegExp) => queryByRole(element, 'dialog', name),
      confirmDialog: () => element.querySelector('app-confirm-dialog dialog') as HTMLDialogElement,
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** After a change the page loads the list and the month view again. */
      reload: async (data: Data = {}, month = '2026-10') => {
        await settle(fixture);
        await answer(fixture, month, data);
      },
    };
    return helpers;
  }

  const noRequest = (pattern: RegExp) => http.expectNone((request) => pattern.test(request.url));

  describe('the list', () => {
    it('has a section each for active, upcoming and cancelled subscriptions', async () => {
      const p = await open();

      const headings = Array.from(p.element.querySelectorAll('section h2')).map((h) => textOf(h));
      expect(headings).toEqual([
        'Fixed costs in October 2026',
        'Active (2)',
        'Upcoming (1)',
        'Cancelled (1)',
      ]);
      expect(textOf(p.section('Active (2)'))).toContain('Domain');
      expect(textOf(p.section('Active (2)'))).toContain('Streaming');
      expect(textOf(p.section('Upcoming (1)'))).toContain('Gym');
      expect(textOf(p.section('Cancelled (1)'))).toContain('Old magazine');
    });

    it('leaves out a section that has nothing in it', async () => {
      const p = await open('2026-10', { subscriptions: [STREAMING, DOMAIN] });

      expect(queryByRole(p.element, 'region', /Upcoming/)).toBeNull();
      expect(queryByRole(p.element, 'region', /Cancelled/)).toBeNull();
    });

    it('shows the fixed costs of the month as the API reports them', async () => {
      const p = await open('2026-10', {
        view: monthView({
          subscriptions: [DOMAIN_LINE, STREAMING_LINE],
          // Not the sum of the lines: the page shows what it is told.
          fixedCosts: 123456,
        }),
      });

      const summary = textOf(p.section('Fixed costs in October 2026'));
      expect(summary).toContain('€1,234.56');
      expect(summary).toContain('Current month');
      expect(summary).toContain('not the whole price');
    });

    it('puts the fixed costs in a flat strip as the big figure, and the long explanation behind "How this works"', async () => {
      const p = await open('2026-10', {
        view: monthView({ subscriptions: [DOMAIN_LINE, STREAMING_LINE], fixedCosts: 123456 }),
      });

      const strip = p.section('Fixed costs in October 2026');
      expect(strip.closest('.card')).toBeNull();
      const figure = strip.querySelector('dl > div') as HTMLElement;
      expect(textOf(figure)).toContain('Fixed costs €1,234.56');
      expect(figure.querySelector('dd.text-kpi')).not.toBeNull();
      // One line says what it is; what a yearly one adds is folded away.
      expect(textOf(figure)).toContain(
        "What your subscriptions take off the top of this month's income.",
      );
      expect(textOf(figure)).not.toContain('not the whole price');
      const details = strip.querySelector('details') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      expect(textOf(details.querySelector('summary') as Element)).toBe('How this works');
      expect(textOf(details)).toContain('not the whole price');
      // The status of the month sits with the heading.
      expect(textOf(strip.querySelector('header') as Element)).toBe(
        'Fixed costs in October 2026 Current month',
      );
    });

    it('invites the user to add the first subscription when there are none', async () => {
      const p = await open('2026-10', { subscriptions: [], view: monthView() });

      expect(p.text()).toContain('No subscriptions yet');
      expect(p.element.querySelectorAll('article')).toHaveLength(0);
    });

    it('says it is loading while the requests are out', async () => {
      await primeStores(http);
      await router.navigateByUrl('/subscriptions');
      const fixture = TestBed.createComponent(SubscriptionsHost);
      fixture.detectChanges();
      await settle(fixture);

      expect(textOf(fixture.nativeElement)).toContain('Loading subscriptions…');
      expect(textOf(fixture.nativeElement)).toContain("Loading this month's fixed costs…");
      await answer(fixture, '2026-10');
    });

    it('shows what the API said when the list cannot be loaded, keeps the rest, and can try again', async () => {
      await primeStores(http);
      await router.navigateByUrl('/subscriptions');
      const fixture = TestBed.createComponent(SubscriptionsHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(http.expectOne('/api/subscriptions'), 500, 'internal_error', 'The list is busy');
      await settle(fixture);
      const p = page(fixture);

      const alert = getByRole(
        p.element.querySelector('app-subscriptions-page') as HTMLElement,
        'alert',
      );
      expect(textOf(alert)).toContain("Couldn't load the subscriptions");
      expect(textOf(alert)).toContain('The list is busy');
      expect(p.text()).toContain('Fixed costs in October 2026');

      getByRole(alert, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/subscriptions').flush(ALL);
      await settle(fixture);
      expect(p.text()).toContain('Streaming');
    });

    it('shows the failure of the month view in place of the fixed costs, and keeps the list', async () => {
      await primeStores(http);
      await router.navigateByUrl('/subscriptions');
      const fixture = TestBed.createComponent(SubscriptionsHost);
      fixture.detectChanges();
      await settle(fixture);
      flushError(http.expectOne('/api/months/2026-10'), 500, 'internal_error', 'No ledger');
      http.expectOne('/api/subscriptions').flush(ALL);
      await settle(fixture);
      const p = page(fixture);

      expect(
        textOf(
          getByRole(p.element.querySelector('app-subscriptions-page') as HTMLElement, 'alert'),
        ),
      ).toContain('No ledger');
      expect(p.cardText('Streaming')).toContain('Monthly');
    });

    it('follows the month switcher: another month is another request, the list stays', async () => {
      const p = await open();
      await router.navigateByUrl('/subscriptions?month=2026-08');
      await settle(p.fixture);

      http
        .expectOne('/api/months/2026-08')
        .flush(monthView({ month: '2026-08', status: 'closed', subscriptions: [STREAMING_LINE] }));
      await settle(p.fixture);

      expect(p.text()).toContain('Fixed costs in August 2026');
      expect(p.text()).toContain('Closed month');
      noRequest(/\/api\/subscriptions/);
    });
  });

  describe('a subscription card', () => {
    it('shows a monthly one: frequency, price, per month, status and billing day', async () => {
      const p = await open();
      const text = p.cardText('Streaming');

      expect(text).toContain('Monthly');
      expect(text).toContain('Active');
      expect(text).toContain('Price €10.00 a month');
      expect(text).toContain('Per month €10.00');
      expect(text).toContain('Charged on day 14 of each month.');
      expect(text).not.toContain('approximate');
    });

    it('gives each status a meaning besides its word: active is positive, upcoming is accent, cancelled is neutral', async () => {
      const p = await open();
      const tone = (name: string, label: string) => {
        const badge = Array.from(p.card(name).querySelectorAll<HTMLElement>('app-badge')).find(
          (candidate) => textOf(candidate) === label,
        );
        return [...(badge?.classList ?? [])].find((className) => className.startsWith('bg-'));
      };

      expect(tone('Streaming', 'Active')).toBe('bg-positive-soft');
      expect(tone('Gym', 'Upcoming')).toBe('bg-accent-soft');
      expect(tone('Old magazine', 'Cancelled')).toBe('bg-subtle');
    });

    it('shows a yearly one: its price per year, and the monthly equivalent as an approximation', async () => {
      const p = await open();
      const text = p.cardText('Domain');

      expect(text).toContain('Yearly');
      expect(text).toContain('Price €120.00 a year');
      expect(text).toContain('Monthly equivalent (approximate) About €10.00');
      expect(text).toContain('Renews every year on March 14.');
    });

    it('rounds nothing itself: the monthly equivalent is the API figure', async () => {
      const odd = { ...DOMAIN, monthlyEquivalent: 834, currentPrice: 10000 };
      const p = await open('2026-10', { subscriptions: [odd] });

      expect(p.cardText('Domain')).toContain('Price €100.00 a year');
      expect(p.cardText('Domain')).toContain('About €8.34');
    });

    it('says the last day of a shorter month when the billing day is above 28', async () => {
      const late = subscriptionDto({ id: 1, name: 'Streaming', anchorDate: '2026-05-31' });
      const p = await open('2026-10', { subscriptions: [late] });

      expect(p.cardText('Streaming')).toContain(
        'Charged on day 31 of each month, or the last day of a shorter month.',
      );
    });

    it('shows an upcoming one with the month it starts and its first price', async () => {
      const p = await open();
      const text = p.cardText('Gym');

      expect(text).toContain('Upcoming');
      expect(text).toContain('Starts Jan 2027');
      expect(text).toContain('Price €30.00 a month');
      // There is no monthly equivalent before it starts: the API says null.
      expect(text).not.toContain('Per month');
      expect(text).toContain('Not charged in October 2026.');
    });

    it('shows a cancelled one with the month it ended', async () => {
      const p = await open();
      const text = p.cardText('Old magazine');

      expect(text).toContain('Cancelled');
      expect(text).toContain('Ended Aug 2026');
      expect(text).toContain('Not charged in October 2026.');
    });

    it('says when an active one ends: it is charged one last time', async () => {
      const ending = { ...STREAMING, endMonth: '2026-12' };
      const p = await open('2026-10', { subscriptions: [ending, DOMAIN] });

      expect(p.cardText('Streaming')).toContain('Active');
      expect(p.cardText('Streaming')).toContain('Ends Dec 2026');
    });

    it('shows the name, color and notes', async () => {
      const styled = { ...STREAMING, color: '#7e22ce', notes: 'Family plan' };
      const p = await open('2026-10', { subscriptions: [styled] });

      expect(p.cardText('Streaming')).toContain('Family plan');
      // The color is a dot beside the name, for the eye only: the name says what the card is.
      const dot = p.card('Streaming').querySelector('span[appColorDot]') as HTMLElement;
      expect(dot.style.backgroundColor).toBe('rgb(126, 34, 206)');
      expect(dot.getAttribute('aria-hidden')).toBe('true');
    });

    describe('actions', () => {
      const visibleButtons = (card: HTMLElement) =>
        queryAllByRole(card, 'button')
          .filter((button) => !button.hasAttribute('appMenuItem'))
          .map((button) => button.getAttribute('aria-label') ?? textOf(button));

      it('are Edit and Change price on the card, and Cancel and Delete in its menu, Delete last', async () => {
        const p = await open();

        expect(visibleButtons(p.card('Streaming'))).toEqual([
          'Edit Streaming',
          'Change the price of Streaming',
          'More actions for Streaming',
        ]);
        expect(menuItemNames(p.card('Streaming'))).toEqual(['Cancel', 'Delete']);
        // Cancelling the subscription is named for it, so it is not taken for the Cancel of a dialog.
        expect(menuItem(p.card('Streaming'), 'Cancel Streaming').textContent).toContain('Cancel');
      });

      it('leave out what does not apply: a cancelled subscription can only be edited or deleted', async () => {
        const p = await open();

        expect(visibleButtons(p.card('Old magazine'))).toEqual([
          'Edit Old magazine',
          'More actions for Old magazine',
        ]);
        expect(menuItemNames(p.card('Old magazine'))).toEqual(['Delete']);
      });
    });
  });

  describe('the reserve of a yearly subscription', () => {
    it('is plain content of the card, not a box inside it', async () => {
      const p = await open();

      // A card holds no card, tile or tinted panel: the sentences and the bar sit on the card.
      expect(p.card('Domain').querySelector('div.rounded-control')).toBeNull();
      expect(p.card('Domain').querySelector('div.bg-subtle:not([role="progressbar"])')).toBeNull();
    });

    it('says in plain words how much is set aside for the next renewal, with a bar', async () => {
      const p = await open();
      const text = p.cardText('Domain');

      expect(text).toContain('In October 2026, €20.00 goes into the reserve.');
      expect(text).toContain(
        '€60.00 of €120.00 set aside so the March 2027 renewal is already paid.',
      );
      expect(text).toContain('Next renewal: March 2027 (€120.00)');
      const bar = getByRole(p.card('Domain'), 'progressbar', 'Domain reserve');
      expect(bar.getAttribute('aria-valuenow')).toBe('50');
      expect(bar.getAttribute('aria-valuetext')).toBe('50% of the €120.00 renewal set aside');
    });

    it('shows the amount set aside as a figure over its bar, and says it in one sentence', async () => {
      const p = await open();
      const card = p.card('Domain');

      const figure = Array.from(card.querySelectorAll<HTMLElement>('dl > div')).find(
        (stat) => textOf(stat.querySelector('dt') as Element) === 'Reserve',
      ) as HTMLElement;
      expect(figure).toBeTruthy();
      expect(textOf(figure.querySelector('dd') as Element)).toContain('€60.00');
      // The figure comes before the bar it is drawn in.
      const bar = getByRole(card, 'progressbar', 'Domain reserve');
      expect(Boolean(figure.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
        true,
      );
      // The real text of the page, not the helper's: a space the template dropped would show here.
      expect((figure.textContent ?? '').replace(/\s+/g, ' ')).toContain(
        '€60.00 of €120.00 set aside so the March 2027 renewal is already paid.',
      );
    });

    it('writes the next renewal as one readable line', async () => {
      const p = await open();

      // The real text of the page, not the helper's: a space the template dropped would show here.
      const line = Array.from(p.card('Domain').querySelectorAll('p')).find((paragraph) =>
        paragraph.textContent?.includes('Next renewal'),
      );
      expect(line?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Next renewal: March 2027 (€120.00)',
      );
    });

    it('draws the bar from the figures it is given, and shows them as given', async () => {
      const p = await open('2026-10', {
        view: monthView({
          subscriptions: [
            subscriptionLine({
              id: 2,
              name: 'Domain',
              charge: 834,
              reserveBalance: 2502,
              nextRenewalPrice: 10000,
              nextRenewalMonth: '2027-03',
            }),
          ],
        }),
      });

      expect(p.cardText('Domain')).toContain('€8.34 goes into the reserve');
      expect(p.cardText('Domain')).toContain('€25.02 of €100.00 set aside');
      expect(getByRole(p.card('Domain'), 'progressbar').getAttribute('aria-valuenow')).toBe('25');
    });

    it('uses the price the reserve is saving towards, not the price of this month', async () => {
      // A price change is scheduled before the renewal: the API says what is saved towards.
      const p = await open('2026-10', {
        view: monthView({
          subscriptions: [
            subscriptionLine({
              id: 2,
              name: 'Domain',
              price: 12000,
              nextRenewalPrice: 15000,
              reserveBalance: 7500,
            }),
          ],
        }),
      });

      expect(p.cardText('Domain')).toContain('€75.00 of €150.00 set aside');
      expect(getByRole(p.card('Domain'), 'progressbar').getAttribute('aria-valuenow')).toBe('50');
    });

    it('says the renewal is paid from the reserve in a renewal month, with no bar', async () => {
      const p = await open('2027-03', {
        view: monthView({
          month: '2027-03',
          status: 'future',
          subscriptions: [
            subscriptionLine({
              id: 2,
              name: 'Domain',
              renewalThisMonth: true,
              reserveBalance: 0,
              charge: 1000,
              nextRenewalMonth: '2027-03',
              nextRenewalPrice: 12000,
            }),
          ],
        }),
      });
      const text = p.cardText('Domain');

      expect(text).toContain(
        'It renews in March 2027. The €120.00 renewal is paid out of the reserve you set aside, so the reserve is empty afterwards.',
      );
      expect(text).toContain("This month's top-up before the renewal: €10.00.");
      expect(queryByRole(p.card('Domain'), 'progressbar')).toBeNull();
    });

    it('says what is released to savings', async () => {
      const p = await open('2026-10', {
        view: monthView({
          subscriptions: [subscriptionLine({ id: 2, name: 'Domain', reserveReleased: 2500 })],
        }),
      });

      expect(p.cardText('Domain')).toContain(
        '€25.00 of the reserve goes back to savings in October 2026.',
      );
    });

    it('says when it ends before its next renewal, so nothing more is set aside', async () => {
      const p = await open('2026-10', {
        view: monthView({
          subscriptions: [
            subscriptionLine({
              id: 2,
              name: 'Domain',
              nextRenewalMonth: null,
              nextRenewalPrice: null,
              endsThisMonth: true,
              reserveBalance: 0,
              charge: 0,
            }),
          ],
        }),
      });
      const text = p.cardText('Domain');

      expect(text).toContain(
        'It ends before its next renewal, so nothing more is set aside for it.',
      );
      expect(text).toContain('October 2026 is the last month it is charged.');
      expect(queryByRole(p.card('Domain'), 'progressbar')).toBeNull();
    });

    it('is not shown for a monthly subscription: it says what it takes from the income', async () => {
      const p = await open();

      expect(p.cardText('Streaming')).toContain(
        'In October 2026 it takes €10.00 from your income.',
      );
      expect(queryByRole(p.card('Streaming'), 'progressbar')).toBeNull();
    });

    it('is the one of the month shown: a month where it is not charged says so', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', subscriptions: [STREAMING_LINE] }),
      });

      expect(p.cardText('Domain')).toContain('Not charged in August 2026.');
      expect(p.cardText('Streaming')).toContain('In August 2026 it takes €10.00 from your income.');
    });
  });

  describe('add', () => {
    it('opens a dialog with the fields, starting today in the current month', async () => {
      const p = await open();
      await p.press('Add subscription');

      const dialog = p.dialog('Add a subscription') as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      for (const label of [
        'Name',
        'Frequency',
        'Price per month',
        'Charge date',
        'Start month',
        'Notes (optional)',
      ]) {
        expect(getByLabel(dialog, label), label).toBeTruthy();
      }
      expect(getByRole(dialog, 'group', /Color/)).toBeTruthy();
      expect(p.value('Frequency')).toBe('monthly');
      expect(p.value('Charge date')).toBe('2026-10-02');
      expect(p.value('Start month')).toBe('2026-10');
      expect(textOf(dialog)).toContain(
        'The subscription starts in October 2026. Earlier months are not affected.',
      );
      expect(document.activeElement).toBe(getByLabel(dialog, 'Name'));
    });

    it('names the price per year for a yearly subscription', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Frequency', 'yearly');

      expect(getByLabel(p.element, 'Price per year')).toBeTruthy();
    });

    it('starts in the shown month when it is not closed, and in the current month when it is', async () => {
      const future = await open('2026-12', {
        view: monthView({ month: '2026-12', status: 'future', subscriptions: [] }),
      });
      await future.press('Add subscription');
      expect(future.value('Start month')).toBe('2026-12');
      future.fixture.destroy();

      await router.navigateByUrl('/subscriptions?month=2026-08');
      const fixture = TestBed.createComponent(SubscriptionsHost);
      fixture.detectChanges();
      await settle(fixture);
      await answer(fixture, '2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', subscriptions: [] }),
      });
      const closed = page(fixture);
      await closed.press('Add subscription');
      expect(closed.value('Start month')).toBe('2026-10');
    });

    it('posts the subscription with integer cents, then reloads and confirms', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Name', '  Cloud storage ');
      await p.type('Frequency', 'yearly');
      await p.type('Price per year', '99,99');
      await p.type('Charge date', '2026-03-14');
      await p.type('Start month', '2026-11');
      await p.choose('Teal');
      await p.type('Notes (optional)', ' Shared with Anna ');

      await p.press('Add subscription', p.dialog('Add a subscription') as HTMLElement);

      const request = http.expectOne('/api/subscriptions');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'Cloud storage',
        frequency: 'yearly',
        anchorDate: '2026-03-14',
        amount: 9999,
        startMonth: '2026-11',
        color: '#0e7490',
        notes: 'Shared with Anna',
      });
      expect(subscriptionCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(subscriptionDto({ id: 9, name: 'Cloud storage' }), {
        status: 201,
        statusText: 'Created',
      });
      await p.reload();

      expect(p.toasts()).toEqual(['Cloud storage added.']);
      expect(p.dialog()?.closest('app-subscription-form')).toBeNull();
    });

    it('sends only what was filled in', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Name', 'Streaming 2');
      await p.type('Price per month', '12');
      await p.press('Add subscription', p.dialog('Add a subscription') as HTMLElement);

      const request = http.expectOne('/api/subscriptions');
      expect(request.request.body).toEqual({
        name: 'Streaming 2',
        frequency: 'monthly',
        anchorDate: '2026-10-02',
        amount: 1200,
        startMonth: '2026-10',
      });
      request.flush(subscriptionDto({ id: 9 }), { status: 201, statusText: 'Created' });
      await p.reload();
    });

    it('needs a name, a price above zero and a charge date, and sends nothing otherwise', async () => {
      const p = await open();
      await p.press('Add subscription');
      const dialog = p.dialog('Add a subscription') as HTMLElement;
      await p.press('Add subscription', dialog);

      expect(fieldError(getByLabel(dialog, 'Name'))).toBe('Name is required.');
      expect(fieldError(getByLabel(dialog, 'Price per month'))).toBe(
        'Price per month is required.',
      );
      expect(document.activeElement).toBe(getByLabel(dialog, 'Name'));

      await p.type('Name', 'Streaming 2');
      await p.type('Price per month', '0');
      await p.type('Charge date', '');
      await p.press('Add subscription', dialog);
      expect(fieldError(getByLabel(dialog, 'Price per month'))).toBe(
        'Enter an amount greater than zero.',
      );
      expect(fieldError(getByLabel(dialog, 'Charge date'))).toBe('Charge date is required.');
      noRequest(/\/api\/subscriptions$/);
    });

    it('warns that a start in a closed month changes that month', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Start month', '2026-08');

      expect(textOf(p.dialog('Add a subscription') as HTMLElement)).toContain(
        'Backdating: August 2026 is already closed. A subscription that starts then also changes that month',
      );
    });

    it('shows what the API says on the field it names, and keeps what was typed', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Name', 'Streaming 2');
      await p.type('Price per month', '12');
      await p.press('Add subscription', p.dialog('Add a subscription') as HTMLElement);
      flushError(
        http.expectOne('/api/subscriptions'),
        422,
        'rule_violation',
        'A subscription cannot start in 2026-10, before the start month 2026-11',
        { rule: 'before_start_month', field: 'startMonth' },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(p.element, 'Start month'))).toBe(
        'A subscription cannot start in 2026-10, before the start month 2026-11',
      );
      expect(p.value('Name')).toBe('Streaming 2');
      expect(p.dialog('Add a subscription')).not.toBeNull();
      expect(p.toasts()).toEqual([]);
    });

    it('shows an error that belongs to no field in an alert inside the dialog', async () => {
      const p = await open();
      await p.press('Add subscription');
      await p.type('Name', 'Streaming 2');
      await p.type('Price per month', '12');
      await p.press('Add subscription', p.dialog('Add a subscription') as HTMLElement);
      flushError(http.expectOne('/api/subscriptions'), 500, 'internal_error', 'Something broke');
      await settle(p.fixture);

      expect(textOf(getByRole(p.dialog('Add a subscription') as HTMLElement, 'alert'))).toBe(
        'Something broke',
      );
    });

    it('cancels without a request and gives focus back to the button that opened it', async () => {
      const p = await open();
      const opener = getByRole(
        p.element.querySelector('header') as HTMLElement,
        'button',
        'Add subscription',
      );
      opener.focus();
      opener.click();
      await settle(p.fixture);
      await p.press('Cancel', p.dialog('Add a subscription') as HTMLElement);

      expect(p.dialog('Add a subscription')).toBeNull();
      expect(document.activeElement).toBe(opener);
      noRequest(/\/api\/subscriptions$/);
    });
  });

  describe('edit', () => {
    it('opens with the subscription filled in, and says the frequency and price are elsewhere', async () => {
      const p = await open();
      await p.press('Edit Domain');

      const dialog = p.dialog('Edit Domain') as HTMLElement;
      expect(p.value('Name')).toBe('Domain');
      expect(p.value('Charge date')).toBe('2025-03-14');
      expect(textOf(dialog)).toContain("Yearly subscription. The frequency can't be changed");
      expect(textOf(dialog)).toContain('To change what it costs, use Change price.');
      expect(queryByRole(dialog, 'combobox', 'Frequency')).toBeNull();
      expect(() => getByLabel(dialog, /Price per/)).toThrow();
      expect(() => getByLabel(dialog, 'Start month')).toThrow();
    });

    it('sends only what changed, with PATCH', async () => {
      const p = await open();
      await p.press('Edit Streaming');
      await p.type('Name', 'Video streaming');
      await p.type('Charge date', '2026-06-20');
      await p.choose('Pink');
      await p.type('Notes (optional)', 'Family plan');

      await p.press('Save changes');

      const request = http.expectOne('/api/subscriptions/1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({
        name: 'Video streaming',
        anchorDate: '2026-06-20',
        color: '#be185d',
        notes: 'Family plan',
      });
      expect(subscriptionUpdateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...STREAMING, name: 'Video streaming' });
      await p.reload();

      expect(p.toasts()).toEqual(['Video streaming updated.']);
    });

    it('clears the color and the notes with null', async () => {
      const styled = { ...STREAMING, color: '#7e22ce', notes: 'Family plan' };
      const p = await open('2026-10', { subscriptions: [styled] });
      await p.press('Edit Streaming');
      await p.choose('None');
      await p.type('Notes (optional)', '');
      await p.press('Save changes');

      const request = http.expectOne('/api/subscriptions/1');
      expect(request.request.body).toEqual({ color: null, notes: null });
      request.flush(STREAMING);
      await p.reload({ subscriptions: [STREAMING] });
    });

    it('closes without a request when nothing changed', async () => {
      const p = await open();
      await p.press('Edit Streaming');
      await p.press('Save changes');

      expect(p.dialog('Edit Streaming')).toBeNull();
      noRequest(/\/api\/subscriptions\/1/);
    });

    it('shows what the API says on the field it names', async () => {
      const p = await open();
      await p.press('Edit Streaming');
      await p.type('Name', 'Taken');
      await p.press('Save changes');
      flushError(
        http.expectOne('/api/subscriptions/1'),
        400,
        'validation_error',
        'Invalid request',
        [{ path: 'name', message: 'Name is already used' }],
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(p.element, 'Name'))).toBe('Name is already used');
    });
  });

  describe('change price', () => {
    it('opens a dialog that says what it costs now, and starts in the current month', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');

      const dialog = p.dialog('Change the price of Streaming') as HTMLElement;
      expect(textOf(dialog)).toContain('It costs €10.00 a month now.');
      expect(p.value('Applies from')).toBe('2026-10');
      expect(textOf(dialog)).toContain(
        'The new price applies from October 2026 on. Earlier months keep their prices.',
      );
      expect(document.activeElement).toBe(getByLabel(dialog, 'New price per month'));
    });

    it('defaults to the current month, not to the month the page shows', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', subscriptions: [STREAMING_LINE] }),
      });
      await p.press('Change the price of Streaming');

      expect(p.value('Applies from')).toBe('2026-10');
    });

    it('puts the new price on the current month with PUT, then reloads', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');
      await p.type('New price per month', '12,99');

      await p.press('Save price');

      const request = http.expectOne('/api/subscriptions/1/prices/2026-10');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ amount: 1299 });
      expect(subscriptionPriceSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(STREAMING);
      await p.reload();

      expect(p.toasts()).toEqual(['Streaming costs the new price from October 2026 on.']);
      expect(p.dialog('Change the price of Streaming')).toBeNull();
    });

    it('names the price per year for a yearly subscription', async () => {
      const p = await open();
      await p.press('Change the price of Domain');

      expect(textOf(p.dialog('Change the price of Domain') as HTMLElement)).toContain(
        'It costs €120.00 a year now.',
      );
      expect(getByLabel(p.element, 'New price per year')).toBeTruthy();
    });

    it('can schedule a later month, and says so', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');
      await p.type('Applies from', '2027-01');
      await p.type('New price per month', '15');

      expect(textOf(p.dialog('Change the price of Streaming') as HTMLElement)).toContain(
        'Scheduled: the new price applies from January 2027 on. October 2026 and earlier months keep their prices.',
      );
      await p.press('Save price');
      const request = http.expectOne('/api/subscriptions/1/prices/2027-01');
      expect(request.request.body).toEqual({ amount: 1500 });
      request.flush(STREAMING);
      await p.reload();
    });

    it('treats backdating as an explicit choice with a visible warning', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');
      const dialog = p.dialog('Change the price of Streaming') as HTMLElement;
      expect(textOf(dialog)).not.toContain('Backdating');

      await p.type('Applies from', '2026-08');
      expect(textOf(dialog)).toContain(
        "Backdating: August 2026 is already closed. Changing its price also changes that month's figures and what is due to savings.",
      );
      await p.type('New price per month', '15');
      await p.press('Save price');

      const request = http.expectOne('/api/subscriptions/1/prices/2026-08');
      expect(request.request.body).toEqual({ amount: 1500 });
      request.flush(STREAMING);
      await p.reload();
    });

    it('only offers the months the subscription exists in, and starts at the first for one that has not started', async () => {
      const p = await open();
      await p.press('Change the price of Gym');

      const input = getByLabel(p.element, 'Applies from');
      expect((input as HTMLInputElement).value).toBe('2027-01');
      expect(input.getAttribute('min')).toBe('2027-01');
      expect(textOf(p.dialog('Change the price of Gym') as HTMLElement)).toContain(
        'It costs €30.00 a month now.',
      );
    });

    it('does not offer a price change for a cancelled subscription', async () => {
      const p = await open();
      expect(queryByRole(p.card('Old magazine'), 'button', /Change the price/)).toBeNull();
    });

    it('needs a price above zero', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');
      await p.type('New price per month', '0');
      await p.press('Save price');

      expect(fieldError(getByLabel(p.element, 'New price per month'))).toBe(
        'Enter an amount greater than zero.',
      );
      noRequest(/\/prices\//);
    });

    it('shows what the API says on the month field', async () => {
      const p = await open();
      await p.press('Change the price of Streaming');
      await p.type('Applies from', '2026-07');
      await p.type('New price per month', '15');
      await p.press('Save price');
      flushError(
        http.expectOne('/api/subscriptions/1/prices/2026-07'),
        422,
        'rule_violation',
        "2026-07 is outside the subscription's active months (2026-08 to no end)",
        { rule: 'outside_active_months', field: 'month' },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(p.element, 'Applies from'))).toBe(
        "2026-07 is outside the subscription's active months (2026-08 to no end)",
      );
      expect(p.dialog('Change the price of Streaming')).not.toBeNull();
    });
  });

  describe('cancel', () => {
    it('asks first, saying it is charged through its last month', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Cancel Streaming');

      const text = textOf(p.confirmDialog());
      expect(text).toContain('Cancel "Streaming"?');
      expect(text).toContain(
        'It is still charged through October 2026, its last month, and not after.',
      );
      expect(text).not.toContain('set aside');
      await p.press('Keep subscription', p.confirmDialog());
      noRequest(/\/api\/subscriptions\/1/);
    });

    it('mentions the reserve of a yearly one going back to savings', async () => {
      const p = await open();
      await p.menuAction('More actions for Domain', 'Cancel Domain');

      expect(textOf(p.confirmDialog())).toContain(
        'Whatever you have set aside for its next renewal goes back to savings.',
      );
    });

    it('posts the cancellation once confirmed, with no end month: the server uses the current one', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Cancel Streaming');
      await p.press('Cancel subscription', p.confirmDialog());

      const request = http.expectOne('/api/subscriptions/1/cancel');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({});
      expect(subscriptionCancelSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({ ...STREAMING, endMonth: '2026-10' });
      await p.reload({
        view: monthView({
          subscriptions: [DOMAIN_LINE, { ...STREAMING_LINE, endsThisMonth: true }],
        }),
        subscriptions: [DOMAIN, GYM, MAGAZINE, { ...STREAMING, endMonth: '2026-10' }],
      });

      expect(p.toasts()).toEqual(['Streaming cancelled. It is charged through October 2026.']);
      expect(p.cardText('Streaming')).toContain('Ends Oct 2026');
      expect(p.cardText('Streaming')).toContain('October 2026 is the last month it is charged.');
      // It cannot be cancelled twice, and focus stayed on the card's menu button: the item that was
      // pressed is hidden.
      expect(menuItemNames(p.card('Streaming'))).not.toContain('Cancel');
      expect(document.activeElement).toBe(
        getByRole(p.card('Streaming'), 'button', 'More actions for Streaming'),
      );
    });

    it('is only offered for an active subscription that is not ending already', async () => {
      const ending = { ...STREAMING, endMonth: '2026-12' };
      const p = await open('2026-10', { subscriptions: [ending, DOMAIN, GYM, MAGAZINE] });

      expect(menuItemNames(p.card('Streaming'))).not.toContain('Cancel');
      expect(menuItemNames(p.card('Domain'))).toContain('Cancel');
      expect(menuItemNames(p.card('Gym'))).not.toContain('Cancel');
      expect(menuItemNames(p.card('Old magazine'))).not.toContain('Cancel');
    });

    it('reports a refusal with the message of the API', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Cancel Streaming');
      await p.press('Cancel subscription', p.confirmDialog());
      flushError(
        http.expectOne('/api/subscriptions/1/cancel'),
        422,
        'rule_violation',
        "The end month 2026-10 is before the subscription's start month 2026-11",
        { rule: 'end_before_start', field: 'endMonth' },
      );
      await p.reload();

      expect(p.toasts()).toEqual([
        "The end month 2026-10 is before the subscription's start month 2026-11",
      ]);
    });
  });

  describe('delete', () => {
    it('asks with a strong warning: it disappears from every month, closed ones too', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Delete');

      const text = textOf(p.confirmDialog());
      expect(text).toContain('Delete "Streaming" for good?');
      expect(text).toContain(
        'removes it from every month, including months that are already closed',
      );
      expect(text).toContain('cancel it instead');
      // The button names what it does, and the dialog is the danger kind.
      expect(getByRole(p.confirmDialog(), 'button', 'Delete from every month').className).toContain(
        'bg-negative',
      );
      await p.press('Keep subscription', p.confirmDialog());
      noRequest(/\/api\/subscriptions\/1/);
    });

    it('is offered for every subscription, whatever its status', async () => {
      const p = await open();

      for (const name of ['Streaming', 'Domain', 'Gym', 'Old magazine']) {
        expect(menuItemNames(p.card(name)), name).toContain('Delete');
      }
    });

    it('deletes once confirmed, then reloads and puts focus on the page title', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Delete');
      await p.press('Delete from every month', p.confirmDialog());

      const request = http.expectOne('/api/subscriptions/1');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({
        view: monthView({ subscriptions: [DOMAIN_LINE] }),
        subscriptions: [DOMAIN, GYM, MAGAZINE],
      });

      expect(p.toasts()).toEqual(['Streaming deleted.']);
      expect(queryByRole(p.element, 'article', 'Streaming')).toBeNull();
      expect(document.activeElement).toBe(getByRole(p.element, 'heading', 'Subscriptions'));
    });

    it('reports a failure with the message of the API', async () => {
      const p = await open();
      await p.menuAction('More actions for Streaming', 'Delete');
      await p.press('Delete from every month', p.confirmDialog());
      flushError(
        http.expectOne('/api/subscriptions/1'),
        404,
        'not_found',
        'Subscription not found',
      );
      await p.reload();

      expect(p.toasts()).toEqual(['Subscription not found']);
    });
  });
});
