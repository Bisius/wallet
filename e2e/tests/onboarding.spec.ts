import type { Locator, Page } from '@playwright/test';
import { expect, failedResponse, test } from '../support/fixtures';
import { getMonth, getSavings, getSettings, onboard } from '../support/seed';

/*
 * First run, through the browser. The server clock is fixed at 2026-03-10 09:00 (the default of the
 * harness), so "today" is the 10th of March 2026 on every machine.
 *
 * The app asks `GET /api/settings` before it shows anything, and that is a 404 until the wallet is
 * set up. It is by design, and Chromium logs every failed fetch as a console error, so the browser
 * error guard has to be told that this one is expected.
 */
test.use({ allowedConsoleErrors: [failedResponse(404, /\/api\/settings$/)] });

/** The figure of the tile (a `dt` and its `dd`) that is labelled `label` inside `region`. */
function figure(region: Locator, label: string) {
  return region
    .locator('dl > div')
    .filter({ has: region.page().getByText(label, { exact: true }) })
    .getByRole('definition')
    .first();
}

/** A figure of the "at a glance" strip of the dashboard. */
function glanceFigure(page: Page, label: string) {
  return figure(page.getByRole('region', { name: /at a glance$/ }), label);
}

/** The "Budget progress" row of one budget. */
function budgetRow(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Budget progress' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

test.describe('first run', () => {
  test('a fresh database opens on the welcome wizard, whatever page is asked for', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Welcome to Wallet', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Welcome · Wallet');
    await expect(page.getByText('Step 1 of 5')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start month and currency' })).toBeVisible();

    // The wizard starts from the server's today: March 2026, euros, US formatting.
    await expect(page.getByLabel('Start month')).toHaveValue('2026-03');
    await expect(page.getByLabel('Currency')).toHaveValue('EUR');
    await expect(page.getByLabel('Locale')).toHaveValue('en-US');
    await expect(page.getByText('Amounts will look like €1,234.56.')).toBeVisible();

    // The rest of the app is not reachable before the setup.
    for (const path of ['/dashboard', '/budgets', '/savings?month=2026-03', '/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/onboarding$/);
    }
  });

  test('the wizard sets the wallet up and the dashboard shows what was entered', async ({
    page,
    wallet,
  }) => {
    await page.goto('/');

    // 1. Basics: start in January, which makes January and February closed months.
    await expect(page.getByRole('heading', { name: 'Start month and currency' })).toBeVisible();
    await page.getByLabel('Start month').fill('2026-01');
    await page.getByRole('button', { name: 'Next' }).click();

    // 2. Salary.
    await expect(page.getByRole('heading', { name: 'Your monthly salary' })).toBeVisible();
    await expect(page.getByText('Step 2 of 5')).toBeVisible();
    await page.getByLabel('Monthly net salary').fill('2500');
    await page.getByRole('button', { name: 'Next' }).click();

    // 3. Opening savings: the label says which day the balance is on.
    await expect(page.getByRole('heading', { name: 'Your savings so far' })).toBeVisible();
    await page.getByLabel('Savings balance on the 1st of January 2026').fill('1500');
    await page.getByRole('button', { name: 'Next' }).click();

    // 4. Two budgets: Groceries leaves its leftovers to savings, Fun carries them over.
    await expect(page.getByRole('heading', { name: 'Your first budgets' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a budget' }).click();
    const first = page.getByRole('group', { name: 'Budget 1' });
    await first.getByLabel('Name').fill('Groceries');
    await first.getByLabel('Monthly amount').fill('400');
    await page.getByRole('button', { name: 'Add a budget' }).click();
    const second = page.getByRole('group', { name: 'Budget 2' });
    await second.getByLabel('Name').fill('Fun');
    await second.getByLabel('Monthly amount').fill('150');
    // The switch is a visually hidden checkbox: like a user, press its label.
    await second.getByText('Incremental', { exact: true }).click();
    await expect(second.getByRole('switch', { name: 'Incremental' })).toBeChecked();
    await page.getByRole('button', { name: 'Next' }).click();

    // 5. Review: everything typed, written the way the dashboard will write it. Nothing is saved yet.
    await expect(page.getByRole('heading', { name: 'Review and finish' })).toBeVisible();
    const review = page.getByRole('list').filter({ hasText: 'Currency and locale' });
    await expect(review).toContainText('January 2026');
    await expect(review).toContainText('EUR · en-US');
    await expect(review).toContainText('€2,500.00');
    await expect(review).toContainText('€1,500.00');
    await expect(review).toContainText('Groceries · Not incremental');
    await expect(review).toContainText('€400.00');
    await expect(review).toContainText('Fun · Incremental');
    await expect(review).toContainText('€150.00');
    expect((await wallet.api.get('/api/settings', { failOnStatusCode: false })).status()).toBe(404);

    await page.getByRole('button', { name: 'Create my wallet' }).click();

    // The dashboard of the current month, March 2026.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Your wallet is ready.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Income, budgets and trends for March 2026.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'March 2026 at a glance' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'March 2026 at a glance' })).toContainText(
      'Current month',
    );

    // Income 2,500.00, no fixed costs, budgets 400.00 + 150.00, nothing spent yet, so
    // 2,500.00 - 0.00 - 550.00 = 1,950.00 is left unallocated.
    await expect(glanceFigure(page, 'Income')).toHaveText('€2,500.00');
    await expect(glanceFigure(page, 'Fixed costs')).toHaveText('€0.00');
    await expect(glanceFigure(page, 'Budgeted')).toHaveText('€550.00');
    await expect(glanceFigure(page, 'Spent')).toHaveText('€0.00');
    await expect(glanceFigure(page, 'Unallocated')).toHaveText('€1,950.00');

    // Groceries is not incremental: it starts March clean with 400.00. Fun is incremental and
    // nothing was spent in January and February, so it brings 150.00 + 150.00 into March:
    // 300.00 + 150.00 = 450.00.
    await expect(budgetRow(page, 'Groceries')).toContainText(/Remaining\s*€400\.00/);
    await expect(budgetRow(page, 'Groceries')).toContainText(/Available\s*€400\.00/);
    await expect(budgetRow(page, 'Fun')).toContainText(/Remaining\s*€450\.00/);
    await expect(budgetRow(page, 'Fun')).toContainText(/Available\s*€450\.00/);

    // January and February are closed and each has 1,950.00 unallocated plus the 400.00 that
    // Groceries leaves (Fun carries its own over): 2,350.00 each, 4,700.00 to move to savings.
    const savingsToMove = page.getByRole('region', { name: 'Savings to move' });
    await expect(savingsToMove).toContainText('+€4,700.00');
    await expect(savingsToMove).toContainText('2 months to settle. Move this to savings.');
    await expect(page.getByRole('link', { name: /^Savings/ })).toContainText(
      '2 months to move to savings',
    );

    // The server stored what the wizard showed, and its month view says the same as the page.
    expect(await getSettings(wallet.api)).toEqual({
      currency: 'EUR',
      locale: 'en-US',
      startMonth: '2026-01',
      theme: 'system',
      alertWarnPercent: 80,
    });
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.status).toBe('current');
    expect(march.income.total).toBe(250000);
    expect(march.totals.allocated).toBe(55000);
    expect(march.unallocated).toBe(195000);
    expect(march.budgets.map(({ name, available }) => [name, available])).toEqual([
      ['Groceries', 40000],
      ['Fun', 45000],
    ]);
    const savings = await getSavings(wallet.api);
    expect(savings.balance).toBe(150000);
    expect(savings.outstandingTotal).toBe(470000);

    // The savings page: the opening balance is all there is, and it is not assigned to a goal. The
    // two closed months wait to be moved, 2,350.00 each.
    await page.getByRole('link', { name: /^Savings/ }).click();
    await expect(page).toHaveURL(/\/savings/);
    const balance = page.getByRole('region', { name: 'Your savings' });
    await expect(figure(balance, 'Savings balance')).toHaveText('€1,500.00');
    await expect(figure(balance, 'Unassigned')).toHaveText('€1,500.00');
    const inbox = page.getByRole('region', { name: 'Move to savings' });
    await expect(inbox).toContainText('2 months to settle.');
    await expect(inbox.getByRole('listitem').filter({ hasText: 'January 2026' })).toContainText(
      'January 2026: move €2,350.00 to savings',
    );
    await expect(inbox.getByRole('listitem').filter({ hasText: 'February 2026' })).toContainText(
      'February 2026: move €2,350.00 to savings',
    );
  });

  test('after the setup a reload shows the dashboard and the wizard is out of reach', async ({
    page,
    wallet,
  }) => {
    await onboard(wallet.api, {
      startMonth: '2026-03',
      salary: 250000,
      openingSavings: 150000,
      budgets: [{ name: 'Groceries', amount: 40000, incremental: false }],
    });

    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(glanceFigure(page, 'Income')).toHaveText('€2,500.00');

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(glanceFigure(page, 'Income')).toHaveText('€2,500.00');
    await expect(page.getByText('Welcome to Wallet')).toHaveCount(0);

    // Asking for the wizard again sends the user to the dashboard.
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Welcome to Wallet')).toHaveCount(0);

    // And the API refuses a second setup, which leaves the first one as it was.
    const again = await wallet.api.post('/api/onboarding', {
      data: {
        currency: 'USD',
        locale: 'en-US',
        startMonth: '2026-02',
        salary: 1,
        openingSavings: 0,
      },
      failOnStatusCode: false,
    });
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'already_onboarded' } });
    expect(await getSettings(wallet.api)).toMatchObject({
      currency: 'EUR',
      startMonth: '2026-03',
    });
  });

  test('the wizard keeps the user on a step until its answer is valid, and keeps their answers', async ({
    page,
  }) => {
    await page.goto('/onboarding');
    await page.getByRole('button', { name: 'Next' }).click();

    // No salary yet: the step stays, says why, and puts the cursor in the field.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Your monthly salary' })).toBeVisible();
    await expect(page.getByText('Monthly net salary is required.')).toBeVisible();
    await expect(page.getByLabel('Monthly net salary')).toBeFocused();

    await page.getByLabel('Monthly net salary').fill('abc');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Enter an amount like 12.50 or 12,50.')).toBeVisible();

    // A valid answer moves on; going back shows it, tidied up.
    await page.getByLabel('Monthly net salary').fill('2500,5');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Your savings so far' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByLabel('Monthly net salary')).toHaveValue('2500.50');

    // Nothing was sent: the wallet is still not set up.
    await expect(page).toHaveURL(/\/onboarding$/);
  });

  test('amounts are written the way the chosen locale writes them', async ({ page, wallet }) => {
    await page.goto('/onboarding');
    await page.getByLabel('Locale').fill('de-DE');
    await expect(page.getByText('Amounts will look like 1.234,56\u00a0€.')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    // In German a comma is the decimal separator, and the field says so.
    await page.getByLabel('Monthly net salary').fill('2500,50');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create my wallet' }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'März 2026 at a glance' })).toBeVisible();
    await expect(glanceFigure(page, 'Income')).toHaveText('2.500,50\u00a0€');
    expect(await getSettings(wallet.api)).toMatchObject({
      locale: 'de-DE',
      currency: 'EUR',
    });
  });
});
