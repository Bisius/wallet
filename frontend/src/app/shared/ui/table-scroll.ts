import { Component, ElementRef, input, viewChild } from '@angular/core';

/**
 * The box a table scrolls sideways in when it is wider than the screen: it keeps the page from
 * scrolling instead. Put the table inside it, with the `data-table` class:
 *
 * ```html
 * <app-table-scroll label="Figures per month">
 *   <table class="data-table min-w-[40rem]"><caption class="sr-only">…</caption>…</table>
 * </app-table-scroll>
 * ```
 *
 * The box is a named region that the keyboard can stop on (`tabindex="0"`), which is what lets a
 * keyboard user scroll it with the arrow keys and what axe asks of any region that scrolls
 * (`scrollable-region-focusable`). `label` names it for a screen reader: it says what is in it, as
 * the table's caption does ("Rows of the file"). A table narrower than the box makes it inert.
 *
 * Code that moves the keyboard to the table (after a page of rows is replaced) uses `focus()`.
 */
@Component({
  selector: 'app-table-scroll',
  template: `
    <div #region role="region" tabindex="0" class="table-scroll" [attr.aria-label]="label()">
      <ng-content />
    </div>
  `,
  host: { class: 'block' },
})
export class TableScroll {
  /** What is in the table: it names the region. */
  readonly label = input.required<string>();

  private readonly region = viewChild.required<ElementRef<HTMLElement>>('region');

  /** Puts the keyboard on the box. */
  focus(): void {
    this.region().nativeElement.focus();
  }

  /** Scrolls the box into view. */
  scrollIntoView(options?: ScrollIntoViewOptions): void {
    this.region().nativeElement.scrollIntoView(options);
  }
}
