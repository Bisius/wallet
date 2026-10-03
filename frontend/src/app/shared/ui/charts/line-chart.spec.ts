import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../../testing/dom';
import { primeStores, render, SETTINGS, settle } from '../../../../testing/harness';
import { monthRange } from '@wallet/shared/month';
import { formatMonth } from '../../format';
import { LineChart, type LineChartCategory, type LineChartSeries } from './line-chart';

@Component({
  selector: 'app-line-chart-host',
  imports: [LineChart],
  template: `<app-line-chart
    label="Income, spent and saved, June 2026 to October 2026"
    pointsLabel="Months"
    [categories]="categories()"
    [series]="series()"
  />`,
})
class Host {
  readonly categories = signal<LineChartCategory[]>([]);
  readonly series = signal<LineChartSeries[]>([]);
}

const NOTE: Record<string, string> = {
  closed: 'Closed month',
  current: 'Current month',
  future: 'Projection',
};

function category(month: string, status: 'closed' | 'current' | 'future'): LineChartCategory {
  return {
    key: month,
    label: formatMonth(month, 'en-US', 'monthOnly'),
    group: formatMonth(month, 'en-US', 'yearOnly'),
    name: formatMonth(month, 'en-US', 'long'),
    note: NOTE[status] ?? null,
    projected: status === 'future',
  };
}

/** June to October 2026, October being the current month. July saves a negative amount. */
const CATEGORIES = [
  category('2026-06', 'closed'),
  category('2026-07', 'closed'),
  category('2026-08', 'closed'),
  category('2026-09', 'closed'),
  category('2026-10', 'current'),
];

const SERIES: LineChartSeries[] = [
  { key: 'income', label: 'Income', slot: 1, values: [250000, 250000, 250000, 270000, 270000] },
  { key: 'spent', label: 'Spent', slot: 2, values: [152000, 142500, 120000, 90000, 10000] },
  {
    key: 'saved',
    label: 'Saved',
    slot: 3,
    values: [93500, -30000, 112000, 150000, 240000],
    signed: true,
  },
];

/** A stand-in for the browser's ResizeObserver, which the unit tests do not have. */
class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  resize(width: number): void {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as never);
  }
}

describe('LineChart', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
    FakeResizeObserver.instances.length = 0;
  });

  async function open(
    options: {
      categories?: LineChartCategory[];
      series?: LineChartSeries[];
    } = {},
  ) {
    await primeStores(http);
    const fixture = await render(Host);
    fixture.componentInstance.categories.set(options.categories ?? CATEGORIES);
    fixture.componentInstance.series.set(options.series ?? SERIES);
    await settle(fixture);
    return chart(fixture);
  }

  function chart(fixture: Awaited<ReturnType<typeof render<Host>>>) {
    const element = fixture.nativeElement as HTMLElement;
    const stops = () => queryAllByRole(element, 'img');
    const stop = (index: number) => stops()[index];
    return {
      fixture,
      element,
      stops,
      stop,
      /** What the legend and the line above it say: the month in focus, and each line's value. */
      readout: () => textOf(element.querySelector('figure > div') as HTMLElement),
      legend: () => textOf(getByRole(element, 'list', 'Legend')),
      table: () => getByRole(element, 'table', /Income, spent and saved/),
      svg: () => element.querySelector('figure svg.absolute') as SVGElement,
      svgTexts: () =>
        Array.from(
          (element.querySelector('figure svg.absolute') as SVGElement).querySelectorAll('text'),
        ).map((t) => t.textContent?.trim()),
      tabindexes: () => stops().map((s) => s.getAttribute('tabindex')),
      fire: async (target: Element, event: Event) => {
        target.dispatchEvent(event);
        await settle(fixture);
      },
      key: async (target: Element, key: string) => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
        await settle(fixture);
      },
      focus: async (target: HTMLElement) => {
        target.focus();
        await settle(fixture);
      },
    };
  }

  describe('reading it', () => {
    it('is a figure with a name, and its picture is hidden from assistive technology', async () => {
      const c = await open();

      expect(
        getByRole(c.element, 'figure', 'Income, spent and saved, June 2026 to October 2026'),
      ).toBeTruthy();
      // The picture says nothing the months and the table do not say.
      expect(c.svg().getAttribute('aria-hidden')).toBe('true');
    });

    it('shows the last month, and every line with its value, until told otherwise', async () => {
      const c = await open();

      expect(c.readout()).toContain('October 2026 · Current month');
      expect(c.legend()).toBe('Income €2,700.00 Spent €100.00 Saved +€2,400.00');
    });

    it('tells each line apart by line style and marker shape, in the legend as well as the plot', async () => {
      const c = await open();

      // The legend: a solid line with a round marker, a dashed one with a square, a dotted one with a diamond.
      const keys = Array.from(c.element.querySelectorAll('ul[aria-label="Legend"] li')).map(
        (li) => {
          const [line, marker] = Array.from(li.querySelectorAll('svg path'));
          return {
            dash: line.getAttribute('stroke-dasharray'),
            marker: marker.getAttribute('d') ?? '',
          };
        },
      );
      expect(keys.map((k) => k.dash)).toEqual([null, '7 5', '1 5']);
      expect(keys[0].marker).toContain('a'); // arcs: a circle
      expect(keys[1].marker).toMatch(/^M[^L]*h[^L]*v[^L]*h/); // a square
      expect(keys[2].marker).toContain('L'); // straight edges at an angle: a diamond

      // The plot draws the same three styles.
      const lines = Array.from(c.svg().querySelectorAll('path[fill="none"]'));
      expect(lines.map((line) => line.getAttribute('stroke-dasharray'))).toEqual([
        null,
        '7 5',
        '1 5',
      ]);
      expect(lines.map((line) => line.getAttribute('class'))).toEqual([
        'stroke-series-1',
        'stroke-series-2',
        'stroke-series-3',
      ]);
    });

    it('draws a marker for every month of every line, with a ring of the surface color', async () => {
      const c = await open();
      expect(c.svg().querySelectorAll('path.stroke-surface')).toHaveLength(15);
      expect(c.svg().querySelectorAll('path.fill-surface')).toHaveLength(0);
    });

    it('draws a projection with hollow markers, and says so', async () => {
      const c = await open({
        categories: [
          category('2026-09', 'closed'),
          category('2026-10', 'current'),
          category('2026-11', 'future'),
        ],
        series: SERIES.map((s) => ({ ...s, values: s.values.slice(2) })),
      });

      // Three lines, each with one hollow marker (its projected month) and two solid ones.
      expect(c.svg().querySelectorAll('path.fill-surface')).toHaveLength(3);
      expect(c.svg().querySelectorAll('path.stroke-surface')).toHaveLength(6);
      expect(textOf(c.element)).toContain('Hollow markers are projections.');
    });

    it('writes the amounts with a plus or minus sign where the sign matters', async () => {
      const c = await open();
      await c.fire(c.stop(1), new Event('pointerenter'));

      // Saved is "signed": July takes 300.00 out of savings.
      expect(c.legend()).toBe('Income €2,500.00 Spent €1,425.00 Saved -€300.00');
    });

    it('labels the axes: nice whole-unit ticks, below zero too, and the months with the year once', async () => {
      const c = await open();

      expect(c.svgTexts()).toEqual([
        '-€1,000',
        '€0',
        '€1,000',
        '€2,000',
        '€3,000',
        'Jun',
        '2026',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
      ]);
    });

    it('draws the zero line stronger than the other gridlines', async () => {
      const c = await open();
      const grid = Array.from(c.svg().querySelectorAll('line'));
      const strong = grid.filter((line) => line.getAttribute('class') === 'stroke-line-strong');
      // The zero line, and the hairline that marks the month in focus.
      expect(strong).toHaveLength(2);
    });
  });

  describe('moving through the months', () => {
    it('shows the month the pointer is over, and goes back when it leaves', async () => {
      const c = await open();

      await c.fire(c.stop(1), new Event('pointerenter'));
      expect(c.readout()).toContain('July 2026 · Closed month');
      expect(c.legend()).toContain('Spent €1,425.00');

      await c.fire(c.stop(1), new Event('pointerleave'));
      expect(c.readout()).toContain('October 2026 · Current month');
    });

    it('marks the month in focus on the axis', async () => {
      const c = await open();
      const bold = () =>
        Array.from(c.svg().querySelectorAll('text.font-semibold')).map((t) =>
          t.textContent?.trim(),
        );
      expect(bold()).toEqual(['Oct']);

      await c.fire(c.stop(2), new Event('pointerenter'));
      expect(bold()).toEqual(['Aug']);
    });

    it('enlarges the markers of the month in focus', async () => {
      const c = await open();
      const sizes = () =>
        Array.from(c.svg().querySelectorAll('path.stroke-surface')).map((m) => m.getAttribute('d'));
      const before = sizes();

      await c.fire(c.stop(0), new Event('pointerenter'));
      const after = sizes();
      // Markers come in lines of five months. June's three grow, and October's three shrink back.
      const changed = after.flatMap((d, i) => (d !== before[i] ? [i] : []));
      expect(changed).toEqual([0, 4, 5, 9, 10, 14]);
    });

    it('follows the keyboard: a stop in focus is the month shown', async () => {
      const c = await open();

      await c.focus(c.stop(3));
      expect(c.readout()).toContain('September 2026');

      c.stop(3).blur();
      await settle(c.fixture);
      expect(c.readout()).toContain('October 2026');
    });

    it('has one tab stop for the whole chart, which remembers where it was', async () => {
      const c = await open();
      // Tab lands on the last month (the selected one); the others are reached with the arrows.
      expect(c.tabindexes()).toEqual(['-1', '-1', '-1', '-1', '0']);

      await c.focus(c.stop(1));
      expect(c.tabindexes()).toEqual(['-1', '0', '-1', '-1', '-1']);
    });

    it('moves between months with the arrow keys, Home and End, and stops at the ends', async () => {
      const c = await open();
      await c.focus(c.stop(4));

      await c.key(c.stop(4), 'ArrowLeft');
      expect(document.activeElement).toBe(c.stop(3));
      expect(c.readout()).toContain('September 2026');

      await c.key(c.stop(3), 'Home');
      expect(document.activeElement).toBe(c.stop(0));
      await c.key(c.stop(0), 'ArrowLeft');
      expect(document.activeElement).toBe(c.stop(0));

      await c.key(c.stop(0), 'ArrowRight');
      expect(document.activeElement).toBe(c.stop(1));

      await c.key(c.stop(1), 'End');
      expect(document.activeElement).toBe(c.stop(4));
      await c.key(c.stop(4), 'ArrowRight');
      expect(document.activeElement).toBe(c.stop(4));
    });

    it('leaves the other keys alone', async () => {
      const c = await open();
      const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      c.stop(2).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);

      const arrow = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      });
      c.stop(2).dispatchEvent(arrow);
      // The arrow keys move focus instead of scrolling the page.
      expect(arrow.defaultPrevented).toBe(true);
    });

    it('keeps a month that was tapped, until another is tapped, it is tapped again, or Escape is pressed', async () => {
      const c = await open();

      await c.fire(c.stop(2), new Event('click'));
      // A touch pointer "leaves" as soon as the finger lifts: the tapped month stays.
      await c.fire(c.stop(2), new Event('pointerleave'));
      expect(c.readout()).toContain('August 2026');

      await c.fire(c.stop(0), new Event('click'));
      expect(c.readout()).toContain('June 2026');

      await c.key(c.stop(0), 'Escape');
      expect(c.readout()).toContain('October 2026');

      await c.fire(c.stop(1), new Event('click'));
      expect(c.readout()).toContain('July 2026');
      await c.fire(c.stop(1), new Event('click'));
      expect(c.readout()).toContain('October 2026');
    });

    it('lets go of a tapped month when the user taps anywhere outside the chart', async () => {
      const c = await open();
      await c.fire(c.stop(1), new Event('click'));
      expect(c.readout()).toContain('July 2026');

      // Pressing down on the chart itself is part of the tap that pins: nothing is released.
      await c.fire(c.stop(1), new Event('pointerdown', { bubbles: true }));
      expect(c.readout()).toContain('July 2026');

      await c.fire(document.body, new Event('pointerdown', { bubbles: true }));
      expect(c.readout()).toContain('October 2026');
    });

    it('does nothing about a tap elsewhere when no month is kept', async () => {
      const c = await open();
      await c.focus(c.stop(2));
      await c.fire(document.body, new Event('pointerdown', { bubbles: true }));
      // The keyboard still has August.
      expect(c.readout()).toContain('August 2026');
    });

    it('shows what the pointer is over before what was tapped', async () => {
      const c = await open();
      await c.fire(c.stop(2), new Event('click'));
      await c.fire(c.stop(3), new Event('pointerenter'));
      expect(c.readout()).toContain('September 2026');
      await c.fire(c.stop(3), new Event('pointerleave'));
      expect(c.readout()).toContain('August 2026');
    });

    it('follows whichever the user used last, the pointer or the keyboard', async () => {
      const c = await open();
      await c.focus(c.stop(3));
      expect(c.readout()).toContain('September 2026');

      // The pointer rests over July while the keyboard is on September: the pointer moved last.
      await c.fire(c.stop(1), new Event('pointerenter'));
      expect(c.readout()).toContain('July 2026');

      // An arrow key is the latest input now, so the keyboard leads again even though the pointer is still over July.
      await c.key(c.stop(3), 'ArrowLeft');
      expect(c.readout()).toContain('August 2026');

      // Once the pointer leaves, the keyboard is all that is left either way.
      await c.fire(c.stop(1), new Event('pointerleave'));
      expect(c.readout()).toContain('August 2026');
    });

    it('covers the whole plot with the months, each as wide as its share, so aiming only has to be close', async () => {
      const c = await open();
      const boxes = c.stops().map((s) => ({
        left: parseFloat(s.style.left),
        width: parseFloat(s.style.width),
      }));

      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i].left).toBeCloseTo(boxes[i - 1].left + boxes[i - 1].width, 1);
      }
      expect(boxes.every((box) => box.width > 24)).toBe(true);
    });
  });

  describe('text alternatives', () => {
    it('gives each month a name that lists all its figures', async () => {
      const c = await open();

      expect(c.stops().map((s) => s.getAttribute('aria-label'))).toEqual([
        'June 2026, closed month: Income €2,500.00, Spent €1,520.00, Saved +€935.00',
        'July 2026, closed month: Income €2,500.00, Spent €1,425.00, Saved -€300.00',
        'August 2026, closed month: Income €2,500.00, Spent €1,200.00, Saved +€1,120.00',
        'September 2026, closed month: Income €2,700.00, Spent €900.00, Saved +€1,500.00',
        'October 2026, current month: Income €2,700.00, Spent €100.00, Saved +€2,400.00',
      ]);
    });

    it('groups the months under a name, and says how to move between them', async () => {
      const c = await open();
      const group = getByRole(c.element, 'group', 'Months');
      const hint = c.element.querySelector(`#${group.getAttribute('aria-describedby')}`);
      expect(hint?.textContent).toContain('arrow keys');
      expect(group.contains(c.stop(0))).toBe(true);
    });

    it('is also a table, with headers, that a screen reader always has', async () => {
      const c = await open();
      const table = c.table();

      expect(queryAllByRole(table, 'columnheader').map(textOf)).toEqual([
        'Month',
        'Status',
        'Income',
        'Spent',
        'Saved',
      ]);
      expect(queryAllByRole(table, 'rowheader').map(textOf)).toEqual([
        'June 2026',
        'July 2026',
        'August 2026',
        'September 2026',
        'October 2026',
      ]);
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()),
      );
      expect(rows[0]).toEqual(['Closed month', '€2,500.00', '€1,520.00', '+€935.00']);
      // A negative amount keeps its minus sign.
      expect(rows[1]).toEqual(['Closed month', '€2,500.00', '€1,425.00', '-€300.00']);
      expect(rows[4]).toEqual(['Current month', '€2,700.00', '€100.00', '+€2,400.00']);
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

      getByRole(c.element, 'button', 'Hide table').click();
      await settle(c.fixture);
      expect(wrapper().className).toContain('sr-only');
    });

    it('leaves out the status column when no month has a note', async () => {
      const c = await open({ categories: CATEGORIES.map((c2) => ({ ...c2, note: null })) });
      expect(queryAllByRole(c.table(), 'columnheader').map(textOf)).toEqual([
        'Month',
        'Income',
        'Spent',
        'Saved',
      ]);
      expect(c.stop(4).getAttribute('aria-label')).toBe(
        'October 2026: Income €2,700.00, Spent €100.00, Saved +€2,400.00',
      );
    });
  });

  describe('any data', () => {
    const noNaN = (c: ReturnType<typeof chart>) => expect(c.element.innerHTML).not.toContain('NaN');

    it('keeps every figure on the page when all of them are zero', async () => {
      const zero = SERIES.map((s) => ({ ...s, values: s.values.map(() => 0) }));
      const c = await open({ series: zero });

      noNaN(c);
      // An axis of its own, with the zero line at the bottom, and flat lines on it.
      expect(c.svgTexts().slice(0, 3)).toEqual(['€0', '€5', '€10']);
      expect(c.legend()).toBe('Income €0.00 Spent €0.00 Saved €0.00');
    });

    it('puts all-negative figures below the zero line', async () => {
      const negative = SERIES.map((s) => ({ ...s, values: s.values.map(() => -25000) }));
      const c = await open({ series: negative });

      noNaN(c);
      expect(c.svgTexts().slice(0, 4)).toEqual(['-€300', '-€200', '-€100', '€0']);
      expect(c.legend()).toBe('Income -€250.00 Spent -€250.00 Saved -€250.00');
    });

    it('shows a single month as markers only, and says why there is no line', async () => {
      const c = await open({
        categories: [category('2026-10', 'current')],
        series: SERIES.map((s) => ({ ...s, values: s.values.slice(-1) })),
      });

      noNaN(c);
      expect(c.svg().querySelectorAll('path[fill="none"]')).toHaveLength(0);
      expect(c.svg().querySelectorAll('path.stroke-surface')).toHaveLength(3);
      expect(c.stops()).toHaveLength(1);
      expect(textOf(c.element)).toContain('There is only one month to show');
      expect(c.legend()).toBe('Income €2,700.00 Spent €100.00 Saved +€2,400.00');
    });

    it('draws a line through two months, from one end of the plot to the other', async () => {
      const c = await open({
        categories: CATEGORIES.slice(-2),
        series: SERIES.map((s) => ({ ...s, values: s.values.slice(-2) })),
      });
      expect(c.svg().querySelectorAll('path[fill="none"]')).toHaveLength(3);
      noNaN(c);
    });

    it('survives having nothing to show', async () => {
      const c = await open({ categories: [], series: SERIES.map((s) => ({ ...s, values: [] })) });

      noNaN(c);
      expect(c.stops()).toHaveLength(0);
      expect(queryByRole(c.element, 'list', 'Legend')).toBeNull();
      expect(c.svgTexts().slice(0, 3)).toEqual(['€0', '€5', '€10']);
    });

    it('treats a missing value as zero rather than breaking', async () => {
      const c = await open({
        series: [{ key: 'income', label: 'Income', slot: 1, values: [100000, 200000] }],
      });
      noNaN(c);
      expect(c.stop(4).getAttribute('aria-label')).toContain('Income €0.00');
    });

    it('formats the amounts in the currency and locale of the settings', async () => {
      await primeStores(http, { settings: { ...SETTINGS, currency: 'USD', locale: 'en-US' } });
      const fixture = await render(Host);
      fixture.componentInstance.categories.set(CATEGORIES);
      fixture.componentInstance.series.set(SERIES);
      await settle(fixture);

      expect(textOf(getByRole(fixture.nativeElement, 'list', 'Legend'))).toContain('$2,700.00');
    });
  });

  describe('twelve months', () => {
    const MONTHS = monthRange('2025-11', '2026-10');
    const TWELVE = MONTHS.map((month) =>
      category(month, month === '2026-10' ? 'current' : 'closed'),
    );
    const SERIES_12: LineChartSeries[] = [
      { key: 'income', label: 'Income', slot: 1, values: MONTHS.map(() => 320000) },
      { key: 'spent', label: 'Spent', slot: 2, values: MONTHS.map((_m, i) => 150000 + i * 4000) },
      {
        key: 'saved',
        label: 'Saved',
        slot: 3,
        values: MONTHS.map((_m, i) => (i === 4 ? -112000 : 100000)),
        signed: true,
      },
    ];
    const monthLabels = (texts: (string | undefined)[]) => texts.filter((t) => !t?.includes('€'));

    it('labels every month, with the year under the first and wherever it changes', async () => {
      const c = await open({ categories: TWELVE, series: SERIES_12 });

      expect(monthLabels(c.svgTexts())).toEqual([
        'Nov',
        '2025',
        'Dec',
        'Jan',
        '2026',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
      ]);
      expect(c.stops()).toHaveLength(12);
      // One tab stop, on the selected (last) month.
      expect(c.tabindexes().filter((t) => t === '0')).toHaveLength(1);
      expect(c.tabindexes().at(-1)).toBe('0');
    });

    it('labels every other month on a phone, counting back from the selected one', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const c = await open({ categories: TWELVE, series: SERIES_12 });
      FakeResizeObserver.instances[0].resize(324);
      await settle(c.fixture);

      // The year is written under the first label and again where it changes (January is skipped).
      expect(monthLabels(c.svgTexts())).toEqual([
        'Dec',
        '2025',
        'Feb',
        '2026',
        'Apr',
        'Jun',
        'Aug',
        'Oct',
      ]);
      // Every month can still be reached.
      expect(c.stops()).toHaveLength(12);
    });

    it('reaches below zero for the month that takes money from savings', async () => {
      const c = await open({ categories: TWELVE, series: SERIES_12 });

      expect(c.svgTexts().filter((t) => t?.includes('€'))).toEqual([
        '-€2,000',
        '€0',
        '€2,000',
        '€4,000',
      ]);
      await c.fire(c.stop(4), new Event('pointerenter'));
      expect(c.readout()).toContain('March 2026');
      expect(c.legend()).toContain('Saved -€1,120.00');
    });
  });

  describe('on a narrow screen', () => {
    it('lays out in the width it has, and labels fewer months so the labels never touch', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const c = await open();
      // Wide: every month is labelled.
      expect(c.svgTexts().filter((t) => /^(Jun|Jul|Aug|Sep|Oct)$/.test(t ?? ''))).toHaveLength(5);

      FakeResizeObserver.instances[0].resize(200);
      await settle(c.fixture);

      // Narrow: every other month, counting back from the selected one, with the year under the first.
      expect(c.svgTexts().slice(5)).toEqual(['Jun', '2026', 'Aug', 'Oct']);
      expect(c.svg().getAttribute('viewBox')).toBe('0 0 200 256');
      // The months are still all there for the pointer and the keyboard.
      expect(c.stops()).toHaveLength(5);
    });

    it('keeps the last width when the chart is measured as hidden', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const c = await open();
      FakeResizeObserver.instances[0].resize(300);
      await settle(c.fixture);
      FakeResizeObserver.instances[0].resize(0);
      await settle(c.fixture);

      expect(c.svg().getAttribute('viewBox')).toBe('0 0 300 256');
    });
  });
});
