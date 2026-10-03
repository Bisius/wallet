import { Routes } from '@angular/router';
import type { AppRouteData } from './core/route-data';
import { onboardedGuard, onboardingGuard, unavailableGuard } from './core/guards';

/** Pages that show one month at a time get the month switcher in the shell. */
const monthScoped: AppRouteData = { monthScoped: true };

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'onboarding',
    title: 'Welcome · Wallet',
    data: { focusLayout: true } satisfies AppRouteData,
    canActivate: [onboardingGuard],
    loadComponent: () =>
      import('./features/onboarding/onboarding-page').then((m) => m.OnboardingPage),
  },
  {
    path: 'unavailable',
    title: 'Unavailable · Wallet',
    data: { focusLayout: true } satisfies AppRouteData,
    canActivate: [unavailableGuard],
    loadComponent: () =>
      import('./features/unavailable/unavailable-page').then((m) => m.UnavailablePage),
  },
  {
    // Every page of the app: waits for the settings and sends the user to onboarding if needed.
    path: '',
    canActivateChild: [onboardedGuard],
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard · Wallet',
        data: monthScoped,
        loadComponent: () =>
          import('./features/dashboard/dashboard-page').then((m) => m.DashboardPage),
      },
      {
        path: 'budgets',
        title: 'Budgets · Wallet',
        data: monthScoped,
        loadComponent: () => import('./features/budgets/budgets-page').then((m) => m.BudgetsPage),
      },
      {
        path: 'spendings',
        title: 'Spendings · Wallet',
        data: monthScoped,
        loadComponent: () =>
          import('./features/spendings/spendings-page').then((m) => m.SpendingsPage),
      },
      {
        path: 'subscriptions',
        title: 'Subscriptions · Wallet',
        data: monthScoped,
        loadComponent: () =>
          import('./features/subscriptions/subscriptions-page').then((m) => m.SubscriptionsPage),
      },
      {
        path: 'income',
        title: 'Income · Wallet',
        data: monthScoped,
        loadComponent: () => import('./features/income/income-page').then((m) => m.IncomePage),
      },
      {
        path: 'savings',
        title: 'Savings · Wallet',
        loadComponent: () => import('./features/savings/savings-page').then((m) => m.SavingsPage),
      },
      {
        path: 'report',
        title: 'Yearly report · Wallet',
        loadComponent: () =>
          import('./features/reports/yearly-report-page').then((m) => m.YearlyReportPage),
      },
      {
        path: 'settings',
        title: 'Settings · Wallet',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
