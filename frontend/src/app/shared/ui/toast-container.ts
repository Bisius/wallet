import { Component, computed, inject } from '@angular/core';
import { Button } from './button';
import { Icon } from './icon';
import { ToastService } from './toast.service';

/**
 * Renders the toasts of `ToastService`. Both live regions are always in the page, because a screen
 * reader only announces content that appears inside a region that already exists: errors go to an
 * assertive `alert` region, everything else to a polite `status` region.
 */
@Component({
  selector: 'app-toast-container',
  imports: [Button, Icon],
  template: `
    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div role="status" class="flex w-full max-w-md flex-col gap-2">
        @for (toast of polite(); track toast.id) {
          <div
            class="pointer-events-auto flex items-start gap-3 rounded-card border border-line-strong bg-surface p-3 text-sm text-ink shadow-lg"
          >
            <span
              class="mt-0.5"
              [class.text-positive]="toast.kind === 'success'"
              [class.text-accent]="toast.kind === 'info'"
            >
              <app-icon [name]="toast.kind === 'success' ? 'check-circle' : 'info'" />
            </span>
            <p class="min-w-0 flex-1">{{ toast.message }}</p>
            @if (toast.action; as action) {
              <button appButton variant="secondary" size="sm" class="-my-1" (click)="act(toast.id)">
                {{ action.label }}
              </button>
            }
            <button
              type="button"
              class="rounded-control p-1 text-muted hover:bg-subtle hover:text-ink"
              aria-label="Dismiss notification"
              (click)="dismiss(toast.id)"
            >
              <app-icon name="x" />
            </button>
          </div>
        }
      </div>
      <div role="alert" class="flex w-full max-w-md flex-col gap-2">
        @for (toast of errors(); track toast.id) {
          <div
            class="pointer-events-auto flex items-start gap-3 rounded-card border border-negative bg-negative-soft p-3 text-sm text-ink shadow-lg"
          >
            <span class="mt-0.5 text-negative"><app-icon name="alert" /></span>
            <p class="min-w-0 flex-1">
              <span class="font-semibold">Error: </span>{{ toast.message }}
            </p>
            <button
              type="button"
              class="rounded-control p-1 text-ink hover:bg-surface"
              aria-label="Dismiss error"
              (click)="dismiss(toast.id)"
            >
              <app-icon name="x" />
            </button>
          </div>
        }
      </div>
    </div>
  `,
})
export class ToastContainer {
  private readonly service = inject(ToastService);

  protected readonly polite = computed(() =>
    this.service.toasts().filter((toast) => toast.kind !== 'error'),
  );
  protected readonly errors = computed(() =>
    this.service.toasts().filter((toast) => toast.kind === 'error'),
  );

  protected dismiss(id: number): void {
    this.service.dismiss(id);
  }

  protected act(id: number): void {
    this.service.act(id);
  }
}
