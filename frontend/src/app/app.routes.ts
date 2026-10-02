import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard · Wallet',
    loadComponent: () => import('./features/dashboard/dashboard-page').then((m) => m.DashboardPage),
  },
  {
    path: 'budgets',
    title: 'Budgets · Wallet',
    loadComponent: () => import('./features/budgets/budgets-page').then((m) => m.BudgetsPage),
  },
  {
    path: 'spendings',
    title: 'Spendings · Wallet',
    loadComponent: () => import('./features/spendings/spendings-page').then((m) => m.SpendingsPage),
  },
  {
    path: 'subscriptions',
    title: 'Subscriptions · Wallet',
    loadComponent: () =>
      import('./features/subscriptions/subscriptions-page').then((m) => m.SubscriptionsPage),
  },
  {
    path: 'income',
    title: 'Income · Wallet',
    loadComponent: () => import('./features/income/income-page').then((m) => m.IncomePage),
  },
  {
    path: 'savings',
    title: 'Savings · Wallet',
    loadComponent: () => import('./features/savings/savings-page').then((m) => m.SavingsPage),
  },
  {
    path: 'settings',
    title: 'Settings · Wallet',
    loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'dashboard' },
];
