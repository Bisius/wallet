import { Component } from '@angular/core';
import { PageHeader } from '../../shared/page-header';

@Component({
  selector: 'app-spendings-page',
  imports: [PageHeader],
  template: `
    <app-page-header title="Spendings" subtitle="Every expense, linked to a budget." />
    <p class="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
      Not built yet, see docs/PLAN.md.
    </p>
  `,
})
export class SpendingsPage {}
