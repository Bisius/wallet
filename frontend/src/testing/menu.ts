import { getByRole, queryAllByRole } from './dom';
import { settle } from './harness';

/** The name of every "More actions" button: `More actions for Groceries`. */
const MORE_ACTIONS = /^More actions/;

/** The menus that are open inside `root`, as the jsdom shim of popovers marks them. */
function openMenus(root: ParentNode): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>('[popover][data-popover-open]'));
  // `root` can be the popover itself.
  if (root instanceof HTMLElement && root.matches('[popover][data-popover-open]')) {
    found.unshift(root);
  }
  return found;
}

/**
 * Opens an `app-action-menu` the way a person does, by pressing its "More actions" button, and
 * returns the open list. `name` is the button's accessible name: leave it out when `root` holds a
 * single menu (a row), say it (`'More actions for Groceries'`) when it holds several. The menu stays
 * open when it already is.
 */
export async function openActionMenu(
  root: ParentNode,
  name: string | RegExp = MORE_ACTIONS,
): Promise<HTMLElement> {
  const button = getByRole(root, 'button', name);
  if (button.getAttribute('aria-expanded') !== 'true') {
    button.click();
    await settle();
  }
  const menu = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (!menu || !menu.hasAttribute('data-popover-open')) {
    throw new Error(`The menu of "${button.getAttribute('aria-label')}" did not open`);
  }
  return menu;
}

/**
 * Presses an item of the menu that is open inside `root` (see `openActionMenu`), and lets what it
 * starts settle. The menu closes first and hands focus to its button, as it does for a person.
 */
export async function clickMenuItem(root: ParentNode, name: string | RegExp): Promise<void> {
  const menus = openMenus(root);
  if (menus.length !== 1) {
    throw new Error(
      `Expected one open menu, found ${menus.length}. Open it with openActionMenu().`,
    );
  }
  getByRole(menus[0], 'button', name).click();
  await settle();
}

/** Opens the menu of `root` and presses its item `item`: `await rowAction(row, 'Delete')`. */
export async function rowAction(
  root: ParentNode,
  item: string | RegExp,
  menu: string | RegExp = MORE_ACTIONS,
): Promise<void> {
  await openActionMenu(root, menu);
  await clickMenuItem(root, item);
}

/**
 * An item of the menu named `menu` inside `root`, whether the menu is open or not, to look at (is it
 * disabled?) without opening it. `menu` can be left out when `root` holds a single menu.
 */
export function menuItem(
  root: ParentNode,
  item: string | RegExp,
  menu: string | RegExp = MORE_ACTIONS,
): HTMLButtonElement {
  const button = getByRole(root, 'button', menu);
  const popover = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (!popover) throw new Error(`The menu of "${button.getAttribute('aria-label')}" is not there`);
  return getByRole(popover, 'button', item) as HTMLButtonElement;
}

/** The names of the items in the menu named `name`, in the order they are reached with Tab. */
export function menuItemNames(root: ParentNode, name: string | RegExp = MORE_ACTIONS): string[] {
  const button = getByRole(root, 'button', name);
  const menu = document.getElementById(button.getAttribute('aria-controls') ?? '');
  return menu ? queryAllByRole(menu, 'button').map((item) => item.textContent?.trim() ?? '') : [];
}
