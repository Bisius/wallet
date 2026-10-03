import { Component, computed, inject } from '@angular/core';
import { ApiStatus } from '../../core/api-status';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatDate } from '../format';

/**
 * Whether the API is reachable, in words (never only a colored dot), announced politely when it
 * changes. On wide screens it also shows the date the server uses for "today", which is where every
 * default date and month of the app comes from.
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
        <span>{{ label() }}</span>
        @if (status.state() === 'offline') {
          <button
            type="button"
            class="rounded-control px-1 font-medium text-accent underline"
            (click)="status.check()"
          >
            Check again
          </button>
        }
      </p>
      @if (serverDate(); as date) {
        <p class="mt-0.5 hidden md:block">Server date: {{ date }}</p>
      }
    </div>
  `,
})
export class ApiStatusIndicator {
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
