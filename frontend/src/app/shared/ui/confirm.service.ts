import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the button that confirms. Name the action: "Delete", not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything destructive. */
  tone?: 'default' | 'danger';
}

export interface ConfirmRequest extends Required<ConfirmOptions> {
  resolve: (confirmed: boolean) => void;
}

/**
 * Asks the user to confirm before something destructive: `if (await confirm.confirm({...})) ...`.
 * `ConfirmDialog` (in the app shell) shows the question in a native modal `<dialog>`; Escape,
 * Cancel and a click on the backdrop all answer `false`.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  /** The open question, if any. */
  readonly request = signal<ConfirmRequest | null>(null);

  confirm(options: ConfirmOptions): Promise<boolean> {
    // A new question replaces an open one, which counts as "no".
    this.request()?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.request.set({
        confirmLabel: 'Confirm',
        cancelLabel: 'Cancel',
        tone: 'default',
        ...options,
        resolve,
      });
    });
  }

  /** Used by the dialog to give the user's answer. */
  answer(confirmed: boolean): void {
    const request = this.request();
    if (!request) return;
    this.request.set(null);
    request.resolve(confirmed);
  }
}
