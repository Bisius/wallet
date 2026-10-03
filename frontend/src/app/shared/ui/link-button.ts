import { computed, Directive, input } from '@angular/core';
import { type ButtonSize, type ButtonVariant, buttonClasses } from './button';

/**
 * A link that looks like a button: `<a appLinkButton href="/api/export/spendings.csv" download>`. Use
 * it for a navigation or a download, where a real `<a>` is the right element (a button that
 * navigates is announced as a button and cannot be opened in a new tab). Secondary by default.
 */
@Directive({
  selector: 'a[appLinkButton]',
  host: { '[class]': 'classes()' },
})
export class LinkButton {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<ButtonSize>('md');

  protected readonly classes = computed(() => buttonClasses(this.variant(), this.size()));
}
