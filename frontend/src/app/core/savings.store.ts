import { httpResource } from '@angular/common/http';
import { computed, DestroyRef, DOCUMENT, inject, Injectable, Injector } from '@angular/core';
import type { SavingsDto } from '@wallet/shared';
import { reloaded, resourceState } from './resource-state';
import { SettingsStore } from './settings.store';

/**
 * The savings overview (`GET /api/savings`): the balance, the goals and the closed months still to
 * be moved to savings. The Savings page, the Dashboard block and the badge on the navigation all
 * read this one resource, so they never disagree.
 *
 * Nothing is requested before the settings exist (a first-run user gets `not_onboarded`). The shell
 * refreshes it when the user moves to another page and this class when the tab becomes visible
 * again, because the list changes without the user doing anything on this page: a spending added to
 * a closed month, or a new month that has just started.
 */
@Injectable({ providedIn: 'root' })
export class SavingsStore {
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);
  private readonly resource = httpResource<SavingsDto>(() =>
    this.settings.onboarded() ? '/api/savings' : undefined,
  );

  readonly state = resourceState(this.resource);
  /** Why loading failed, while `state()` is `error`. */
  readonly error = computed(() => (this.state() === 'error' ? this.resource.error() : undefined));
  /** What the API said, undefined until it has loaded. */
  readonly savings = computed<SavingsDto | undefined>(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );

  /** How many closed months wait to be moved to savings. 0 until loaded. */
  readonly outstandingCount = computed(() => this.savings()?.outstanding.length ?? 0);
  /** The signed sum of what they are due: positive is money to move, negative to take. */
  readonly outstandingTotal = computed(() => this.savings()?.outstandingTotal ?? 0);

  constructor() {
    const doc = inject(DOCUMENT);
    const refresh = () => {
      if (!doc.hidden && this.state() === 'ready') this.resource.reload();
    };
    doc.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('visibilitychange', refresh));
  }

  /** Fetches the overview again in the background. The old figures stay until the new ones arrive. */
  refresh(): void {
    if (this.settings.onboarded()) this.resource.reload();
  }

  /**
   * Fetches it again and resolves once the fresh answer is in: for a page that just changed
   * something and shows the result. A failed reload also resolves (the store then holds the error).
   */
  reload(): Promise<void> {
    return reloaded(this.resource, this.injector);
  }
}
