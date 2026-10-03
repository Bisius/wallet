import { inject } from '@angular/core';
import { type CanActivateChildFn, type CanActivateFn, Router, type UrlTree } from '@angular/router';
import { SettingsStore } from './settings.store';
import { TodayStore } from './today.store';

function unavailable(router: Router, next: string): UrlTree {
  // Never remember the unavailable page itself as the place to come back to.
  const queryParams = next.startsWith('/unavailable') ? {} : { next };
  return router.createUrlTree(['/unavailable'], { queryParams });
}

/**
 * Guards every page of the app: it waits until the settings and today's date are known, sends a user
 * who has not been through onboarding to `/onboarding`, and a failed load to `/unavailable`.
 */
export const onboardedGuard: CanActivateChildFn = async (_route, state) => {
  const settings = inject(SettingsStore);
  const today = inject(TodayStore);
  const router = inject(Router);

  const [settingsState, todayState] = await Promise.all([settings.settled(), today.settled()]);
  if (settingsState === 'error' || todayState === 'error') return unavailable(router, state.url);
  if (settingsState === 'not-onboarded') return router.createUrlTree(['/onboarding']);
  return true;
};

/** Guards `/onboarding`: only for a user who has not been through it yet. */
export const onboardingGuard: CanActivateFn = async (_route, state) => {
  const settings = inject(SettingsStore);
  const today = inject(TodayStore);
  const router = inject(Router);

  const [settingsState, todayState] = await Promise.all([settings.settled(), today.settled()]);
  if (settingsState === 'error' || todayState === 'error') return unavailable(router, state.url);
  if (settingsState === 'onboarded') return router.createUrlTree(['/dashboard']);
  return true;
};

/** Guards `/unavailable`: only while the settings or today's date really cannot be loaded. */
export const unavailableGuard: CanActivateFn = async (route) => {
  const settings = inject(SettingsStore);
  const today = inject(TodayStore);
  const router = inject(Router);

  const [settingsState, todayState] = await Promise.all([settings.settled(), today.settled()]);
  if (settingsState === 'error' || todayState === 'error') return true;
  const next = route.queryParamMap.get('next');
  const safe = next?.startsWith('/') && !next.startsWith('/unavailable') ? next : '/';
  return router.parseUrl(safe);
};
