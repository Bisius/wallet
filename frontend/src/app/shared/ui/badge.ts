import { Component, computed, input } from '@angular/core';
import { Icon, type IconName } from './icon';

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative';

/** Each tone is a soft background with its own text color: pairs whose contrast is checked in both themes. */
const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-subtle text-ink',
  accent: 'bg-accent-soft text-accent-text',
  positive: 'bg-positive-soft text-positive',
  warning: 'bg-warning-soft text-warning',
  negative: 'bg-negative-soft text-negative',
};

/**
 * A small label for the state of something: `<app-badge tone="positive">Active</app-badge>`.
 *
 * It always has words, and the tone says how to take them, it never replaces them: a badge without
 * text would be a color only. An `icon` next to the words helps where the state is easy to miss
 * (overdue, refused). Use the tone for what the state means: **positive** (active, reached), **accent**
 * (upcoming, current, a note that points at something), **warning** (needs care, overdue),
 * **negative** (failed, refused), **neutral** (everything else: ended, cancelled, a plain label).
 *
 * Text that runs long wraps inside the pill instead of widening the page.
 */
@Component({
  selector: 'app-badge',
  imports: [Icon],
  template: `
    @if (icon(); as icon) {
      <app-icon [name]="icon" />
    }
    <span class="min-w-0">
      <ng-content />
    </span>
  `,
  host: { '[class]': 'classes()' },
})
export class Badge {
  readonly tone = input<BadgeTone>('neutral');
  readonly icon = input<IconName>();

  protected readonly classes = computed(
    () =>
      `inline-flex max-w-full items-start gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[this.tone()]}`,
  );
}
