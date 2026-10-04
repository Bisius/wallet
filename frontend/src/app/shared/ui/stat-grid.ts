import { booleanAttribute, Component, computed, input } from '@angular/core';

/** How many figures fit on a row when there is room (2 to 5). Narrower, fewer: see `StatGrid`. */
export type StatColumns = 2 | 3 | 4 | 5;

/*
 * A row of tiles that wraps. A tile is at least 8.5rem wide and at most `columns` of them share a row
 * (the other tile width is a share of the row, less the gaps). The rest is the browser's: a tile
 * whose figure is wider than a row takes a row of its own, so an amount of a hundred million never
 * pushes the page sideways, and the tiles of the last row grow to fill it.
 */
const COLUMNS: Record<StatColumns, string> = {
  2: '*:basis-[max(8.5rem,calc((100%_-_0.75rem)/2))]',
  3: '*:basis-[max(8.5rem,calc((100%_-_1.5rem)/3))]',
  4: '*:basis-[max(8.5rem,calc((100%_-_2.25rem)/4))]',
  5: '*:basis-[max(8.5rem,calc((100%_-_3rem)/5))]',
};

/** The same for figures with no tile around them (inside a card): they need less room, 6rem each. */
const COLUMNS_COMPACT: Record<StatColumns, string> = {
  2: '*:basis-[max(6rem,calc((100%_-_0.75rem)/2))]',
  3: '*:basis-[max(6rem,calc((100%_-_1.5rem)/3))]',
  4: '*:basis-[max(6rem,calc((100%_-_2.25rem)/4))]',
  5: '*:basis-[max(6rem,calc((100%_-_3rem)/5))]',
};

/**
 * Lays out `div[appStat]` figures in a row that wraps, from two on a phone to five on a wide page:
 * `<dl appStatGrid [columns]="4">…</dl>`. `columns` is the most there are on a row when there is
 * room, and the grid has no media query: it follows the width of the block it sits in, so the same
 * strip works in a narrow page and in a wide one, and at 320 px.
 *
 * `compact` is for plain figures that sit in a card (see `EntityCard`): without a tile's padding they
 * need less room, so three of them share a row on a phone.
 *
 * It is the `dl` itself, so that the stats are its direct children (see `Stat`).
 */
@Component({
  selector: 'dl[appStatGrid]',
  template: `<ng-content />`,
  host: { '[class]': 'classes()' },
})
export class StatGrid {
  /** The most figures on a row. Four by default. */
  readonly columns = input<StatColumns, number | string>(4, {
    transform: (value) => {
      const count = Math.round(Number(value));
      return (count >= 5 ? 5 : count <= 2 ? 2 : count) as StatColumns;
    },
  });

  /** Narrower minimum width, for figures with no tile around them. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly classes = computed(
    () =>
      `flex flex-wrap gap-3 *:grow ${(this.compact() ? COLUMNS_COMPACT : COLUMNS)[this.columns()]}`,
  );
}
