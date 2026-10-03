import { booleanAttribute, Component, computed, input } from '@angular/core';
import type { Cents } from '@wallet/shared';
import { MoneyPipe } from '../money.pipe';

/**
 * An amount of money with its meaning in more than color: a negative amount always shows its minus
 * sign (and is red), and with `signed` a positive one gets a plus sign (and is green). With `plain`
 * it keeps the text color whatever its sign: for a figure that is neither good nor bad news (a
 * savings balance that went below zero), where the minus sign and a label say all there is to say.
 */
@Component({
  selector: 'app-amount',
  imports: [MoneyPipe],
  template: `<span
    class="tabular-nums"
    [class.text-negative]="!plain() && cents() < 0"
    [class.text-positive]="!plain() && signed() && cents() > 0"
    >{{ prefix() }}{{ cents() | money }}</span
  >`,
})
export class Amount {
  readonly cents = input.required<Cents>();
  /** Show `+` before a positive amount, for money that came in. */
  readonly signed = input(false);
  /** Keep the text color for a negative (and a signed positive) amount. The signs still show. */
  readonly plain = input(false, { transform: booleanAttribute });

  protected readonly prefix = computed(() => (this.signed() && this.cents() > 0 ? '+' : ''));
}
