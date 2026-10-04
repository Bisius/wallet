import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { YearlyReportDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { reportMonth, yearlyReport } from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import { SelectedYear } from './selected-year';
import { YearlyReportPage } from './yearly-report-page';

const URL_2026 = '/api/reports/yearly/2026';

/** Figures that tell the sections apart, and do not add up on purpose: the page must not compute. */
const REPORT: YearlyReportDto = yearlyReport({
  income: { salary: 3000000, extra: 150000, total: 3150000 },
  allocated: 2800000,
  spent: 1234500,
  saved: 987600,
  savedBreakdown: { unallocated: 900000, budgetsSettled: 100000, reservesReleased: -12400 },
  fixedCosts: {
    total: 240000,
    paid: 180000,
    subscriptions: [
      {
        id: 1,
        name: 'Streaming',
        color: '#2563eb',
        frequency: 'monthly',
        cost: 70000,
        paid: 70000,
      },
      { id: 2, name: 'Domain', color: null, frequency: 'yearly', cost: 12000, paid: 0 },
    ],
  },
  budgets: [
    { id: 1, name: 'Groceries', color: null, icon: '🛒', allocated: 280000, spent: 250000 },
    { id: 2, name: 'Fun', color: null, icon: null, allocated: 70000, spent: 91000 },
  ],
});

describe('YearlyReportPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'report', component: StubPage },
          { path: 'dashboard', component: StubPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  /** Creates the page at an address and returns before the report is answered. */
  async function create(query = '', options: Parameters<typeof primeStores>[1] = {}) {
    await primeStores(http, options);
    await router.navigateByUrl(`/report${query}`);
    const fixture = TestBed.createComponent(YearlyReportPage);
    fixture.detectChanges();
    await settle(fixture);
    return page(fixture);
  }

  async function open(report: YearlyReportDto = REPORT, query = '') {
    const p = await create(query);
    http.expectOne(`/api/reports/yearly/${report.year}`).flush(report);
    await settle(p.fixture);
    return p;
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<YearlyReportPage>>) {
    const element = fixture.nativeElement as HTMLElement;
    const region = (name: string | RegExp) => getByRole(element, 'region', name);
    return {
      fixture,
      element,
      text: () => textOf(element),
      glance: () => region(/at a glance/),
      income: () => region('Income'),
      saved: () => region('Saved, due to savings'),
      fixed: () => region('Fixed costs'),
      budgets: () => region('Spent per budget'),
      months: () => region('Month by month'),
      /** The page's own table of the months (the chart has its own, for assistive technology). */
      monthTable: () => getByRole(region('Month by month'), 'region', 'Figures per month'),
    };
  }

  describe('the page', () => {
    it('is titled and has one heading per section, in the order the user reads them', async () => {
      const p = await open();

      expect(textOf(getByRole(p.element, 'heading', 'Yearly report'))).toBe('Yearly report');
      expect(
        Array.from(p.element.querySelectorAll('h2')).map((heading) => textOf(heading)),
      ).toEqual([
        '2026 at a glance',
        'Income',
        'Saved, due to savings',
        'Fixed costs',
        'Spent per budget',
        'Month by month',
      ]);
    });

    it('opens the current year, as the server says, and asks for nothing else', async () => {
      // `http.verify()` fails the test on any other request.
      const p = await open();

      expect(p.text()).toContain('2026 at a glance');
    });

    it('has no year switcher of its own: it is in the top bar of the shell', async () => {
      const p = await open();

      expect(queryByRole(p.element, 'group', 'Year')).toBeNull();
      expect(p.element.querySelector('app-year-switcher')).toBeNull();
    });

    it('does not ask for a report before today is known, and says why when it cannot be known', async () => {
      await primeStores(http, { today: 'error' });
      const fixture = TestBed.createComponent(YearlyReportPage);
      fixture.detectChanges();
      await settle(fixture);
      const p = page(fixture);

      expect(textOf(getByRole(p.element, 'alert'))).toContain("Couldn't load today's date");
    });

    it('has nothing wrong with its markup', async () => {
      const p = await open();

      expect(a11yProblems(p.element)).toEqual([]);
    });

    it('does not animate anything', async () => {
      const p = await open();

      const classes = Array.from(p.element.querySelectorAll('[class]')).flatMap((node) =>
        (node.getAttribute('class') ?? '').split(/\s+/),
      );
      expect(
        classes.filter((name) => /^(transition|animate|duration|delay|ease)/.test(name)),
      ).toEqual([]);
    });
  });

  describe('the year in the URL', () => {
    it('opens the year the URL names', async () => {
      const p = await open(yearlyReport({ year: 2027 }), '?year=2027');

      expect(p.text()).toContain('2027 at a glance');
    });

    it('falls back to the current year for something that is not a year', async () => {
      const p = await open(REPORT, '?year=abc');

      expect(p.text()).toContain('2026 at a glance');
    });

    it('follows the address when the year is changed (the switcher of the shell does that)', async () => {
      const p = await open();

      await TestBed.inject(SelectedYear).select(2027);
      await settle(p.fixture);
      expect(router.url).toBe('/report?year=2027');
      http.expectOne('/api/reports/yearly/2027').flush(yearlyReport({ year: 2027 }));
      await settle(p.fixture);
      expect(p.text()).toContain('2027 at a glance');

      await TestBed.inject(SelectedYear).select(2026);
      await settle(p.fixture);
      // The current year is the default: it needs no parameter.
      expect(router.url).toBe('/report');
      http.expectOne(URL_2026).flush(REPORT);
      await settle(p.fixture);
      expect(p.text()).toContain('2026 at a glance');
    });
  });

  describe('at a glance', () => {
    it('shows income, fixed costs, budgeted, spent and saved exactly as the API reports them', async () => {
      const p = await open();

      const text = textOf(p.glance());
      expect(text).toContain('Income €31,500.00');
      expect(text).toContain('Fixed costs €2,400.00');
      expect(text).toContain('Budgeted €28,000.00');
      expect(text).toContain('Spent €12,345.00');
      expect(text).toContain('Saved +€9,876.00 Due to savings');
    });

    it('is a flat strip on the page, with income, spent and saved large and the other two medium', async () => {
      const p = await open();

      // No card around it, and no tile inside a card.
      expect(p.glance().closest('.card')).toBeNull();
      expect(p.glance().querySelector('.card')).toBeNull();
      const sizeOf = (label: string) => {
        const term = Array.from(p.glance().querySelectorAll('dt')).find(
          (dt) => textOf(dt) === label,
        ) as Element;
        return Array.from((term.parentElement as Element).querySelectorAll('dd')).some((dd) =>
          dd.classList.contains('text-kpi'),
        )
          ? 'large'
          : 'medium';
      };
      expect(['Income', 'Spent', 'Saved'].map(sizeOf)).toEqual(['large', 'large', 'large']);
      expect(['Fixed costs', 'Budgeted'].map(sizeOf)).toEqual(['medium', 'medium']);
    });

    it('splits the income into salary, extra income and the total', async () => {
      const p = await open();

      const income = p.income();
      expect(textOf(income)).toContain('Salary €30,000.00');
      expect(textOf(income)).toContain('Extra income €1,500.00');
      expect(textOf(income)).toContain('Total income €31,500.00');
    });

    it('explains saved as due to savings, and shows what it is made of', async () => {
      const p = await open();

      const saved = p.saved();
      const text = textOf(saved);
      expect(text).toContain('whether or not you have settled it yet');
      expect(text).toContain('Left unallocated +€9,000.00');
      expect(text).toContain('Budgets settled to savings +€1,000.00');
      // A negative part keeps its sign, and is not an error.
      expect(text).toContain('Subscription reserves released -€124.00');
      expect(text).toContain('Saved in 2026 +€9,876.00');
      expect(saved.querySelector('.text-negative')).toBeNull();
    });

    it('says how many months are projections, when there are any', async () => {
      const p = await open();

      // November and December.
      expect(textOf(p.glance())).toContain('The totals include 2 projected months');
    });

    it('says nothing about projections for a year that is over', async () => {
      const closed = yearlyReport({
        year: 2026,
        months: [reportMonth({ month: '2026-06' }), reportMonth({ month: '2026-07' })],
      });
      const p = await open(closed);

      expect(textOf(p.glance())).not.toContain('projected');
    });

    it('says "1 projected month" in the singular', async () => {
      const p = await open(
        yearlyReport({
          months: [
            reportMonth({ month: '2026-10', status: 'current' }),
            reportMonth({ month: '2026-11', status: 'future' }),
          ],
        }),
      );

      expect(textOf(p.glance())).toContain('include 1 projected month.');
    });
  });

  describe('fixed costs', () => {
    it('has one line per subscription with what was set aside and what was paid, and the totals', async () => {
      const p = await open();

      const rows = Array.from(p.fixed().querySelectorAll('tbody tr')).map((row) => textOf(row));
      expect(rows).toEqual(['Streaming Monthly €700.00 €700.00', 'Domain Yearly €120.00 €0.00']);
      expect(textOf(p.fixed().querySelector('tfoot') as Element)).toBe('Total €2,400.00 €1,800.00');
    });

    it('marks the colour of a subscription with a dot beside its name, not a stripe', async () => {
      const p = await open();

      const dots = Array.from(
        p.fixed().querySelectorAll<HTMLElement>('tbody th span.rounded-full'),
      );
      expect(dots).toHaveLength(2);
      expect(dots[0].style.backgroundColor).toBe('rgb(37, 99, 235)');
      expect(dots.every((dot) => dot.getAttribute('aria-hidden') === 'true')).toBe(true);
      expect(p.fixed().querySelector('[class*="border-l-"]')).toBeNull();
    });

    it('is a table with headers, in a scrollable region a keyboard can reach', async () => {
      const p = await open();

      expect(queryAllByRole(p.fixed(), 'columnheader').map((cell) => textOf(cell))).toEqual([
        'Subscription',
        'Set aside',
        'Paid',
      ]);
      const scroller = getByRole(p.fixed(), 'region', 'Fixed costs per subscription');
      expect(scroller.getAttribute('tabindex')).toBe('0');
      expect(textOf(p.fixed())).toContain('a yearly subscription is set aside month by month');
    });

    it('says when there are no subscriptions', async () => {
      const p = await open(yearlyReport());

      expect(textOf(p.fixed())).toContain('No subscriptions in 2026');
      expect(p.fixed().querySelector('table')).toBeNull();
    });
  });

  describe('spent per budget', () => {
    it('shows what each budget spent against what it was allocated, with the totals', async () => {
      const p = await open();

      const text = textOf(p.budgets());
      expect(text).toContain('Groceries');
      expect(text).toContain('€2,500.00');
      expect(text).toContain('€2,800.00');
      expect(text).toContain('Fun');
      expect(text).toContain('€910.00');
      expect(text).toContain('Total allocated €28,000.00');
      expect(text).toContain('Total spent €12,345.00');
      expect(getByRole(p.budgets(), 'figure', 'Spent per budget, 2026')).toBeTruthy();
    });

    it('says when there are no budgets', async () => {
      const p = await open(yearlyReport());

      expect(textOf(p.budgets())).toContain('No budgets in 2026');
      expect(queryByRole(p.budgets(), 'figure')).toBeNull();
    });
  });

  describe('month by month', () => {
    const MIXED = yearlyReport({
      months: [
        reportMonth({ month: '2026-08', status: 'closed', saved: 5000 }),
        reportMonth({ month: '2026-09', status: 'closed', saved: -8500 }),
        reportMonth({ month: '2026-10', status: 'current', saved: 100 }),
        reportMonth({ month: '2026-11', status: 'future', saved: 200 }),
      ],
    });

    it('has a row per month with its figures, and the total of the year as the API gave it', async () => {
      const p = await open(MIXED);

      const rows = Array.from(p.monthTable().querySelectorAll('tbody tr')).map((row) =>
        textOf(row),
      );
      expect(rows[0]).toBe('August 2026 €2,700.00 €200.00 €400.00 €100.00 +€50.00');
      expect(rows).toHaveLength(4);
      expect(textOf(p.monthTable().querySelector('tfoot') as Element)).toBe(
        `Total 2026 ${'€10,800.00 €800.00 €1,600.00 €400.00'} -€32.00`,
      );
    });

    it('marks the current month and the projections in words', async () => {
      const p = await open(MIXED);

      const rows = Array.from(p.monthTable().querySelectorAll('tbody tr')).map((row) =>
        textOf(row),
      );
      expect(rows[0]).not.toContain('Closed month');
      expect(rows[2]).toContain('October 2026 Current month');
      expect(rows[3]).toContain('November 2026 Projection');
    });

    it('shows a month that takes money from savings with its minus sign, not as an error', async () => {
      const p = await open(MIXED);

      const row = p.monthTable().querySelectorAll('tbody tr')[1];
      expect(textOf(row)).toContain('-€85.00');
      expect(row.querySelector('.text-negative')).toBeNull();
    });

    it('draws the shared chart of income, spent and saved with every month as a stop', async () => {
      const p = await open(MIXED);

      const chart = getByRole(p.months(), 'figure', 'Income, spent and saved per month, 2026');
      expect(textOf(chart)).toContain('Income');
      expect(textOf(chart)).toContain('Spent');
      expect(textOf(chart)).toContain('Saved');
      expect(chart.querySelectorAll('[role="img"], [tabindex]').length).toBeGreaterThanOrEqual(4);
      // The text alternative says which months are projections.
      expect(textOf(chart)).toContain('Projection');
    });

    it('explains projections and saved in words', async () => {
      const p = await open(MIXED);

      expect(textOf(p.months())).toContain('A month marked Projection has not started');
      expect(textOf(p.months())).toContain('due to savings');
    });

    it('is a table with headers in a scrollable region a keyboard can reach', async () => {
      const p = await open(MIXED);

      expect(queryAllByRole(p.monthTable(), 'columnheader').map((cell) => textOf(cell))).toEqual([
        'Month',
        'Income',
        'Fixed costs',
        'Budgeted',
        'Spent',
        'Saved',
      ]);
      expect(getByRole(p.months(), 'region', 'Figures per month').getAttribute('tabindex')).toBe(
        '0',
      );
    });
  });

  describe('loading, errors and years with no months', () => {
    it('says it is loading while the report is out', async () => {
      const p = await create();

      expect(textOf(getByRole(p.element, 'status'))).toContain('Loading the report for 2026…');

      http.expectOne(URL_2026).flush(REPORT);
    });

    it('shows what the API said when the report cannot be loaded, announced, and tries again', async () => {
      const p = await create();
      flushError(http.expectOne(URL_2026), 500, 'internal_error', 'The ledger is down');
      await settle(p.fixture);

      const alert = getByRole(p.element, 'alert');
      expect(textOf(alert)).toContain("Couldn't load the report for 2026");
      expect(textOf(alert)).toContain('The ledger is down');

      getByRole(p.element, 'button', 'Try again').click();
      await settle(p.fixture);
      http.expectOne(URL_2026).flush(REPORT);
      await settle(p.fixture);

      expect(p.text()).toContain('2026 at a glance');
      expect(queryByRole(p.element, 'alert')).toBeNull();
    });

    it('words the 404 of a year before the start month as an empty state, not an error', async () => {
      const p = await create('?year=2025');
      flushError(
        http.expectOne('/api/reports/yearly/2025'),
        404,
        'not_found',
        'No month of 2025 is tracked',
      );
      await settle(p.fixture);

      expect(queryByRole(p.element, 'alert')).toBeNull();
      expect(p.text()).toContain('No months to report in 2025');
      expect(p.text()).toContain(
        'Wallet tracks months from June 2026 on, so there is nothing to report for 2025.',
      );
      expect(getByRole(p.element, 'link', 'Go to 2026').getAttribute('href')).toBe(
        '/report?year=2026',
      );
    });

    it('words the 404 of a year beyond the horizon as an empty state too', async () => {
      const p = await create('?year=2040');
      flushError(http.expectOne('/api/reports/yearly/2040'), 404, 'not_found', 'Nothing');
      await settle(p.fixture);

      expect(p.text()).toContain('No months to report in 2040');
      expect(p.text()).toContain('further ahead than Wallet plans');
    });

    it('moves on from the empty state when the year changes', async () => {
      const p = await create('?year=2025');
      flushError(http.expectOne('/api/reports/yearly/2025'), 404, 'not_found', 'Nothing');
      await settle(p.fixture);

      await TestBed.inject(SelectedYear).select(2026);
      await settle(p.fixture);
      http.expectOne(URL_2026).flush(REPORT);
      await settle(p.fixture);

      expect(p.text()).toContain('2026 at a glance');
      expect(p.text()).not.toContain('No months to report');
    });
  });
});
