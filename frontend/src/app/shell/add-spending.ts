import { Component, inject, Injectable, signal } from '@angular/core';
import { Icon } from '../shared/ui/icon';

/**
 * Whether the shell's "Add spending" dialog is open. The buttons (the top bar's, the floating one of a
 * phone) call `open()`, and `app-add-spending-dialog` shows the form while it is true.
 */
@Injectable({ providedIn: 'root' })
export class AddSpending {
  readonly isOpen = signal(false);

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }
}

/**
 * The floating "Add spending" button of a phone: 56 px, in the corner above the tab bar. The page
 * leaves room under its content for it (`--fab-zone`, styles.css). From `md` up there is the top
 * bar's button instead, so this one is not there.
 *
 * It is in the page's `main`: a button outside every landmark would be content no region holds.
 */
@Component({
  selector: 'app-add-spending-fab',
  imports: [Icon],
  template: `
    <button
      type="button"
      aria-label="Add spending"
      class="fixed right-4 bottom-[calc(var(--tab-bar-height)+1rem+env(safe-area-inset-bottom))] z-30 inline-flex size-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-overlay hover:bg-accent-hover md:hidden [&_svg]:size-6"
      (click)="add.open()"
    >
      <app-icon name="plus" />
    </button>
  `,
})
export class AddSpendingFab {
  protected readonly add = inject(AddSpending);
}
