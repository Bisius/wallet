import { Component, computed, input, model } from '@angular/core';
import { Icon } from './icon';

/** `section` reads like the title of a block that is folded away, `inline` like a link in a text. */
export type DisclosureSize = 'section' | 'inline';

const SUMMARY_BASE =
  'flex cursor-pointer list-none items-center gap-2 rounded-control [&::-webkit-details-marker]:hidden';

const SUMMARY: Record<DisclosureSize, string> = {
  // 44 px tall: it is the only way into what is folded, so it is as easy to hit as a button.
  section: `${SUMMARY_BASE} min-h-11 text-section-title`,
  inline: `${SUMMARY_BASE} py-1 text-sm font-medium text-accent-text`,
};

const BODY: Record<DisclosureSize, string> = {
  section: 'mt-3',
  inline: 'mt-2',
};

/**
 * Something folded away until it is asked for: `<app-disclosure summary="Amount history (3)">…</app-disclosure>`.
 * It is a native `<details>`, so the keyboard (Enter and Space on the summary), the focus ring and
 * the find-in-page behavior are the browser's; the browser's own triangle is replaced by a chevron
 * that turns when it is open (it only animates for people who have not asked for reduced motion).
 *
 * The summary is the `summary` input, and what is projected into an element marked
 * `disclosureSummary` goes after it (a `sr-only` span that says what the summary is about when the
 * page has several of them). `open` is two-way, for the few callers that fold it up themselves.
 *
 * Never put a card inside a card: a `section` disclosure is not a card, it holds one or several.
 */
@Component({
  selector: 'app-disclosure',
  imports: [Icon],
  template: `
    <details class="group" [open]="open()" (toggle)="onToggle($event)">
      <summary [class]="summaryClasses()">
        <app-icon
          name="chevron-down"
          class="motion-safe:transition-transform motion-safe:duration-150 group-open:rotate-180"
        />
        <span class="min-w-0">{{ summary() }}<ng-content select="[disclosureSummary]" /></span>
      </summary>
      <div [class]="bodyClasses()">
        <ng-content />
      </div>
    </details>
  `,
  host: { class: 'block' },
})
export class Disclosure {
  /** What the folded content is, as the summary says it: "Upcoming and ended budgets (2)". */
  readonly summary = input<string>('');
  readonly size = input<DisclosureSize>('inline');
  /** Whether it is unfolded. */
  readonly open = model(false);

  protected readonly summaryClasses = computed(() => SUMMARY[this.size()]);
  protected readonly bodyClasses = computed(() => BODY[this.size()]);

  protected onToggle(event: Event): void {
    this.open.set((event.target as HTMLDetailsElement).open);
  }
}
