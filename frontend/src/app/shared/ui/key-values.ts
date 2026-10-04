import { booleanAttribute, Component, computed, inject, input } from '@angular/core';

/** `rows` is a label with its value at the end of the line, `stacked` puts the value under the label. */
export type KeyValuesLayout = 'rows' | 'stacked';

/**
 * A description list: what something is called and what it is. The one look of every `dl` that is
 * not a figure (a figure is a `div[appStat]`).
 *
 * ```html
 * <dl appKeyValues>
 *   <div appKeyValue label="Salary"><app-amount [cents]="income.salary" /></div>
 *   <div appKeyValue label="Total income" strong><app-amount [cents]="income.total" /></div>
 * </dl>
 * ```
 *
 * - `rows` (default): a muted label and its value on one line, with a divider between the rows. On a
 *   narrow screen, or for a value too long for the line, the value drops under its label.
 * - `stacked`: the label in small muted text with the value under it, for a value that is a block (a
 *   list, a paragraph) or a short summary.
 *
 * Like `Stat` it is a `dl` whose direct children are `div`s that hold a `dt` and a `dd`, the shape
 * of a description list that HTML and axe allow, so the screen reader hears "Salary, €2,500.00".
 */
@Component({
  selector: 'dl[appKeyValues]',
  template: `<ng-content />`,
  host: { '[class]': 'classes()' },
})
export class KeyValues {
  readonly layout = input<KeyValuesLayout>('rows');

  protected readonly classes = computed(() =>
    this.layout() === 'rows' ? 'block divide-y divide-line text-sm' : 'block space-y-2',
  );
}

/**
 * One row of `dl[appKeyValues]`: `label` is the term, what is put inside is the value.
 *
 * - `description` is a muted line under the label, inside the term (the label and what it says are
 *   read together). A label with a description is in the text color, so the two differ.
 * - `strong` makes the row the one that sums up the others: a total.
 */
@Component({
  selector: 'div[appKeyValue]',
  template: `
    <dt [class]="termClasses()">
      {{ label() }}
      @if (description()) {
        <span class="block font-normal text-muted">{{ description() }}</span>
      }
    </dt>
    <dd [class]="valueClasses()"><ng-content /></dd>
  `,
  host: { '[class]': 'classes()' },
})
export class KeyValue {
  private readonly list = inject(KeyValues);

  /** What the value is: the term of the row. */
  readonly label = input.required<string>();
  /** A muted line under the label. */
  readonly description = input<string>();
  /** The row that sums up the others (a total): semibold, and the label in the text color. */
  readonly strong = input(false, { transform: booleanAttribute });

  private readonly rows = computed(() => this.list.layout() === 'rows');

  protected readonly classes = computed(() =>
    this.rows()
      ? `flex flex-wrap items-start gap-x-4 gap-y-0.5 py-2 ${this.strong() ? 'font-semibold' : ''}`
      : 'block',
  );
  // The label takes what the value leaves, so a value is at the end of the line. A label never
  // shrinks below its longest word (no `min-w-0`), which is what drops a wide value to its own line.
  protected readonly termClasses = computed(() =>
    this.rows() ? `flex-1 ${this.strong() ? 'text-ink' : 'text-muted'}` : 'text-sm text-muted',
  );
  protected readonly valueClasses = computed(() =>
    this.rows() ? 'min-w-0 break-words' : 'font-medium break-words',
  );
}
