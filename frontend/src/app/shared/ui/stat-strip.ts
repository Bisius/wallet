import { Component, contentChild, input } from '@angular/core';
import { Disclosure } from './disclosure';
import { SectionHelp } from './section';

let strips = 0;

/**
 * The figures at the top of a page, with no card around them: a small heading (what they are about),
 * the status of the period beside it, the figures themselves and, folded away under them, what they
 * mean.
 *
 * ```html
 * <app-stat-strip [heading]="monthLabel() + ' at a glance'">
 *   <app-month-status stripStatus [status]="view.status" />
 *   <dl appStatGrid [columns]="3">
 *     <div appStat size="lg" label="Income" [cents]="view.income.total"></div>
 *     …
 *   </dl>
 *   <app-alert tone="error" title="Over-allocated by €50.00">…</app-alert>
 *   <p sectionHelp>This month is still running, so these figures update as you add spendings.</p>
 * </app-stat-strip>
 * ```
 *
 * - The default content is the strip itself, in the order it is written: usually one
 *   `dl[appStatGrid]` of `div[appStat]` figures (see `Stat`), then a message about them when there is
 *   one. The figures are tiles on the page, so nothing here is a card and a tile never ends up in one.
 * - `stripStatus` is a badge for the state of what is shown, in the heading's row.
 * - `sectionHelp` is the longer explanation (the same marker as `app-section`). It is shown in a
 *   "How this works" disclosure (`helpTitle`) under the figures, so the figures come first.
 * - It is a region named by its heading (an `h2`), like every titled block of a page.
 */
@Component({
  selector: 'app-stat-strip',
  imports: [Disclosure],
  template: `
    <section [attr.aria-labelledby]="headingId" class="space-y-3">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 [id]="headingId" class="text-section-title">{{ heading() }}</h2>
        <ng-content select="[stripStatus]" />
      </header>

      <ng-content />

      @if (help()) {
        <app-disclosure [summary]="helpTitle()">
          <div class="space-y-2 text-sm text-muted">
            <ng-content select="[sectionHelp]" />
          </div>
        </app-disclosure>
      }
    </section>
  `,
  host: { class: 'block' },
})
export class StatStrip {
  /** What the figures are about: also the name of the region. */
  readonly heading = input.required<string>();
  /** The title of the disclosure that holds what is marked `sectionHelp`. */
  readonly helpTitle = input('How this works');

  protected readonly help = contentChild(SectionHelp);

  protected readonly headingId = `stat-strip-heading-${++strips}`;
}
