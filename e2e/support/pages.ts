import { type Locator, type Page, expect, test } from '@playwright/test';
import { finishAnimations } from './axe';
import { chooseMenuItem, moreActions } from './menu';
import { openFilters, openMore } from './month-ui';
import { goToPage, moreButton } from './nav';
import { NAMES } from './rich-data';

/*
 * Every page of Wallet, and every state a user opens on those pages, as a list of "stops" that a spec
 * can walk with a check of its own (axe in `a11y.spec.ts`, phone layout in `mobile.spec.ts`).
 *
 * A stop brings a fresh page to one state, from the address up: it starts with `page.goto`, so a
 * stop never depends on the one before it and a stop that fails cannot spoil the next one.
 */

export type ThemeName = 'light' | 'dark';

/** The two screens of the suite. `isMobile` matters: it is what makes the layout viewport behave. */
export const SCREENS = {
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
export type ScreenName = keyof typeof SCREENS;

/** A bank's file, in the layout of an Italian one: semicolons, day first, a comma for the cents. */
export const BANK_CSV = [
  'Date;Description;Amount',
  '03/03/2026;Conad;-12,30',
  '04/03/2026;Esselunga Milano;-45,20',
  '04/03/2026;Esselunga Milano;-45,20',
  '08/03/2026;Cafe Roma;-3,50',
  '31/02/2026;Bad date row;-1,00',
  '09/03/2026;Salary;+2500,00',
  '15/12/2025;Before the wallet started;-5,00',
].join('\n');

// ------------------------------------------------------------------------------------------------
// Waiting for a page to be ready
// ------------------------------------------------------------------------------------------------

/**
 * The words of the API status that are on screen. The sidebar of a wide screen has them and so does
 * the top bar of a phone (as text for a screen reader beside a dot), and CSS hides the one that does
 * not fit the screen (`display: none`), so only the visible one counts: two matches would be an error.
 */
export function apiStatus(page: Page, words: 'API online' | 'API offline'): Locator {
  return page.getByText(words).filter({ visible: true });
}

/** Waits until nothing on the page is loading, and nothing is moving. */
export async function settle(page: Page): Promise<void> {
  await expect(apiStatus(page, 'API online')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: /^\s*(Loading|Reading)/ }),
    'a loading indicator is still on screen',
  ).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await finishAnimations(page);
}

/** Opens an address and waits for the page, named by its `h1`, to have loaded. */
export async function openPage(page: Page, path: string, heading: string | RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await settle(page);
}

/** The open modal dialog (a native `<dialog>`: the app's forms and its confirmations). */
export function openDialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/** Waits for a modal dialog to be open and finished animating. */
export async function expectDialogOpen(page: Page): Promise<void> {
  await expect(openDialog(page)).toBeVisible();
  await settle(page);
}

function luminance([r, g, b]: number[]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

/**
 * Asserts that the page really is in the theme that the test asked for. Dark is not just a class: the
 * `<html class="dark">` of the app, the browser's own `color-scheme` (native controls follow it),
 * and the colours that a user sees (a dark canvas with light text, or the reverse). `system` is the
 * operating system preference the test emulated, when it differs from the theme asked for.
 */
export async function expectTheme(
  page: Page,
  theme: ThemeName,
  system: ThemeName = theme,
): Promise<void> {
  const html = page.locator('html');
  if (theme === 'dark') await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
  const seen = await page.evaluate(() => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const body = getComputedStyle(document.body);
    return {
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      background: rgb(body.backgroundColor),
      text: rgb(body.color),
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    };
  });
  expect(seen.colorScheme, 'the browser colour scheme of <html>').toBe(theme);
  expect(seen.prefersDark, 'the emulated operating system preference').toBe(system === 'dark');
  const [canvas, ink] = [luminance(seen.background), luminance(seen.text)];
  if (theme === 'dark') {
    expect(canvas, `page background rgb(${seen.background}) is dark`).toBeLessThan(0.05);
    expect(ink, `page text rgb(${seen.text}) is light`).toBeGreaterThan(0.5);
  } else {
    expect(canvas, `page background rgb(${seen.background}) is light`).toBeGreaterThan(0.8);
    expect(ink, `page text rgb(${seen.text}) is dark`).toBeLessThan(0.1);
  }
}

// ------------------------------------------------------------------------------------------------
// Stops
// ------------------------------------------------------------------------------------------------

/** How to open a modal dialog the way a user does: from a page, with one control. */
export interface DialogOpening {
  path: string;
  heading: string | RegExp;
  /** Anything to do on the page first (open a section that is folded). */
  prepare?: (page: Page) => Promise<void>;
  /**
   * The control that opens the dialog. The keyboard check focuses it and presses Enter. When an item
   * of a "More actions" menu opens the dialog, this is the menu's button (the one that gets focus back
   * when the dialog closes) and `menuItem` is the item.
   */
  opener: (page: Page) => Locator;
  /** The item of the menu of `opener` that opens the dialog (a name, matched exactly). */
  menuItem?: string | RegExp;
}

export interface Stop {
  /** `page`, or `page > state`: what a failure message calls it. */
  name: string;
  /** Opens the page from its address and brings it to this state. Throws when it cannot. */
  open: (page: Page) => Promise<void>;
  /** A modal dialog is open in this state. */
  modal?: boolean;
  /**
   * A "More actions" menu is open in this state. It is on screen, in front of the page, and closes
   * when the page scrolls, so a screenshot shows the window as it is, not the whole page.
   */
  menu?: boolean;
  /** The one thing a user comes to this page, or this dialog, to do. */
  primary?: (page: Page) => Locator;
  /** For a dialog that is just opened: how, so that the keyboard check can open it with keys. */
  dialog?: DialogOpening;
  /** The state only exists on this screen (the tab bar's "More" sheet is a phone's). Leave it out for both. */
  screen?: ScreenName;
}

/** The stops that make sense on a screen: the ones that belong to the other one are left out. */
export function onScreen<T extends Stop>(stops: readonly T[], screen: ScreenName): T[] {
  return stops.filter((stop) => stop.screen === undefined || stop.screen === screen);
}

/**
 * Scrolls a control to the middle of the window, where a person who has just unfolded a section is
 * looking. Unfolding at the end of a long page leaves what it reveals wherever the click scrolled to,
 * which can be under the sticky top bar (or the tab bar of a phone): not a fault of the page, but axe
 * measures a target that is half under a bar as a small one.
 */
async function toMiddle(control: Locator): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
}

/** Last button of the open dialog: Save, Create, Confirm. Cancel always comes first. */
const dialogPrimary = (page: Page): Locator => openDialog(page).getByRole('button').last();

function pageStop(
  name: string,
  path: string,
  heading: string | RegExp,
  extra: {
    primary?: Stop['primary'];
    then?: (page: Page) => Promise<void>;
  } = {},
): Stop {
  return {
    name,
    primary: extra.primary,
    open: async (page) => {
      await openPage(page, path, heading);
      await extra.then?.(page);
      await settle(page);
    },
  };
}

function dialogStop(
  name: string,
  opening: DialogOpening,
  after?: (page: Page, dialog: Locator) => Promise<void>,
): Stop {
  return {
    name,
    modal: true,
    primary: dialogPrimary,
    // The keyboard check opens the plain dialog; a state that goes on from there is the same dialog.
    dialog: after ? undefined : opening,
    open: async (page) => {
      await openPage(page, opening.path, opening.heading);
      await opening.prepare?.(page);
      if (opening.menuItem === undefined) await opening.opener(page).click();
      else await chooseMenuItem(opening.opener(page), opening.menuItem);
      await expectDialogOpen(page);
      await after?.(page, openDialog(page));
      await settle(page);
    },
  };
}

/** A page with the "More actions" menu of one row open: what a user sees before choosing. */
function menuStop(
  name: string,
  path: string,
  heading: string | RegExp,
  row: (page: Page) => Locator,
): Stop {
  return {
    name,
    menu: true,
    open: async (page) => {
      await openPage(page, path, heading);
      const button = moreActions(row(page));
      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await settle(page);
    },
  };
}

/** A card (budget, subscription, goal) by its name: an `article` named by its title. */
const card = (page: Page, name: string): Locator =>
  page.getByRole('article', { name, exact: true });

/** A row of a list, found by the text of its title (a row has one title, and the text is its own). */
const listRow = (page: Page, title: string | RegExp): Locator =>
  page.getByRole('listitem').filter({
    has: typeof title === 'string' ? page.getByText(title, { exact: true }) : page.getByText(title),
  });

/** Presses a dialog's submit button with nothing filled in, and waits for the fields to complain. */
async function submitEmpty(dialog: Locator, button: string | RegExp): Promise<void> {
  await dialog.getByRole('button', { name: button }).click();
  await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible();
}

/**
 * Every page and state of the app with the `rich`, `long-text` or `big-amounts` dataset of `support/rich-data.ts` in
 * it. Names that the clicks use come from `NAMES`, which the seed made.
 */
export function richStops(): Stop[] {
  const { budgets, subscriptions, goals, incomes, tags } = NAMES;
  const dashboardPage = { path: '/dashboard', heading: 'Dashboard' };
  const addSpendingButton = (page: Page) =>
    page.getByRole('button', { name: 'Add spending', exact: true });
  const budgetsPage = { path: '/budgets', heading: 'Budgets' };
  const subscriptionsPage = { path: '/subscriptions', heading: 'Subscriptions' };
  const incomePage = { path: '/income', heading: 'Income' };
  const changeSalaryButton = (page: Page) =>
    page.getByRole('button', { name: 'Change salary', exact: true });
  const addIncomeButton = (page: Page) =>
    page.getByRole('button', { name: 'Add income', exact: true });
  const savingsPage = { path: '/savings', heading: 'Savings' };
  const settingsPage = { path: '/settings', heading: 'Settings' };
  const spendingsPage = { path: '/spendings', heading: 'Spendings' };
  const spendingRow = (page: Page) =>
    page.getByRole('listitem').filter({ hasText: NAMES.longSpending });

  return [
    // --- Dashboard
    pageStop('dashboard', '/dashboard', 'Dashboard', {
      primary: (page) => page.getByRole('link', { name: /^See all budgets/ }),
    }),
    pageStop('dashboard (closed month)', '/dashboard?month=2026-02', 'Dashboard'),
    {
      name: 'dashboard > skip link focused',
      open: async (page) => {
        await openPage(page, '/dashboard', 'Dashboard');
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
        await settle(page);
      },
    },
    // The shell's Add spending, which is on every page but Spendings. Exactly one of its buttons is on
    // screen: the top bar's on a wide screen, the floating one on a phone.
    dialogStop('dashboard > Add spending dialog', {
      ...dashboardPage,
      opener: addSpendingButton,
    }),
    dialogStop(
      'dashboard > Add spending dialog, validation errors',
      { ...dashboardPage, opener: addSpendingButton },
      (_page, dialog) => submitEmpty(dialog, 'Add spending'),
    ),
    // The tab bar's "More" sheet, which only a phone has.
    {
      ...dialogStop('dashboard > More sheet', {
        ...dashboardPage,
        opener: (page) => moreButton(page),
      }),
      screen: 'phone',
    },

    // --- Budgets
    pageStop('budgets', budgetsPage.path, budgetsPage.heading, {
      primary: (page) => page.getByRole('button', { name: 'New budget' }).first(),
    }),
    pageStop('budgets (future month)', '/budgets?month=2026-05', 'Budgets'),
    pageStop('budgets > ended and upcoming budgets unfolded', budgetsPage.path, 'Budgets', {
      then: async (page) => {
        await page.getByText('Upcoming and ended budgets').click();
        const unfolded = page.getByRole('button', {
          name: `More actions for ${budgets.deletable}`,
        });
        await expect(unfolded).toBeVisible();
        await toMiddle(unfolded);
      },
    }),
    dialogStop('budgets > New budget dialog', {
      ...budgetsPage,
      opener: (page) => page.getByRole('button', { name: 'New budget' }).first(),
    }),
    dialogStop(
      'budgets > New budget dialog, validation errors',
      {
        ...budgetsPage,
        opener: (page) => page.getByRole('button', { name: 'New budget' }).first(),
      },
      (_page, dialog) => submitEmpty(dialog, 'Create budget'),
    ),
    dialogStop(`budgets > Edit ${budgets.over} dialog`, {
      ...budgetsPage,
      opener: (page) => page.getByRole('button', { name: `Edit ${budgets.over}` }),
    }),
    dialogStop('budgets > Move money dialog', {
      ...budgetsPage,
      opener: (page) => page.getByRole('button', { name: 'Move money', exact: true }).first(),
    }),
    dialogStop(
      'budgets > Move money dialog, validation errors',
      {
        ...budgetsPage,
        opener: (page) => page.getByRole('button', { name: 'Move money', exact: true }).first(),
      },
      (_page, dialog) => submitEmpty(dialog, 'Move money'),
    ),
    dialogStop(`budgets > Archive ${budgets.over} confirmation`, {
      ...budgetsPage,
      opener: (page) => moreActions(card(page, budgets.over)),
      menuItem: 'Archive',
    }),
    dialogStop(`budgets > Delete ${budgets.deletable} confirmation`, {
      ...budgetsPage,
      prepare: (page) => page.getByText('Upcoming and ended budgets').click(),
      opener: (page) => page.getByRole('button', { name: `More actions for ${budgets.deletable}` }),
      menuItem: 'Delete',
    }),
    dialogStop('budgets > Delete transfer confirmation', {
      ...budgetsPage,
      opener: (page) => page.getByRole('button', { name: /^More actions for transfer of/ }).first(),
      menuItem: 'Delete',
    }),
    menuStop('budgets > card menu open', budgetsPage.path, 'Budgets', (page) =>
      card(page, budgets.over),
    ),

    // --- Spendings
    pageStop('spendings', spendingsPage.path, 'Spendings', {
      primary: (page) => page.getByRole('button', { name: 'Add spending', exact: true }),
    }),
    pageStop('spendings > add form, validation errors', spendingsPage.path, 'Spendings', {
      then: async (page) => {
        await page.getByRole('button', { name: 'Add spending', exact: true }).click();
        await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
      },
    }),
    pageStop('spendings > tag suggestions open', spendingsPage.path, 'Spendings', {
      then: async (page) => {
        await openMore(page);
        const box = page.getByRole('combobox', { name: /^Tags/ });
        await box.click();
        await box.pressSequentially('e');
        await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toBeVisible();
      },
    }),
    pageStop('spendings > filters open, nothing found', spendingsPage.path, 'Spendings', {
      then: async (page) => {
        await openFilters(page);
        await page.getByLabel('Search', { exact: true }).fill('no spending is called this');
        await expect(page.getByText('Nothing matches these filters')).toBeVisible();
      },
    }),
    pageStop('spendings > all months, more to load', spendingsPage.path, 'Spendings', {
      then: async (page) => {
        await openFilters(page);
        await page.getByText('All months', { exact: true }).click();
        await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
      },
    }),
    dialogStop('spendings > Edit spending dialog', {
      ...spendingsPage,
      opener: (page) => spendingRow(page).getByRole('button', { name: /^Edit/ }),
    }),
    dialogStop('spendings > Delete spending confirmation', {
      ...spendingsPage,
      opener: (page) => moreActions(spendingRow(page)),
      menuItem: 'Delete',
    }),
    menuStop('spendings > row menu open', spendingsPage.path, 'Spendings', spendingRow),

    // --- Subscriptions
    pageStop('subscriptions', subscriptionsPage.path, 'Subscriptions', {
      primary: (page) => page.getByRole('button', { name: 'Add subscription' }).first(),
    }),
    dialogStop('subscriptions > Add subscription dialog', {
      ...subscriptionsPage,
      opener: (page) => page.getByRole('button', { name: 'Add subscription' }).first(),
    }),
    dialogStop(
      'subscriptions > Add subscription dialog, validation errors',
      {
        ...subscriptionsPage,
        opener: (page) => page.getByRole('button', { name: 'Add subscription' }).first(),
      },
      (_page, dialog) => submitEmpty(dialog, 'Add subscription'),
    ),
    dialogStop(`subscriptions > Edit ${subscriptions.monthly} dialog`, {
      ...subscriptionsPage,
      opener: (page) => page.getByRole('button', { name: `Edit ${subscriptions.monthly}` }),
    }),
    dialogStop(`subscriptions > Change the price of ${subscriptions.monthly} dialog`, {
      ...subscriptionsPage,
      opener: (page) =>
        page.getByRole('button', { name: `Change the price of ${subscriptions.monthly}` }),
    }),
    dialogStop(`subscriptions > Cancel ${subscriptions.renewsSoon} confirmation`, {
      ...subscriptionsPage,
      opener: (page) => moreActions(card(page, subscriptions.renewsSoon)),
      // The item is named for the subscription, so it is not taken for the Cancel of a dialog.
      menuItem: `Cancel ${subscriptions.renewsSoon}`,
    }),
    dialogStop(`subscriptions > Delete ${subscriptions.renewsSoon} confirmation`, {
      ...subscriptionsPage,
      opener: (page) => moreActions(card(page, subscriptions.renewsSoon)),
      menuItem: 'Delete',
    }),
    menuStop('subscriptions > card menu open', subscriptionsPage.path, 'Subscriptions', (page) =>
      card(page, subscriptions.renewsSoon),
    ),

    // --- Income
    pageStop('income', incomePage.path, 'Income', {
      primary: addIncomeButton,
    }),
    dialogStop('income > Change salary dialog', {
      ...incomePage,
      opener: changeSalaryButton,
    }),
    dialogStop(
      'income > Change salary dialog, validation errors',
      { ...incomePage, opener: changeSalaryButton },
      (_page, dialog) => submitEmpty(dialog, /^Save (salary|the change)$/),
    ),
    dialogStop('income > Add income dialog', {
      ...incomePage,
      opener: addIncomeButton,
    }),
    dialogStop(
      'income > Add income dialog, validation errors',
      { ...incomePage, opener: addIncomeButton },
      (_page, dialog) => submitEmpty(dialog, 'Add income'),
    ),
    dialogStop(`income > Edit ${incomes.gift} dialog`, {
      ...incomePage,
      opener: (page) => moreActions(listRow(page, incomes.gift)),
      menuItem: 'Edit',
    }),
    dialogStop(`income > Delete ${incomes.gift} confirmation`, {
      ...incomePage,
      opener: (page) => moreActions(listRow(page, incomes.gift)),
      menuItem: 'Delete',
    }),
    dialogStop('income > Delete salary change confirmation', {
      ...incomePage,
      opener: (page) =>
        page.getByRole('button', { name: /^More actions for the salary from/ }).first(),
      menuItem: 'Delete',
    }),

    // --- Savings
    pageStop('savings', savingsPage.path, 'Savings', {
      primary: (page) => page.getByRole('button', { name: /^Mark .* as done$/ }).first(),
    }),
    pageStop('savings > archived goals unfolded', savingsPage.path, 'Savings', {
      then: async (page) => {
        await page.getByText('Archived goals').click();
        const unfolded = page.getByRole('button', { name: `More actions for ${goals.archived}` });
        await expect(unfolded).toBeVisible();
        await toMiddle(unfolded);
      },
    }),
    dialogStop('savings > Split a month dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: /^Split .* across goals$/ }).first(),
    }),
    dialogStop(
      'savings > Split a month dialog, validation errors',
      {
        ...savingsPage,
        opener: (page) => page.getByRole('button', { name: /^Split .* across goals$/ }).first(),
      },
      async (_page, dialog) => {
        await dialog.getByRole('button', { name: 'Confirm split' }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
      },
    ),
    dialogStop('savings > New goal dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: 'New goal' }).first(),
    }),
    dialogStop(
      'savings > New goal dialog, validation errors',
      { ...savingsPage, opener: (page) => page.getByRole('button', { name: 'New goal' }).first() },
      (_page, dialog) => submitEmpty(dialog, 'Create goal'),
    ),
    dialogStop(`savings > Edit ${goals.active} dialog`, {
      ...savingsPage,
      opener: (page) => moreActions(card(page, goals.active)),
      menuItem: 'Edit',
    }),
    dialogStop('savings > Deposit dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: 'Deposit', exact: true }),
    }),
    dialogStop(
      'savings > Deposit dialog, validation errors',
      {
        ...savingsPage,
        opener: (page) => page.getByRole('button', { name: 'Deposit', exact: true }),
      },
      (_page, dialog) => submitEmpty(dialog, 'Deposit'),
    ),
    dialogStop('savings > Withdraw dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: 'Withdraw', exact: true }),
    }),
    dialogStop('savings > Reallocate dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: 'Reallocate', exact: true }),
    }),
    dialogStop('savings > Edit opening balance dialog', {
      ...savingsPage,
      opener: (page) => page.getByRole('button', { name: 'Edit opening balance' }).first(),
    }),
    dialogStop(`savings > Delete ${goals.open} confirmation`, {
      ...savingsPage,
      opener: (page) => moreActions(card(page, goals.open)),
      menuItem: 'Delete',
    }),
    menuStop('savings > goal card menu open', savingsPage.path, 'Savings', (page) =>
      card(page, goals.active),
    ),
    dialogStop('savings > Delete entry confirmation', {
      ...savingsPage,
      // A deposit, a withdrawal and a reallocation can be deleted: their menus name the entry.
      opener: (page) =>
        page
          .getByRole('region', { name: 'History' })
          .getByRole('button', { name: /^More actions for (Deposit|Withdrawal|Moved)/ })
          .first(),
      menuItem: 'Delete',
    }),
    dialogStop('savings > Undo settlement confirmation', {
      ...savingsPage,
      opener: (page) =>
        page
          .getByRole('region', { name: 'History' })
          .getByRole('button', { name: /^More actions for Settled / })
          .first(),
      menuItem: 'Undo settlement',
    }),
    menuStop('savings > history entry menu open', savingsPage.path, 'Savings', (page) =>
      page
        .getByRole('region', { name: 'History' })
        .getByRole('listitem')
        .filter({
          has: page.getByRole('button', { name: /^More actions for (Deposit|Withdrawal|Moved)/ }),
        })
        .first(),
    ),

    // --- Yearly report
    pageStop('report', '/report', 'Yearly report'),
    pageStop('report (a projected year)', '/report?year=2027', 'Yearly report'),
    pageStop('report (a year before the wallet)', '/report?year=2025', 'Yearly report'),

    // --- Settings
    pageStop('settings', settingsPage.path, 'Settings', {
      primary: (page) => page.getByRole('button', { name: 'Save settings' }),
    }),
    pageStop('settings > form, validation errors', settingsPage.path, 'Settings', {
      then: async (page) => {
        await page.getByLabel('Currency').fill('EU');
        await page.getByRole('button', { name: 'Save settings' }).click();
        await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
      },
    }),
    dialogStop(`settings > Edit tag ${tags.weekend} dialog`, {
      ...settingsPage,
      opener: (page) => page.getByRole('button', { name: `Edit tag ${tags.weekend}` }),
    }),
    dialogStop(
      `settings > Edit tag ${tags.weekend} dialog, validation errors`,
      {
        ...settingsPage,
        opener: (page) => page.getByRole('button', { name: `Edit tag ${tags.weekend}` }),
      },
      async (_page, dialog) => {
        await dialog.getByLabel('Name').fill('');
        await submitEmpty(dialog, 'Save changes');
      },
    ),
    dialogStop(`settings > Delete tag ${tags.weekend} confirmation`, {
      ...settingsPage,
      opener: (page) => page.getByRole('button', { name: `More actions for tag ${tags.weekend}` }),
      menuItem: 'Delete',
    }),
    menuStop('settings > tag menu open', settingsPage.path, 'Settings', (page) =>
      listRow(page, tags.weekend),
    ),
    pageStop('settings > backup made, toast on screen', settingsPage.path, 'Settings', {
      then: async (page) => {
        await page.getByRole('button', { name: 'Back up now' }).click();
        await expect(
          page
            .getByRole('status')
            .filter({ hasText: /backup/i })
            .last(),
        ).toBeVisible();
      },
    }),

    // --- Import
    ...importStops(true),
  ];
}

/** The import wizard, step by step, and the dialogs that belong to it. */
function importStops(withProfile: boolean): Stop[] {
  const path = '/import';
  const heading = 'Import CSV';

  const chooseFile = async (page: Page) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'bank.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(BANK_CSV, 'utf-8'),
    });
    await expect(page.getByText('Rows found')).toBeVisible();
    await settle(page);
  };
  const toColumns = async (page: Page) => {
    await chooseFile(page);
    await page.getByRole('button', { name: 'Next: choose the columns' }).click();
    await expect(page.getByRole('heading', { name: 'How is the file laid out?' })).toBeVisible();
    await settle(page);
  };
  const mapColumns = async (page: Page) => {
    await page.getByLabel('Date column').selectOption({ label: 'Date' });
    await page.getByLabel('Amount column').selectOption({ label: 'Amount' });
    await page.getByLabel('Description column').selectOption({ label: 'Description' });
    await page.getByLabel('Date format').selectOption('DD/MM/YYYY');
    await page.getByLabel('Decimal separator').selectOption(',');
    await expect(page.getByRole('button', { name: 'Next: review the rows' })).toBeEnabled();
  };
  const toReview = async (page: Page) => {
    await toColumns(page);
    await mapColumns(page);
    await page.getByRole('button', { name: 'Next: review the rows' }).click();
    await expect(page.getByRole('heading', { name: 'Review the rows' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await settle(page);
  };
  /** Gives every ticked row the budget with this name (the option also says what is left in it). */
  const setBudgetForTicked = async (page: Page, name: string) => {
    const picker = page.getByLabel('Budget for the ticked rows');
    const value = await picker.locator('option', { hasText: name }).first().getAttribute('value');
    if (value === null) throw new Error(`No budget called ${name} to choose`);
    await picker.selectOption(value);
    await page.getByRole('button', { name: 'Set budget for the ticked rows' }).click();
  };
  return [
    pageStop('import > choose a file', path, heading, {
      primary: (page) => page.getByRole('button', { name: 'Next: choose the columns' }),
    }),
    pageStop('import > file chosen', path, heading, {
      then: chooseFile,
      primary: (page) => page.getByRole('button', { name: 'Next: choose the columns' }),
    }),
    pageStop('import > columns', path, heading, {
      then: toColumns,
      primary: (page) => page.getByRole('button', { name: 'Next: review the rows' }),
    }),
    pageStop('import > columns chosen', path, heading, {
      then: async (page) => {
        await toColumns(page);
        await mapColumns(page);
      },
      primary: (page) => page.getByRole('button', { name: 'Next: review the rows' }),
    }),
    pageStop('import > columns, profile name missing', path, heading, {
      then: async (page) => {
        await toColumns(page);
        await mapColumns(page);
        await page.getByText('Save these settings as a profile').click();
        await page.getByRole('button', { name: 'Save profile' }).click();
        await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
      },
    }),
    {
      name: 'import > Import profiles dialog',
      modal: true,
      primary: dialogPrimary,
      open: async (page) => {
        await openPage(page, path, heading);
        await toColumns(page);
        await page.getByRole('button', { name: 'Manage profiles' }).click();
        await expectDialogOpen(page);
        if (withProfile)
          await expect(openDialog(page).getByText(NAMES.importProfile)).toBeVisible();
        else await expect(openDialog(page).getByText('No profiles yet')).toBeVisible();
      },
    },
    ...(withProfile
      ? [
          {
            name: 'import > Delete profile confirmation, over the profiles dialog',
            modal: true,
            primary: dialogPrimary,
            open: async (page: Page) => {
              await openPage(page, path, heading);
              await toColumns(page);
              await page.getByRole('button', { name: 'Manage profiles' }).click();
              await expectDialogOpen(page);
              await chooseMenuItem(
                openDialog(page).getByRole('button', {
                  name: `More actions for profile ${NAMES.importProfile}`,
                }),
                'Delete',
              );
              await expect(page.getByRole('heading', { name: /Delete/ })).toBeVisible();
              await settle(page);
            },
          } satisfies Stop,
        ]
      : []),
    pageStop('import > review the rows', path, heading, {
      then: toReview,
      primary: (page) => page.getByRole('button', { name: /^Import \d+ spending/ }),
    }),
    pageStop('import > review, rows ticked with a budget', path, heading, {
      then: async (page) => {
        await toReview(page);
        await page.getByRole('button', { name: 'Tick all shown rows', exact: true }).click();
        await setBudgetForTicked(page, NAMES.budgets.fine);
        await expect(page.getByRole('button', { name: /^Import [1-9]\d* spending/ })).toBeEnabled();
      },
      primary: (page) => page.getByRole('button', { name: /^Import \d+ spending/ }),
    }),
    pageStop('import > done', path, heading, {
      then: async (page) => {
        await toReview(page);
        await page.getByRole('button', { name: 'Tick all shown rows', exact: true }).click();
        await setBudgetForTicked(page, NAMES.budgets.fine);
        await page.getByRole('button', { name: /^Import [1-9]\d* spending/ }).click();
        await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
      },
      primary: (page) => page.getByRole('link', { name: 'Go to spendings' }),
    }),
    {
      name: 'import > Leave the import? confirmation',
      modal: true,
      primary: dialogPrimary,
      open: async (page) => {
        await openPage(page, path, heading);
        await chooseFile(page);
        await goToPage(page, 'Budgets');
        await expectDialogOpen(page);
      },
    },
  ];
}

/** The pages of a wallet with nothing in it, and the first things a new user may open. */
export function emptyStops(): Stop[] {
  const spendingsPage = { path: '/spendings', heading: 'Spendings' };
  return [
    pageStop('dashboard', '/dashboard', 'Dashboard'),
    pageStop('budgets', '/budgets', 'Budgets', {
      primary: (page) => page.getByRole('button', { name: 'New budget' }).first(),
    }),
    dialogStop('budgets > New budget dialog', {
      path: '/budgets',
      heading: 'Budgets',
      opener: (page) => page.getByRole('button', { name: 'New budget' }).first(),
    }),
    pageStop('spendings', spendingsPage.path, 'Spendings'),
    pageStop('subscriptions', '/subscriptions', 'Subscriptions', {
      primary: (page) => page.getByRole('button', { name: 'Add subscription' }).first(),
    }),
    dialogStop('subscriptions > Add subscription dialog', {
      path: '/subscriptions',
      heading: 'Subscriptions',
      opener: (page) => page.getByRole('button', { name: 'Add subscription' }).first(),
    }),
    pageStop('income', '/income', 'Income', {
      primary: (page) => page.getByRole('button', { name: 'Add income', exact: true }),
    }),
    dialogStop('income > Add income dialog', {
      path: '/income',
      heading: 'Income',
      opener: (page) => page.getByRole('button', { name: 'Add income', exact: true }),
    }),
    pageStop('savings', '/savings', 'Savings', {
      primary: (page) => page.getByRole('button', { name: 'New goal' }).first(),
    }),
    dialogStop('savings > New goal dialog', {
      path: '/savings',
      heading: 'Savings',
      opener: (page) => page.getByRole('button', { name: 'New goal' }).first(),
    }),
    pageStop('report', '/report', 'Yearly report'),
    pageStop('settings', '/settings', 'Settings', {
      primary: (page) => page.getByRole('button', { name: 'Save settings' }),
    }),
    pageStop('import > choose a file', '/import', 'Import CSV', {
      primary: (page) => page.getByRole('button', { name: 'Next: choose the columns' }),
    }),
    ...importStops(false).filter((stop) => stop.name === 'import > Import profiles dialog'),
  ];
}

/**
 * The welcome wizard, step by step. It only exists for a wallet that was never set up, so these stops
 * need a server with no data (and its `GET /api/settings` 404, which the app expects, is allowed by
 * the spec).
 */
export function onboardingStops(): Stop[] {
  const path = '/onboarding';
  const heading = 'Welcome to Wallet';
  const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
  const step = (page: Page, name: string) =>
    expect(page.getByRole('heading', { name })).toBeVisible();

  const toSalary = async (page: Page) => {
    await next(page).click();
    await step(page, 'Your monthly salary');
  };
  const toSavings = async (page: Page) => {
    await toSalary(page);
    await page.getByLabel('Monthly net salary').fill('2500');
    await next(page).click();
    await step(page, 'Your savings so far');
  };
  const toBudgets = async (page: Page) => {
    await toSavings(page);
    await page.getByLabel(/Savings balance/).fill('1500');
    await next(page).click();
    await step(page, 'Your first budgets');
  };
  const addBudget = async (page: Page, n: number, name: string, amount: string) => {
    await page.getByRole('button', { name: 'Add a budget' }).click();
    const group = page.getByRole('group', { name: `Budget ${n}` });
    await group.getByLabel('Name').fill(name);
    await group.getByLabel('Monthly amount').fill(amount);
  };
  const complaint = (page: Page) =>
    expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();

  return [
    pageStop('onboarding > start month and currency', path, heading, {
      primary: (page) => next(page),
    }),
    pageStop('onboarding > start month and currency, validation errors', path, heading, {
      then: async (page) => {
        await page.getByLabel('Currency').fill('');
        await next(page).click();
        await complaint(page);
      },
    }),
    pageStop('onboarding > salary', path, heading, {
      then: toSalary,
      primary: (page) => next(page),
    }),
    pageStop('onboarding > salary, validation errors', path, heading, {
      then: async (page) => {
        await toSalary(page);
        await next(page).click();
        await complaint(page);
      },
    }),
    pageStop('onboarding > savings', path, heading, { then: toSavings }),
    pageStop('onboarding > budgets, none yet', path, heading, { then: toBudgets }),
    pageStop('onboarding > budgets, one of two incomplete', path, heading, {
      then: async (page) => {
        await toBudgets(page);
        await addBudget(page, 1, 'Groceries', '400');
        await page.getByRole('button', { name: 'Add a budget' }).click();
        await next(page).click();
        await complaint(page);
      },
    }),
    pageStop('onboarding > review', path, heading, {
      then: async (page) => {
        await toBudgets(page);
        await addBudget(page, 1, 'Groceries', '400');
        await addBudget(page, 2, 'Fun', '150');
        await page
          .getByRole('group', { name: 'Budget 2' })
          .getByText('Incremental', { exact: true })
          .click();
        await next(page).click();
        await step(page, 'Review and finish');
      },
      primary: (page) => page.getByRole('button', { name: 'Create my wallet' }),
    }),
  ];
}

// ------------------------------------------------------------------------------------------------
// Walking
// ------------------------------------------------------------------------------------------------

/**
 * Runs `visit` on every stop, each as a `test.step`. A stop that cannot be brought up (a button is
 * missing, a dialog never appears) does not end the walk: the failure is recorded, the next stop goes
 * on from a fresh page, and the test fails at the end with the list. A check reports its own findings
 * softly (`expect.soft`), so those are collected the same way.
 */
export async function eachStop(
  stops: readonly Stop[],
  visit: (stop: Stop) => Promise<void>,
): Promise<void> {
  const unreachable: string[] = [];
  for (const stop of stops) {
    try {
      await test.step(stop.name, () => visit(stop));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unreachable.push(`${stop.name}\n    ${message.split('\n').slice(0, 8).join('\n    ')}`);
    }
  }
  expect(
    unreachable,
    `${unreachable.length} stop(s) failed outright, so they may not have been checked:\n  ${unreachable.join('\n  ')}`,
  ).toEqual([]);
}

/** Visits every stop: opens it, then runs `check` on the page as it is. */
export async function walk(
  page: Page,
  stops: readonly Stop[],
  check: (stop: Stop) => Promise<void>,
): Promise<void> {
  await eachStop(stops, async (stop) => {
    await stop.open(page);
    await check(stop);
  });
}
