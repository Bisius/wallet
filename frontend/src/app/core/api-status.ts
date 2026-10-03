import { httpResource } from '@angular/common/http';
import {
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  linkedSignal,
  type ResourceStatus,
} from '@angular/core';
import type { HealthResponse } from '@wallet/shared';

export type ApiStatusState = 'checking' | 'online' | 'offline';

/** How often the API is probed while the tab is visible. */
export const API_POLL_MS = 30_000;

/**
 * Whether the API is reachable (`GET /api/health`). Checked at startup, then every 30 seconds while
 * the tab is visible, and straight away when the browser reports it went online or offline.
 */
@Injectable({ providedIn: 'root' })
export class ApiStatus {
  private readonly health = httpResource<HealthResponse>(() => '/api/health');

  /** The last answer. While a check is running the previous answer stays. */
  readonly state = linkedSignal<ResourceStatus, ApiStatusState>({
    source: this.health.status,
    computation: (status, previous) => {
      switch (status) {
        case 'resolved':
        case 'local':
          return 'online';
        case 'error':
          return 'offline';
        default:
          return previous?.value ?? 'checking';
      }
    },
  });

  constructor() {
    const doc = inject(DOCUMENT);
    const win = doc.defaultView;
    const check = () => {
      if (!doc.hidden) this.health.reload();
    };

    const timer = setInterval(check, API_POLL_MS);
    win?.addEventListener('online', check);
    win?.addEventListener('offline', check);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      win?.removeEventListener('online', check);
      win?.removeEventListener('offline', check);
    });
  }

  /** Checks now. */
  check(): void {
    this.health.reload();
  }
}
