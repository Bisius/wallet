import { httpResource } from '@angular/common/http';
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { HealthResponse } from '@wallet/shared';

interface NavItem {
  path: string;
  label: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App {
  protected readonly nav: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/budgets', label: 'Budgets' },
    { path: '/spendings', label: 'Spendings' },
    { path: '/subscriptions', label: 'Subscriptions' },
    { path: '/income', label: 'Income' },
    { path: '/savings', label: 'Savings' },
    { path: '/settings', label: 'Settings' },
  ];

  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
}
