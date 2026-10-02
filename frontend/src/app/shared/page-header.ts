import { Component, input } from '@angular/core';

@Component({
  selector: 'app-page-header',
  template: `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ title() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-slate-500">{{ subtitle() }}</p>
        }
      </div>
      <ng-content />
    </header>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
