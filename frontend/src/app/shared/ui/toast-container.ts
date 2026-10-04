import { Component, computed, inject, input } from '@angular/core';
import { Button } from './button';
import { Icon } from './icon';
import { ToastService } from './toast.service';

const BASE =
  'pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4';
/** Clear of the home indicator of a phone, and of nothing else: the whole width is free. */
const FREE = 'pb-[max(1rem,env(safe-area-inset-bottom))]';
/**
 * Above the tab bar of a phone and the floating "Add spending" button over it, so a toast never
 * covers either (below `md`, which is where the tab bar is; from `md` up it is `FREE`).
 */
const ABOVE_TAB_BAR =
  'pb-[max(1rem,env(safe-area-inset-bottom))] max-md:pb-[calc(var(--tab-bar-height)+var(--fab-zone)+env(safe-area-inset-bottom))]';

/**
 * Renders the toasts of `ToastService`. Both live regions are always in the page, because a screen
 * reader only announces content that appears inside a region that already exists: errors go to an
 * assertive `alert` region, everything else to a polite `status` region.
 *
 * On a phone the toasts sit above the tab bar and the floating button (`aboveTabBar`, which the shell
 * turns off where there is no tab bar: the onboarding and the page that cannot load).
 */
@Component({
  selector: 'app-toast-container',
  imports: [Button, Icon],
  template: `
    <div [class]="containerClass()">
      <div role="status" class="flex w-full max-w-md flex-col gap-2">
        @for (toast of polite(); track toast.id) {
          <div
            class="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-surface-raised p-3 text-sm text-ink shadow-overlay motion-safe:animate-toast-in"
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
            class="pointer-events-auto flex items-start gap-3 rounded-card border border-negative bg-negative-soft p-3 text-sm text-ink shadow-overlay motion-safe:animate-toast-in"
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

  /** The page has a tab bar (a phone): keep the toasts above it. */
  readonly aboveTabBar = input(false);
  protected readonly containerClass = computed(
    () => `${BASE} ${this.aboveTabBar() ? ABOVE_TAB_BAR : FREE}`,
  );

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
