import { Component, computed, input } from '@angular/core';

/** `wide` (72rem) for pages of cards side by side and tables, `narrow` (48rem) for a single column. */
export type PageWidth = 'wide' | 'narrow';

const WIDTHS: Record<PageWidth, string> = {
  wide: 'max-w-6xl',
  narrow: 'max-w-3xl',
};

/**
 * The container of a routed page: `<app-page width="wide"><app-page-header title="…" />…</app-page>`.
 * It centers the content, limits it to one of two widths so moving between pages never makes the
 * content jump, and spaces what is inside it (the header, then each section) by 1.5rem. Put the
 * sections directly inside it, not in another wrapper, and never set a `max-w-*` on a page.
 *
 * It is a flex column with a gap, not a stack of margins, so a child that is not a block (a custom
 * element without `display: block`) is spaced like any other.
 */
@Component({
  selector: 'app-page',
  template: `<ng-content />`,
  host: { '[class]': 'classes()' },
})
export class AppPage {
  readonly width = input<PageWidth>('wide');

  protected readonly classes = computed(
    () => `mx-auto flex flex-col gap-6 ${WIDTHS[this.width()]}`,
  );
}
