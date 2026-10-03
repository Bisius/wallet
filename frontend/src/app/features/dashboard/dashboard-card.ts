import { Component, input, output } from '@angular/core';
import type { LoadState } from '../../core/resource-state';
import { ErrorState, LoadingState } from '../../shared/ui/states';

let cards = 0;

/**
 * The frame of a block of the Dashboard: a card with a heading, a line saying what it shows, and
 * the three states of the data behind it. While that loads it says so, when it failed it shows the
 * API's message with a way to try again, and only when it is ready does it show its content. Each
 * block has its own, so one failing request never blanks the page.
 *
 * Put the content inside, guarded by the data it needs (`@if (data(); as data)`), and a link or
 * button for the card's corner on an element marked `cardAction`.
 */
@Component({
  selector: 'app-dashboard-card',
  imports: [ErrorState, LoadingState],
  template: `
    <section [attr.aria-labelledby]="headingId" class="card space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="min-w-0">
          <h2 [id]="headingId" class="text-lg font-semibold">{{ title() }}</h2>
          @if (description()) {
            <p class="mt-1 text-sm text-muted">{{ description() }}</p>
          }
        </div>
        <ng-content select="[cardAction]" />
      </div>

      @switch (state()) {
        @case ('loading') {
          <app-loading-state [label]="loadingLabel()" />
        }
        @case ('error') {
          <app-error-state [title]="errorTitle()" [error]="error()" (retry)="retry.emit()" />
        }
        @default {
          <ng-content />
        }
      }
    </section>
  `,
  host: { class: 'block' },
})
export class DashboardCard {
  readonly title = input.required<string>();
  /** A line under the title on what the block shows and how to read it. */
  readonly description = input<string>();
  readonly state = input.required<LoadState>();
  /** Why loading failed: usually `resource.error()`. */
  readonly error = input<unknown>();
  readonly loadingLabel = input.required<string>();
  /** What failed, for the error state: "Couldn't load budget progress". */
  readonly errorTitle = input.required<string>();
  readonly retry = output<void>();

  protected readonly headingId = `dashboard-card-${++cards}`;
}
