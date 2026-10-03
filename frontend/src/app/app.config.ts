import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, UrlSerializer, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { apiBypassWorkerInterceptor } from './core/api-bypass-worker.interceptor';
import { LenientUrlSerializer } from './core/lenient-url-serializer';
import { notOnboardedInterceptor } from './core/not-onboarded.interceptor';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: UrlSerializer, useClass: LenientUrlSerializer },
    provideHttpClient(
      withFetch(),
      withInterceptors([apiBypassWorkerInterceptor, notOnboardedInterceptor]),
    ),
    // Production builds only: `ng serve` and the unit tests never register a worker. It registers
    // once the app is stable (or after 30 s), so it never competes with the first load.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
