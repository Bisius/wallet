import {
  afterNextRender,
  Component,
  DestroyRef,
  DOCUMENT,
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
 * and Escape to close it. Focus starts on the first field (or the element marked `autofocus`). The
 * heading names the dialog for screen readers.
 *
 * Focus goes back to the control that opened it. The browser does that itself when it closes the
 * dialog (Escape), but not when the owner removes the component: by the time its destroy hooks run
 * the `<dialog>` has already left the document, and a dialog that is no longer in the document
 * cannot give focus back. Focus would drop to the page and the keyboard would start over from the top
 * (Cancel, and Save after a request, are this case). So the opener is remembered and focused again
 * by hand, unless something else has taken focus meanwhile or the opener is gone.
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
          class="shrink-0 border-b border-line px-4 py-3 text-lg font-semibold break-words sm:px-5"
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
  private readonly doc = inject(DOCUMENT);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** The dialog's title: it is also its accessible name. */
  readonly heading = input.required<string>();
  /** While true Escape does nothing: a save is under way, and closing would lose its outcome. */
  readonly locked = input(false);
  /** The browser closed the dialog (Escape). */
  readonly closed = output<void>();

  protected readonly titleId = `dialog-title-${nextDialogId++}`;
  private destroyed = false;
  /** What had focus when the dialog opened: where focus goes back to. */
  private opener: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      if (dialog.open) return;
      const active = this.doc.activeElement;
      this.opener = active instanceof HTMLElement && active !== this.doc.body ? active : null;
      this.markFirstFieldAutofocus(dialog);
      dialog.showModal();
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      const dialog = this.host.nativeElement.querySelector('dialog');
      if (dialog?.open) dialog.close();
      this.returnFocus();
    });
  }

  /**
   * Puts focus back on the control that opened the dialog, when the browser did not (see the class
   * comment) and nothing else has focus: a page that moved focus on purpose, or the browser having
   * restored it already (Escape), is left alone.
   */
  private returnFocus(): void {
    const opener = this.opener;
    this.opener = null;
    if (!opener?.isConnected) return;
    const active = this.doc.activeElement;
    if (active !== null && active !== this.doc.body) return;
    opener.focus();
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
