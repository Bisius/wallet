import { effect, inject, Injectable, Injector, signal, untracked } from '@angular/core';
import { type Reloadable, reloaded } from './resource-state';

/**
 * "The server's figures changed behind the page": for a change that is made away from the page that
 * shows it, which is how the shell's Add spending works (it adds from the Dashboard, the Budgets, the
 * Report, anywhere). The page cannot know, so whoever changed something says so with `notify()`, and
 * every resource that was created with `reloadOnDataChange` loads again, in place: its value stays on
 * screen until the fresh one arrives, so nothing flashes and the scroll position stays.
 *
 * A page that makes its own changes keeps reloading its own resources (`reloaded`): this is only for
 * the ones it did not make.
 */
@Injectable({ providedIn: 'root' })
export class DataChanges {
  private readonly counter = signal(0);

  /** Goes up by one at every `notify()`. */
  readonly version = this.counter.asReadonly();

  /** Something was added, changed or removed on the server. */
  notify(): void {
    this.counter.update((count) => count + 1);
  }
}

/**
 * Makes `resource` load again whenever `DataChanges.notify()` is called, until the component or
 * service that created it is destroyed. Wrap the resources whose figures a spending moves (the month
 * view, the month rows, the yearly report). Call it where a resource may be created (a field
 * initializer or a constructor), as `httpResource` itself needs.
 *
 * It uses `reloaded`, so a load that is already out (and may have been asked for before the change)
 * is waited for and then repeated, instead of the stale answer being kept.
 */
export function reloadOnDataChange<T extends Reloadable>(resource: T): T {
  const changes = inject(DataChanges);
  const injector = inject(Injector);
  let seen = changes.version();

  effect(() => {
    const version = changes.version();
    if (version === seen) return;
    seen = version;
    untracked(() => void reloaded(resource, injector));
  });
  return resource;
}
