import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { MonthSummary, MonthView, SavingsDto, SettingsDto } from '@wallet/shared';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import {
  budgetLine,
  monthSummaries,
  monthView,
  outstandingMonth,
  savingsDto,
} from '../../../testing/fixtures';
import { flushError, primeStores, SETTINGS, settle, StubPage } from '../../../testing/harness';
import { DashboardPage } from './dashboard-page';

/** Three budgets in the order the API gives them (the user's own order): ok, warning, over. */
const TRANSPORT = budgetLine({
  id: 3,
  name: 'Transport',
  allocated: 8000,
  available: 8000,
  spent: 2000,
  remaining: 6000,
  usagePercent: 25,
  alert: 'ok',
  toSavings: 6000,
});
const GROCERIES = budgetLine({
  id: 1,
  name: 'Groceries',
  allocated: 40000,
  available: 40000,
  spent: 34000,
  remaining: 6000,
  usagePercent: 85,
  alert: 'warning',
  toSavings: 6000,
});
const FUN = budgetLine({
  id: 2,
  name: 'Fun',
  color: '#2563eb',
  icon: '🎬',
  incremental: true,
  allocated: 15000,
  available: 22000,
  spent: 23000,
  remaining: -1000,
  usagePercent: 104,
  alert: 'over',
  carriedOut: -1000,
  toSavings: 0,
});

const OCTOBER = monthView({ month: '2026-10', budgets: [TRANSPORT, GROCERIES, FUN] });

/** June to October: five months since the start month of the default settings. */
const SUMMARIES = monthSummaries('2026-06', '2026-10', (_month, index) => ({
  income: 250000 + index * 5000,
  spent: 100000 + index * 10000,
  savingsDue: 90000 - index * 10000,
}));

describe('DashboardPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'dashboard', component: StubPage },
          { path: 'budgets', component: StubPage },
        ]),
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
    months?: MonthSummary[];
    settings?: SettingsDto;
    /** The savings overview the block "Savings to move" reads. Default: nothing to move. */
    savings?: SavingsDto;
    /** The query the trend request is expected to carry. */
    range?: string;
  }

  const monthsUrl = (range: string) => `/api/months?${range}`;

  /** Creates the page for a month, and returns before either request is answered. */
  async function create(month = '2026-10', settings?: SettingsDto) {
    await primeStores(http, settings ? { settings } : {});
    await router.navigateByUrl(`/dashboard${month === '2026-10' ? '' : `?month=${month}`}`);
    const fixture = TestBed.createComponent(DashboardPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  /** Opens the page for a month and answers its two requests. */
  async function open(month = '2026-10', data: Data = {}) {
    const fixture = await create(month, data.settings);
    http.expectOne(`/api/months/${month}`).flush(data.view ?? { ...OCTOBER, month });
    http
      .expectOne(monthsUrl(data.range ?? `from=2026-06&to=${month}`))
      .flush(data.months ?? SUMMARIES);
    http.expectOne('/api/savings').flush(data.savings ?? savingsDto());
    await settle(fixture);
    return page(fixture);
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<DashboardPage>>) {
    const element = fixture.nativeElement as HTMLElement;
    const region = (name: string | RegExp) => getByRole(element, 'region', name);
    const words = (node: Element) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      fixture,
      element,
      text: () => textOf(element),
      glance: () => textOf(region(/at a glance/)),
      progress: () => region('Budget progress'),
      savings: () => region('Savings to move'),
      bars: () => region('Spending per budget'),
      trend: () => region('Income, spent and saved'),
      /** The budgets of the progress block, top to bottom. */
      progressNames: () =>
        Array.from(region('Budget progress').querySelectorAll('h3')).map((h) => words(h)),
      progressRow: (name: string) =>
        Array.from(region('Budget progress').querySelectorAll('li')).find((li) =>
          li.querySelector('h3')?.textContent?.includes(name),
        ) as HTMLElement,
      alerts: () => queryAllByRole(element, 'alert').map((alert) => textOf(alert)),
      words,
    };
  }

  /** Answers a request that was made after the first ones (a retry, a change of month). */
  const flushLater = async (
    fixture: ReturnType<typeof TestBed.createComponent<DashboardPage>>,
    url: string,
    body: MonthView | MonthSummary[],
  ) => {
    http.expectOne(url).flush(body);
    await settle(fixture);
  };

  describe('the page', () => {
    it('is a dashboard with one heading per block, in the order the user reads them', async () => {
      const p = await open();

      expect(textOf(getByRole(p.element, 'heading', 'Dashboard'))).toBe('Dashboard');
      expect(p.text()).toContain('Income, budgets and trends for October 2026.');
      expect(Array.from(p.element.querySelectorAll('h2')).map((h) => textOf(h))).toEqual([
        'October 2026 at a glance',
        'Savings to move',
        'Budget progress',
        'Spending per budget',
        'Income, spent and saved',
      ]);
    });

    it('does not animate anything, so there is nothing for reduced motion to switch off', async () => {
      const p = await open();

      const classes = Array.from(p.element.querySelectorAll('[class]')).flatMap((node) =>
        (node.getAttribute('class') ?? '').split(/\s+/),
      );
      // A motion utility is only allowed behind `motion-safe:`.
      expect(
        classes.filter((name) => /^(transition|animate|duration|delay|ease)/.test(name)),
      ).toEqual([]);
    });

    it('asks for the month, for the months of the trend and for the savings overview, and for nothing else', async () => {
      // `http.verify()` fails the test if any other request was made.
      await open();
    });

    it('waits for today before asking for anything', async () => {
      await primeStores(http, { today: 'error' });
      const fixture = TestBed.createComponent(DashboardPage);
      fixture.detectChanges();
      await settle(fixture);

      // No month, so nothing to show or to request.
      expect(textOf(fixture.nativeElement as HTMLElement)).not.toContain('at a glance');
    });
  });

  describe('this month at a glance', () => {
    it('shows income, fixed costs, budgeted, spent and unallocated exactly as the API reports them', async () => {
      // Figures that do not add up on purpose: the page must show what it is told, not compute.
      const p = await open('2026-10', {
        view: monthView({
          income: { salary: 111, extra: 0, total: 222 },
          fixedCosts: 333,
          totals: { allocated: 444, spent: 555, remaining: 0, transfersNet: 0 },
          unallocated: 666,
          budgets: [GROCERIES],
        }),
      });

      expect(p.glance()).toContain('Income €2.22');
      expect(p.glance()).toContain('Fixed costs €3.33');
      expect(p.glance()).toContain('Budgeted €4.44');
      expect(p.glance()).toContain('Spent €5.55');
      expect(p.glance()).toContain('Unallocated €6.66');
      expect(p.text()).not.toContain('Over-allocated');
    });

    it.each([
      ['closed', '2026-08', 'Closed month', 'This month is over, so its figures are final.'],
      ['current', '2026-10', 'Current month', 'This month is still running'],
      ['future', '2026-12', 'Projection', 'This month has not started yet.'],
    ] as const)('says a %s month is %s', async (status, month, label, explanation) => {
      const p = await open(month, { view: monthView({ month, status, budgets: [GROCERIES] }) });

      expect(p.glance()).toContain(label);
      expect(p.glance()).toContain(explanation);
    });

    it('warns, in an alert and by how much, when the month is over-allocated', async () => {
      const p = await open('2026-10', {
        view: monthView({
          income: { salary: 100000, extra: 0, total: 100000 },
          budgets: [budgetLine({ allocated: 112000, available: 112000, remaining: 112000 })],
        }),
      });

      const alert = getByRole(p.element, 'alert', /Over-allocated by/);
      expect(textOf(alert)).toContain('Over-allocated by €120.00');
      expect(textOf(alert)).toContain(
        'that amount will be taken from savings when the month closes',
      );
      // The tile carries the sign and the word, not only the red.
      expect(p.glance()).toContain('Unallocated -€120.00 Over-allocated');
    });

    it('words the warning of a closed month in the past tense', async () => {
      const p = await open('2026-08', {
        view: monthView({
          month: '2026-08',
          status: 'closed',
          income: { salary: 100000, extra: 0, total: 100000 },
          budgets: [budgetLine({ allocated: 105000, available: 105000, remaining: 105000 })],
        }),
      });

      expect(textOf(getByRole(p.element, 'alert', /Over-allocated by/))).toContain(
        "added up to more than this month's income, so that amount is taken from savings.",
      );
    });

    it('shows no warning when the month is not over-allocated', async () => {
      const p = await open();
      expect(queryByRole(p.element, 'alert', /Over-allocated/)).toBeNull();
    });
  });

  describe('savings to move', () => {
    it('says all months are settled when nothing waits, with a link to Savings', async () => {
      const p = await open();

      const text = textOf(p.savings());
      expect(text).toContain('All settled');
      expect(text).toContain('Every closed month has been moved to savings.');
      expect(getByRole(p.savings(), 'link', /Open savings/).getAttribute('href')).toBe('/savings');
    });

    it('shows how many months wait and the signed total the API gives, and what to do', async () => {
      const p = await open('2026-10', {
        savings: savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08', savingsDue: 31240 }),
            outstandingMonth({ month: '2026-09', savingsDue: -8500 }),
          ],
        }),
      });

      const text = textOf(p.savings());
      expect(text).toContain('+€227.40');
      expect(text).toContain('2 months to settle. Move this to savings.');
      expect(text).not.toContain('All settled');
    });

    it('shows a total that takes money from savings with its minus sign and the words', async () => {
      const p = await open('2026-10', {
        savings: savingsDto({
          outstanding: [outstandingMonth({ month: '2026-09', savingsDue: -8500 })],
        }),
      });

      const text = textOf(p.savings());
      expect(text).toContain('-€85.00');
      expect(text).toContain('1 month to settle. Take this from savings.');
      // Money to take from savings is a to-do, not an error: no error color.
      expect(p.savings().querySelector('.text-negative')).toBeNull();
    });

    it('shows the total as the API gave it, and says when the months cancel out', async () => {
      const p = await open('2026-10', {
        savings: savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08', savingsDue: 5000 }),
            outstandingMonth({ month: '2026-09', savingsDue: -5000 }),
          ],
        }),
      });

      expect(textOf(p.savings())).toContain('€0.00');
      expect(textOf(p.savings())).toContain('2 months to settle. They cancel each other out.');
    });

    it('does not depend on the month the switcher selects: the same figures for a past month', async () => {
      const p = await open('2026-08', {
        view: monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES] }),
        savings: savingsDto({ outstanding: [outstandingMonth()] }),
      });

      expect(textOf(p.savings())).toContain('1 month to settle');
      // The link keeps the selected month, like the links of the other blocks.
      expect(getByRole(p.savings(), 'link', /Open savings/).getAttribute('href')).toBe(
        '/savings?month=2026-08',
      );
    });

    it('says it is loading, and shows what the API said when it cannot be loaded, without taking the other blocks down', async () => {
      const fixture = await create();
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).flush(SUMMARIES);
      await settle(fixture);
      const p = page(fixture);
      expect(textOf(p.savings())).toContain('Loading the savings to move…');

      flushError(http.expectOne('/api/savings'), 500, 'internal_error', 'The ledger is down');
      await settle(fixture);

      expect(textOf(p.savings())).toContain("Couldn't load the savings to move");
      expect(textOf(p.savings())).toContain('The ledger is down');
      expect(p.progressNames()).toEqual(['🎬 Fun', 'Groceries', 'Transport']);

      getByRole(p.savings(), 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/savings').flush(savingsDto());
      await settle(fixture);
      expect(textOf(p.savings())).toContain('All settled');
    });
  });

  describe('budget progress', () => {
    it('lists the budgets over budget first, then in warning, then the rest, keeping the API order within a state', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [
            budgetLine({ id: 1, name: 'Rent', alert: 'ok' }),
            budgetLine({ id: 2, name: 'Food', alert: 'warning', usagePercent: 90 }),
            budgetLine({ id: 3, name: 'Gifts', alert: 'over', remaining: -100, usagePercent: 120 }),
            budgetLine({ id: 4, name: 'Pets', alert: 'warning', usagePercent: 81 }),
            budgetLine({ id: 5, name: 'Fun', alert: 'over', remaining: -200, usagePercent: 130 }),
            budgetLine({ id: 6, name: 'Travel', alert: 'ok' }),
          ],
        }),
      });

      expect(p.progressNames()).toEqual(['Gifts', 'Fun', 'Food', 'Pets', 'Rent', 'Travel']);
    });

    it('shows, for each budget, what is left and its state in words, with a bar', async () => {
      const p = await open();

      expect(p.progressNames()).toEqual(['🎬 Fun', 'Groceries', 'Transport']);
      expect(textOf(p.progressRow('Groceries'))).toBe(
        'Groceries Remaining €60.00 Spent €340.00 · Available €400.00 Warning 85% used, warns at 80%',
      );
      expect(textOf(p.progressRow('Transport'))).toContain('On track 25% used, warns at 80%');
      // Over budget says by how much, and what is left carries its minus sign.
      expect(textOf(p.progressRow('Fun'))).toBe(
        'Fun Remaining -€10.00 Spent €230.00 · Available €220.00 Over budget by €10.00 · 104% used',
      );
    });

    it('draws a progress bar per budget, with its alert as a name, a value and a color', async () => {
      const p = await open();

      const bars = queryAllByRole(p.progress(), 'progressbar');
      expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
        'Fun usage',
        'Groceries usage',
        'Transport usage',
      ]);
      expect(bars.map((bar) => bar.getAttribute('aria-valuetext'))).toEqual([
        '104% used, over budget',
        '85% used, warning',
        '25% used, on track',
      ]);
      // The bar fills to 100 and no further, whatever the percentage says.
      expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['100', '85', '25']);
      expect(bars.map((bar) => bar.querySelector('div')?.className)).toEqual([
        expect.stringContaining('bg-negative'),
        expect.stringContaining('bg-warning'),
        expect.stringContaining('bg-accent'),
      ]);
    });

    it('has no bar, only words, when nothing is available', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [
            budgetLine({
              name: 'Placeholder',
              allocated: 0,
              available: 0,
              spent: 0,
              remaining: 0,
              usagePercent: null,
              toSavings: 0,
            }),
          ],
        }),
      });

      expect(textOf(p.progressRow('Placeholder'))).toContain(
        'On track Nothing available this month.',
      );
      expect(queryByRole(p.progress(), 'progressbar')).toBeNull();
    });

    it('shows the colour and icon of a budget as decoration beside its name', async () => {
      const p = await open();

      const fun = p.progressRow('Fun');
      expect(fun.style.borderLeftColor).not.toBe('');
      expect(fun.querySelector('[aria-hidden="true"]')?.textContent).toBe('🎬');
      expect(p.progressRow('Groceries').style.borderLeftColor).toBe('');
    });

    it('links to the Budgets page for the month shown, from the corner of the block', async () => {
      const p = await open();

      const link = getByRole(p.progress(), 'link', /Open budgets/);
      expect(link.getAttribute('href')).toBe('/budgets');
      // It sits in the header of the block, with the title, not among the rows.
      expect(link.parentElement?.querySelector('h2')?.textContent).toContain('Budget progress');
    });

    it('carries another month to the Budgets page with it', async () => {
      const p = await open('2026-09', {
        view: monthView({ month: '2026-09', status: 'closed', budgets: [GROCERIES] }),
      });
      expect(getByRole(p.progress(), 'link', /Open budgets/).getAttribute('href')).toBe(
        '/budgets?month=2026-09',
      );
    });

    it('says what to do next, and links to Budgets, when the month has no budgets', async () => {
      const p = await open('2026-10', { view: monthView({ budgets: [] }) });

      expect(textOf(p.progress())).toContain('No budgets in October 2026');
      expect(textOf(p.progress())).toContain('Create a budget');
      expect(getByRole(p.progress(), 'link', 'Go to budgets').getAttribute('href')).toBe(
        '/budgets',
      );
      // The corner link would only repeat it.
      expect(queryByRole(p.progress(), 'link', /Open budgets/)).toBeNull();
      // The figures above are still there.
      expect(p.glance()).toContain('Income');
    });

    it('keeps the month in the link of the empty state too', async () => {
      const p = await open('2026-12', {
        view: monthView({ month: '2026-12', status: 'future', budgets: [] }),
      });
      expect(getByRole(p.progress(), 'link', 'Go to budgets').getAttribute('href')).toBe(
        '/budgets?month=2026-12',
      );
    });
  });

  describe('spending per budget', () => {
    it('is a chart with a name and a legend, and the budgets in the user order', async () => {
      const p = await open();

      const chart = getByRole(p.bars(), 'figure', 'Spending per budget, October 2026');
      expect(textOf(getByRole(chart, 'list', 'Legend'))).toBe('Spent Available');
      expect(
        Array.from(chart.querySelectorAll('ul[aria-hidden="true"] > li')).map((li) => p.words(li)),
      ).toEqual([
        'Transport €20.00 of €80.00',
        'Groceries €340.00 of €400.00 Warning',
        '🎬 Fun €230.00 of €220.00 Over budget by €10.00',
      ]);
    });

    it('has a table for those who cannot see the bars, with each budget and its state', async () => {
      const p = await open();

      const table = getByRole(p.bars(), 'table', 'Spending per budget, October 2026');
      expect(queryAllByRole(table, 'columnheader').map(textOf)).toEqual([
        'Budget',
        'Spent',
        'Available',
        'Alert',
      ]);
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) => cell.textContent?.trim()),
      );
      expect(rows).toEqual([
        ['Transport', '€20.00', '€80.00', 'On track'],
        ['Groceries', '€340.00', '€400.00', 'Warning'],
        ['Fun', '€230.00', '€220.00', 'Over budget by €10.00'],
      ]);
    });

    it('draws what was spent over what was available, so overspending shows as a bar past its track', async () => {
      const p = await open();

      const fun = Array.from(p.bars().querySelectorAll('ul[aria-hidden="true"] > li')).find((li) =>
        li.textContent?.includes('Fun'),
      ) as HTMLElement;
      const track = fun.querySelector('rect[fill="none"]') as Element;
      const bar = fun.querySelector('rect.fill-series-2') as Element;
      expect(parseFloat(bar.getAttribute('width') ?? '0')).toBeGreaterThan(
        parseFloat(track.getAttribute('width') ?? '0'),
      );
    });

    it('says when nothing is available instead of drawing a track', async () => {
      const p = await open('2026-10', {
        view: monthView({
          budgets: [
            budgetLine({
              name: 'Placeholder',
              allocated: 0,
              available: 0,
              spent: 500,
              remaining: -500,
              usagePercent: null,
              alert: 'over',
              toSavings: -500,
            }),
          ],
        }),
      });

      const row = p.bars().querySelector('ul[aria-hidden="true"] > li') as HTMLElement;
      expect(p.words(row)).toBe('Placeholder €5.00 Over budget by €5.00');
      expect(row.querySelectorAll('rect[fill="none"]')).toHaveLength(0);
    });

    it('explains itself when the month has no budgets', async () => {
      const p = await open('2026-10', { view: monthView({ budgets: [] }) });

      expect(textOf(p.bars())).toContain('Nothing to compare yet');
      expect(textOf(p.bars())).toContain('Create a budget in October 2026');
      expect(queryByRole(p.bars(), 'figure')).toBeNull();
    });
  });

  describe('income, spent and saved', () => {
    it('is a chart of three lines with a legend, and says the figures of the selected month', async () => {
      const p = await open();

      const chart = getByRole(
        p.trend(),
        'figure',
        'Income, spent and saved, June 2026 to October 2026',
      );
      expect(textOf(getByRole(chart, 'list', 'Legend'))).toBe(
        'Income €2,700.00 Spent €1,400.00 Saved +€500.00',
      );
      expect(textOf(chart)).toContain('October 2026 · Current month');
    });

    it('has a table with every month, as an alternative to the lines', async () => {
      const p = await open();

      const table = getByRole(
        p.trend(),
        'table',
        'Income, spent and saved, June 2026 to October 2026',
      );
      expect(queryAllByRole(table, 'columnheader').map(textOf)).toEqual([
        'Month',
        'Status',
        'Income',
        'Spent',
        'Saved',
      ]);
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) => cell.textContent?.trim()),
      );
      expect(rows).toEqual([
        ['June 2026', 'Closed month', '€2,500.00', '€1,000.00', '+€900.00'],
        ['July 2026', 'Closed month', '€2,550.00', '€1,100.00', '+€800.00'],
        ['August 2026', 'Closed month', '€2,600.00', '€1,200.00', '+€700.00'],
        ['September 2026', 'Closed month', '€2,650.00', '€1,300.00', '+€600.00'],
        ['October 2026', 'Current month', '€2,700.00', '€1,400.00', '+€500.00'],
      ]);
    });

    it('draws savings that are taken from savings below zero, with a minus sign wherever they are written', async () => {
      const p = await open('2026-10', {
        months: monthSummaries('2026-06', '2026-10', (month) =>
          month === '2026-10'
            ? { savingsDue: -30000 }
            : month === '2026-07'
              ? { savingsDue: -5000 }
              : {},
        ),
      });
      const chart = getByRole(p.trend(), 'figure', /Income, spent and saved/);

      // The legend (the month in focus), the table and the name of the month's stop all carry the sign.
      expect(textOf(getByRole(chart, 'list', 'Legend'))).toContain('Saved -€300.00');
      const cells = Array.from(chart.querySelectorAll('tbody tr')).map((tr) =>
        tr.querySelector('td:last-child')?.textContent?.trim(),
      );
      expect(cells[1]).toBe('-€50.00');
      expect(cells[4]).toBe('-€300.00');
      expect(queryAllByRole(chart, 'img').at(-1)?.getAttribute('aria-label')).toBe(
        'October 2026, current month: Income €2,700.00, Spent €100.00, Saved -€300.00',
      );
      // The axis reaches below zero for it.
      const ticks = Array.from(chart.querySelectorAll('svg text.tabular-nums')).map((t) =>
        t.textContent?.trim(),
      );
      expect(ticks[0]).toMatch(/^-€/);
      expect(ticks).toContain('€0');
    });

    it('writes a positive saving with a plus sign', async () => {
      const p = await open();
      expect(
        textOf(getByRole(getByRole(p.trend(), 'figure', /Income/), 'list', 'Legend')),
      ).toContain('Saved +€500.00');
    });

    it('marks the months that are projections, and says so', async () => {
      const p = await open('2026-12', {
        view: monthView({ month: '2026-12', status: 'future', budgets: [GROCERIES] }),
        months: monthSummaries('2026-06', '2026-12'),
      });
      const chart = getByRole(p.trend(), 'figure', /Income, spent and saved/);

      const statuses = Array.from(chart.querySelectorAll('tbody tr')).map((tr) =>
        tr.querySelector('td')?.textContent?.trim(),
      );
      expect(statuses.slice(-3)).toEqual(['Current month', 'Projection', 'Projection']);
      expect(textOf(chart)).toContain('December 2026 · Projection');
      expect(textOf(chart)).toContain('Hollow markers are projections.');
      // Two projected months, three lines: six hollow markers.
      expect(chart.querySelectorAll('svg path.fill-surface')).toHaveLength(6);
    });

    it('explains an empty answer', async () => {
      const p = await open('2026-10', { months: [] });
      expect(textOf(p.trend())).toContain('No months to show yet');
      expect(queryByRole(p.trend(), 'figure')).toBeNull();
    });

    it('shows a month on its own when Wallet has only just started', async () => {
      const p = await open('2026-10', {
        settings: { ...SETTINGS, startMonth: '2026-10' },
        range: 'from=2026-10&to=2026-10',
        months: monthSummaries('2026-10', '2026-10'),
      });
      expect(textOf(p.trend())).toContain('There is only one month to show');
    });
  });

  describe('the months the trend covers', () => {
    it('is the 12 months that end with the selected one', async () => {
      const p = await open('2026-10', {
        settings: { ...SETTINGS, startMonth: '2024-01' },
        range: 'from=2025-11&to=2026-10',
        months: monthSummaries('2025-11', '2026-10'),
      });

      const rows = Array.from(p.trend().querySelectorAll('tbody th')).map((th) =>
        th.textContent?.trim(),
      );
      expect(rows).toHaveLength(12);
      expect(rows[0]).toBe('November 2025');
      expect(rows[11]).toBe('October 2026');
    });

    it('starts no earlier than the month Wallet started tracking', async () => {
      // The default start month is June 2026: 5 months before October, not 12.
      const p = await open('2026-10');
      expect(
        Array.from(p.trend().querySelectorAll('tbody th')).map((th) => th.textContent?.trim()),
      ).toEqual(['June 2026', 'July 2026', 'August 2026', 'September 2026', 'October 2026']);
    });

    it('is a full window of 12 months for a projection far enough ahead', async () => {
      // 12 months back from August 2027 is September 2026: after the start month, so a full window.
      const p = await open('2027-08', {
        range: 'from=2026-09&to=2027-08',
        months: monthSummaries('2026-09', '2027-08'),
      });
      expect(p.trend().querySelectorAll('tbody tr')).toHaveLength(12);
    });

    it('follows the month switcher: another month is another pair of requests', async () => {
      const p = await open();
      await router.navigateByUrl('/dashboard?month=2026-08');
      await settle(p.fixture);

      http
        .expectOne('/api/months/2026-08')
        .flush(monthView({ month: '2026-08', status: 'closed', budgets: [GROCERIES] }));
      http
        .expectOne(monthsUrl('from=2026-06&to=2026-08'))
        .flush(monthSummaries('2026-06', '2026-08'));
      await settle(p.fixture);

      expect(p.text()).toContain('August 2026 at a glance');
      expect(p.text()).toContain('Closed month');
      expect(
        getByRole(p.trend(), 'figure', 'Income, spent and saved, June 2026 to August 2026'),
      ).toBeTruthy();
      expect(p.progressNames()).toEqual(['Groceries']);
    });
  });

  describe('loading and failing, block by block', () => {
    it('says each block is loading, in its own words, while its request is out', async () => {
      const fixture = await create();

      const statuses = queryAllByRole(fixture.nativeElement as HTMLElement, 'status').map((s) =>
        textOf(s),
      );
      expect(statuses).toEqual([
        "Loading this month's figures…",
        'Loading the savings to move…',
        'Loading budget progress…',
        'Loading the spending chart…',
        'Loading the monthly trend…',
      ]);

      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).flush(SUMMARIES);
      http.expectOne('/api/savings').flush(savingsDto());
    });

    it('keeps the blocks that have their data while another is still loading', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(fixture);
      const p = page(fixture);

      expect(p.glance()).toContain('Income');
      expect(p.progressNames()).toHaveLength(3);
      expect(textOf(p.trend())).toContain('Loading the monthly trend…');

      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).flush(SUMMARIES);
    });

    it('shows what the API said where the month could not be loaded, and keeps the trend', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      flushError(
        http.expectOne('/api/months/2026-10'),
        500,
        'internal_error',
        'The ledger is busy',
      );
      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).flush(SUMMARIES);
      await settle(fixture);
      const p = page(fixture);

      // The three blocks that read the month each say so, with the API's own message.
      expect(p.alerts()).toEqual([
        "Couldn't load this month's figures The ledger is busy Try again",
        "Couldn't load budget progress The ledger is busy Try again",
        "Couldn't load the spending chart The ledger is busy Try again",
      ]);
      // The headings stay, so each failure is placed.
      expect(textOf(p.progress())).toContain("Couldn't load budget progress");
      expect(textOf(p.bars())).toContain("Couldn't load the spending chart");
      // The trend has its own request and its own data.
      expect(getByRole(p.trend(), 'figure', /Income, spent and saved/)).toBeTruthy();
      expect(queryByRole(p.trend(), 'alert')).toBeNull();
    });

    it('loads the month again on request, and every block that needed it recovers', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      flushError(
        http.expectOne('/api/months/2026-10'),
        500,
        'internal_error',
        'The ledger is busy',
      );
      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).flush(SUMMARIES);
      await settle(fixture);
      const p = page(fixture);

      getByRole(p.progress(), 'button', 'Try again').click();
      await settle(fixture);
      await flushLater(fixture, '/api/months/2026-10', OCTOBER);

      expect(p.alerts()).toEqual([]);
      expect(p.glance()).toContain('Spent €590.00');
      expect(p.progressNames()).toHaveLength(3);
      expect(getByRole(p.bars(), 'figure', /Spending per budget/)).toBeTruthy();
    });

    it('shows what the API said where the trend could not be loaded, and keeps everything else', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(
        http.expectOne(monthsUrl('from=2026-06&to=2026-10')),
        500,
        'internal_error',
        'No months today',
      );
      await settle(fixture);
      const p = page(fixture);

      expect(p.alerts()).toEqual(["Couldn't load the monthly trend No months today Try again"]);
      expect(p.glance()).toContain('Income');
      expect(p.progressNames()).toHaveLength(3);
      expect(getByRole(p.bars(), 'figure', /Spending per budget/)).toBeTruthy();
    });

    it('loads the trend again on request, without asking for the month again', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(
        http.expectOne(monthsUrl('from=2026-06&to=2026-10')),
        500,
        'internal_error',
        'No months today',
      );
      await settle(fixture);
      const p = page(fixture);

      getByRole(p.trend(), 'button', 'Try again').click();
      await settle(fixture);
      await flushLater(fixture, monthsUrl('from=2026-06&to=2026-10'), SUMMARIES);

      expect(p.alerts()).toEqual([]);
      expect(getByRole(p.trend(), 'figure', /Income, spent and saved/)).toBeTruthy();
    });

    it('still shows the page, with each failure in its own place, when both requests fail', async () => {
      const fixture = await create();
      http.expectOne('/api/savings').flush(savingsDto());
      flushError(http.expectOne('/api/months/2026-10'), 500, 'internal_error', 'Boom');
      http.expectOne(monthsUrl('from=2026-06&to=2026-10')).error(new ProgressEvent('error'), {
        status: 0,
        statusText: 'Unknown Error',
      });
      await settle(fixture);
      const p = page(fixture);

      expect(p.alerts()).toHaveLength(4);
      expect(textOf(p.trend())).toContain("Couldn't load the monthly trend");
      expect(textOf(p.trend())).toContain("Can't reach the server");
      expect(Array.from(p.element.querySelectorAll('h2')).map((h) => textOf(h))).toEqual([
        'Savings to move',
        'Budget progress',
        'Spending per budget',
        'Income, spent and saved',
      ]);
      expect(textOf(getByRole(p.element, 'heading', 'Dashboard'))).toBe('Dashboard');
    });
  });
});
