import { NgTemplateOutlet } from '@angular/common';
import { booleanAttribute, Component, computed, inject, input, output } from '@angular/core';
import { ColorDot } from './color-dot';

/** `compact` is for a list that sits among other content (a dashboard card): tighter, smaller type. */
export type ListDensity = 'comfortable' | 'compact';

/**
 * A list of rows with a hairline between them: the one look of every list in the app (spendings,
 * transfers, history, tags, backups, the dashboard's upcoming renewals). It is a `ul` and its rows
 * are `li`, so a screen reader says "list, 7 items". It has no border and its rows have no box: it
 * sits flat inside its section or card, and **a card is never put inside it**.
 *
 * ```html
 * <ul appList>
 *   @for (tag of tags; track tag.id) {
 *     <li appListRow>…</li>
 *   }
 * </ul>
 * ```
 *
 * `role="list"` is spelled out because Safari with VoiceOver drops the list of a `ul` that has no
 * bullets, and Tailwind's reset removes them.
 *
 * **The actions of a row** are one rule everywhere. A row shows at most two actions, and **how**
 * depends on what they are:
 *
 * - one action that is not destructive stays a visible small button
 *   (`<button rowActions appButton variant="ghost" size="sm">`);
 * - two or more, or any that deletes or cannot be undone, go into an `app-action-menu` named for the
 *   row ("More actions for Groceries") with **every** action in it, the destructive ones last, and
 *   they ask before they do anything.
 */
@Component({
  selector: 'ul[appList]',
  template: `<ng-content />`,
  host: { role: 'list', class: 'block divide-y divide-line' },
})
export class AppList {
  readonly density = input<ListDensity>('comfortable');
}

/**
 * One row of an `ul[appList]`. What is put inside it goes where its attribute says:
 *
 * ```html
 * <li appListRow [color]="budget.color" titleLabel="Edit Coffee, €3.50" (titleClick)="edit(spending)">
 *   <span rowTitle>Coffee</span>
 *   <p rowMeta>Oct 2, 2026 · with Anna</p>
 *   <app-amount rowAmount [cents]="350" outflow />
 *   <app-action-menu rowActions label="More actions for Coffee">…</app-action-menu>
 * </li>
 * ```
 *
 * - `rowLeading`: a marker before the title (an icon). A colour dot is `color` (`null` is a neutral
 *   dot, leave it unset for none): it is decoration, the name beside it says what the colour is.
 * - `rowTitle`: what the row is. Long text wraps (a name with no break in it too), it never widens
 *   the page.
 * - `rowBody`: what a row is when it has no title but a block of its own (a description list), set
 *   where the title would be.
 * - `rowMeta`: the lines under the title (a date, badges, tags), muted and small. Each element you
 *   put there is a line of its own, laid out as a row of inline items that wraps. A note of a thousand
 *   letters with no space in it breaks wherever it has to (`overflow-wrap: anywhere`, which, unlike
 *   `break-words`, also lets a flex item shrink): it never widens the page.
 * - `rowAmount`: money, at the end of the row in tabular figures (an `app-amount`, or the text of an
 *   amount that `app-amount` cannot format, as the onboarding does before settings exist). `amountNote` is a
 *   small word under it ("a month"). The amount stays visible at 320 px: it is the title that wraps.
 * - `rowActions`: a visible small button, or an `app-action-menu` (see `AppList` for the rule).
 * - anything else goes under the row's line, the whole width of it: a progress bar, a notice.
 *
 * `titleLabel` turns the title into a button that does what the row's "Edit" does, for a row whose
 * edit is a dialog: `titleLabel` is its accessible name ("Edit Coffee, €3.50", as the old Edit
 * button was named) and `titleClick` is what it does. The menu keeps its own Edit.
 *
 * `actionsBelow` puts the actions on a line of their own under the text on a phone, for a row whose
 * description would be squeezed beside a button (the export's "Download").
 *
 * `bare` is for a row whose content is not a row at all but a form (the row of an income that is
 * being edited): no title, amount or actions, and no hover.
 *
 * The row has a hover background and, while a keyboard user is inside it, the same one: the focus
 * ring of what has focus is 3:1 against it, as it is against every surface. It is at least 44 px
 * tall, and the padding is the spacing of every row (`px-4 py-3`).
 */
@Component({
  selector: 'li[appListRow]',
  imports: [ColorDot, NgTemplateOutlet],
  template: `
    @if (!bare()) {
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div class="flex shrink-0 items-center empty:hidden">
          @if (color() !== undefined) {
            <span appColorDot [color]="color()"></span>
          }
          <ng-content select="[rowLeading]" />
        </div>
        <div class="min-w-0 flex-1 basis-32">
          @if (titleLabel(); as label) {
            <button
              type="button"
              class="-my-1 block max-w-full rounded-control py-1 text-left font-medium break-words hover:underline"
              [class]="titleSize()"
              [attr.aria-label]="label"
              (click)="titleClick.emit()"
            >
              <ng-container [ngTemplateOutlet]="title" />
            </button>
          } @else {
            <p class="font-medium break-words empty:hidden" [class]="titleSize()">
              <ng-container [ngTemplateOutlet]="title" />
            </p>
          }
          <ng-content select="[rowBody]" />
          <div
            class="mt-0.5 space-y-1 text-sm wrap-anywhere text-muted empty:hidden *:flex *:flex-wrap *:items-center *:gap-x-2 *:gap-y-1"
          >
            <ng-content select="[rowMeta]" />
          </div>
        </div>
        <div
          class="ml-auto shrink-0 text-right font-semibold tabular-nums empty:hidden"
          [class]="titleSize()"
        >
          <ng-content select="[rowAmount]" />
          @if (amountNote(); as note) {
            <span class="block text-xs font-normal text-muted">{{ note }}</span>
          }
        </div>
        <div
          class="flex shrink-0 items-center gap-1 empty:hidden [:empty+&]:ml-auto"
          [class]="actionsBelow() ? 'max-sm:basis-full' : ''"
        >
          <ng-content select="[rowActions]" />
        </div>
      </div>
    }
    <div class="mt-2 space-y-2 empty:hidden first:mt-0">
      <ng-content />
    </div>
    <ng-template #title><ng-content select="[rowTitle]" /></ng-template>
  `,
  host: { '[class]': 'classes()' },
})
export class ListRow {
  private readonly list = inject(AppList);

  /** A colour dot before the title: a `#rrggbb`, `null` for a neutral dot, unset for none. */
  readonly color = input<string | null>();
  /** A small word under the amount: "a month". */
  readonly amountNote = input<string>();
  /** Makes the title a button, and names it: "Edit Coffee, €3.50". Leave unset for a plain title. */
  readonly titleLabel = input<string>();
  /** The title button was pressed. */
  readonly titleClick = output<void>();
  /** The row holds a form or some such of its own, not title, amount and actions. */
  readonly bare = input(false, { transform: booleanAttribute });
  /**
   * On a phone the actions go on a line under the text instead of beside it (from `sm` they are at
   * the end of the row as ever). For a row whose description needs the room, with a button that
   * would squeeze it.
   */
  readonly actionsBelow = input(false, { transform: booleanAttribute });

  private readonly compact = computed(() => this.list.density() === 'compact');
  protected readonly titleSize = computed(() => (this.compact() ? 'text-sm' : ''));
  protected readonly classes = computed(
    () =>
      'block min-h-11 first:rounded-t-control last:rounded-b-control ' +
      (this.compact() ? 'px-4 py-2 ' : 'px-4 py-3 ') +
      (this.bare() ? '' : 'hover:bg-subtle has-[:focus-visible]:bg-subtle'),
  );
}
