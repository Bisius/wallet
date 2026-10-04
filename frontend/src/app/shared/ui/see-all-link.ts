import { Component, input } from '@angular/core';
import { type Params, RouterLink } from '@angular/router';
import { Icon } from './icon';
import { LinkButton } from './link-button';

/**
 * The link in the corner of a compact section that opens the page it is a short list of:
 *
 * ```html
 * <app-async-section heading="Budget progress" …>
 *   <app-see-all-link sectionAction route="/budgets" what="budgets" [queryParams]="selected.linkParams()" />
 *   …
 * </app-async-section>
 * ```
 *
 * It reads "See all" and is named for where it goes ("See all budgets": `what` is the rest of the
 * name, read by a screen reader and a voice-control user alike, and it starts with the visible words).
 * It is a real link, so it can be opened in a new tab. `queryParams` carries what the page needs to
 * show the same thing (the selected month).
 */
@Component({
  selector: 'app-see-all-link',
  imports: [Icon, LinkButton, RouterLink],
  template: `
    <a appLinkButton variant="ghost" size="sm" [routerLink]="route()" [queryParams]="queryParams()">
      See all<span class="sr-only"> {{ what() }}</span>
      <app-icon name="chevron-right" />
    </a>
  `,
  host: { class: 'contents' },
})
export class SeeAllLink {
  /** Where it goes: `/budgets`. */
  readonly route = input.required<string>();
  /** What the page holds, which completes the name: `budgets` makes "See all budgets". */
  readonly what = input.required<string>();
  /** Query parameters for the page (the month the switcher selects). */
  readonly queryParams = input<Params>();
}
