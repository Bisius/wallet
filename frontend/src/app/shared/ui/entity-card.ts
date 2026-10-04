import { Component, input } from '@angular/core';
import { ColorDot } from './color-dot';
import { STAT_VARIANT } from './stat';
import { StatGrid } from './stat-grid';

let nextCard = 0;

/**
 * The card of a thing the user keeps and acts on (a budget, a goal, a subscription): it is the one
 * look of all of them, so a page of them reads as one list and the markup of each stays small.
 *
 * ```html
 * <article appEntityCard heading="Groceries" [color]="budget.color" [icon]="budget.icon">
 *   <ng-container entityBadges>
 *     <app-badge>Incremental</app-badge>
 *   </ng-container>
 *
 *   <div appStat label="Available" [cents]="line.available"></div>
 *   <div appStat label="Spent" [cents]="line.spent"></div>
 *
 *   <app-budget-usage [line]="line" />
 *   <p class="text-muted">Carried in from September: …</p>
 *
 *   <ng-container entityActions>
 *     <button appButton variant="secondary" size="sm">Edit</button>
 *     <button appButton variant="secondary" size="sm">Move money</button>
 *     <app-action-menu label="More actions for Groceries">…</app-action-menu>
 *   </ng-container>
 * </article>
 * ```
 *
 * It is an `article` named by its title, a card (soft shadow, `p-4 md:p-5`) with, from the top:
 *
 * - **The title**, an `h3` (a card sits in a section, which has the `h2`). A long name wraps, a name
 *   with no break in it too. Before it is the **colour marker**: a dot (`color`; `null` is the neutral
 *   dot of something with no colour, leave it unset for none), or, where the thing has an emoji,
 *   an avatar (`icon`) ringed in the colour. Both are decoration (`aria-hidden`): the title says what
 *   the thing is, and the colour is never the only signal.
 * - **`entityBadges`**: its state in words, `app-badge`s with the tone that says what the state
 *   means. They go inside an `ng-container entityBadges`, so a state that comes and goes (`@if`)
 *   leaves no empty row behind.
 * - **The stats**: `div[appStat]` figures, laid out by the card (`statColumns`, at most 3 on a row
 *   by default). A stat inside a card is `plain` without saying so: a card holds no tile.
 * - **The body**: whatever else goes inside, small type (`text-sm`); a muted line is
 *   `<p class="text-muted">`. Never a card, and no bordered or tinted panel either: a line, a
 *   progress bar or a stat says it.
 * - **The footer**, `ng-container entityActions`: **at most two visible actions** (`appButton`,
 *   `variant="secondary"`, `size="sm"`) and one `app-action-menu` for every other action. **Destructive
 *   actions always live in the menu**, last, and ask before they do anything. The footer sits at the
 *   bottom of the card, so the cards of a row line up whatever their content, and no rule divides it
 *   from the body: space does. (Controls that come and go with a condition go inside the container,
 *   which is why it is one: a block with several roots is not projected into a slot of its own.)
 */
@Component({
  selector: 'article[appEntityCard]',
  imports: [ColorDot, StatGrid],
  providers: [{ provide: STAT_VARIANT, useValue: 'plain' }],
  template: `
    <header class="flex items-start gap-2.5">
      @if (icon(); as icon) {
        <span
          aria-hidden="true"
          class="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-line-strong bg-subtle font-emoji text-lg"
          [style.border-color]="color()"
          >{{ icon }}</span
        >
      } @else if (color() !== undefined) {
        <span appColorDot class="mt-1.5" [color]="color()"></span>
      }
      <div
        class="flex min-w-0 flex-1 flex-col gap-1.5"
        [class.min-h-9]="icon()"
        [class.justify-center]="icon()"
      >
        <h3 [id]="headingId" class="font-semibold break-words">{{ heading() }}</h3>
        <div class="flex flex-wrap gap-1.5 empty:hidden">
          <ng-content select="[entityBadges]" />
        </div>
      </div>
    </header>
    <dl appStatGrid compact class="empty:hidden" [columns]="statColumns()">
      <ng-content select="[appStat]" />
    </dl>
    <div class="space-y-3 text-sm empty:hidden">
      <ng-content />
    </div>
    <footer
      class="mt-auto flex flex-wrap items-center gap-2 empty:hidden [&>app-action-menu]:ml-auto"
    >
      <ng-content select="[entityActions]" />
    </footer>
  `,
  host: {
    class: 'card flex h-full flex-col gap-4',
    '[attr.aria-labelledby]': 'headingId',
  },
})
export class EntityCard {
  /** The title: also the name of the card. */
  readonly heading = input.required<string>();
  /** The colour marker: a `#rrggbb`, `null` for the neutral dot, unset for no marker. */
  readonly color = input<string | null>();
  /** An emoji, in an avatar before the title in place of the dot. */
  readonly icon = input<string | null>();
  /** The most figures on a row (2 to 5). */
  readonly statColumns = input(3);

  protected readonly headingId = `entity-card-${++nextCard}`;
}
