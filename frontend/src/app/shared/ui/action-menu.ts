import {
  afterNextRender,
  booleanAttribute,
  Component,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  HostAttributeToken,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';

let nextMenuId = 0;

/** Space kept between the menu and the edge of the window, and between the menu and its button. */
const EDGE = 8;
const GAP = 4;
/** However little room there is, the menu keeps this much (two items) and scrolls inside it. */
const MIN_HEIGHT = 96;

/**
 * An item of an `app-action-menu`: `<button appMenuItem (click)="edit()"><app-icon name="pencil" /> Edit</button>`.
 * An ordinary button with the look of a menu row (44 px tall, so it is as easy to hit as any
 * button). `destructive` is for what deletes or cannot be undone: it is drawn in the negative color,
 * with an icon that says so (`trash`, never the color alone), and it goes **last**, after the others,
 * in the markup too, so the tab order is what the eye sees.
 */
@Directive({
  selector: 'button[appMenuItem]',
  host: {
    '[class]': 'classes()',
    '[attr.type]': 'type',
  },
})
export class MenuItem {
  /** Deletes something or cannot be undone: drawn in the negative color. Put these items last. */
  readonly destructive = input(false, { transform: booleanAttribute });

  protected readonly type = inject(new HostAttributeToken('type'), { optional: true }) ?? 'button';
  protected readonly classes = computed(
    () =>
      'flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium ' +
      'focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ' +
      (this.destructive() ? 'text-negative hover:bg-negative-soft' : 'text-ink hover:bg-subtle'),
  );
}

/**
 * The "More actions" of a card or a row: a 44 px button with three dots that opens a short list of
 * actions, for everything beyond the one or two actions that stay visible. Destructive actions always
 * live here, and they ask before they do anything.
 *
 * ```html
 * <app-action-menu label="More actions for Groceries">
 *   <button appMenuItem (click)="archive()"><app-icon name="archive" /> Archive</button>
 *   <button appMenuItem destructive (click)="remove()"><app-icon name="trash" /> Delete</button>
 * </app-action-menu>
 * ```
 *
 * `label` is the name of the button and has to say what the actions are for ("More actions for
 * Groceries"): a page has one menu per row.
 *
 * **It is a disclosure, not an ARIA menu.** The button has `aria-expanded` and `aria-controls`, the
 * items are ordinary buttons that Tab reaches in turn (there is no `role="menu"`, so no promise of
 * arrow keys that nothing keeps). Escape closes it and puts focus back on the button.
 *
 * The list is a native `popover="auto"`, so the browser does the rest: it sits in the top layer (no
 * `overflow` container, card or dialog clips it), a click anywhere else closes it (light dismiss),
 * and opening another one closes this one. A little code places it, because the browser does not:
 * fixed under the button with its right edge on the button's, above it when there is no room below,
 * and never beyond the window, so it cannot widen a page at 320 px. It closes when the window is
 * resized or scrolled, as it would otherwise stay behind while its button moves away.
 *
 * **Focus before the action.** An item that opens a dialog or a confirmation (`app-dialog`,
 * `ConfirmService`) leaves the menu hidden by the time the dialog closes, so focus could not go
 * back to the item. A dialog returns focus to what had it when it opened. So the menu closes and
 * hands focus to its button *before* the item's own handler runs (it listens in the capture phase,
 * ahead of the item): the button is the dialog's opener, and focus comes back to it. An action that
 * removes the row (Delete) leaves focus to the page, as it did before.
 *
 * It looks like a dialog: `surface-raised`, the overlay shadow, a border (in dark mode the shadow
 * does not show), and a 150 ms fade for people who accept motion.
 */
@Component({
  selector: 'app-action-menu',
  imports: [Icon],
  template: `
    <button
      #trigger
      type="button"
      class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-muted hover:bg-subtle hover:text-ink aria-expanded:bg-subtle aria-expanded:text-ink"
      [attr.aria-label]="label()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="menuId"
      [attr.popovertarget]="menuId"
    >
      <app-icon name="more-horizontal" />
    </button>
    <div
      #menu
      popover="auto"
      [id]="menuId"
      class="m-0 w-max min-w-44 overflow-y-auto rounded-card border border-line bg-surface-raised p-1 text-ink shadow-overlay inset-auto motion-safe:animate-fade-in"
      (beforetoggle)="onBeforeToggle($event)"
      (toggle)="onToggle($event)"
    >
      <div class="flex flex-col gap-0.5">
        <ng-content />
      </div>
    </div>
  `,
  host: { class: 'inline-block' },
})
export class ActionMenu {
  /** The name of the button: "More actions for Groceries". */
  readonly label = input.required<string>();

  protected readonly menuId = `action-menu-${nextMenuId++}`;
  protected readonly open = signal(false);

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly menu = viewChild.required<ElementRef<HTMLElement>>('menu');
  private readonly destroyRef = inject(DestroyRef);

  /** Whether focus was in the menu when it started to close: then it goes back to the button. */
  private focusWasInside = false;
  /** Ends the listeners of the window that only matter while the menu is open. */
  private whileOpen: AbortController | null = null;

  constructor() {
    afterNextRender(() => {
      // The capture phase runs before the item's own click handlers (see the class comment).
      this.menu().nativeElement.addEventListener('click', (event) => this.handFocusBack(event), {
        capture: true,
      });
    });
    this.destroyRef.onDestroy(() => this.whileOpen?.abort());
  }

  /**
   * Puts the keyboard on the "More actions" button, for a page that moves a card after one of the
   * menu's items was pressed (the item is hidden by then, and the card may have a new place).
   */
  focus(): void {
    this.trigger().nativeElement.focus();
  }

  protected onBeforeToggle(event: ToggleEvent): void {
    const menu = this.menu().nativeElement;
    if (event.newState === 'open') {
      // Out of sight until it is placed, and at the corner so that it is measured at its own size
      // (not squeezed against the right edge).
      menu.style.visibility = 'hidden';
      menu.style.top = '0px';
      menu.style.left = '0px';
    } else {
      this.focusWasInside = menu.contains(menu.ownerDocument.activeElement);
    }
  }

  protected onToggle(event: ToggleEvent): void {
    const opened = event.newState === 'open';
    this.open.set(opened);
    if (opened) {
      this.place();
      this.menu().nativeElement.style.visibility = '';
      this.closeOnMovement();
    } else {
      this.whileOpen?.abort();
      this.whileOpen = null;
      // Escape and an item hand focus back to the button. A click on another control keeps its own.
      if (this.focusWasInside) this.trigger().nativeElement.focus();
      this.focusWasInside = false;
    }
  }

  /** Closes the menu and hands focus to its button, before the item that was pressed runs. */
  private handFocusBack(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('button, a[href]')) return;
    this.menu().nativeElement.hidePopover();
    this.trigger().nativeElement.focus();
  }

  /** Fixed under the button, right edges level; above it without room below; inside the window. */
  private place(): void {
    const menu = this.menu().nativeElement;
    const view = menu.ownerDocument.documentElement;
    const width = view.clientWidth;
    const height = view.clientHeight;

    menu.style.maxWidth = `${width - 2 * EDGE}px`;
    menu.style.maxHeight = '';
    const size = menu.getBoundingClientRect();
    const anchor = this.trigger().nativeElement.getBoundingClientRect();

    const left = Math.min(Math.max(anchor.right - size.width, EDGE), width - size.width - EDGE);
    const below = height - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const downward = size.height <= below || below >= above;
    const room = Math.max(downward ? below : above, MIN_HEIGHT);
    const shown = Math.min(size.height, room);

    menu.style.left = `${Math.max(left, EDGE)}px`;
    menu.style.top = `${downward ? anchor.bottom + GAP : Math.max(anchor.top - GAP - shown, EDGE)}px`;
    menu.style.maxHeight = `${room}px`;
  }

  /** The menu is fixed, so a button that moves away (scroll) or a window that changes size leaves it behind. */
  private closeOnMovement(): void {
    this.whileOpen?.abort();
    const controller = new AbortController();
    this.whileOpen = controller;
    const close = () => this.menu().nativeElement.hidePopover();
    const view = this.menu().nativeElement.ownerDocument.defaultView;
    view?.addEventListener('resize', close, { signal: controller.signal });
    // `scroll` does not bubble, so listen in the capture phase to hear every scroller. What the
    // menu scrolls inside itself (a long list in a short window) is not a reason to close.
    view?.addEventListener(
      'scroll',
      (event) => {
        if (!(event.target instanceof Node) || !this.menu().nativeElement.contains(event.target)) {
          close();
        }
      },
      { capture: true, signal: controller.signal },
    );
  }
}
