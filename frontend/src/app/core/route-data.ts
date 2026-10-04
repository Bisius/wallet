import type { ActivatedRouteSnapshot, Data } from '@angular/router';

/** What a route can say about itself to the app shell (`data` in `app.routes.ts`). */
export interface AppRouteData extends Data {
  /**
   * What period the page shows, so the shell's top bar has the switcher for it: `month` for a page
   * that shows one month at a time, `year` for the yearly report. A page with no period (Savings,
   * Settings, Import) says nothing and gets no switcher.
   */
  period?: 'month' | 'year';
  /** A focused flow (onboarding): the shell hides the main navigation, the tab bar and the add button. */
  focusLayout?: boolean;
  /**
   * The page already has its own way to add a spending (the form of the Spendings page), so the shell
   * leaves out its "Add spending" button there: one way to add on that page.
   */
  hideAddSpending?: boolean;
}

/** The `data` of the active route and of all its parents, the deepest route's winning. */
export function activeRouteData(snapshot: ActivatedRouteSnapshot): AppRouteData {
  let data: AppRouteData = {};
  for (let route: ActivatedRouteSnapshot | null = snapshot; route; route = route.firstChild) {
    data = { ...data, ...route.data };
  }
  return data;
}
