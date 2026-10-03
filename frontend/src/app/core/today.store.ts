import { httpResource } from '@angular/common/http';
import { computed, DestroyRef, DOCUMENT, inject, Injectable, Injector } from '@angular/core';
import type { TodayResponse } from '@wallet/shared';
import { waitUntil } from './wait-until';

export type TodayState = 'loading' | 'ready' | 'error';

/**
 * "Today" according to the server (`GET /api/today`, its clock and time zone). The browser clock
 * must never provide a business date or month: defaults for dates and months come from here.
 *
 * The value is refreshed whenever the tab becomes visible again, so an app left open overnight (or a
 * phone resuming it) does not offer yesterday's date.
 */
@Injectable({ providedIn: 'root' })
export class TodayStore {
  private readonly injector = inject(Injector);
  private readonly resource = httpResource<TodayResponse>(() => '/api/today');

  readonly state = computed<TodayState>(() => {
    if (this.resource.hasValue()) return 'ready';
    return this.resource.status() === 'error' ? 'error' : 'loading';
  });

  /** Why loading failed, while `state()` is `error`. */
  readonly error = computed(() => (this.state() === 'error' ? this.resource.error() : undefined));

  /** `YYYY-MM-DD`, undefined until loaded. */
  readonly date = computed(() =>
    this.resource.hasValue() ? this.resource.value().date : undefined,
  );
  /** The current month, `YYYY-MM`. undefined until loaded. */
  readonly month = computed(() =>
    this.resource.hasValue() ? this.resource.value().month : undefined,
  );

  constructor() {
    const doc = inject(DOCUMENT);
    const refresh = () => {
      if (!doc.hidden && this.state() === 'ready') this.resource.reload();
    };
    doc.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('visibilitychange', refresh));
  }

  /** Resolves once the state is final: `ready` or `error`. */
  settled(): Promise<Exclude<TodayState, 'loading'>> {
    return waitUntil(this.injector, () => {
      const state = this.state();
      return state === 'loading' ? undefined : state;
    });
  }

  /** Fetches the date again. */
  reload(): void {
    this.resource.reload();
  }
}
