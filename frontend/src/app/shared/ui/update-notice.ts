import { Component, inject } from '@angular/core';
import { AppUpdate } from '../../core/app-update';
import { Alert } from './alert';
import { Button } from './button';

/**
 * Tells, quietly, that a new version of the app is ready, with a button to load it. It sits in the
 * shell, in normal flow (it never covers a form): in the footer of the sidebar, and at the top of the
 * page on a phone. It stays until the person reloads. The live region is always in the page, so the
 * message is announced when it appears.
 */
@Component({
  selector: 'app-update-notice',
  imports: [Alert, Button],
  template: `
    <div aria-live="polite" class="empty:hidden">
      @if (update.ready()) {
        <app-alert tone="info" class="mb-3">
          A new version is ready.
          <button alertAction appButton variant="secondary" size="sm" (click)="update.reload()">
            Reload to update
          </button>
        </app-alert>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class UpdateNotice {
  protected readonly update = inject(AppUpdate);
}
