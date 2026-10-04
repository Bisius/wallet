import {
  booleanAttribute,
  Component,
  computed,
  Directive,
  inject,
  InjectionToken,
  input,
} from '@angular/core';
import type { Cents } from '@wallet/shared';
import { Amount } from './amount';

/** `lg` is the big figure of a page (income, spent), `md` a figure beside others (a balance, a limit). */
export type StatSize = 'lg' | 'md';

/** The color of a figure that is not money (money has its own: a negative amount is red). */
export type StatTone = 'neutral' | 'positive' | 'negative' | 'warning';

/** `tile` sits on a soft surface of its own, `plain` is only the text (inside something that is the surface). */
export type StatVariant = 'tile' | 'plain';

/**
 * What a stat is when it does not say: `tile`, unless something that is a surface already provides
 * `plain` (an `app-entity-card` does), so that no tile ends up inside a card.
 */
export const STAT_VARIANT = new InjectionToken<StatVariant>('STAT_VARIANT');

const SIZES: Record<StatSize, string> = {
  lg: 'text-kpi',
  md: 'text-stat',
};

const TONES: Record<StatTone, string> = {
  neutral: '',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
};

/** How a note under the figure is written: muted (a hint), `ink` (a sentence to read) or negative (a flag). */
export type StatNoteTone = 'muted' | 'ink' | 'negative';

const NOTE_TONES: Record<StatNoteTone, string> = {
  muted: 'text-muted',
  ink: 'text-ink',
  negative: 'font-medium text-negative',
};

/**
 * A line under a figure that is more than a `hint`: an icon with a sentence, a flag. Put it inside
 * the stat, as a `dd`: `<dd statNote tone="negative"><app-icon name="alert" /> Over-allocated</dd>`.
 * A flag carries an icon and words, never its color alone.
 */
@Directive({
  selector: 'dd[statNote]',
  host: { '[class]': 'classes()' },
})
export class StatNote {
  readonly tone = input<StatNoteTone>('muted');

  protected readonly classes = computed(
    () => `mt-1 flex items-start gap-1.5 text-sm ${NOTE_TONES[this.tone()]}`,
  );
}

/**
 * One figure with its caption: the label above, the value large, an optional hint under it.
 *
 * ```html
 * <dl appStatGrid [columns]="3">
 *   <div appStat label="Income" [cents]="view.income.total"></div>
 *   <div appStat label="Saved" [cents]="report.saved" [signed]="true" plain hint="Due to savings"></div>
 *   <div appStat label="Rows found">{{ count }}</div>
 * </dl>
 * ```
 *
 * It is a `div` that holds a `dt` and a `dd`, which is the one shape of a description list that
 * HTML (and axe) allows inside a `dl`: a screen reader hears "Income, €2,500.00". That is why it is
 * an attribute on a `div` and not an element of its own: an `<app-stat>` between the `dl` and its
 * `dt` would break the list. Put the stats in a `dl[appStatGrid]`, which lays them out.
 *
 * - The value is money with `cents` (shown by `app-amount`, so a negative amount keeps its minus sign
 *   and its color; `signed` adds the plus of money that came in, `plain` keeps the text color), or
 *   whatever is put inside the element: a count, a percentage.
 * - `hint` is one muted line under the figure. A longer or richer line is a `dd statNote`.
 * - `size` is `md` (default) or `lg`; `tone` colors a figure that is not money.
 * - A tile has a soft surface and no border: never a bordered box inside a card. Inside an
 *   `app-entity-card` a stat is `plain` by itself.
 */
@Component({
  selector: 'div[appStat]',
  imports: [Amount],
  template: `
    <dt class="text-label">{{ label() }}</dt>
    <dd [class]="valueClasses()">
      @if (cents() === undefined) {
        <ng-content />
      } @else {
        <app-amount [cents]="cents()!" [signed]="signed()" [plain]="plain()" />
      }
    </dd>
    @if (hint()) {
      <dd class="mt-0.5 text-sm text-muted">{{ hint() }}</dd>
    }
    <ng-content select="[statNote]" />
  `,
  host: { '[class]': 'classes()' },
})
export class Stat {
  /** What the figure is: "Income". The `dt`, so it is what a screen reader hears first. */
  readonly label = input.required<string>();
  /** The figure, when it is money. Leave unset to put another value inside the element. */
  readonly cents = input<Cents>();
  /** Show `+` before a positive amount (money that came in). */
  readonly signed = input(false, { transform: booleanAttribute });
  /** Keep the text color for a negative amount (the minus sign and a label say all there is to say). */
  readonly plain = input(false, { transform: booleanAttribute });
  /** One muted line under the figure. */
  readonly hint = input<string>();
  readonly size = input<StatSize>('md');
  readonly tone = input<StatTone>('neutral');
  readonly variant = input<StatVariant>(inject(STAT_VARIANT, { optional: true }) ?? 'tile');

  protected readonly valueClasses = computed(
    () => `mt-0.5 ${SIZES[this.size()]} ${TONES[this.tone()]}`,
  );
  protected readonly classes = computed(() =>
    this.variant() === 'tile' ? 'block rounded-control bg-subtle p-3' : 'block',
  );
}
