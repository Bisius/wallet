import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { UpcomingRenewalDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { upcomingRenewal } from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import { UpcomingRenewalsSection } from './upcoming-renewals-section';

const URL = '/api/subscriptions/upcoming?days=30';

const STREAMING = upcomingRenewal({ id: 1, name: 'Streaming', date: '2026-10-07', daysUntil: 5 });
const DOMAIN = upcomingRenewal({
  id: 2,
  name: 'Domain',
  color: '#2563eb',
  frequency: 'yearly',
  yearly: true,
  date: '2026-10-20',
  daysUntil: 18,
  amount: 12000,
  reserved: 9000,
  unreserved: 3000,
});

describe('UpcomingRenewalsSection', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'subscriptions', component: StubPage },
          { path: 'dashboard', component: StubPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function create(options: { today?: 'error' } = {}) {
    await primeStores(http, options);
    const fixture = TestBed.createComponent(UpcomingRenewalsSection);
    fixture.detectChanges();
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, element, region: () => getByRole(element, 'region', 'Upcoming renewals') };
  }

  async function open(renewals: UpcomingRenewalDto[]) {
    const p = await create();
    http.expectOne(URL).flush(renewals);
    await settle(p.fixture);
    return p;
  }

  it('asks for the next 30 days once today is known, and not before', async () => {
    await primeStores(http, { today: 'error' });
    const fixture = TestBed.createComponent(UpcomingRenewalsSection);
    fixture.detectChanges();
    await settle(fixture);

    // `http.verify()` fails the test if a request went out without today.
    expect(textOf(fixture.nativeElement as HTMLElement)).toContain(
      'Loading the upcoming renewals…',
    );
  });

  it('says it is loading while the request is out', async () => {
    const p = await create();

    expect(textOf(p.region())).toContain('Loading the upcoming renewals…');

    http.expectOne(URL).flush([]);
  });

  it('lists the renewals as the API ordered them, with when, what and how much', async () => {
    const p = await open([STREAMING, DOMAIN]);

    const rows = queryAllByRole(p.region(), 'listitem');
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'Streaming',
      'Domain',
    ]);
    expect(textOf(rows[0])).toBe('Streaming In 5 days Wed, Oct 7 €9.99 a month');
  });

  it.each([
    [0, 'Today'],
    [1, 'Tomorrow'],
    [12, 'In 12 days'],
  ])('words %i days until a renewal as "%s"', async (daysUntil, words) => {
    const p = await open([{ ...STREAMING, daysUntil }]);

    expect(textOf(p.region())).toContain(words);
  });

  it('highlights a yearly renewal and shows what is reserved and what is still missing', async () => {
    const p = await open([STREAMING, DOMAIN]);
    const [monthly, yearly] = queryAllByRole(p.region(), 'listitem');

    expect(textOf(yearly)).toContain('Yearly renewal');
    expect(textOf(yearly)).toContain('€120.00 a year');
    expect(textOf(yearly)).toContain('€90.00 of €120.00 reserved.');
    expect(textOf(yearly)).toContain('Still to set aside: €30.00.');
    const bar = getByRole(yearly, 'progressbar', 'Domain reserve');
    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    expect(bar.getAttribute('aria-valuetext')).toBe('75% reserved');
    // The highlight is a ring and a label, and a monthly renewal has neither nor a reserve.
    expect(yearly.classList.contains('ring-2')).toBe(true);
    expect(textOf(monthly)).not.toContain('Yearly renewal');
    expect(monthly.classList.contains('ring-2')).toBe(false);
    expect(queryByRole(monthly, 'progressbar')).toBeNull();
  });

  it('shows the API amounts as they are, never working out the reserve itself', async () => {
    // These do not add up on purpose.
    const p = await open([{ ...DOMAIN, amount: 10000, reserved: 1234, unreserved: 5678 }]);

    expect(textOf(p.region())).toContain('€12.34 of €100.00 reserved.');
    expect(textOf(p.region())).toContain('Still to set aside: €56.78.');
  });

  it('says a yearly renewal is fully reserved when nothing is missing', async () => {
    const p = await open([{ ...DOMAIN, reserved: 12000, unreserved: 0 }]);

    expect(textOf(p.region())).toContain('€120.00 of €120.00 reserved. Fully reserved.');
    expect(getByRole(p.region(), 'progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('colors the row with the subscription color', async () => {
    const p = await open([DOMAIN]);

    const row = queryAllByRole(p.region(), 'listitem')[0];
    expect(row.style.borderLeftColor).not.toBe('');
  });

  it('links to the subscriptions, keeping the selected month in the link', async () => {
    const p = await open([STREAMING]);

    expect(getByRole(p.region(), 'link', /Open subscriptions/).getAttribute('href')).toBe(
      '/subscriptions',
    );
  });

  it('says when nothing renews, and offers the subscriptions', async () => {
    const p = await open([]);

    expect(textOf(p.region())).toContain('Nothing renews in the next 30 days');
    expect(queryAllByRole(p.region(), 'listitem')).toEqual([]);
    expect(getByRole(p.region(), 'link', 'Go to subscriptions').getAttribute('href')).toBe(
      '/subscriptions',
    );
  });

  it('shows what the API said when it fails, announced, and tries again', async () => {
    const p = await create();
    flushError(http.expectOne(URL), 500, 'internal_error', 'The ledger is down');
    await settle(p.fixture);

    expect(textOf(getByRole(p.region(), 'alert'))).toContain("Couldn't load the upcoming renewals");
    expect(textOf(p.region())).toContain('The ledger is down');

    getByRole(p.region(), 'button', 'Try again').click();
    await settle(p.fixture);
    http.expectOne(URL).flush([STREAMING]);
    await settle(p.fixture);

    expect(textOf(p.region())).toContain('Streaming');
    expect(queryByRole(p.region(), 'alert')).toBeNull();
  });

  it('has nothing wrong with its markup', async () => {
    const p = await open([STREAMING, DOMAIN]);

    expect(a11yProblems(p.element)).toEqual([]);
  });
});
