import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { a11yProblems } from '../../../testing/a11y';
import { textOf } from '../../../testing/dom';
import { primeStores, render, settle } from '../../../testing/harness';
import { Amount } from './amount';
import { KeyValue, KeyValues, type KeyValuesLayout } from './key-values';

@Component({
  selector: 'app-key-values-host',
  imports: [KeyValues, KeyValue, Amount],
  template: `
    <dl appKeyValues [layout]="layout()">
      <div appKeyValue label="Salary"><app-amount [cents]="250000" /></div>
      <div
        appKeyValue
        label="Unallocated income"
        description="What the month earned beyond its costs."
      >
        <app-amount [cents]="-4000" [signed]="true" />
      </div>
      <div appKeyValue label="Total income" strong><app-amount [cents]="246000" /></div>
    </dl>
  `,
})
class KeyValuesHost {
  readonly layout = signal<KeyValuesLayout>('rows');
}

describe('KeyValues', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    const fixture = await render(KeyValuesHost);
    await primeStores(http);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const list = element.querySelector('dl') as HTMLElement;
    const rows = () => Array.from(list.children) as HTMLElement[];
    return { fixture, host: fixture.componentInstance, element, list, rows };
  }

  it('is a description list of label and value pairs, read as "label, value"', async () => {
    const { list, rows } = await setup();

    expect(list.tagName).toBe('DL');
    expect(rows().map((row) => row.tagName)).toEqual(['DIV', 'DIV', 'DIV']);
    expect(
      rows().map((row) => [textOf(row.querySelector('dt')!), textOf(row.querySelector('dd')!)]),
    ).toEqual([
      ['Salary', '€2,500.00'],
      ['Unallocated income What the month earned beyond its costs.', '-€40.00'],
      ['Total income', '€2,460.00'],
    ]);
    for (const row of rows()) {
      expect(Array.from(row.children).map((part) => part.tagName)).toEqual(['DT', 'DD']);
    }
  });

  it('says what is under the label inside the term, so both are read together', async () => {
    const { rows } = await setup();

    const term = rows()[1].querySelector('dt') as HTMLElement;
    expect(term.querySelector('span')?.textContent?.trim()).toBe(
      'What the month earned beyond its costs.',
    );
    expect(term.querySelector('span')?.classList).toContain('text-muted');
  });

  describe('as rows', () => {
    it('divides the rows, with the label muted and the value at the end of the line', async () => {
      const { list, rows } = await setup();

      expect(list.classList).toContain('divide-y');
      expect(rows()[0].classList).toContain('flex');
      expect(rows()[0].classList).toContain('flex-wrap');
      expect(rows()[0].querySelector('dt')?.classList).toContain('flex-1');
      expect(rows()[0].querySelector('dt')?.classList).toContain('text-muted');
    });

    it('lets a value that does not fit the line drop under its label, and wrap there', async () => {
      const { rows } = await setup();

      const value = rows()[0].querySelector('dd') as HTMLElement;
      expect(rows()[0].classList).toContain('flex-wrap');
      expect(value.classList).toContain('min-w-0');
      expect(value.classList).toContain('break-words');
      // The label keeps at least its longest word: that is what sends a wide value to its own line.
      expect(rows()[0].querySelector('dt')?.classList).not.toContain('min-w-0');
    });

    it('makes the row that sums up the others semibold, with its label in the text color', async () => {
      const { rows } = await setup();

      expect(rows()[2].classList).toContain('font-semibold');
      expect(rows()[2].querySelector('dt')?.classList).toContain('text-ink');
      expect(rows()[0].classList).not.toContain('font-semibold');
    });
  });

  describe('stacked', () => {
    it('puts the value under a small muted label, without dividers', async () => {
      const { fixture, host, list, rows } = await setup();

      host.layout.set('stacked');
      await settle(fixture);

      expect(list.classList).not.toContain('divide-y');
      expect(list.classList).toContain('space-y-2');
      expect(rows()[0].classList).not.toContain('flex');
      expect(rows()[0].querySelector('dt')?.classList).toContain('text-muted');
      expect(rows()[0].querySelector('dt')?.classList).toContain('text-sm');
      expect(rows()[0].querySelector('dd')?.classList).toContain('font-medium');
    });
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { fixture, host, element } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    host.layout.set('stacked');
    await settle(fixture);
    expect(a11yProblems(element)).toEqual([]);
  });
});
