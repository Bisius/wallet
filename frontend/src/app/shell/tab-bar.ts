import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';
import { SelectedMonth } from '../core/selected-month';
import { Icon } from '../shared/ui/icon';
import { MoreSheet } from './more-sheet';
import { ACTIVE_LINK_OPTIONS, MORE_ITEMS, TAB_ITEMS } from './nav-items';
import { SavingsBadge } from './savings-badge';

/** What a tab is, whatever element it is: the icon over the label, 56 px tall, a target for a thumb. */
const TAB =
  'group relative flex min-h-(--tab-bar-height) w-full flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted hover:text-ink aria-[current=page]:text-accent-text data-[current]:text-accent-text';
/**
 * The soft pill behind the icon: the current page (`aria-current` of a link), or the page that "More"
 * holds (`data-current` of its button: `aria-current` is for links).
 */
const PILL =
  'rounded-full px-4 py-1 group-aria-[current=page]:bg-accent-soft group-data-[current]:bg-accent-soft';

/**
 * The navigation of a phone (below `md`; a wide screen has the sidebar): Dashboard, Budgets,
 * Spendings, Savings (with the badge that counts the months to move) and More, which opens the sheet
 * with the rest. It is fixed to the bottom edge on `surface-raised` with a visible top border, keeps
 * clear of the home indicator (`env(safe-area-inset-bottom)`), and its tabs are 56 px tall with an icon
 * and a label (a label is never left out).
 *
 * Its name is "Main (tabs)", the sidebar's is "Main": only one of them is on screen, the other is
 * `display: none`, so the page never has two navigations with one name for a screen reader.
 *
 * The current page is `aria-current="page"` on its link. "More" is a button, and `aria-current` is for
 * links, so when the page is one of its items it says so in words instead (`, current page: Income`,
 * for a screen reader) and the same pill the tabs have (for the eye).
 */
@Component({
  selector: 'app-tab-bar',
  imports: [RouterLink, RouterLinkActive, Icon, SavingsBadge, MoreSheet],
  template: `
    <nav
      aria-label="Main (tabs)"
      class="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface-raised pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul class="grid grid-cols-5">
        @for (item of tabs; track item.path) {
          <li>
            <a
              [routerLink]="item.path"
              [queryParams]="selectedMonth.linkParams()"
              routerLinkActive
              [routerLinkActiveOptions]="activeOptions"
              ariaCurrentWhenActive="page"
              [class]="tabClass"
            >
              <span [class]="pillClass"
                ><app-icon [name]="item.icon" class="[&_svg]:size-5"
              /></span>
              <span>{{ item.label }}</span>
              @if (item.savingsBadge) {
                <app-savings-badge class="absolute top-1.5 left-1/2 ml-2" />
              }
            </a>
          </li>
        }
        <li>
          <button
            type="button"
            aria-haspopup="dialog"
            [class]="tabClass"
            [attr.data-current]="moreCurrent() ? '' : null"
            (click)="sheetOpen.set(true)"
          >
            <span [class]="pillClass"
              ><app-icon name="more-horizontal" class="[&_svg]:size-5"
            /></span>
            <span>More</span>
            @if (moreCurrent(); as current) {
              <span class="sr-only">, current page: {{ current.label }}</span>
            }
          </button>
        </li>
      </ul>
    </nav>
    @if (sheetOpen()) {
      <app-more-sheet (closed)="sheetOpen.set(false)" />
    }
  `,
  host: { class: 'contents' },
})
export class TabBar {
  private readonly router = inject(Router);

  protected readonly selectedMonth = inject(SelectedMonth);
  protected readonly tabs = TAB_ITEMS;
  protected readonly activeOptions = ACTIVE_LINK_OPTIONS;
  protected readonly tabClass = TAB;
  protected readonly pillClass = PILL;

  protected readonly sheetOpen = signal(false);

  /** The address, which changes when a navigation ends: what `moreCurrent` follows. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** The item of "More" that is the page the person is on, if any. Asks the router like a link does. */
  protected readonly moreCurrent = computed(() => {
    this.url();
    return MORE_ITEMS.find((item) => this.router.isActive(item.path, ACTIVE_LINK_OPTIONS));
  });
}
