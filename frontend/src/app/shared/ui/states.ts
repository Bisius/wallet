import { Component, computed, input, output } from '@angular/core';
import { parseApiError } from '../../core/api-error';
import { Alert } from './alert';
import { Button } from './button';

/** Shown while data loads. A polite live region, so screen readers hear that something is loading. */
@Component({
  selector: 'app-loading-state',
  template: `
    <div role="status" class="flex items-center gap-3 p-6 text-muted">
      <span
        aria-hidden="true"
        class="size-5 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
      ></span>
      <span>{{ label() }}</span>
    </div>
  `,
  host: { class: 'block' },
})
export class LoadingState {
  readonly label = input('Loading…');
}

/** Shown when there is nothing to list yet. Put the call to action inside it. */
@Component({
  selector: 'app-empty-state',
  template: `
    <div class="rounded-card border border-dashed border-line-strong p-6 text-center">
      <p class="font-medium text-ink">{{ title() }}</p>
      @if (description()) {
        <p class="mt-1 text-sm text-muted">{{ description() }}</p>
      }
      <div class="mt-4 flex flex-wrap justify-center gap-2 empty:hidden">
        <ng-content />
      </div>
    </div>
  `,
  host: { class: 'block' },
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string>();
}

/**
 * Shown when a request failed. It tells the user what the API said (the `message` of the `ApiError`
 * body), or what the HTTP status means. It is announced as an alert. It is an `app-alert` with the
 * message of the error and, unless `retryable` is off, a "Try again" button.
 */
@Component({
  selector: 'app-error-state',
  imports: [Alert, Button],
  template: `
    <app-alert tone="error" [title]="title()">
      {{ message() }}
      @if (retryable()) {
        <button alertAction appButton variant="secondary" size="sm" (click)="retry.emit()">
          Try again
        </button>
      }
    </app-alert>
  `,
  host: { class: 'block' },
})
export class ErrorState {
  /** What failed: usually `resource.error()`. */
  readonly error = input<unknown>();
  readonly title = input('Something went wrong');
  readonly retryable = input(true);
  readonly retry = output<void>();

  protected readonly message = computed(() => parseApiError(this.error()).message);
}
