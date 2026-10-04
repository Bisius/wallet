import { Component, computed, inject, input } from '@angular/core';
import { ApiStatus } from '../../core/api-status';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatDate } from '../format';

/**
 * Whether the API is reachable, in words (never only a colored dot), announced politely when it
 * changes. In the sidebar it also shows the date the server uses for "today", which is where every
 * default date and month of the app comes from.
 *
 * `compact` is the one in the top bar of a phone, which has no room for words while all is well: a dot,
 * with the words for a screen reader (`API online`). When the API is not online the words are shown, with
 * the way to check again, so the state is never told by the color of the dot alone.
 */
@Component({
  selector: 'app-api-status-indicator',
  template: `
    <div role="status" class="text-xs text-muted">
      <p class="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          class="size-2 rounded-full"
          [class.bg-positive]="status.state() === 'online'"
          [class.bg-negative]="status.state() === 'offline'"
          [class.border]="status.state() === 'checking'"
          [class.border-muted]="status.state() === 'checking'"
        ></span>
        <span [class.sr-only]="compact() && status.state() === 'online'">{{ label() }}</span>
        @if (status.state() === 'offline') {
          <button
            type="button"
            class="min-h-6 rounded-control px-1 font-medium text-accent underline"
            (click)="status.check()"
          >
            Check again
          </button>
        }
      </p>
      @if (!compact() && serverDate(); as date) {
        <p class="mt-0.5">Server date: {{ date }}</p>
      }
    </div>
  `,
})
export class ApiStatusIndicator {
  /** Only a dot while the API is online (the words are for a screen reader), and no server date. */
  readonly compact = input(false);

  protected readonly status = inject(ApiStatus);
  private readonly today = inject(TodayStore);
  private readonly settings = inject(SettingsStore);

  protected readonly label = computed(() => {
    switch (this.status.state()) {
      case 'online':
        return 'API online';
      case 'offline':
        return 'API offline';
      default:
        return 'Checking API…';
    }
  });

  protected readonly serverDate = computed(() => {
    const date = this.today.date();
    return date ? formatDate(date, this.settings.locale(), 'medium') : null;
  });
}
