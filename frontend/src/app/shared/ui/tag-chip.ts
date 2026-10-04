import { Component, computed, input } from '@angular/core';
import { Icon } from './icon';

/**
 * A tag as a small pill: a marker, then its name. The name is what tells tags apart, so the color is
 * never the only signal: a tag with a color gets a dot (ringed, so it shows on a light and a dark
 * surface alike) and one without gets the tag icon. Anything projected goes after the name, which is
 * where the tag input puts its remove button.
 *
 * In the `color` mode the chip is a plain label with an optional colored dot, for something that is
 * not a tag but has a color (the budget of a spending): without a color it has no marker at all,
 * where a tag would show the tag icon.
 */
@Component({
  selector: 'app-tag-chip',
  imports: [Icon],
  template: `
    <span [class]="classes()">
      @if (color(); as color) {
        <span
          aria-hidden="true"
          class="size-2.5 shrink-0 rounded-full ring-1 ring-line-strong"
          [style.background-color]="color"
        ></span>
      } @else if (mode() === 'tag') {
        <app-icon name="tag" class="text-muted" />
      }
      <span class="min-w-0 break-words">{{ name() }}</span>
      <ng-content />
    </span>
  `,
  host: { class: 'inline-flex max-w-full' },
})
export class TagChip {
  readonly name = input.required<string>();
  /** A `#rrggbb` color, or null for a tag without one. */
  readonly color = input<string | null>(null);
  /** `tag` marks a chip without a color with the tag icon, `color` leaves it without a marker. */
  readonly mode = input<'tag' | 'color'>('tag');
  /** `md` is for the tag input, where the chip carries a remove button. */
  readonly size = input<'sm' | 'md'>('sm');

  protected readonly classes = computed(
    () =>
      'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-surface font-medium text-ink ' +
      (this.size() === 'md' ? 'py-0.5 pr-1 pl-2.5 text-sm' : 'px-2 py-0.5 text-xs'),
  );
}
