import {
  afterNextRender,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

let nextDialogId = 0;

/**
 * A modal dialog for a form: `<app-dialog heading="New budget" (closed)="close()">…</app-dialog>`.
 *
 * Render it with `@if` while it should be open. It opens as a native modal `<dialog>` as soon as it
 * is in the page, so the browser provides what a modal needs: a focus trap, an inert page behind it,
 * Escape to close it, and focus going back to the control that opened it. Focus starts on the first
 * field (or the element marked `autofocus`). The heading names the dialog for screen readers.
 *
 * The content scrolls when it is taller than the screen. Put the buttons in an element with the
 * `dialog-footer` class (see styles.css) to keep them in view at the bottom: the content keeps
 * room for it (`scroll-pb-20`), so a field that takes focus is never left behind the buttons.
 *
 * `closed` is emitted when the browser closes it (Escape). It does not close on a click outside, so a
 * stray tap never throws away a half-filled form, and `locked` keeps Escape from closing it while a
 * save is under way. The content decides what Save and Cancel do.
 */
@Component({
  selector: 'app-dialog',
  template: `
    <dialog
      #dialog
      [attr.aria-labelledby]="titleId"
      class="m-auto w-[min(96vw,36rem)] overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/60"
      (cancel)="onCancel($event)"
      (close)="onClose()"
    >
      <div class="flex max-h-[min(94dvh,52rem)] flex-col">
        <h2
          [id]="titleId"
          class="shrink-0 border-b border-line px-4 py-3 text-lg font-semibold sm:px-5"
        >
          {{ heading() }}
        </h2>
        <div class="min-h-0 flex-1 scroll-pb-20 overflow-y-auto px-4 pt-4 sm:px-5">
          <ng-content />
        </div>
      </div>
    </dialog>
  `,
})
export class AppDialog {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** The dialog's title: it is also its accessible name. */
  readonly heading = input.required<string>();
  /** While true Escape does nothing: a save is under way, and closing would lose its outcome. */
  readonly locked = input(false);
  /** The browser closed the dialog (Escape). */
  readonly closed = output<void>();

  protected readonly titleId = `dialog-title-${nextDialogId++}`;
  private destroyed = false;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      if (dialog.open) return;
      this.markFirstFieldAutofocus(dialog);
      dialog.showModal();
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      // Closing it before it leaves the page lets the browser give focus back to the opener.
      const dialog = this.host.nativeElement.querySelector('dialog');
      if (dialog?.open) dialog.close();
    });
  }

  /**
   * A modal dialog focuses its `autofocus` element, else the first focusable thing in it. When the
   * content is taller than the dialog, Chromium counts the scrolling area itself as focusable and it
   * comes before the fields, so focus would land on a plain `div`. Naming the first field settles it.
   * An `autofocus` the content already set is left alone.
   */
  private markFirstFieldAutofocus(dialog: HTMLDialogElement): void {
    if (dialog.querySelector('[autofocus]')) return;
    const first = Array.from(
      dialog.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href]'),
    ).find(
      (element) => !element.hasAttribute('disabled') && element.getAttribute('type') !== 'hidden',
    );
    first?.setAttribute('autofocus', '');
  }

  protected onCancel(event: Event): void {
    if (this.locked()) event.preventDefault();
  }

  protected onClose(): void {
    if (!this.destroyed) this.closed.emit();
  }
}
