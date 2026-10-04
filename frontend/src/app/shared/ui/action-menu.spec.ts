import { Component, signal, viewChildren } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { clickMenuItem, menuItemNames, openActionMenu, rowAction } from '../../../testing/menu';
import { ActionMenu, MenuItem } from './action-menu';
import { Icon } from './icon';
import { AppDialog } from './dialog';

@Component({
  selector: 'app-menu-host',
  imports: [ActionMenu, MenuItem, AppDialog, Icon],
  template: `
    <button type="button" id="before">Before</button>
    <div id="groceries">
      <app-action-menu label="More actions for Groceries">
        <button appMenuItem (click)="act('edit')">
          <app-icon name="pencil" />
          Edit
        </button>
        <button appMenuItem (click)="act('archive')">
          <app-icon name="archive" />
          Archive
        </button>
        <button appMenuItem [disabled]="true" (click)="act('disabled')">Move up</button>
        <button appMenuItem destructive (click)="confirming.set(true)">
          <app-icon name="trash" />
          Delete
        </button>
      </app-action-menu>
    </div>
    <div id="rent">
      <app-action-menu label="More actions for Rent">
        <button appMenuItem (click)="act('edit rent')">Edit</button>
      </app-action-menu>
    </div>
    <button type="button" id="after">After</button>
    @if (confirming()) {
      <app-dialog heading="Delete Groceries?" (closed)="confirming.set(false)">
        <button type="button" (click)="confirming.set(false)">Keep it</button>
      </app-dialog>
    }
  `,
})
class MenuHost {
  readonly confirming = signal(false);
  readonly menus = viewChildren(ActionMenu);
  /** What was pressed, and what had focus at that moment. */
  readonly pressed: { action: string; focusedLabel: string | null }[] = [];

  act(action: string): void {
    this.pressed.push({
      action,
      focusedLabel: document.activeElement?.getAttribute('aria-label') ?? null,
    });
  }
}

@Component({
  selector: 'app-menu-in-dialog-host',
  imports: [ActionMenu, MenuItem, AppDialog],
  template: `
    <button type="button" id="opener" (click)="open.set(true)">Open</button>
    @if (open()) {
      <app-dialog heading="Groceries" (closed)="open.set(false)">
        <app-action-menu label="More actions inside the dialog">
          <button appMenuItem>Archive</button>
        </app-action-menu>
      </app-dialog>
    }
  `,
})
class MenuInDialogHost {
  readonly open = signal(false);
}

describe('ActionMenu', () => {
  async function setup() {
    const fixture = await render(MenuHost);
    const element = fixture.nativeElement as HTMLElement;
    const groceries = element.querySelector('#groceries') as HTMLElement;
    const rent = element.querySelector('#rent') as HTMLElement;
    const trigger = getByRole(element, 'button', 'More actions for Groceries');
    const menu = () => document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    const isOpen = () => menu()?.hasAttribute('data-popover-open') ?? false;
    const key = async (name: string) => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
      await settle(fixture);
    };
    return {
      fixture,
      element,
      host: fixture.componentInstance,
      groceries,
      rent,
      trigger,
      menu,
      isOpen,
      key,
    };
  }

  describe('the button', () => {
    it('is named for what the actions are for, so a page of rows has one name each', async () => {
      const { element } = await setup();

      expect(
        queryAllByRole(element, 'button', /^More actions/).map((button) =>
          button.getAttribute('aria-label'),
        ),
      ).toEqual(['More actions for Groceries', 'More actions for Rent']);
    });

    it('says it is closed and what it controls, and is a 44 px target', async () => {
      const { trigger, menu } = await setup();

      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(menu()).not.toBeNull();
      expect(menu()?.getAttribute('popover')).toBe('auto');
      expect(trigger.getAttribute('popovertarget')).toBe(menu()?.id);
      expect(trigger.classList).toContain('min-h-11');
      expect(trigger.classList).toContain('min-w-11');
    });

    it('can be given the keyboard from outside: a page puts it back after it moved a card', async () => {
      const { host, trigger } = await setup();

      host.menus()[0].focus();

      expect(document.activeElement).toBe(trigger);
    });

    it('shows the dots as decoration: the name is the label', async () => {
      const { trigger } = await setup();

      const icon = trigger.querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(textOf(trigger)).toBe('');
    });
  });

  describe('opening and closing', () => {
    it('opens on a press, says so, and shows the items', async () => {
      const { trigger, menu, isOpen } = await setup();
      expect(getComputedStyle(menu() as HTMLElement).display).toBe('none');

      trigger.click();
      await settle();

      expect(isOpen()).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(getComputedStyle(menu() as HTMLElement).display).not.toBe('none');
    });

    it('closes on the same button, and says so', async () => {
      const { trigger, isOpen } = await setup();

      trigger.click();
      await settle();
      trigger.click();
      await settle();

      expect(isOpen()).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Escape and puts focus back on its button', async () => {
      const { element, groceries, trigger, isOpen, key } = await setup();
      await openActionMenu(element, 'More actions for Groceries');
      // The keyboard went down into the list.
      getByRole(groceries, 'button', 'Edit').focus();

      await key('Escape');

      expect(isOpen()).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(trigger);
    });

    it('closes on a click anywhere else, without taking focus from where the person clicked', async () => {
      const { element, isOpen, fixture } = await setup();
      await openActionMenu(element, 'More actions for Groceries');
      const after = element.querySelector('#after') as HTMLButtonElement;

      after.focus();
      after.click();
      await settle(fixture);

      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(after);
    });

    it('closes the open menu when another one opens', async () => {
      const { element, isOpen } = await setup();
      await openActionMenu(element, 'More actions for Groceries');

      await openActionMenu(element, 'More actions for Rent');

      expect(isOpen()).toBe(false);
      expect(
        getByRole(element, 'button', 'More actions for Rent').getAttribute('aria-expanded'),
      ).toBe('true');
    });

    it('closes when the window is resized or the page scrolls, but not when the list scrolls inside itself', async () => {
      const { element, menu, isOpen, fixture } = await setup();
      await openActionMenu(element, 'More actions for Groceries');

      menu()?.dispatchEvent(new Event('scroll'));
      await settle(fixture);
      expect(isOpen()).toBe(true);

      document.dispatchEvent(new Event('scroll'));
      await settle(fixture);
      expect(isOpen()).toBe(false);

      await openActionMenu(element, 'More actions for Groceries');
      window.dispatchEvent(new Event('resize'));
      await settle(fixture);
      expect(isOpen()).toBe(false);
    });
  });

  describe('the items', () => {
    it('are ordinary buttons reached in turn, in the order they are written: not an ARIA menu', async () => {
      const { element, groceries } = await setup();
      await openActionMenu(element, 'More actions for Groceries');

      expect(menuItemNames(groceries)).toEqual(['Edit', 'Archive', 'Move up', 'Delete']);
      expect(element.querySelector('[role="menu"], [role="menuitem"], [aria-haspopup]')).toBeNull();
      expect(
        Array.from(groceries.querySelectorAll<HTMLElement>('[popover] button')).map(
          (item) => item.tabIndex,
        ),
      ).toEqual([0, 0, 0, 0]);
    });

    it('draw a destructive one last, in the negative color, with the icon that says what it does', async () => {
      const { groceries } = await setup();
      const items = Array.from(groceries.querySelectorAll<HTMLElement>('[popover] button'));
      const destructive = items.filter((item) => item.classList.contains('text-negative'));

      expect(destructive.map((item) => textOf(item))).toEqual(['Delete']);
      expect(items[items.length - 1]).toBe(destructive[0]);
      expect(destructive[0].querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('are 44 px rows with their own focus ring drawn inside the list, so the list does not cut it off', async () => {
      const { groceries } = await setup();
      const item = groceries.querySelector('[popover] button') as HTMLElement;

      expect(item.classList).toContain('min-h-11');
      expect(item.classList).toContain('focus-visible:-outline-offset-2');
      expect(item.getAttribute('type')).toBe('button');
    });

    it('close the menu when they are pressed, and run', async () => {
      const { element, host, isOpen } = await setup();

      await rowAction(element.querySelector('#groceries') as HTMLElement, 'Archive');

      expect(isOpen()).toBe(false);
      expect(host.pressed.map((press) => press.action)).toEqual(['archive']);
    });

    it('cannot be pressed while disabled', async () => {
      const { element, host } = await setup();
      await openActionMenu(element, 'More actions for Groceries');

      getByRole(element, 'button', 'Move up').click();

      expect(host.pressed).toEqual([]);
    });

    it('find their own menu: Edit of Rent is not Edit of Groceries', async () => {
      const { rent, host } = await setup();

      await rowAction(rent, 'Edit');

      expect(host.pressed.map((press) => press.action)).toEqual(['edit rent']);
    });

    it('can be pressed only in a menu that is open', async () => {
      const { groceries } = await setup();

      await expect(clickMenuItem(groceries, 'Edit')).rejects.toThrow(/one open menu/);
    });
  });

  describe('focus', () => {
    it('is on the button before the item runs, so what an item opens remembers the button', async () => {
      const { groceries, host } = await setup();
      await openActionMenu(groceries);
      // A mouse press focuses the item (Chromium, not Safari): it is about to be hidden.
      getByRole(groceries, 'button', 'Edit').focus();

      await clickMenuItem(groceries, 'Edit');

      expect(host.pressed).toEqual([
        { action: 'edit', focusedLabel: 'More actions for Groceries' },
      ]);
    });

    it('goes back to the button when the dialog an item opened is closed with Escape', async () => {
      const { element, groceries, trigger, key } = await setup();

      await rowAction(groceries, 'Delete');
      const dialog = element.querySelector('dialog') as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect(document.activeElement).not.toBe(trigger);

      await key('Escape');

      expect(element.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('goes back to the button when the dialog is closed by its own Cancel', async () => {
      const { element, groceries, trigger, fixture } = await setup();
      await rowAction(groceries, 'Delete');

      getByRole(element, 'button', 'Keep it').click();
      await settle(fixture);

      expect(element.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  describe('in a dialog', () => {
    it('opens above the dialog, and Escape closes the list first and the dialog second', async () => {
      const fixture = await render(MenuInDialogHost);
      const element = fixture.nativeElement as HTMLElement;
      (element.querySelector('#opener') as HTMLElement).focus();
      fixture.componentInstance.open.set(true);
      await settle(fixture);
      const dialog = element.querySelector('dialog') as HTMLDialogElement;

      const menu = await openActionMenu(dialog);
      expect(dialog.contains(menu)).toBe(true);

      const escape = async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        await settle(fixture);
      };
      await escape();
      expect(menu.hasAttribute('data-popover-open')).toBe(false);
      expect(dialog.open).toBe(true);

      await escape();
      expect(element.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(element.querySelector('#opener'));
    });
  });

  describe('placement', () => {
    const WINDOW = { width: 320, height: 800 };
    const MENU = { width: 180, height: 132 };

    function rect(left: number, top: number, width: number, height: number): DOMRect {
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      };
    }

    /** jsdom has no layout: say where the button is, how big the list is and how big the window is. */
    async function place(anchor: DOMRect, windowHeight = WINDOW.height) {
      const context = await setup();
      const menu = context.menu() as HTMLElement;
      vi.spyOn(context.trigger, 'getBoundingClientRect').mockReturnValue(anchor);
      vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(rect(0, 0, MENU.width, MENU.height));
      const view = document.documentElement;
      vi.spyOn(view, 'clientWidth', 'get').mockReturnValue(WINDOW.width);
      vi.spyOn(view, 'clientHeight', 'get').mockReturnValue(windowHeight);
      await openActionMenu(context.groceries);
      return { ...context, menu, style: menu.style };
    }

    afterEach(() => vi.restoreAllMocks());

    it('opens below the button with its right edge level with the button', async () => {
      const { style } = await place(rect(200, 100, 44, 44));

      expect(style.top).toBe('148px');
      expect(style.left).toBe('64px');
      expect(style.visibility).toBe('');
    });

    it('is kept inside the window at its right edge, so it cannot widen the page at 320 px', async () => {
      const { style } = await place(rect(272, 100, 44, 44));

      expect(style.left).toBe('132px');
    });

    it('is kept inside the window at its left edge', async () => {
      const { style } = await place(rect(0, 100, 44, 44));

      expect(style.left).toBe('8px');
    });

    it('opens above the button when there is no room below', async () => {
      const { style } = await place(rect(200, 740, 44, 44));

      expect(style.top).toBe('604px');
    });

    it('keeps to the room there is, on the side with more of it, and scrolls inside it', async () => {
      // A short window: 114 px below the button, 118 px above it, and the list is 132 px tall.
      const { style } = await place(rect(200, 130, 44, 44), 300);

      expect(style.top).toBe('8px');
      expect(style.maxHeight).toBe('118px');
    });

    it('can be no wider than the window', async () => {
      const { style } = await place(rect(200, 100, 44, 44));

      expect(style.maxWidth).toBe('304px');
    });
  });

  it('has nothing for a screen reader to complain about, closed and open', async () => {
    const { element, groceries } = await setup();
    expect(a11yProblems(element)).toEqual([]);

    await openActionMenu(groceries);
    expect(a11yProblems(element)).toEqual([]);
  });
});
