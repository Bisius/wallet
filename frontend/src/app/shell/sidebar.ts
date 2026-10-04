import { Component, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { SelectedMonth } from '../core/selected-month';
import { ApiStatusIndicator } from '../shared/ui/api-status-indicator';
import { Icon } from '../shared/ui/icon';
import { UpdateNotice } from '../shared/ui/update-notice';
import { ACTIVE_LINK_OPTIONS, SIDEBAR_GROUPS, SIDEBAR_SETTINGS } from './nav-items';
import { SavingsBadge } from './savings-badge';

/**
 * The navigation of a wide screen (from `md`; a phone has the tab bar instead): the brand, the
 * pages in two labelled groups, Settings apart at the bottom, and, in the footer, the "new version"
 * notice and whether the API answers (with the date the server uses for "today").
 *
 * The groups are lists named by the label above them, so a screen reader announces "Overview, list,
 * 2 items" without extra headings in the page's outline. The current page is `aria-current="page"` and
 * drawn soft (`accent-soft`), with its icon. Every link keeps the month the person is looking at
 * (`SelectedMonth.linkParams()`).
 *
 * In a focus layout (the onboarding) it keeps the brand and the footer and drops the navigation.
 */
@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, Icon, SavingsBadge, ApiStatusIndicator, UpdateNotice],
  template: `
    <aside
      class="hidden border-r border-line-soft bg-surface md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col"
    >
      <div class="px-5 py-5">
        <a
          routerLink="/dashboard"
          [queryParams]="selectedMonth.linkParams()"
          class="rounded-control text-lg font-semibold tracking-tight"
        >
          Wallet
        </a>
      </div>

      @if (focusLayout()) {
        <div class="flex-1"></div>
      } @else {
        <nav aria-label="Main" class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
          @for (group of groups; track group.label) {
            <div>
              <p
                [id]="'nav-group-' + $index"
                class="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
              >
                {{ group.label }}
              </p>
              <ul [attr.aria-labelledby]="'nav-group-' + $index" class="space-y-0.5">
                @for (item of group.items; track item.path) {
                  <li>
                    <a
                      [routerLink]="item.path"
                      [queryParams]="selectedMonth.linkParams()"
                      routerLinkActive
                      [routerLinkActiveOptions]="activeOptions"
                      ariaCurrentWhenActive="page"
                      [class]="linkClass"
                    >
                      <app-icon [name]="item.icon" />
                      {{ item.label }}
                      @if (item.savingsBadge) {
                        <app-savings-badge class="ml-auto" />
                      }
                    </a>
                  </li>
                }
              </ul>
            </div>
          }
          <ul class="mt-auto">
            <li>
              <a
                [routerLink]="settings.path"
                [queryParams]="selectedMonth.linkParams()"
                routerLinkActive
                [routerLinkActiveOptions]="activeOptions"
                ariaCurrentWhenActive="page"
                [class]="linkClass"
              >
                <app-icon [name]="settings.icon" />
                {{ settings.label }}
              </a>
            </li>
          </ul>
        </nav>
      }

      <div class="border-t border-line-soft p-4">
        <app-update-notice />
        <app-api-status-indicator />
      </div>
    </aside>
  `,
  // The `aside` is the flex item of the shell: the component itself takes no box.
  host: { class: 'contents' },
})
export class Sidebar {
  /** The onboarding and the page that cannot load: the brand and the footer only. */
  readonly focusLayout = input(false);

  protected readonly selectedMonth = inject(SelectedMonth);
  protected readonly groups = SIDEBAR_GROUPS;
  protected readonly settings = SIDEBAR_SETTINGS;
  protected readonly activeOptions = ACTIVE_LINK_OPTIONS;
  protected readonly linkClass =
    'flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium text-ink hover:bg-subtle aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text aria-[current=page]:hover:bg-accent-soft';
}
