import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, UrlSerializer, withComponentInputBinding } from '@angular/router';
import { LenientUrlSerializer } from './core/lenient-url-serializer';
import { notOnboardedInterceptor } from './core/not-onboarded.interceptor';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: UrlSerializer, useClass: LenientUrlSerializer },
    provideHttpClient(withFetch(), withInterceptors([notOnboardedInterceptor])),
  ],
};
