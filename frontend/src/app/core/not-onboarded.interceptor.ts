import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { isNotOnboardedError } from './api-error';
import { SettingsStore } from './settings.store';

/**
 * Any response with 409 `not_onboarded` means the settings do not exist (for example the database
 * was reset while the app was open): forget the cached settings and go to onboarding. The error is
 * still passed on to whoever made the request.
 */
export const notOnboardedInterceptor: HttpInterceptorFn = (request, next) => {
  const settings = inject(SettingsStore);
  const router = inject(Router);

  return next(request).pipe(
    catchError((error: unknown) => {
      if (isNotOnboardedError(error)) {
        settings.markNotOnboarded();
        void router.navigateByUrl('/onboarding');
      }
      return throwError(() => error);
    }),
  );
};
