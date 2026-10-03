import { Component, inject } from '@angular/core';
import { AppUpdate } from '../../core/app-update';
import { Button } from './button';

/**
 * Tells, quietly, that a new version of the app is ready, with a button to load it. It sits in the
 * shell, in normal flow (it never covers a form), and stays until the person reloads. The live region
 * is always in the page, so the message is announced when it appears.
 */
@Component({
  selector: 'app-update-notice',
  imports: [Button],
  template: `
    <div aria-live="polite" class="empty:hidden">
      @if (update.ready()) {
        <div
          class="mx-2 mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control bg-accent-soft px-3 py-1.5 text-sm text-accent-text"
        >
          <span>A new version is ready.</span>
          <button appButton variant="secondary" size="sm" (click)="update.reload()">
            Reload to update
          </button>
        </div>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class UpdateNotice {
  protected readonly update = inject(AppUpdate);
}
