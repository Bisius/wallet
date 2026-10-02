import { Component } from '@angular/core';
import { PageHeader } from '../../shared/page-header';

@Component({
  selector: 'app-settings-page',
  imports: [PageHeader],
  template: `
    <app-page-header title="Settings" subtitle="Currency, month cycle and data." />
    <p class="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
      Not built yet, see docs/PLAN.md.
    </p>
  `,
})
export class SettingsPage {}
