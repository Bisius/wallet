import { Component, input } from '@angular/core';

/**
 * The colour of something the user colours (a budget, a goal, a subscription): a small dot beside its
 * name, `<span appColorDot [color]="budget.color"></span>`. A `#rrggbb`, or `null` for the neutral dot
 * of something that has no colour.
 *
 * It is decoration, for the eye only (`aria-hidden`): the name beside it says what the thing is, and
 * the colour is never the only signal. A ring in the line colour keeps a pale colour visible on the
 * surface, in both themes.
 */
@Component({
  selector: 'span[appColorDot]',
  template: '',
  host: {
    'aria-hidden': 'true',
    class: 'inline-block size-3 shrink-0 rounded-full bg-line-strong ring-1 ring-line-strong',
    '[style.background-color]': 'color()',
  },
})
export class ColorDot {
  readonly color = input<string | null | undefined>(null);
}
