import type { HttpInterceptorFn } from '@angular/common/http';

/** The header that makes Angular's service worker leave a request alone: it does not handle it at all. */
export const WORKER_BYPASS_HEADER = 'ngsw-bypass';

/**
 * The API is network-only: the service worker caches the app (its files), never an answer of the API.
 * The worker's configuration already says so (no data groups), and this makes it so for the worker's
 * code too: with the header it does not even pass an API request through, so a failure to reach the
 * server reaches the app as what it is (a network error, "Can't reach the server") and not as the
 * `504 Gateway Timeout` that the worker invents for a request it handled and could not fetch.
 */
export const apiBypassWorkerInterceptor: HttpInterceptorFn = (request, next) =>
  request.url === '/api' || request.url.startsWith('/api/') || request.url.startsWith('/api?')
    ? next(request.clone({ setHeaders: { [WORKER_BYPASS_HEADER]: 'true' } }))
    : next(request);
