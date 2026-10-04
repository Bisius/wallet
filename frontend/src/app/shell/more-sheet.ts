import { Component, inject, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { SelectedMonth } from '../core/selected-month';
import { Button } from '../shared/ui/button';
import { AppDialog } from '../shared/ui/dialog';
import { Icon } from '../shared/ui/icon';
import { ACTIVE_LINK_OPTIONS, MORE_ITEMS } from './nav-items';

/**
 * What the tab bar has no room for, on a phone: Subscriptions, Income, Report, Settings and Import, as
 * links with icons, in a bottom sheet.
 *
 * The sheet is the app's dialog (`app-dialog` with `variant="sheet"`), so it is modal, focus goes into
 * it, Escape closes it and focus goes back to the "More" button that opened it (the owner removes it
 * when `closed` is emitted, which also happens when a link is chosen: the page it goes to takes focus
 * on its heading, as with any navigation). A tap on the backdrop closes it, and so does the Close
 * button, which is the last stop so that Tab starts on the links.
 */
@Component({
  selector: 'app-more-sheet',
  imports: [AppDialog, RouterLink, RouterLinkActive, Icon, Button],
  template: `
    <app-dialog heading="More" variant="sheet" (closed)="closed.emit()">
      <ul class="space-y-0.5">
        @for (item of items; track item.path) {
          <li>
            <a
              [routerLink]="item.path"
              [queryParams]="selectedMonth.linkParams()"
              routerLinkActive
              [routerLinkActiveOptions]="activeOptions"
              ariaCurrentWhenActive="page"
              class="flex min-h-12 items-center gap-3 rounded-control px-3 text-base font-medium text-ink hover:bg-subtle aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-text aria-[current=page]:hover:bg-accent-soft"
              (click)="closed.emit()"
            >
              <app-icon [name]="item.icon" class="[&_svg]:size-5" />
              {{ item.label }}
            </a>
          </li>
        }
      </ul>
      <div class="pt-3 pb-4">
        <button appButton variant="secondary" class="w-full" (click)="closed.emit()">Close</button>
      </div>
    </app-dialog>
  `,
})
export class MoreSheet {
  /** The sheet should go away: Escape, a tap outside, Close, or a link was chosen. */
  readonly closed = output<void>();

  protected readonly selectedMonth = inject(SelectedMonth);
  protected readonly items = MORE_ITEMS;
  protected readonly activeOptions = ACTIVE_LINK_OPTIONS;
}
