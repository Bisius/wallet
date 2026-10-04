import { Component, input } from '@angular/core';

/**
 * The page title (an `h1`) and an optional subtitle, with room for actions on the right. Put it
 * first inside `app-page`, which spaces it from what follows.
 *
 * The title takes focus after a navigation (see `app.ts`), so keyboard and screen reader users land
 * on the new page. The actions are what a person does on this page as a whole: **at most one of them
 * is primary**, the rest are secondary (a link to another page, a second way in).
 */
@Component({
  selector: 'app-page-header',
  template: `
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <h1 tabindex="-1" class="text-page-title">{{ title() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex flex-wrap items-center gap-2 empty:hidden">
        <ng-content />
      </div>
    </header>
  `,
  host: { class: 'block' },
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
