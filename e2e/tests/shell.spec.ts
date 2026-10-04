import type { Page } from '@playwright/test';
import { expect, failedResponse, test, type Wallet } from '../support/fixtures';
import {
  chooseBudget,
  expectBudgetCard,
  expectDashboardRow,
  expectGlance,
  figure,
  monthSwitcher,
  openPage,
} from '../support/month-ui';
import { goToPage, moreButton, moreSheet, sidebar, tabBar } from '../support/nav';
import { SCREENS, apiStatus, openPage as openAddress, settle } from '../support/pages';
import { expectBadge, savingsToMove } from '../support/savings-ui';
import { createBudget, onboard } from '../support/seed';

/*
 * The app shell, through the browser: the navigation of each screen, the top bar with the period of
 * the page, and the global "Add spending". The fake clock stays at 2026-03-10, so the month in view is
 * March 2026 and "today" is Tuesday the 10th.
 *
 * The wallet of the add flows (all amounts in cents; the rules are in docs/DOMAIN.md):
 *
 *   salary 300000 from March 2026, no fixed costs, no extra income      income    = 300000
 *   budgets  Groceries 40000, Eating out 20000 (neither is incremental)  budgeted  =  60000
 *   unallocated = 300000 - 0 - 60000                                                 = 240000
 *
 * A spending comes out of its budget and never moves "unallocated".
 */

const INCOME = 300000;
const BUDGETED = 60000;
const UNALLOCATED = 240000;

async function seedMarch(wallet: Wallet): Promise<void> {
  await onboard(wallet.api, { startMonth: '2026-03', salary: 300000 });
  await createBudget(wallet.api, { name: 'Groceries', amount: 40000, incremental: false });
  await createBudget(wallet.api, { name: 'Eating out', amount: 20000, incremental: false });
}

/** The dialog of the shell's Add spending. */
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add spending' });

/**
 * The shell's Add spending button that is on screen: the top bar's on a wide screen, the floating one
 * on a phone. The Spendings page has its own form, and so no such button.
 */
const addButton = (page: Page) => page.getByRole('button', { name: 'Add spending', exact: true });

/** The toast that confirms an add, in the words of the Spendings page (they dismiss themselves). */
const confirmation = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Adds a spending through the shell's dialog, as a person does, and waits for the dialog to go. */
async function addThroughDialog(
  page: Page,
  entry: { amount: string; budget?: string },
): Promise<void> {
  await addButton(page).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  // The cursor is on the amount as soon as the budgets are there.
  await expect(dialog.getByLabel('Amount', { exact: true })).toBeFocused();
  await dialog.getByLabel('Amount', { exact: true }).fill(entry.amount);
  if (entry.budget !== undefined) await chooseBudget(dialog, entry.budget);
  await dialog.getByRole('button', { name: 'Add spending' }).click();
  await expect(dialog).toBeHidden();
}

/** The "Spent" tile and the budget rows of the dashboard, then the cards of the budgets page. */
async function expectMarch(
  page: Page,
  expected: {
    spent: number;
    eatingOut: [spent: number, usage: number];
    groceries: [number, number];
  },
): Promise<void> {
  const row = (available: number, [spent, usage]: [number, number]) => ({
    available,
    spent,
    remaining: available - spent,
    alert: 'ok' as const,
    usage,
  });
  await expectGlance(page, {
    income: INCOME,
    budgeted: BUDGETED,
    spent: expected.spent,
    unallocated: UNALLOCATED,
  });
  await expectDashboardRow(page, 'Eating out', row(20000, expected.eatingOut));
  await expectDashboardRow(page, 'Groceries', row(40000, expected.groceries));
}

/**
 * Adding from the Dashboard with the global button, twice, and then from the Budgets page: the page
 * behind the dialog shows the new figures at once, without a reload and without leaving it.
 */
async function addFromAnywhere(page: Page, wallet: Wallet): Promise<void> {
  await seedMarch(wallet);
  await openAddress(page, '/dashboard', 'Dashboard');
  await expectMarch(page, { spent: 0, eatingOut: [0, 0], groceries: [0, 0] });

  // 1. Eating out 12.30 on today's date (the server's).
  //    20000 - 1230 = 18770 left. usage = floor(100 * 1230 / 20000) = floor(6.15) = 6.
  await addButton(page).click();
  await expect(addDialog(page)).toContainText('Adding to March 2026.');
  await expect(addDialog(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-10');
  await page.keyboard.press('Escape');
  await expect(addDialog(page)).toBeHidden();
  await expect(addButton(page), 'focus goes back to the button that opened it').toBeFocused();

  await addThroughDialog(page, { amount: '12.30', budget: 'Eating out' });
  await expect(
    confirmation(page, 'Added €12.30 to Eating out. €187.70 left of €200.00.'),
  ).toBeVisible();
  await expect(addButton(page), 'focus goes back to the button that opened it').toBeFocused();
  // Still on the Dashboard, and its figures moved: 1230 spent in all.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expectMarch(page, { spent: 1230, eatingOut: [1230, 6], groceries: [0, 0] });

  // 2. The budget used last is the one the dialog starts on, so a second spending in it is an amount
  //    and a tap. Groceries 45.50 is not: one choice.
  //    40000 - 4550 = 35450 left. usage = floor(100 * 4550 / 40000) = floor(11.375) = 11.
  //    Spent in all: 1230 + 4550 = 5780.
  await addButton(page).click();
  await expect(
    addDialog(page).getByLabel('Budget', { exact: true }).locator('option:checked'),
  ).toContainText('Eating out');
  await page.keyboard.press('Escape');
  await addThroughDialog(page, { amount: '45.50', budget: 'Groceries' });
  await expect(
    confirmation(page, 'Added €45.50 to Groceries. €354.50 left of €400.00.'),
  ).toBeVisible();
  await expectMarch(page, { spent: 5780, eatingOut: [1230, 6], groceries: [4550, 11] });

  // The server agrees, which is what the Budgets page says when it is opened.
  await openPage(page, 'Budgets');
  await expectBudgetCard(page, 'Groceries', {
    available: 40000,
    spent: 4550,
    remaining: 35450,
    alert: 'ok',
    usage: 11,
  });
  await expectBudgetCard(page, 'Eating out', {
    available: 20000,
    spent: 1230,
    remaining: 18770,
    alert: 'ok',
    usage: 6,
  });

  // 3. From the Budgets page itself: its card moves without a reload.
  //    4550 + 1000 = 5550 spent, 40000 - 5550 = 34450 left, usage = floor(100 * 5550 / 40000) = 13.
  await addThroughDialog(page, { amount: '10.00', budget: 'Groceries' });
  await expect(page).toHaveURL(/\/budgets$/);
  await expectBudgetCard(page, 'Groceries', {
    available: 40000,
    spent: 5550,
    remaining: 34450,
    alert: 'ok',
    usage: 13,
  });
}

test.describe('on a wide screen', () => {
  test.use({ ...SCREENS.desktop });

  test('the sidebar is the one navigation: two labelled groups, Settings at the bottom, the status in its footer', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');

    await expect(sidebar(page)).toBeVisible();
    await expect(tabBar(page), 'no tab bar on a wide screen').toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(
      sidebar(page).getByRole('list', { name: 'Overview' }).getByRole('link'),
    ).toHaveText(['Dashboard', 'Report']);
    await expect(sidebar(page).getByRole('list', { name: 'Money' }).getByRole('link')).toHaveText([
      'Budgets',
      'Spendings',
      'Subscriptions',
      'Income',
      'Savings',
    ]);
    // Settings is last, below the groups, and the current page is the one that says so.
    await expect(sidebar(page).getByRole('link').last()).toHaveText('Settings');
    await expect(sidebar(page).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
    // Every link is a target of 44 px or more, and the brand is a link too.
    for (const link of await sidebar(page).getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.height, await link.innerText()).toBeGreaterThanOrEqual(44);
    }

    // The footer of the sidebar: whether the API answers, and the date the server uses.
    const aside = page.getByRole('complementary');
    await expect(aside.getByText('API online')).toBeVisible();
    await expect(aside.getByText('Server date: Mar 10, 2026')).toBeVisible();
    // The top bar has the brand and the status only on a phone.
    await expect(page.getByRole('banner').getByRole('link', { name: 'Wallet' })).toBeHidden();
    await expect(apiStatus(page, 'API online')).toHaveCount(1);
  });

  test('every page is reachable from the sidebar, the month goes with the links, and the page takes focus on its heading', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');
    await monthSwitcher(page).next();
    await monthSwitcher(page).expectShowing('April 2026');

    for (const [name, heading] of [
      ['Budgets', 'Budgets'],
      ['Spendings', 'Spendings'],
      ['Subscriptions', 'Subscriptions'],
      ['Income', 'Income'],
      ['Savings', 'Savings'],
      ['Report', 'Yearly report'],
      ['Settings', 'Settings'],
    ] as const) {
      await goToPage(page, name);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeFocused();
    }
    // The month in view travelled with the links of the pages that have one.
    await goToPage(page, 'Income');
    await expect(page).toHaveURL(/\/income\?month=2026-04$/);
    await monthSwitcher(page).expectShowing('April 2026');
  });

  test('the report has its year in the top bar, and the page follows it', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/report', 'Yearly report');

    const banner = page.getByRole('banner');
    const year = banner.getByRole('group', { name: 'Year' });
    await expect(year).toContainText('2026');
    await expect(
      page.getByRole('main').getByRole('group', { name: 'Year' }),
      'the page header no longer has a switcher',
    ).toHaveCount(0);
    await expect(
      banner.getByRole('group', { name: 'Month' }),
      'no month switcher here',
    ).toHaveCount(0);

    await year.getByRole('button', { name: 'Next year, 2027' }).click();
    await expect(page).toHaveURL(/\/report\?year=2027$/);
    await expect(year).toContainText('2027');
    await expect(page.getByRole('region', { name: '2027 at a glance' })).toBeVisible();

    // A deep link opens the same page, with the same year in the same place.
    await page.goto('/report?year=2027');
    await expect(page.getByRole('region', { name: '2027 at a glance' })).toBeVisible();
    await expect(banner.getByRole('group', { name: 'Year' })).toContainText('2027');
    await banner.getByRole('button', { name: 'Go to this year, 2026' }).click();
    await expect(page).toHaveURL(/\/report$/);
    await expect(page.getByRole('region', { name: '2026 at a glance' })).toBeVisible();
  });

  test('pages with no period have a top bar with the add button only', async ({ page, wallet }) => {
    await seedMarch(wallet);
    for (const [path, heading] of [
      ['/settings', 'Settings'],
      ['/savings', 'Savings'],
    ] as const) {
      await openAddress(page, path, heading);
      await expect(page.getByRole('group', { name: 'Month' })).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Year' })).toHaveCount(0);
      await expect(addButton(page)).toBeVisible();
    }
  });

  test('Add spending: from the Dashboard and the Budgets page, the figures move behind the dialog', async ({
    page,
    wallet,
  }) => {
    await addFromAnywhere(page, wallet);
  });

  test('Add spending in a closed month moves what is due to savings, behind the dialog', async ({
    page,
    wallet,
  }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 300000 });
    await createBudget(wallet.api, { name: 'Groceries', amount: 40000, incremental: false });
    await wallet.setNow('2026-04-10T09:00:00');

    // March is closed and waits to be moved to savings.
    // Due = unallocated 300000 - 40000 = 260000, plus the budget's 40000 that was not spent = 300000.
    await openAddress(page, '/dashboard?month=2026-03', 'Dashboard');
    await expectBadge(page, 1);
    await expect(savingsToMove(page)).toContainText('+€3,000.00');

    await addButton(page).click();
    await expect(addDialog(page)).toContainText(
      'March 2026 is closed. A spending added to it changes what is due to savings.',
    );
    await expect(addDialog(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-31');
    await addDialog(page).getByLabel('Amount', { exact: true }).fill('5');
    await addDialog(page).getByRole('button', { name: 'Add spending' }).click();
    await expect(addDialog(page)).toBeHidden();
    await expect(
      confirmation(page, 'Added €5.00 to Groceries. €395.00 left of €400.00.'),
    ).toBeVisible();

    // 40000 - 500 = 39500 not spent, so 260000 + 39500 = 299500: the block on the page moved, and the
    // badge still counts the one month.
    await expect(savingsToMove(page)).toContainText('+€2,995.00');
    await expectBadge(page, 1);
  });

  test('Add spending from the Report moves its figures', async ({ page, wallet }) => {
    await seedMarch(wallet);
    await openAddress(page, '/report', 'Yearly report');
    const glance = page.getByRole('region', { name: '2026 at a glance' });
    await expect(figure(glance, 'Spent')).toHaveText('€0.00');

    await addThroughDialog(page, { amount: '25', budget: 'Groceries' });

    // The year's spending is 2500 (nothing else was spent).
    await expect(figure(glance, 'Spent')).toHaveText('€25.00');
    await expect(page).toHaveURL(/\/report$/);
  });

  test('the Spendings page keeps its own form as the one way to add', async ({ page, wallet }) => {
    await seedMarch(wallet);
    await openAddress(page, '/spendings', 'Spendings');

    await expect(page.getByRole('button', { name: 'Add spending', exact: true })).toHaveCount(1);
    await expect(
      page
        .getByRole('region', { name: 'Add a spending' })
        .getByRole('button', { name: 'Add spending' }),
    ).toHaveCount(1);
    // The shortcut of the installed app keeps working: the cursor is on the form's amount.
    await page.goto('/spendings?add=1');
    await expect(
      page.getByRole('region', { name: 'Add a spending' }).getByLabel('Amount'),
    ).toBeFocused();
  });

  test('the add dialog says what went wrong when a month has no budget, and Cancel closes it', async ({
    page,
    wallet,
  }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 300000 });
    await openAddress(page, '/dashboard', 'Dashboard');

    await addButton(page).click();
    await expect(addDialog(page)).toContainText('No budgets in March 2026');
    await expect(addDialog(page).getByRole('link', { name: 'Go to budgets' })).toBeVisible();
    await addDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(addDialog(page)).toBeHidden();
    await expect(addButton(page)).toBeFocused();
  });
});

test.describe('on a phone', () => {
  test.use({ ...SCREENS.phone });

  test('the tab bar is the one navigation, and the status is a dot in the top bar', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');

    await expect(tabBar(page)).toBeVisible();
    await expect(sidebar(page), 'no sidebar on a phone').toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(tabBar(page).getByRole('link')).toHaveText([
      'Dashboard',
      'Budgets',
      'Spendings',
      'Savings',
    ]);
    await expect(moreButton(page)).toBeVisible();
    await expect(tabBar(page).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // The brand and the status are in the top bar, and the status is still said in words.
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Wallet' })).toBeVisible();
    await expect(apiStatus(page, 'API online')).toHaveCount(1);
    await expect(banner.getByRole('status')).toContainText('API online');
    await expect(
      page.getByRole('complementary'),
      'the sidebar holds nothing on a phone',
    ).toHaveCount(0);
  });

  test('"More" opens a sheet with the rest of the pages, and each one is reachable', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');

    await moreButton(page).click();
    await expect(moreSheet(page)).toBeVisible();
    await expect(moreSheet(page).getByRole('link')).toHaveText([
      'Subscriptions',
      'Income',
      'Report',
      'Settings',
      'Import CSV',
    ]);
    // Modal: what is behind it cannot be reached, and the page does not scroll under it.
    await expect(page.locator('html')).toHaveCSS('overflow', 'hidden');
    await page.keyboard.press('Escape');
    await expect(moreSheet(page)).toBeHidden();
    await expect(moreButton(page)).toBeFocused();
    await expect(page.locator('html')).not.toHaveCSS('overflow', 'hidden');

    for (const [name, heading] of [
      ['Subscriptions', 'Subscriptions'],
      ['Income', 'Income'],
      ['Report', 'Yearly report'],
      ['Settings', 'Settings'],
      ['Import CSV', 'Import CSV'],
    ] as const) {
      await goToPage(page, name);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeFocused();
      // "More" says the page is one of its items, in words.
      await expect(moreButton(page)).toHaveAccessibleName(
        new RegExp(`^More\\s*,\\s*current page: ${name}$`),
      );
    }
    // Back on a tab, it says nothing.
    await goToPage(page, 'Budgets');
    await expect(moreButton(page)).toHaveAccessibleName('More');
  });

  test('a tap on the backdrop closes the sheet', async ({ page, wallet }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');

    await moreButton(page).click();
    await expect(moreSheet(page)).toBeVisible();
    // Above the sheet: the dimmed page.
    await page.mouse.click(195, 60);
    await expect(moreSheet(page)).toBeHidden();
    await expect(moreButton(page)).toBeFocused();
  });

  test('the Savings tab carries the badge with the months to move, in words for a screen reader', async ({
    page,
    wallet,
  }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 300000 });
    await createBudget(wallet.api, { name: 'Groceries', amount: 40000, incremental: false });
    await wallet.setNow('2026-05-06T09:00:00');

    await openAddress(page, '/dashboard', 'Dashboard');
    // March and April are closed and unsettled.
    await expectBadge(page, 2);
    await expect(tabBar(page).getByRole('link', { name: /^Savings/ })).toContainText(
      '2 months to move to savings',
    );
  });

  test('Add spending, with the floating button: the same figures move behind the dialog', async ({
    page,
    wallet,
  }) => {
    await addFromAnywhere(page, wallet);
  });

  test('the floating button is above the tab bar, and a toast does not cover either', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/dashboard', 'Dashboard');

    await expect(addButton(page)).toHaveCount(1);
    const fab = await addButton(page).boundingBox();
    const tabs = await tabBar(page).boundingBox();
    expect(fab?.width).toBe(56);
    expect(fab?.height).toBe(56);
    expect((fab?.y ?? 0) + (fab?.height ?? 0)).toBeLessThan(tabs?.y ?? 0);

    await addThroughDialog(page, { amount: '3.50', budget: 'Groceries' });
    const toast = confirmation(page, 'Added €3.50 to Groceries. €396.50 left of €400.00.');
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(fab?.y ?? 0);
  });

  test('the Spendings page has no floating button: its form is the way to add', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/spendings', 'Spendings');

    await expect(page.getByRole('button', { name: 'Add spending', exact: true })).toHaveCount(1);
    await expect(page.locator('app-add-spending-fab')).toHaveCount(0);
    await expect(tabBar(page)).toBeVisible();
  });

  test('the report has its year in the top bar, in the same place as the month on the other pages', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openAddress(page, '/report', 'Yearly report');

    const year = page.getByRole('banner').getByRole('group', { name: 'Year' });
    await expect(year).toContainText('2026');
    await year.getByRole('button', { name: 'Next year, 2027' }).click();
    await expect(page).toHaveURL(/\/report\?year=2027$/);
    await expect(page.getByRole('region', { name: '2027 at a glance' })).toBeVisible();
  });
});

for (const [name, screen] of [
  ['a wide screen', SCREENS.desktop],
  ['a phone', SCREENS.phone],
] as const) {
  test.describe(`the welcome wizard, on ${name}`, () => {
    test.use({ ...screen });
    // `GET /api/settings` is a 404 until the wizard is done, by design (see onboarding.spec.ts).
    test.use({ allowedConsoleErrors: [failedResponse(404, /\/api\/settings$/)] });

    test('keeps the brand and the status, and offers no navigation and no way to add a spending', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Welcome to Wallet', level: 1 }),
      ).toBeVisible();
      await settle(page);

      // The wizard's own steps are a navigation too: it is the app's two that must be gone.
      await expect(page.getByRole('navigation', { name: /^Main/ })).toHaveCount(0);
      await expect(addButton(page)).toHaveCount(0);
      await expect(page.locator('app-add-spending-fab')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Wallet' })).toBeVisible();
      await expect(apiStatus(page, 'API online')).toBeVisible();
      // Not even "More": a person who has not set up yet has nowhere to go.
      await expect(page.getByRole('button', { name: /^More$/ })).toHaveCount(0);
    });
  });
}
