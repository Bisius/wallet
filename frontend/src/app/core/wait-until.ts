import { effect, Injector } from '@angular/core';

/**
 * Resolves with the first value `read` returns that is not `undefined`. `read` may read signals: the
 * promise settles as soon as they give a value. Used by route guards to wait for a store to finish
 * loading. The effect it creates cleans itself up, so repeated navigations do not leak effects.
 */
export function waitUntil<T>(injector: Injector, read: () => T | undefined): Promise<T> {
  const current = read();
  if (current !== undefined) return Promise.resolve(current);

  return new Promise<T>((resolve) => {
    const ref = effect(
      () => {
        const value = read();
        if (value === undefined) return;
        resolve(value);
        // Not destroyed inside its own run.
        queueMicrotask(() => ref.destroy());
      },
      { injector },
    );
  });
}
