import { DestroyRef, DOCUMENT, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Loads the page again. A token so that a spec can watch it: a test page cannot reload. */
export const RELOAD_PAGE = new InjectionToken<() => void>('RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => {
    const doc = inject(DOCUMENT);
    return () => doc.location.reload();
  },
});

/**
 * Whether a newer version of the app has been downloaded by the service worker and waits for a
 * reload. The worker serves the files it already has, so after a deployment the page runs the old
 * version until it is loaded again, which an installed app on a phone may not be for days. This
 * only tells, and `reload()` is the person's choice (a reload in the middle of typing a spending
 * would lose it). It also asks the server for a new version whenever the app comes back to the
 * foreground, since the worker looks only when a page is loaded.
 *
 * Without a service worker (`ng serve`, the unit tests, a browser that has none) `ready` stays false.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdate {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly reloadPage = inject(RELOAD_PAGE);
  private readonly readyState = signal(false);

  /** A new version is ready (or the worker is in a state that only a reload repairs). */
  readonly ready = this.readyState.asReadonly();

  constructor() {
    const updates = this.updates;
    if (!updates?.isEnabled) return;

    updates.versionUpdates
      .pipe(
        filter((event) => event.type === 'VERSION_READY'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.readyState.set(true));
    updates.unrecoverable.pipe(takeUntilDestroyed()).subscribe(() => this.readyState.set(true));

    const doc = inject(DOCUMENT);
    const check = () => {
      if (!doc.hidden) updates.checkForUpdate().catch(() => undefined);
    };
    doc.addEventListener('visibilitychange', check);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('visibilitychange', check));
  }

  /** Switches to the new version, then loads the page again. */
  async reload(): Promise<void> {
    try {
      await this.updates?.activateUpdate();
    } catch {
      // The reload is what the person asked for, and it is also what repairs a broken worker.
    }
    this.reloadPage();
  }
}
