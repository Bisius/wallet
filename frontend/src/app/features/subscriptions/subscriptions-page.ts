import { Component } from '@angular/core';
import { PageHeader } from '../../shared/page-header';

@Component({
  selector: 'app-subscriptions-page',
  imports: [PageHeader],
  template: `
    <app-page-header title="Subscriptions" subtitle="Monthly and yearly recurring costs." />
    <p class="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
      Not built yet, see docs/PLAN.md.
    </p>
  `,
})
export class SubscriptionsPage {}
