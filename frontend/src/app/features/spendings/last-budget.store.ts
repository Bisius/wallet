import { DOCUMENT, inject, Injectable } from '@angular/core';

/** localStorage key of the budget the last spending was added to. */
export const LAST_BUDGET_KEY = 'wallet.lastBudgetId';

/**
 * Remembers which budget the last spending was added to, so the next one starts there: most
 * entries go to the same few budgets, and the phone should not need a tap to pick it again.
 *
 * It lives in this browser only (a convenience, not data). Storage can be blocked or full, so every
 * access is guarded and the app works the same without it.
 */
@Injectable({ providedIn: 'root' })
export class LastBudgetStore {
  private readonly doc = inject(DOCUMENT);

  /** The id of the budget used last, or null when there is none (or storage is not available). */
  get(): number | null {
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(LAST_BUDGET_KEY);
      const id = Number(raw);
      return raw && Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }

  set(id: number): void {
    try {
      this.doc.defaultView?.localStorage.setItem(LAST_BUDGET_KEY, String(id));
    } catch {
      // Storage can be blocked. The next entry just starts on the first budget.
    }
  }
}
