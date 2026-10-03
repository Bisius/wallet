import { DestroyRef, inject } from '@angular/core';

/**
 * Says whether the component (or service) that called it, in its injection context, is still alive.
 * A form that finishes a request after the user left the page must not emit its outputs any more:
 * Angular warns about an output that emits after its owner was destroyed.
 */
export function aliveFlag(): () => boolean {
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));
  return () => alive;
}
