import { type Locator, type Page, expect } from '@playwright/test';

/*
 * Moving between the pages of the app through the navigation, as a person does, on either screen.
 *
 * A wide screen has the sidebar (`navigation` named "Main") with every page but Import. A phone has the
 * tab bar (`navigation` named "Main (tabs)") with four of them, and a "More" button that opens a sheet
 * with the rest, so Subscriptions, Income, Report, Settings and Import are one tap further. The hidden
 * navigation is `display: none`, which takes it out of what `getByRole` finds, so at any moment there is
 * exactly one of them to ask.
 */

/** A page, by the name of its link in the navigation. */
export type NavPage =
  | 'Dashboard'
  | 'Budgets'
  | 'Spendings'
  | 'Subscriptions'
  | 'Income'
  | 'Savings'
  | 'Report'
  | 'Settings'
  | 'Import CSV';

/** The pages that have a tab of their own on a phone. */
const TABS: readonly NavPage[] = ['Dashboard', 'Budgets', 'Spendings', 'Savings'];

/** The tab bar of a phone: there is one to find only on a phone. */
export function tabBar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main (tabs)' });
}

/** The sidebar of a wide screen: there is one to find only on a wide screen. */
export function sidebar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main', exact: true });
}

/** The navigation that is on screen, whichever it is. */
export async function navigation(page: Page): Promise<Locator> {
  return (await tabBar(page).count()) > 0 ? tabBar(page) : sidebar(page);
}

/** The "More" button of the tab bar. Its name says when the page is one of its items ("More, current page: Income"). */
export function moreButton(page: Page): Locator {
  return tabBar(page).getByRole('button', { name: /^More/ });
}

/** The sheet that "More" opens. */
export function moreSheet(page: Page): Locator {
  return page.getByRole('dialog', { name: 'More' });
}

/** The link of a page in the navigation that is on screen (a link also carries the badge words: it starts with the name). */
function link(scope: Locator, name: NavPage): Locator {
  return scope.getByRole('link', { name: new RegExp(`^${name}`) });
}

/**
 * Goes to a page through the navigation: the sidebar link on a wide screen, the tab on a phone, and for
 * what the tab bar has no room for, "More" and then the link in the sheet (which closes). It presses
 * the link and returns: what the page shows is for the caller to wait for. The month in view travels
 * with the link, as it does for a person.
 *
 * Import has no link in the sidebar (the Spendings page links to it), so on a wide screen it is an error.
 */
export async function goToPage(page: Page, name: NavPage): Promise<void> {
  if ((await tabBar(page).count()) === 0) {
    if (name === 'Import CSV') {
      throw new Error('Import has no link in the sidebar: use the link on the Spendings page');
    }
    await link(sidebar(page), name).click();
    return;
  }
  if (TABS.includes(name)) {
    await link(tabBar(page), name).click();
    return;
  }
  await moreButton(page).click();
  await expect(moreSheet(page)).toBeVisible();
  await link(moreSheet(page), name).click();
  await expect(moreSheet(page), 'the sheet closes when a link is chosen').toBeHidden();
}
