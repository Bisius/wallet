import type { ActivatedRouteSnapshot, Data } from '@angular/router';

/** What a route can say about itself to the app shell (`data` in `app.routes.ts`). */
export interface AppRouteData extends Data {
  /** The page shows one month at a time, so the shell shows the month switcher. */
  monthScoped?: boolean;
  /** A focused flow (onboarding): the shell hides the main navigation. */
  focusLayout?: boolean;
}

/** The `data` of the active route and of all its parents, the deepest route's winning. */
export function activeRouteData(snapshot: ActivatedRouteSnapshot): AppRouteData {
  let data: AppRouteData = {};
  for (let route: ActivatedRouteSnapshot | null = snapshot; route; route = route.firstChild) {
    data = { ...data, ...route.data };
  }
  return data;
}
