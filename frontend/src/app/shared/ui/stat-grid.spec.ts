import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { render, settle } from '../../../testing/harness';
import { Stat } from './stat';
import { StatGrid, type StatColumns } from './stat-grid';

@Component({
  selector: 'app-stat-grid-host',
  imports: [Stat, StatGrid],
  template: `
    <dl appStatGrid id="default">
      <div appStat label="One">1</div>
      <div appStat label="Two">2</div>
    </dl>
    <dl appStatGrid id="chosen" [columns]="columns()">
      <div appStat label="One">1</div>
      <div appStat label="Two">2</div>
    </dl>
    <dl appStatGrid id="attribute" columns="5">
      <div appStat label="One">1</div>
    </dl>
    <dl appStatGrid id="compact" compact [columns]="3">
      <div appStat label="One" variant="plain">1</div>
    </dl>
  `,
})
class StatGridHost {
  readonly columns = signal<StatColumns>(3);
}

describe('StatGrid', () => {
  async function setup() {
    const fixture = await render(StatGridHost);
    const element = fixture.nativeElement as HTMLElement;
    const grid = (id: string) => element.querySelector(`#${id}`) as HTMLElement;
    const basis = (id: string) => [...grid(id).classList].find((name) => name.includes('basis-'));
    return { fixture, host: fixture.componentInstance, element, grid, basis };
  }

  it('is the description list itself, so the figures are its direct children', async () => {
    const { grid } = await setup();

    expect(grid('default').tagName).toBe('DL');
    expect(Array.from(grid('default').children).map((child) => child.tagName)).toEqual([
      'DIV',
      'DIV',
    ]);
  });

  it('wraps: a figure too wide for its row takes a row of its own instead of widening the page', async () => {
    const { grid } = await setup();

    expect(grid('default').classList).toContain('flex');
    expect(grid('default').classList).toContain('flex-wrap');
    expect(grid('default').classList).toContain('*:grow');
  });

  it('puts at most four figures on a row unless it is told otherwise, and never fewer than fit', async () => {
    const { basis } = await setup();

    // A share of the row, but never narrower than 8.5rem.
    expect(basis('default')).toBe('*:basis-[max(8.5rem,calc((100%_-_2.25rem)/4))]');
  });

  it('puts the chosen number of figures on a row, and follows when it changes', async () => {
    const { fixture, host, basis } = await setup();
    expect(basis('chosen')).toBe('*:basis-[max(8.5rem,calc((100%_-_1.5rem)/3))]');

    host.columns.set(2);
    await settle(fixture);
    expect(basis('chosen')).toBe('*:basis-[max(8.5rem,calc((100%_-_0.75rem)/2))]');

    host.columns.set(5);
    await settle(fixture);
    expect(basis('chosen')).toBe('*:basis-[max(8.5rem,calc((100%_-_3rem)/5))]');
  });

  it('takes the number as an attribute, from two to five', async () => {
    const { basis } = await setup();

    expect(basis('attribute')).toBe('*:basis-[max(8.5rem,calc((100%_-_3rem)/5))]');
  });

  it('needs less room per figure when they have no tile around them (compact): 6rem, not 8.5rem', async () => {
    const { basis } = await setup();

    expect(basis('compact')).toBe('*:basis-[max(6rem,calc((100%_-_1.5rem)/3))]');
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
