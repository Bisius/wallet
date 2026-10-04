import { afterRenderEffect, Component, ElementRef, inject, viewChild } from '@angular/core';
import { Button } from './button';
import { ConfirmService } from './confirm.service';

/**
 * Shows the question of `ConfirmService` in a native modal `<dialog>`. The browser provides the
 * focus trap, makes the rest of the page inert, closes on Escape and puts focus back where it was.
 * Focus starts on Cancel, so a stray Enter never confirms a deletion.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [Button],
  template: `
    <dialog
      #dialog
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      class="m-auto w-[min(92vw,26rem)] rounded-card border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/60"
      (close)="answer(false)"
      (click)="onBackdropClick($event)"
    >
      @if (request(); as request) {
        <div class="p-5">
          <h2 id="confirm-title" class="text-lg font-semibold break-words">{{ request.title }}</h2>
          <p id="confirm-message" class="mt-2 text-sm break-words text-muted">
            {{ request.message }}
          </p>
          <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button appButton variant="secondary" autofocus (click)="answer(false)">
              {{ request.cancelLabel }}
            </button>
            <button
              appButton
              [variant]="request.tone === 'danger' ? 'danger' : 'primary'"
              (click)="answer(true)"
            >
              {{ request.confirmLabel }}
            </button>
          </div>
        </div>
      }
    </dialog>
  `,
})
export class ConfirmDialog {
  private readonly service = inject(ConfirmService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly request = this.service.request;

  constructor() {
    // Keep the native dialog in step with the service, after the content has been rendered.
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      const wanted = this.request() !== null;
      if (wanted && !dialog.open) dialog.showModal();
      else if (!wanted && dialog.open) dialog.close();
    });
  }

  protected answer(confirmed: boolean): void {
    this.service.answer(confirmed);
  }

  protected onBackdropClick(event: MouseEvent): void {
    // The dialog has no padding of its own, so a click that lands on the dialog element itself is a
    // click on the backdrop.
    if (event.target === event.currentTarget) this.answer(false);
  }
}
