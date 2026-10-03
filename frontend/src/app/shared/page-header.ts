import { Component, input } from '@angular/core';

/**
 * The page title (an `h1`) and an optional subtitle, with room for actions on the right. The
 * title takes focus after a navigation, so keyboard and screen reader users land on the new page.
 */
@Component({
  selector: 'app-page-header',
  template: `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ title() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
        }
      </div>
      <ng-content />
    </header>
  `,
  host: { class: 'block' },
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
