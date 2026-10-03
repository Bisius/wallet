import { Component, signal } from '@angular/core';
import { getByRole, queryAllByRole, textOf } from '../../../../testing/dom';
import { render, settle } from '../../../../testing/harness';
import { ChartTable, type ChartTableRow } from './chart-table';

@Component({
  selector: 'app-chart-table-host',
  imports: [ChartTable],
  template: `<app-chart-table
    caption="Income by month"
    tableId="the-table"
    [columns]="['Month', 'Income', 'Spent']"
    [rows]="rows"
    [visible]="visible()"
  />`,
})
class Host {
  readonly visible = signal(false);
  readonly rows: ChartTableRow[] = [
    { header: 'September 2026', cells: ['€2,700.00', '€900.00'] },
    { header: 'October 2026', cells: ['€2,700.00', '-€100.00'] },
  ];
}

describe('ChartTable', () => {
  it('is a table with a caption, column headers and row headers', async () => {
    const fixture = await render(Host);
    const element = fixture.nativeElement as HTMLElement;
    const table = getByRole(element, 'table', 'Income by month');

    expect(queryAllByRole(table, 'columnheader').map(textOf)).toEqual(['Month', 'Income', 'Spent']);
    expect(queryAllByRole(table, 'rowheader').map(textOf)).toEqual([
      'September 2026',
      'October 2026',
    ]);
    expect(
      Array.from(table.querySelectorAll('tbody tr:last-child td')).map((td) =>
        td.textContent?.trim(),
      ),
    ).toEqual(['€2,700.00', '-€100.00']);
  });

  it('is only visually hidden by default, so a screen reader still reads it', async () => {
    const fixture = await render(Host);
    const element = fixture.nativeElement as HTMLElement;
    const box = element.querySelector('#the-table') as HTMLElement;

    expect(box.className).toBe('sr-only');
    // Hidden with the screen-reader-only utility, not display:none or aria-hidden.
    expect(box.closest('[aria-hidden="true"]')).toBeNull();
    expect(getByRole(element, 'table', 'Income by month')).toBeTruthy();
  });

  it('shows itself, with its caption, when asked to', async () => {
    const fixture = await render(Host);
    const element = fixture.nativeElement as HTMLElement;
    fixture.componentInstance.visible.set(true);
    await settle(fixture);

    const box = element.querySelector('#the-table') as HTMLElement;
    expect(box.className).not.toContain('sr-only');
    expect(box.querySelector('caption')?.className).not.toContain('sr-only');
  });
});
