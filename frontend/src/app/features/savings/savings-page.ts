import { Component } from '@angular/core';
import { PageHeader } from '../../shared/page-header';

@Component({
  selector: 'app-savings-page',
  imports: [PageHeader],
  template: `
    <app-page-header title="Savings" subtitle="Leftovers waiting to be moved to savings." />
    <p class="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
      Not built yet, see docs/PLAN.md.
    </p>
  `,
})
export class SavingsPage {}
