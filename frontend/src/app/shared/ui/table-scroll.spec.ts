import { Component, viewChild } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole } from '../../../testing/dom';
import { render } from '../../../testing/harness';
import { TableScroll } from './table-scroll';

@Component({
  selector: 'app-table-scroll-host',
  imports: [TableScroll],
  template: `
    <app-table-scroll label="Figures per month">
      <table class="data-table">
        <caption class="sr-only">
          Figures per month in 2026
        </caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col" class="cell-num">Income</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">January</th>
            <td class="cell-num">€2,500.00</td>
          </tr>
        </tbody>
      </table>
    </app-table-scroll>
  `,
})
class TableScrollHost {
  readonly scroll = viewChild.required(TableScroll);
}

describe('TableScroll', () => {
  async function setup() {
    const fixture = await render(TableScrollHost);
    const element = fixture.nativeElement as HTMLElement;
    const region = getByRole(element, 'region', 'Figures per month');
    return { fixture, host: fixture.componentInstance, element, region };
  }

  it('is a region named for what is in it, around the table it is given', async () => {
    const { region } = await setup();

    expect(region.querySelector('table')).not.toBeNull();
    expect(getByRole(region, 'table', 'Figures per month in 2026')).toBeTruthy();
  });

  it('is a stop for the keyboard, so that a table that scrolls can be scrolled with it', async () => {
    const { region } = await setup();

    expect(region.getAttribute('tabindex')).toBe('0');
    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it('scrolls sideways inside its own rounded box, and never the page', async () => {
    const { region } = await setup();

    expect(region.classList).toContain('table-scroll');
  });

  it('takes focus from code', async () => {
    const { host, region } = await setup();

    host.scroll().focus();

    expect(document.activeElement).toBe(region);
  });

  it('can be scrolled into view', async () => {
    const { host, region } = await setup();
    const scrollIntoView = vi.spyOn(region, 'scrollIntoView');

    host.scroll().scrollIntoView({ block: 'nearest' });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('holds the table the way the app draws one: numbers to the right', async () => {
    const { region } = await setup();

    expect(
      queryAllByRole(region, 'columnheader').map((cell) => cell.classList.contains('cell-num')),
    ).toEqual([false, true]);
    expect(region.querySelector('table')?.classList).toContain('data-table');
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element } = await setup();
    expect(a11yProblems(element)).toEqual([]);
  });
});
