import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { a11yProblems } from '../../../testing/a11y';
import { textOf } from '../../../testing/dom';
import { primeStores, render, settle } from '../../../testing/harness';
import { Icon } from './icon';
import { Stat, StatNote, type StatSize, type StatTone, type StatVariant } from './stat';
import { StatGrid } from './stat-grid';

@Component({
  selector: 'app-stat-host',
  imports: [Stat, StatNote, StatGrid, Icon],
  template: `
    <dl appStatGrid>
      <div appStat id="income" label="Income" [cents]="250000"></div>
      <div appStat id="owed" label="Unallocated" [cents]="-4000">
        <dd statNote tone="negative">
          <app-icon name="alert" />
          Over-allocated
        </dd>
      </div>
      <div
        appStat
        id="saved"
        label="Saved"
        [cents]="-12000"
        [signed]="true"
        plain
        hint="Due to savings"
      ></div>
      <div appStat id="in" label="Refunded" [cents]="3000" [signed]="true"></div>
      <div
        appStat
        id="count"
        label="Rows found"
        [size]="size()"
        [tone]="tone()"
        [variant]="variant()"
      >
        42
      </div>
      <div appStat id="below" label="Balance" [cents]="0">
        <dd statNote tone="ink">Below zero.</dd>
        <dd statNote>Muted by default.</dd>
      </div>
    </dl>
  `,
})
class StatHost {
  readonly size = signal<StatSize>('md');
  readonly tone = signal<StatTone>('neutral');
  readonly variant = signal<StatVariant>('tile');
}

describe('Stat', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    const fixture = await render(StatHost);
    await primeStores(http);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const stat = (id: string) => element.querySelector(`#${id}`) as HTMLElement;
    const term = (id: string) => stat(id).querySelector('dt') as HTMLElement;
    const values = (id: string) => Array.from(stat(id).querySelectorAll('dd'));
    return { fixture, host: fixture.componentInstance, element, stat, term, values };
  }

  describe('as a description list', () => {
    it('is a term and its definition, so a screen reader hears "label, value"', async () => {
      const { stat, term, values } = await setup();

      expect(textOf(term('income'))).toBe('Income');
      expect(textOf(values('income')[0])).toBe('€2,500.00');
      expect(stat('income').parentElement?.tagName).toBe('DL');
      expect(Array.from(stat('income').children).map((child) => child.tagName)).toEqual([
        'DT',
        'DD',
      ]);
    });

    it('keeps the shape of a description list that HTML allows: dl > div > dt + dd, and nothing else', async () => {
      const { element } = await setup();

      const list = element.querySelector('dl') as HTMLElement;
      expect(Array.from(list.children).every((child) => child.tagName === 'DIV')).toBe(true);
      for (const child of Array.from(list.children)) {
        expect(
          Array.from(child.children).every(
            (part) => part.tagName === 'DT' || part.tagName === 'DD',
          ),
        ).toBe(true);
      }
    });
  });

  describe('the value', () => {
    it('is money with its minus sign and its color, so the sign carries the meaning', async () => {
      const { stat, values } = await setup();

      expect(textOf(values('owed')[0])).toBe('-€40.00');
      expect(stat('owed').querySelector('app-amount span')?.classList).toContain('text-negative');
    });

    it('can keep the text color of a negative amount, and still shows the sign', async () => {
      const { stat, values } = await setup();

      expect(textOf(values('saved')[0])).toBe('-€120.00');
      expect(stat('saved').querySelector('app-amount span')?.classList).not.toContain(
        'text-negative',
      );
    });

    it('can show the plus of money that came in', async () => {
      const { values } = await setup();

      expect(textOf(values('in')[0])).toBe('+€30.00');
    });

    it('is the content of the element when it is not money: a count', async () => {
      const { stat, values } = await setup();

      expect(textOf(values('count')[0])).toBe('42');
      expect(stat('count').querySelector('app-amount')).toBeNull();
    });

    it('is a figure of 20 px (md) or the big one of a page (lg), in tabular numerals', async () => {
      const { fixture, host, values } = await setup();
      expect(values('count')[0].classList).toContain('text-stat');

      host.size.set('lg');
      await settle(fixture);

      expect(values('count')[0].classList).toContain('text-kpi');
      expect(values('count')[0].classList).not.toContain('text-stat');
    });

    it('can be colored when it is not money, and the color is never all there is to say', async () => {
      const { fixture, host, values } = await setup();
      expect(values('count')[0].classList).not.toContain('text-warning');

      host.tone.set('warning');
      await settle(fixture);

      expect(values('count')[0].classList).toContain('text-warning');
      expect(textOf(values('count')[0])).toBe('42');
    });
  });

  describe('under the figure', () => {
    it('has a muted hint, a line of its own after the value', async () => {
      const { values } = await setup();

      const [value, hint] = values('saved');
      expect(textOf(value)).toBe('-€120.00');
      expect(textOf(hint)).toBe('Due to savings');
      expect(hint.classList).toContain('text-muted');
    });

    it('has no hint line when there is none', async () => {
      const { values } = await setup();

      expect(values('income')).toHaveLength(1);
    });

    it('has notes that carry an icon with the words: a flag is never its color alone', async () => {
      const { values } = await setup();

      const note = values('owed')[1];
      expect(textOf(note)).toBe('Over-allocated');
      expect(note.classList).toContain('text-negative');
      expect(note.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('has notes in the muted or the ink color, after the value', async () => {
      const { values } = await setup();

      const [, ink, muted] = values('below');
      expect(textOf(ink)).toBe('Below zero.');
      expect(ink.classList).toContain('text-ink');
      expect(textOf(muted)).toBe('Muted by default.');
      expect(muted.classList).toContain('text-muted');
    });
  });

  describe('the surface', () => {
    it('is a soft tile with no border of its own: never a bordered box inside a card', async () => {
      const { stat } = await setup();

      expect(stat('income').classList).toContain('bg-subtle');
      expect(stat('income').classList).toContain('rounded-control');
      expect([...stat('income').classList].some((name) => name.startsWith('border'))).toBe(false);
    });

    it('can be plain, for a figure that sits on a surface that is already there', async () => {
      const { fixture, host, stat } = await setup();

      host.variant.set('plain');
      await settle(fixture);

      expect(stat('count').classList).not.toContain('bg-subtle');
      expect(stat('count').classList).not.toContain('p-3');
    });

    it('labels in the caption style: small, medium weight and muted', async () => {
      const { term } = await setup();

      expect(term('income').classList).toContain('text-label');
    });
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { fixture, host, element } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    host.size.set('lg');
    host.variant.set('plain');
    await settle(fixture);
    expect(a11yProblems(element)).toEqual([]);
  });
});
