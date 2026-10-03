import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getByRole, queryAllByRole, textOf } from '../../../../testing/dom';
import { primeStores, render, settle } from '../../../../testing/harness';
import { BarChart, type BarChartRow } from './bar-chart';

@Component({
  selector: 'app-bar-chart-host',
  imports: [BarChart],
  template: `<app-bar-chart
    label="Spending per budget, October 2026"
    valueLabel="Spent"
    trackLabel="Available"
    nameLabel="Budget"
    statusLabel="Alert"
    [slot]="2"
    [rows]="rows()"
  />`,
})
class Host {
  readonly rows = signal<BarChartRow[]>([]);
}

const GROCERIES: BarChartRow = {
  key: 1,
  label: 'Groceries',
  value: 34000,
  track: 40000,
  status: { label: 'Warning', tone: 'warning' },
};
const FUN: BarChartRow = {
  key: 2,
  label: 'Fun',
  icon: '🎬',
  value: 23000,
  track: 22000,
  status: { label: 'Over budget', tone: 'danger' },
  note: 'by €10.00',
};
const TRANSPORT: BarChartRow = {
  key: 3,
  label: 'Transport',
  value: 2000,
  track: 8000,
  status: { label: 'On track', tone: 'ok' },
};

describe('BarChart', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(rows: BarChartRow[] = [GROCERIES, FUN, TRANSPORT]) {
    await primeStores(http);
    const fixture = await render(Host);
    fixture.componentInstance.rows.set(rows);
    await settle(fixture);
    return chart(fixture);
  }

  function chart(fixture: Awaited<ReturnType<typeof render<Host>>>) {
    const element = fixture.nativeElement as HTMLElement;
    const rowItems = () =>
      Array.from(element.querySelectorAll<HTMLElement>('ul[aria-hidden="true"] > li'));
    const spans = (li: HTMLElement) => {
      const read = (rect: Element | null) =>
        rect ? { x: rect.getAttribute('x'), width: rect.getAttribute('width') } : null;
      return {
        track: read(li.querySelector('rect[fill="none"]')),
        bar: read(li.querySelector('rect.fill-series-2')),
      };
    };
    return {
      fixture,
      element,
      rowItems,
      row: (name: string) => rowItems().find((li) => li.textContent?.includes(name)) as HTMLElement,
      spans,
      /** What a row says, as a reader would take it in. */
      words: (li: HTMLElement) => li.textContent?.replace(/\s+/g, ' ').trim(),
      table: () => getByRole(element, 'table', 'Spending per budget, October 2026'),
      zeroLines: () => element.querySelectorAll('ul[aria-hidden="true"] svg line'),
      noNaN: () => expect(element.innerHTML).not.toContain('NaN'),
    };
  }

  describe('reading it', () => {
    it('is a figure with a name, and its rows are hidden from assistive technology', async () => {
      const c = await open();

      expect(getByRole(c.element, 'figure', 'Spending per budget, October 2026')).toBeTruthy();
      // The table is what a screen reader reads: the same numbers, with headers.
      expect(c.rowItems()).toHaveLength(3);
      expect(c.element.querySelector('ul[aria-hidden="true"]')).not.toBeNull();
    });

    it('says every row in words next to its bar: name, spent, and what it was measured against', async () => {
      const c = await open();

      expect(c.words(c.row('Groceries'))).toContain('Groceries €340.00 of €400.00');
      expect(c.words(c.row('Fun'))).toContain('Fun €230.00 of €220.00');
      expect(c.words(c.row('Transport'))).toContain('Transport €20.00 of €80.00');
      // An emoji is decoration before the name.
      expect(c.words(c.row('Fun'))).toContain('🎬');
    });

    it('draws each bar from zero over its track, all on one scale so lengths compare', async () => {
      const c = await open();

      // The scale runs to 400.00, the largest of all the bars and tracks.
      expect(c.spans(c.row('Groceries'))).toEqual({
        track: { x: '0%', width: '100%' },
        bar: { x: '0%', width: '85%' },
      });
      expect(c.spans(c.row('Fun'))).toEqual({
        track: { x: '0%', width: '55%' },
        bar: { x: '0%', width: '57.5%' },
      });
      expect(c.spans(c.row('Transport'))).toEqual({
        track: { x: '0%', width: '20%' },
        bar: { x: '0%', width: '5%' },
      });
    });

    it('lets a bar run on past the end of its track when more was spent than was available', async () => {
      const c = await open();
      const { track, bar } = c.spans(c.row('Fun'));
      expect(parseFloat(bar?.width ?? '0')).toBeGreaterThan(parseFloat(track?.width ?? '0'));

      const groceries = c.spans(c.row('Groceries'));
      expect(parseFloat(groceries.bar?.width ?? '0')).toBeLessThan(
        parseFloat(groceries.track?.width ?? '0'),
      );
    });

    it('writes a state in words with an icon, never only as a color', async () => {
      const c = await open();

      expect(c.words(c.row('Fun'))).toContain('Over budget by €10.00');
      expect(c.words(c.row('Groceries'))).toContain('Warning');
      expect(c.row('Fun').querySelectorAll('app-icon')).toHaveLength(1);
      expect(c.row('Groceries').querySelectorAll('app-icon')).toHaveLength(1);
      // On track needs no words on the bar (the table still says it).
      expect(c.row('Transport').querySelectorAll('app-icon')).toHaveLength(0);
      expect(c.words(c.row('Transport'))).not.toContain('On track');

      const tone = (name: string) => c.row(name).querySelector('p span')?.className ?? '';
      expect(tone('Fun')).toContain('text-negative');
      expect(tone('Groceries')).toContain('text-warning');
    });

    it('has a legend that names the bars and the tracks, with a key that looks like each', async () => {
      const c = await open();

      expect(textOf(getByRole(c.element, 'list', 'Legend'))).toBe('Spent Available');
      const [bar, track] = Array.from(c.element.querySelectorAll('ul[aria-label="Legend"] svg'));
      expect(bar.querySelector('rect')?.getAttribute('class')).toBe('fill-series-2');
      expect(track.querySelector('rect')?.getAttribute('fill')).toBe('none');
    });

    it('colors the bars with the series color it is given', async () => {
      const c = await open();
      expect(c.element.querySelectorAll('rect.fill-series-2')).toHaveLength(3 + 1); // three bars and the key
    });
  });

  describe('text alternatives', () => {
    it('is also a table with headers, which a screen reader always has', async () => {
      const c = await open();
      const table = c.table();

      expect(queryAllByRole(table, 'columnheader').map(textOf)).toEqual([
        'Budget',
        'Spent',
        'Available',
        'Alert',
      ]);
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => ({
        header: tr.querySelector('th')?.textContent?.trim(),
        cells: Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()),
      }));
      expect(rows).toEqual([
        { header: 'Groceries', cells: ['€340.00', '€400.00', 'Warning'] },
        { header: 'Fun', cells: ['€230.00', '€220.00', 'Over budget by €10.00'] },
        { header: 'Transport', cells: ['€20.00', '€80.00', 'On track'] },
      ]);
    });

    it('hides the table from the eye until asked, then shows it', async () => {
      const c = await open();
      const wrapper = () => c.table().parentElement as HTMLElement;
      expect(wrapper().className).toContain('sr-only');

      const button = getByRole(c.element, 'button', 'Show table');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe(wrapper().id);
      button.click();
      await settle(c.fixture);

      expect(wrapper().className).not.toContain('sr-only');
      expect(getByRole(c.element, 'button', 'Hide table').getAttribute('aria-expanded')).toBe(
        'true',
      );
    });

    it('leaves the state column out when no row has a state or a note', async () => {
      const c = await open([{ key: 1, label: 'Rent', value: 5000, track: 9000 }]);
      expect(queryAllByRole(c.table(), 'columnheader').map(textOf)).toEqual([
        'Budget',
        'Spent',
        'Available',
      ]);
    });
  });

  describe('any data', () => {
    it('runs a negative value (refunds outweigh spendings) to the left of a zero line', async () => {
      const c = await open([
        { key: 1, label: 'Gifts', value: -5000, track: 20000 },
        { key: 2, label: 'Fun', value: 10000, track: 20000 },
      ]);

      // The axis runs from -50.00 to 200.00, so zero is 20% along.
      expect(c.spans(c.row('Gifts'))).toEqual({
        track: { x: '20%', width: '80%' },
        bar: { x: '0%', width: '20%' },
      });
      expect(c.spans(c.row('Fun')).bar).toEqual({ x: '20%', width: '40%' });
      expect(c.zeroLines()).toHaveLength(2);
      expect(c.zeroLines()[0].getAttribute('x1')).toBe('20%');
      expect(c.words(c.row('Gifts'))).toContain('-€50.00 of €200.00');
    });

    it('draws no zero line when no bar runs below zero', async () => {
      const c = await open();
      expect(c.zeroLines()).toHaveLength(0);
    });

    it('draws no track when nothing was available, and says so in words', async () => {
      const c = await open([
        {
          key: 1,
          label: 'Gifts',
          value: 500,
          track: 0,
          status: { label: 'Over budget', tone: 'danger' },
          note: 'by €5.00',
        },
        TRANSPORT,
      ]);

      expect(c.spans(c.row('Gifts')).track).toBeNull();
      expect(c.words(c.row('Gifts'))).toContain('Gifts €5.00');
      expect(c.words(c.row('Gifts'))).not.toContain(' of ');
      expect(c.words(c.row('Gifts'))).toContain('Over budget by €5.00');
      // The table keeps the real figure.
      const cells = Array.from(c.table().querySelectorAll('tbody tr:first-child td')).map((td) =>
        td.textContent?.trim(),
      );
      expect(cells).toEqual(['€5.00', '€0.00', 'Over budget by €5.00']);
    });

    it('draws no track at all for rows without one, and leaves it out of the legend', async () => {
      const c = await open([{ key: 1, label: 'Gifts', value: 500, track: null }]);

      expect(c.element.querySelectorAll('ul[aria-hidden="true"] rect[fill="none"]')).toHaveLength(
        0,
      );
      expect(textOf(getByRole(c.element, 'list', 'Legend'))).toBe('Spent');
      const cells = Array.from(c.table().querySelectorAll('tbody td')).map((td) =>
        td.textContent?.trim(),
      );
      expect(cells).toEqual(['€5.00', 'None']);
    });

    it('keeps every figure when all of them are zero, with no bars', async () => {
      const c = await open([
        { key: 1, label: 'Rent', value: 0, track: 0 },
        { key: 2, label: 'Fun', value: 0, track: null },
      ]);

      c.noNaN();
      expect(c.element.querySelectorAll('ul[aria-hidden="true"] rect')).toHaveLength(0);
      expect(c.words(c.row('Rent'))).toContain('Rent €0.00');
    });

    it('shows a bar even when it is the only row, filling the width', async () => {
      const c = await open([{ key: 1, label: 'Rent', value: 90000, track: 90000 }]);
      expect(c.spans(c.row('Rent'))).toEqual({
        track: { x: '0%', width: '100%' },
        bar: { x: '0%', width: '100%' },
      });
    });

    it('survives having no rows', async () => {
      const c = await open([]);

      c.noNaN();
      expect(c.rowItems()).toHaveLength(0);
      expect(textOf(getByRole(c.element, 'list', 'Legend'))).toBe('Spent');
      expect(c.table().querySelectorAll('tbody tr')).toHaveLength(0);
    });

    it('keeps a row apart from another that has the same name (rows are told apart by key)', async () => {
      const c = await open([
        { key: 1, label: 'Fun', value: 100, track: 1000 },
        { key: 2, label: 'Fun', value: 200, track: 1000 },
      ]);
      expect(c.rowItems().map((li) => c.words(li))).toEqual([
        expect.stringContaining('€1.00 of €10.00'),
        expect.stringContaining('€2.00 of €10.00'),
      ]);
    });
  });
});
