import { Component, input } from '@angular/core';

/** One row of a chart's table: a header cell (the category) and one cell per other column. */
export interface ChartTableRow {
  header: string;
  cells: readonly string[];
}

/**
 * The same numbers as a chart, as a real table: the text alternative every chart carries. By default
 * it is visually hidden but stays in the accessibility tree, so a screen reader reads the figures
 * with row and column headers. `visible` shows it for everyone (the chart's "Show table" button).
 *
 * The first of `columns` heads the row headers, and the rest head `cells`.
 */
@Component({
  selector: 'app-chart-table',
  template: `
    <div [class]="visible() ? 'table-scroll' : 'sr-only'" [attr.id]="tableId()">
      <table class="data-table">
        <caption [class]="visible() ? 'px-3 py-2 text-left font-medium' : 'sr-only'">
          {{
            caption()
          }}
        </caption>
        <thead>
          <tr>
            @for (column of columns(); track $index) {
              <th scope="col" [class.cell-num]="$index > 0">
                {{ column }}
              </th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track $index) {
            <tr>
              <th scope="row" class="whitespace-nowrap">{{ row.header }}</th>
              @for (cell of row.cells; track $index) {
                <td class="cell-num">{{ cell }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  // Hidden for the eye it takes no room of its own (`contents`), so it adds no gap under the chart.
  host: { '[class]': 'visible() ? "block" : "contents"' },
})
export class ChartTable {
  /** What the table lists, as its caption. */
  readonly caption = input.required<string>();
  readonly columns = input.required<readonly string[]>();
  readonly rows = input.required<readonly ChartTableRow[]>();
  /** Show the table to everyone instead of only to assistive technology. */
  readonly visible = input(false);
  /** An id for the table's box, so a button can say it controls it (`aria-controls`). */
  readonly tableId = input<string>();
}
