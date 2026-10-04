import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiStatus } from '../../core/api-status';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { AppPage } from '../../shared/ui/page';
import { PageHeader } from '../../shared/ui/page-header';

/**
 * Where the guards send the user when the settings or today's date could not be loaded (the API is
 * down, or answered 500). "Try again" loads them again and, when that works, goes back to the page
 * the user asked for.
 */
@Component({
  selector: 'app-unavailable-page',
  imports: [AppPage, PageHeader, Alert, Button],
  template: `
    <app-page width="narrow">
      <app-page-header
        title="Wallet can't load"
        subtitle="The server did not give the app what it needs to start."
      />
      <app-alert tone="error" title="What went wrong">
        <p>{{ message() }}</p>
        <p class="mt-2">Check that the Wallet server is running and reachable from this device.</p>
        <button alertAction appButton [loading]="retrying()" (click)="retry()">Try again</button>
      </app-alert>
    </app-page>
  `,
})
export class UnavailablePage {
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly apiStatus = inject(ApiStatus);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly retrying = signal(false);

  protected readonly message = computed(() => {
    const cause = this.settings.error() ?? this.today.error();
    return cause ? parseApiError(cause).message : "Can't reach the server.";
  });

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    this.settings.reload();
    this.today.reload();
    this.apiStatus.check();
    await Promise.all([this.settings.settled(), this.today.settled()]);
    this.retrying.set(false);
    // The guards decide where to go: back to the requested page, to onboarding, or here again.
    const next = this.route.snapshot.queryParamMap.get('next');
    await this.router.navigateByUrl(next?.startsWith('/') ? next : '/');
  }
}
