import {
  computed,
  type Injector,
  type Resource,
  type ResourceRef,
  type Signal,
} from '@angular/core';
import { waitUntil } from './wait-until';

/** `loading` until there is a value, `error` when the request failed, otherwise `ready`. */
export type LoadState = 'loading' | 'error' | 'ready';

/**
 * The three states every page has to handle for a resource. A resource that is reloading with a
 * value is `ready`: keep showing the data while it refreshes.
 */
export function resourceState(resource: Resource<unknown>): Signal<LoadState> {
  return computed(() => {
    if (resource.hasValue()) return 'ready';
    return resource.status() === 'error' ? 'error' : 'loading';
  });
}

/** What `reloaded` needs from a resource. */
export type Reloadable = Pick<ResourceRef<unknown>, 'reload' | 'isLoading'>;

/**
 * Loads a resource again after the server's data changed, and resolves once the fresh answer is in
 * (a failed reload also counts: the resource then holds the error).
 *
 * `resource.reload()` does nothing while a load is already running, and that load may have been sent
 * before the change, so it could bring back stale data. In that case this waits for it to finish and
 * reloads once more. Call it where a signal can be read (a page or a service) and pass its injector.
 */
export async function reloaded(resource: Reloadable, injector: Injector): Promise<void> {
  const settled = () => waitUntil(injector, () => (resource.isLoading() ? undefined : true));

  if (!resource.reload()) {
    await settled();
    // A resource that never loads (nothing to ask for) says `false` again: nothing to wait for.
    if (!resource.reload()) return;
  }
  await settled();
}
