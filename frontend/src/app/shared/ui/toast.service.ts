import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'info' | 'error';

/** A button on a toast, for the one thing the user may want to do about it: "Undo". */
export interface ToastAction {
  /** Names what it does. */
  label: string;
  /** Runs when the button is pressed. The toast goes away first. */
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

/** How long a success or info toast stays. Errors stay until dismissed. */
export const TOAST_DURATION_MS = 5000;
/** A toast with an action stays longer: there is something to read, reach and press. */
export const TOAST_ACTION_DURATION_MS = 12000;
/** The most toasts on screen at once. The oldest one goes first. */
const MAX_TOASTS = 4;

/**
 * Short feedback after an action. `ToastContainer` (in the app shell) shows them in a live region.
 * Success and info toasts dismiss themselves; errors stay until the user dismisses them, so nobody
 * misses a failed save. A success or info toast may carry an action (an "Undo"): it stays a little
 * longer, and what it offers must also be possible somewhere else in the app, because a toast is
 * easy to miss with a keyboard.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  readonly toasts = signal<Toast[]>([]);

  success(message: string, action?: ToastAction): void {
    this.show('success', message, action);
  }

  info(message: string, action?: ToastAction): void {
    this.show('info', message, action);
  }

  error(message: string): void {
    this.show('error', message);
  }

  show(kind: ToastKind, message: string, action?: ToastAction): number {
    const id = this.nextId++;
    const toast: Toast = action ? { id, kind, message, action } : { id, kind, message };
    this.toasts.update((toasts) => [...toasts, toast].slice(-MAX_TOASTS));
    if (kind !== 'error') {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS),
      );
    }
    return id;
  }

  /** The user pressed the action of a toast: it goes away, then the action runs. */
  act(id: number): void {
    const action = this.toasts().find((toast) => toast.id === id)?.action;
    this.dismiss(id);
    action?.run();
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.toasts.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }
}
