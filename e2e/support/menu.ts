import { type Locator, expect } from '@playwright/test';

/*
 * The "More actions" menu of a card or a row (`app-action-menu`). It is a disclosure: a button with
 * `aria-expanded` that opens a list of ordinary buttons (a native popover in the top layer), so a
 * spec opens it and presses an item like a person does. Use this one helper for every action that
 * lives in a menu (Edit, Archive, Move up, Delete, ...), so that moving an action in or out of a menu
 * changes one place.
 */

/** The "More actions" button inside `scope` (a row or a card: it holds exactly one menu). */
export function moreActions(scope: Locator): Locator {
  return scope.getByRole('button', { name: /^More actions/ });
}

/** An item of the menu that is open under `button` (a "More actions" button): for a spec that reaches it with the keyboard. */
export function openMenuItem(button: Locator, name: string | RegExp): Locator {
  return button
    .page()
    .locator('[popover]:popover-open')
    .getByRole('button', typeof name === 'string' ? { name, exact: true } : { name });
}

/**
 * Opens the menu of `button` (a "More actions" button) and presses its item `name`. A string is
 * matched exactly ("Edit" is not "Edit budget"). Use `rowAction` when the row or card is at hand;
 * this is for a spec that holds the button (a list of stops that also presses it with the keyboard).
 *
 * The menu closes when the item is pressed, and focus is on its button before the item acts (a dialog
 * the item opens returns focus there), which the helper waits for. A row that the item turns into a
 * form takes its menu with it: that counts as closed.
 */
export async function chooseMenuItem(button: Locator, name: string | RegExp): Promise<void> {
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const menuId = await button.getAttribute('aria-controls');
  if (menuId === null) throw new Error('The "More actions" button does not say what it controls');
  const menu = button.page().locator(`[id="${menuId}"]`);
  await menu
    .getByRole('button', typeof name === 'string' ? { name, exact: true } : { name })
    .click();
  // Closed, or gone with its row: an item that edits the row in place (Rename, Edit) replaces it.
  await expect(menu).toBeHidden();
}

/**
 * Opens the "More actions" menu inside `scope` (a row or a card: it holds exactly one menu) and
 * presses the item `name`.
 *
 *     await rowAction(page.getByRole('article', { name: 'Groceries' }), 'Delete');
 */
export async function rowAction(scope: Locator, name: string | RegExp): Promise<void> {
  await chooseMenuItem(moreActions(scope), name);
}
