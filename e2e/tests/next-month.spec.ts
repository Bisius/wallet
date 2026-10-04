import type { Page } from '@playwright/test';
import { expect, test, type Wallet } from '../support/fixtures';
import {
  type BudgetFigures,
  addForm,
  addSpendingViaForm,
  budgetCard,
  dashboardOrder,
  expectBudgetCard,
  expectDashboardRow,
  expectFixedCosts,
  expectGlance,
  expectReserveLine,
  glance,
  monthSwitcher,
  openPage,
  spendingRow,
  spendingsList,
} from '../support/month-ui';
import { rowAction } from '../support/menu';
import { eur, signedEur } from '../support/money';
import {
  doneButton,
  expectBadge,
  expectBalance,
  expectBreakdown,
  expectHistory,
  historyEntries,
  historyEntry,
  inbox,
  inboxEntry,
  savingsToMove,
} from '../support/savings-ui';
import {
  addSpending,
  createBudget,
  createSubscription,
  getMonth,
  getSavings,
  onboard,
  setSalary,
  settleMonth,
} from '../support/seed';

/*
 * Months close by the clock passing them. Every test builds March 2026 (the harness clock starts on
 * the 10th), moves the fake clock with `wallet.setNow(...)` and reloads the page, as a user opening the
 * app on a later day.
 *
 * The month used by most tests (amounts in cents, rules in docs/DOMAIN.md):
 *
 *   income        salary 300000
 *   fixed costs   Streaming (monthly) 1250
 *                 + Insurance (yearly 12000, renews in September 2026, saving from March):
 *                   N = 2026-09, monthsLeft = 9 - 3 + 1 = 7, contribution = ceilDiv(12000, 7) = 1715
 *                                                                   = 1250 + 1715 = 2965
 *   budgets       Groceries 40000 and Eating out 20000   (not incremental)
 *                 Fun 15000 and Hobby 10000              (incremental)           allocated = 85000
 *   unallocated   300000 - 2965 - 85000                                            = 212035
 *   spendings     Groceries 30000, Eating out 25000, Fun 4000, Hobby 13000          spent = 72000
 *
 * At the end of March, budget by budget (available = carriedIn 0 + allocated):
 *
 *   Groceries   40000 - 30000 =  10000  not incremental  -> 10000 moves to savings
 *   Eating out  20000 - 25000 =  -5000  not incremental  -> 5000 is taken from savings
 *   Fun         15000 -  4000 =  11000  incremental      -> 11000 carries into April
 *   Hobby       10000 - 13000 =  -3000  incremental      -> -3000 carries into April (a deficit)
 *
 * savings due of March = unallocated 212035 + 10000 - 5000 = 217035.
 */

const MARCH_DUE = 217035;

async function seedMarch(wallet: Wallet) {
  const { api } = wallet;
  await onboard(api, { startMonth: '2026-03', salary: 300000, openingSavings: 100000 });
  await createSubscription(api, {
    name: 'Streaming',
    frequency: 'monthly',
    anchorDate: '2026-03-15',
    amount: 1250,
  });
  await createSubscription(api, {
    name: 'Insurance',
    frequency: 'yearly',
    anchorDate: '2026-09-20',
    amount: 12000,
  });
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
  });
  const eatingOut = await createBudget(api, {
    name: 'Eating out',
    amount: 20000,
    incremental: false,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 15000, incremental: true });
  const hobby = await createBudget(api, { name: 'Hobby', amount: 10000, incremental: true });
  await addSpending(api, { date: '2026-03-12', amount: 30000, budgetId: groceries.id });
  await addSpending(api, { date: '2026-03-15', amount: 25000, budgetId: eatingOut.id });
  await addSpending(api, { date: '2026-03-20', amount: 4000, budgetId: fun.id });
  await addSpending(api, { date: '2026-03-22', amount: 13000, budgetId: hobby.id });
  return { groceries, eatingOut, fun, hobby };
}

/** March as it stands at its end: what the dashboard rows and the budget cards show. */
const MARCH: Record<string, BudgetFigures> = {
  // usage = floor(100 * 30000 / 40000) = 75
  Groceries: { available: 40000, spent: 30000, remaining: 10000, alert: 'ok', usage: 75 },
  // usage = floor(100 * 25000 / 20000) = 125
  'Eating out': { available: 20000, spent: 25000, remaining: -5000, alert: 'over', usage: 125 },
  // usage = floor(100 * 4000 / 15000) = floor(26.67) = 26
  Fun: { available: 15000, spent: 4000, remaining: 11000, alert: 'ok', usage: 26 },
  // usage = floor(100 * 13000 / 10000) = 130
  Hobby: { available: 10000, spent: 13000, remaining: -3000, alert: 'over', usage: 130 },
};

/**
 * Moves the clock and opens the app again, as a user does on another day: the page that is open is
 * reloaded, and a test that has no page open yet goes to `path`.
 */
async function openOn(page: Page, wallet: Wallet, instant: string, path?: string): Promise<void> {
  await wallet.setNow(instant);
  if (path === undefined) await page.reload();
  else await page.goto(path);
}

test.describe('March closes and April begins', () => {
  test('the old month is final, and the new one starts from what carries', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);

    // March is the current month: nothing is due yet, and its leftovers are only a projection.
    await page.goto('/dashboard');
    await expect(glance(page)).toContainText('Current month');
    await expectBadge(page, 0);
    await expect(savingsToMove(page)).toContainText('All settled');
    await openPage(page, 'Budgets');
    await expect(budgetCard(page, 'Fun')).toContainText(
      'Projected to carry into April 2026: €110.00',
    );
    await expect(budgetCard(page, 'Hobby')).toContainText(
      'Projected to carry into April 2026: -€30.00',
    );
    await expect(budgetCard(page, 'Groceries')).toContainText(
      'Projected to move to savings: €100.00',
    );
    await expect(budgetCard(page, 'Eating out')).toContainText(
      'Projected to be taken from savings: €50.00',
    );

    // The clock passes the end of March, and the app is opened on its dashboard again.
    await openPage(page, 'Dashboard');
    await openOn(page, wallet, '2026-04-02T08:00:00');
    await expect(page.getByRole('heading', { name: 'April 2026 at a glance' })).toBeVisible();
    await expect(glance(page)).toContainText('Current month');

    // April: the same salary and costs (the reserve of the insurance: April's monthsLeft is 6,
    // ceilDiv(12000 - 1715, 6) = ceil(1714.17) = 1715, so 3430 is held), nothing spent.
    // unallocated = 300000 - 2965 - 85000 = 212035.
    await expectGlance(page, {
      income: 300000,
      fixedCosts: 2965,
      budgeted: 85000,
      spent: 0,
      unallocated: 212035,
    });
    // Groceries and Eating out start clean (not incremental), the others bring their balance:
    //   Fun    available = 11000 carried in + 15000 = 26000
    //   Hobby  available = -3000 carried in + 10000 =  7000 (the deficit eats into this month's amount)
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 0,
      remaining: 40000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Eating out', {
      available: 20000,
      spent: 0,
      remaining: 20000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Fun', {
      available: 26000,
      spent: 0,
      remaining: 26000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Hobby', {
      available: 7000,
      spent: 0,
      remaining: 7000,
      alert: 'ok',
      usage: 0,
    });

    // March is waiting to be moved to savings: the badge, the dashboard and the inbox agree.
    await expectBadge(page, 1);
    await expect(savingsToMove(page)).toContainText(signedEur(MARCH_DUE));
    await expect(savingsToMove(page)).toContainText('1 month to settle. Move this to savings.');

    await openPage(page, 'Budgets');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried in from March 2026: +€110.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried in from March 2026: -€30.00');
    await expect(budgetCard(page, 'Groceries')).not.toContainText('Carried in from');
    await expectBudgetCard(page, 'Fun', {
      available: 26000,
      spent: 0,
      remaining: 26000,
      alert: 'ok',
      usage: 0,
    });
    await expectBudgetCard(page, 'Hobby', {
      available: 7000,
      spent: 0,
      remaining: 7000,
      alert: 'ok',
      usage: 0,
    });

    // The yearly reserve keeps growing: 1715 in March, 3430 after April.
    await openPage(page, 'Subscriptions');
    await expectFixedCosts(page, 2965);
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'April 2026',
      contribution: 1715,
      held: 3430,
      price: 12000,
      renewalLabel: 'September 2026',
    });

    // The month switcher shows March as a closed month: what it carried out and moved to savings.
    await openPage(page, 'Budgets');
    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('March 2026');
    await expect(glance(page)).toContainText('Closed month');
    await expect(glance(page)).toContainText(
      'This month is over, so its figures are final. Changing something in it now changes what is due to savings.',
    );
    // The budgets page's strip is slim: March's income and fixed costs are asserted on its dashboard below.
    await expectGlance(page, { budgeted: 85000, unallocated: 212035 });
    for (const [name, figures] of Object.entries(MARCH))
      await expectBudgetCard(page, name, figures);
    await expect(budgetCard(page, 'Groceries')).toContainText('Moved to savings: €100.00');
    await expect(budgetCard(page, 'Eating out')).toContainText('Taken from savings: €50.00');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried into April 2026: €110.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried into April 2026: -€30.00');
    await openPage(page, 'Subscriptions');
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'March 2026',
      contribution: 1715,
      held: 1715,
      price: 12000,
      renewalLabel: 'September 2026',
    });

    // A spending in April does not change closed March.
    await monthSwitcher(page).thisMonth();
    await monthSwitcher(page).expectShowing('April 2026');
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, {
      amount: '20',
      budget: 'Groceries',
      description: 'First shop of April',
    });
    // April Groceries: 2000 spent of 40000, 38000 left, usage = floor(100 * 2000 / 40000) = 5.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €20.00 to Groceries. €380.00 left of €400.00.',
    );
    await openPage(page, 'Dashboard');
    await expectGlance(page, { spent: 2000, unallocated: 212035 });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 2000,
      remaining: 38000,
      alert: 'ok',
      usage: 5,
    });

    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('March 2026');
    await expectGlance(page, {
      income: 300000,
      fixedCosts: 2965,
      budgeted: 85000,
      spent: 72000,
      unallocated: 212035,
    });
    for (const [name, figures] of Object.entries(MARCH))
      await expectDashboardRow(page, name, figures);
    // What March is due did not move either: the same amount waits in the inbox.
    await expect(savingsToMove(page)).toContainText(signedEur(MARCH_DUE));
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.status).toBe('closed');
    expect(march.savingsDue.total).toBe(MARCH_DUE);
    expect((await getSavings(wallet.api)).outstanding.map((entry) => entry.outstanding)).toEqual([
      MARCH_DUE,
    ]);
  });

  test('what March is due is made of the unallocated income and what its budgets settle', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/dashboard');

    await openPage(page, 'Savings');
    await expectBadge(page, 1);
    const march = inboxEntry(page, 'March 2026');
    await expect(march).toContainText('March 2026: move €2,170.35 to savings');
    await expect(march).not.toContainText('Correction');
    // 212035 unallocated + (10000 Groceries - 5000 Eating out = 5000 settled) + 0 reserves released.
    await expectBreakdown(march, {
      unallocated: 212035,
      budgetsSettled: 5000,
      reservesReleased: 0,
      due: MARCH_DUE,
      now: MARCH_DUE,
    });
    // Nothing moved yet: the balance is the opening balance.
    await expectBalance(page, { balance: 100000, unassigned: 100000 });
  });

  test('a late spending dated in the closed month changes what it is due', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/dashboard');

    // The spendings page of March says what a spending there does.
    await page.goto('/spendings?month=2026-03');
    await expect(addForm(page)).toContainText(
      'March 2026 is closed. A spending added to it changes what is due to savings.',
    );
    // Today (April 2nd) is not in March: the form offers the last day of the month shown.
    await expect(addForm(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-31');
    await addSpendingViaForm(page, {
      amount: '15',
      budget: 'Groceries',
      description: 'Forgotten receipt',
    });
    // Groceries March: spent 30000 + 1500 = 31500, left 40000 - 31500 = 8500, usage floor(78.75) = 78.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €15.00 to Groceries. €85.00 left of €400.00.',
    );
    await expect(spendingRow(page, 'Forgotten receipt')).toBeVisible();
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 31, 2026', level: 3 }),
    ).toBeVisible();

    // What March is due drops by the 15.00: 217035 - 1500 = 215535 (Groceries leaves 8500, not 10000).
    const due = MARCH_DUE - 1500;
    await expectBadge(page, 1);
    await openPage(page, 'Dashboard');
    await expect(savingsToMove(page)).toContainText(signedEur(due));
    await expectGlance(page, { spent: 73500, unallocated: 212035 });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 31500,
      remaining: 8500,
      alert: 'ok',
      usage: 78,
    });

    await openPage(page, 'Savings');
    const march = inboxEntry(page, 'March 2026');
    await expect(march).toContainText('March 2026: move €2,155.35 to savings');
    // It was never settled, so it is a first move and not a correction.
    await expect(march).not.toContainText('Correction');
    await expectBreakdown(march, {
      unallocated: 212035,
      budgetsSettled: 3500, // Groceries 8500 + Eating out -5000
      reservesReleased: 0,
      due,
      now: due,
    });

    // April is untouched by it (a budget that is not incremental carries nothing).
    await openPage(page, 'Budgets');
    await monthSwitcher(page).thisMonth();
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 0,
      remaining: 40000,
      alert: 'ok',
      usage: 0,
    });
    expect((await getMonth(wallet.api, '2026-04')).unallocated).toBe(212035);
  });

  test('a late spending in a month that was settled becomes a correction to settle', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/dashboard');
    await settleMonth(wallet.api, '2026-03');
    // The balance is the opening balance and what March was due: 100000 + 217035 = 317035.
    expect((await getSavings(wallet.api)).balance).toBe(317035);
    await page.reload();
    await expectBadge(page, 0);

    await page.goto('/spendings?month=2026-03');
    await addSpendingViaForm(page, {
      amount: '15',
      budget: 'Groceries',
      description: 'Forgotten receipt',
    });
    await expect(addForm(page).getByRole('status')).toContainText('Added €15.00 to Groceries.');

    // The month is due 215535 now, 1500 less than it was settled for: take 15.00 back from savings.
    // The badge came back without leaving the page that made the change.
    await expectBadge(page, 1);
    await openPage(page, 'Dashboard');
    await expect(savingsToMove(page)).toContainText('-€15.00');
    await expect(savingsToMove(page)).toContainText('1 month to settle. Take this from savings.');

    await openPage(page, 'Savings');
    const march = inboxEntry(page, 'March 2026');
    await expect(march).toContainText('March 2026: take €15.00 more from savings');
    await expect(march).toContainText('Correction');
    await expect(march).toContainText(
      'You settled this month before. Later changes to it moved what it is due, so this corrects that earlier settlement.',
    );
    await expectBreakdown(march, {
      unallocated: 212035,
      budgetsSettled: 3500,
      reservesReleased: 0,
      due: 215535, // 217035 - 1500
      settled: 217035,
      now: -1500, // 215535 - 217035
    });
    // The balance has not moved: the correction is only asked for.
    await expectBalance(page, { balance: 317035, unassigned: 317035 });

    // Done records the correction: 317035 - 1500 = 315535 = opening 100000 + due 215535.
    await doneButton(march).click();
    await expect(
      page.getByText('Correction for March 2026 recorded: €15.00 taken from savings.'),
    ).toBeVisible();
    await expect(inbox(page)).toContainText('All months are settled');
    await expectBadge(page, 0);
    await expectBalance(page, { balance: 315535, unassigned: 315535 });
    expect((await getSavings(wallet.api)).outstanding).toEqual([]);

    // The history has the correction on top of the first settlement, and Undo is offered once.
    await expectHistory(page, ['Settled March 2026', 'Settled March 2026', 'Opening balance']);
    await expect(historyEntries(page).nth(0)).toContainText('Unassigned savings: -€15.00');
    await expect(historyEntries(page).nth(1)).toContainText('Unassigned savings: +€2,170.35');
    await expect(
      page.getByRole('button', { name: 'More actions for Settled March 2026' }),
    ).toHaveCount(1);

    // Undoing removes both: March is due its whole 215535 again, as a first move and not a correction.
    await rowAction(historyEntry(page, 'Settled March 2026').first(), 'Undo settlement');
    await page
      .getByRole('dialog', { name: 'Undo the settlement of March 2026?' })
      .getByRole('button', { name: 'Undo settlement' })
      .click();
    await expectBalance(page, { balance: 100000, unassigned: 100000 });
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,155.35 to savings',
    );
    await expect(inboxEntry(page, 'March 2026')).not.toContainText('Correction');
    await expectHistory(page, ['Opening balance']);
  });
});

test.describe('a late spending in an incremental budget', () => {
  test('changes what the next month has to spend, and not what March is due', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/spendings?month=2026-03');

    await addSpendingViaForm(page, {
      amount: '10',
      budget: 'Fun',
      description: 'Forgotten ticket',
    });
    // Fun in March: spent 4000 + 1000 = 5000 of 15000, left 10000, usage floor(33.33) = 33.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €10.00 to Fun. €100.00 left of €150.00.',
    );

    // What is left is carried, not moved to savings: March is due what it was.
    await expectBadge(page, 1);
    await openPage(page, 'Savings');
    const march = inboxEntry(page, 'March 2026');
    await expect(march).toContainText(`March 2026: move ${eur(MARCH_DUE)} to savings`);
    await expect(march).not.toContainText('Correction');

    // April has 1000 less: 10000 carried in + 15000 = 25000 (it was 26000).
    await openPage(page, 'Budgets');
    await monthSwitcher(page).thisMonth();
    await monthSwitcher(page).expectShowing('April 2026');
    await expectBudgetCard(page, 'Fun', {
      available: 25000,
      spent: 0,
      remaining: 25000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Fun')).toContainText('Carried in from March 2026: +€100.00');
    expect((await getMonth(wallet.api, '2026-03')).savingsDue.total).toBe(MARCH_DUE);
  });
});

test.describe('a correction that changes or disappears', () => {
  test('editing and deleting a late spending moves the correction, and the badge follows', async ({
    page,
    wallet,
  }) => {
    const { groceries } = await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/dashboard');
    await settleMonth(wallet.api, '2026-03');
    // A forgotten receipt of 15.00, entered after March was settled for 217035.
    await addSpending(wallet.api, {
      date: '2026-03-28',
      amount: 1500,
      budgetId: groceries.id,
      description: 'Forgotten receipt',
    });
    await page.goto('/spendings?month=2026-03');
    await expectBadge(page, 1);

    // Edited to 25.00: March is due 217035 - 2500 = 214535, so 25.00 is to be taken back.
    await rowAction(spendingRow(page, 'Forgotten receipt'), 'Edit');
    const dialog = page.getByRole('dialog', { name: 'Edit spending' });
    await dialog.getByLabel('Amount', { exact: true }).fill('25');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Spending updated.')).toBeVisible();
    await openPage(page, 'Savings');
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: take €25.00 more from savings',
    );
    await expectBreakdown(inboxEntry(page, 'March 2026'), {
      unallocated: 212035,
      budgetsSettled: 2500, // Groceries leaves 40000 - 32500 = 7500, Eating out -5000
      reservesReleased: 0,
      due: 214535,
      settled: 217035,
      now: -2500,
    });

    // Deleted: March is due what it was settled for, and leaves the list, on the page that did it.
    await openPage(page, 'Spendings');
    await rowAction(spendingRow(page, 'Forgotten receipt'), 'Delete');
    await page
      .getByRole('dialog', { name: 'Delete this spending?' })
      .getByRole('button', { name: 'Delete spending' })
      .click();
    await expect(page.getByText('Spending deleted.')).toBeVisible();
    await expectBadge(page, 0);
    await openPage(page, 'Savings');
    await expect(inbox(page)).toContainText('All months are settled');
    expect((await getSavings(wallet.api)).outstanding).toEqual([]);
  });
});

test.describe('skipping months', () => {
  test('an incremental budget compounds over the months nobody opened, and so does the reserve', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);

    // Nobody opens the app in April and May. It is the 5th of June.
    await openOn(page, wallet, '2026-06-05T10:00:00', '/dashboard');
    await expect(page.getByRole('heading', { name: 'June 2026 at a glance' })).toBeVisible();

    // Reserve of Insurance: contributions 1715 (Mar), 1715 (Apr), 1714 (May: ceilDiv(12000 - 3430, 5)
    // = 1714 exactly) and 1714 (Jun: ceilDiv(12000 - 5144, 4) = 1714), held 6858 after June.
    // fixed costs June = 1250 + 1714 = 2964, unallocated = 300000 - 2964 - 85000 = 212036.
    await expectGlance(page, {
      income: 300000,
      fixedCosts: 2964,
      budgeted: 85000,
      spent: 0,
      unallocated: 212036,
    });

    // Fun and Hobby kept adding their amounts, month after month, with nothing spent after March:
    //   Fun    March 11000 left -> April 11000 + 15000 = 26000 -> May 26000 + 15000 = 41000
    //          June available = 41000 + 15000 = 56000
    //   Hobby  March -3000      -> April -3000 + 10000 = 7000   -> May 7000 + 10000 = 17000
    //          June available = 17000 + 10000 = 27000
    await expectDashboardRow(page, 'Fun', {
      available: 56000,
      spent: 0,
      remaining: 56000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Hobby', {
      available: 27000,
      spent: 0,
      remaining: 27000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 0,
      remaining: 40000,
      alert: 'ok',
      usage: 0,
    });
    await openPage(page, 'Budgets');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried in from May 2026: +€410.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried in from May 2026: +€170.00');

    // Three closed months wait: March 217035, April 212035 + 40000 + 20000 = 272035,
    // May 212036 + 60000 = 272036 (the May contribution is a cent less). Total 761106.
    await expectBadge(page, 3);
    await openPage(page, 'Dashboard');
    await expect(savingsToMove(page)).toContainText('+€7,611.06');
    await expect(savingsToMove(page)).toContainText('3 months to settle. Move this to savings.');
    await openPage(page, 'Savings');
    await expect(inbox(page)).toContainText(
      '3 months to settle. In total: move €7,611.06 to savings.',
    );
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,170.35 to savings',
    );
    await expect(inboxEntry(page, 'April 2026')).toContainText(
      'April 2026: move €2,720.35 to savings',
    );
    await expect(inboxEntry(page, 'May 2026')).toContainText('May 2026: move €2,720.36 to savings');
    await expectBreakdown(inboxEntry(page, 'April 2026'), {
      unallocated: 212035,
      budgetsSettled: 60000, // Groceries 40000 + Eating out 20000, nothing was spent
      reservesReleased: 0,
      due: 272035,
      now: 272035,
    });
    await expectBreakdown(inboxEntry(page, 'May 2026'), {
      unallocated: 212036,
      budgetsSettled: 60000,
      reservesReleased: 0,
      due: 272036,
      now: 272036,
    });

    // The months in between, as they were: each one closed, with its own carry and its own reserve.
    await openPage(page, 'Budgets');
    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('May 2026');
    await expect(glance(page)).toContainText('Closed month');
    await expectBudgetCard(page, 'Fun', {
      available: 41000,
      spent: 0,
      remaining: 41000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Fun')).toContainText('Carried in from April 2026: +€260.00');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried into June 2026: €410.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried in from April 2026: +€70.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried into June 2026: €170.00');
    await expect(budgetCard(page, 'Groceries')).toContainText('Moved to savings: €400.00');
    await expect(budgetCard(page, 'Eating out')).toContainText('Moved to savings: €200.00');
    await expectGlance(page, { unallocated: 212036 });

    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('April 2026');
    await expectBudgetCard(page, 'Fun', {
      available: 26000,
      spent: 0,
      remaining: 26000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Fun')).toContainText('Carried in from March 2026: +€110.00');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried into May 2026: €260.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried into May 2026: €70.00');
    await expectGlance(page, { unallocated: 212035 });

    // The reserve at the end of each month: 1715, 3430, 5144, 6858 (and 57% of the price in June).
    // The fixed costs of April and May (the budgets page's strip has no such figure) are the
    // subscriptions page's: 1250 + the month's contribution.
    await openPage(page, 'Subscriptions');
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'April 2026',
      contribution: 1715,
      held: 3430,
      price: 12000,
      renewalLabel: 'September 2026',
    });
    await expectFixedCosts(page, 2965);
    await monthSwitcher(page).next();
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'May 2026',
      contribution: 1714,
      held: 5144,
      price: 12000,
      renewalLabel: 'September 2026',
    });
    await expectFixedCosts(page, 2964);
    await monthSwitcher(page).next();
    await monthSwitcher(page).expectShowing('June 2026');
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'June 2026',
      contribution: 1714,
      held: 6858,
      price: 12000,
      renewalLabel: 'September 2026',
    });
    await expect(page.getByRole('progressbar', { name: 'Insurance reserve' })).toHaveAttribute(
      'aria-valuetext',
      '57% of the €120.00 renewal set aside',
    );

    // The server says the same as the pages.
    const savings = await getSavings(wallet.api);
    expect(savings.outstanding.map((entry) => [entry.month, entry.outstanding])).toEqual([
      ['2026-03', 217035],
      ['2026-04', 272035],
      ['2026-05', 272036],
    ]);
    expect(savings.outstandingTotal).toBe(761106);
  });
});

test.describe('skipping a renewal', () => {
  test('the reserve pays the renewal in its month and starts the next year from nothing', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);

    // Nobody opens the app from March to October: March to September are closed, October is current.
    await openOn(page, wallet, '2026-10-05T10:00:00', '/dashboard');
    await expect(page.getByRole('heading', { name: 'October 2026 at a glance' })).toBeVisible();

    // The reserve of Insurance (12000, renews in September): 1715, 1715, then 1714 each month until
    // September: 3430 + 5 * 1714 = 12000 exactly, and the renewal empties it.
    // October starts the next cycle, N = 2027-09: monthsLeft = 12, ceilDiv(12000, 12) = 1000.
    // fixed costs October = 1250 + 1000 = 2250, unallocated = 300000 - 2250 - 85000 = 212750.
    await expectGlance(page, {
      income: 300000,
      fixedCosts: 2250,
      budgeted: 85000,
      spent: 0,
      unallocated: 212750,
    });
    // Fun and Hobby went on for seven months (nothing spent after March): Fun 11000 + 6 * 15000 =
    // 101000 at the end of September, Hobby -3000 + 6 * 10000 = 57000.
    await expectDashboardRow(page, 'Fun', {
      available: 116000, // 101000 + 15000
      spent: 0,
      remaining: 116000,
      alert: 'ok',
      usage: 0,
    });
    await expectDashboardRow(page, 'Hobby', {
      available: 67000, // 57000 + 10000
      spent: 0,
      remaining: 67000,
      alert: 'ok',
      usage: 0,
    });

    // Seven closed months: March 217035, April 272035, May to September 272036 each
    // (212036 unallocated + 60000 from the two budgets that are not incremental). Total
    // 217035 + 272035 + 5 * 272036 = 1849250.
    await expectBadge(page, 7);
    await expect(savingsToMove(page)).toContainText('+€18,492.50');
    await expect(savingsToMove(page)).toContainText('7 months to settle. Move this to savings.');

    await openPage(page, 'Subscriptions');
    await expectFixedCosts(page, 2250);
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'October 2026',
      contribution: 1000,
      held: 1000,
      price: 12000,
      renewalLabel: 'September 2027',
    });

    // August: the reserve is at 10286, September's top-up is the last 1714.
    await monthSwitcher(page).previous();
    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('August 2026');
    await expectReserveLine(page, 'Insurance', {
      monthLabel: 'August 2026',
      contribution: 1714,
      held: 10286,
      price: 12000,
      renewalLabel: 'September 2026',
    });
    // September is the renewal month: the 120.00 is paid out of the reserve, which is empty after it,
    // and the month's fixed costs are only the top-up and the monthly price: 1250 + 1714 = 2964.
    await monthSwitcher(page).next();
    await monthSwitcher(page).expectShowing('September 2026');
    const card = page.getByRole('article', { name: 'Insurance', exact: true });
    await expect(card).toContainText(
      'It renews in September 2026. The €120.00 renewal is paid out of the reserve you set aside, so the reserve is empty afterwards.',
    );
    await expect(card).toContainText("This month's top-up before the renewal: €17.14.");
    await expectFixedCosts(page, 2964);

    // The server agrees: every month's reserve at its end, and the figures of the pages.
    expect(
      (await getMonth(wallet.api, '2026-08')).subscriptions.find(
        (line) => line.name === 'Insurance',
      )?.reserveBalance,
    ).toBe(10286);
    const september = (await getMonth(wallet.api, '2026-09')).subscriptions.find(
      (line) => line.name === 'Insurance',
    );
    expect(september?.reserveBalance).toBe(0);
    expect(september?.renewalThisMonth).toBe(true);
    const savings = await getSavings(wallet.api);
    expect(savings.outstanding.map((entry) => entry.outstanding)).toEqual([
      217035, 272035, 272036, 272036, 272036, 272036, 272036,
    ]);
    expect(savings.outstandingTotal).toBe(1849250);
  });
});

test.describe('a budget that changes mode or ends', () => {
  test('switching off Incremental releases the balance, and archiving settles the whole budget', async ({
    page,
    wallet,
  }) => {
    await seedMarch(wallet);
    await openOn(page, wallet, '2026-04-02T08:00:00', '/budgets');

    // Fun carried 11000 into April, so it has 26000 now. From April on it is not incremental.
    await page.getByRole('button', { name: 'Edit Fun', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Fun' });
    await expect(dialog.getByRole('switch', { name: 'Incremental' })).toBeChecked();
    await expect(dialog.getByLabel('Applies from')).toHaveValue('2026-04');
    await dialog.getByText('Incremental', { exact: true }).click();
    await expect(dialog.getByRole('switch', { name: 'Incremental' })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(budgetCard(page, 'Fun')).not.toContainText('Incremental');
    // March is not rewritten by it, and April still has what it carried in; only its end changes.
    await expectBudgetCard(page, 'Fun', {
      available: 26000,
      spent: 0,
      remaining: 26000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Fun')).toContainText('Projected to move to savings: €260.00');

    // Hobby is archived in April, its last month: 7000 is left in it (-3000 carried in + 10000).
    await rowAction(budgetCard(page, 'Hobby'), 'Archive');
    const confirm = page.getByRole('dialog', { name: 'Archive "Hobby"?' });
    await expect(confirm).toContainText('It stays active through April 2026, its last month');
    await confirm.getByRole('button', { name: 'Archive budget' }).click();
    await expect(page.getByText('Hobby archived.')).toBeVisible();
    await expect(budgetCard(page, 'Hobby')).toContainText('Ends Apr 2026');
    await expect(budgetCard(page, 'Hobby')).toContainText('Projected to move to savings: €70.00');

    // May: April closes. Fun is released (26000) and Hobby is settled whole (7000), on top of the
    // unallocated 212035 and the 40000 + 20000 of the two plain budgets: 212035 + 60000 + 26000 + 7000.
    await openOn(page, wallet, '2026-05-03T08:00:00');
    await expectBudgetCard(page, 'Fun', {
      available: 15000,
      spent: 0,
      remaining: 15000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Fun')).not.toContainText('Carried in from');
    await expect(budgetCard(page, 'Hobby')).toHaveCount(0);
    await expect(page.getByText('Upcoming and ended budgets (1)')).toBeVisible();

    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('April 2026');
    await expect(budgetCard(page, 'Fun')).toContainText('Moved to savings: €260.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Moved to savings: €70.00');
    await expect(budgetCard(page, 'Hobby')).toContainText('Ended Apr 2026');

    await openPage(page, 'Savings');
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,170.35 to savings',
    );
    const april = inboxEntry(page, 'April 2026');
    await expect(april).toContainText('April 2026: move €3,050.35 to savings');
    await expectBreakdown(april, {
      unallocated: 212035,
      budgetsSettled: 93000, // 40000 + 20000 + 26000 + 7000
      reservesReleased: 0,
      due: 305035,
      now: 305035,
    });
  });
});

test.describe('a budget with nothing available', () => {
  test('a deficit deeper than the next amount leaves no bar, and the next month starts from it', async ({
    page,
    wallet,
  }) => {
    // Salary 300000, no subscriptions. Groceries 40000 (not incremental); Hobby and Gifts 10000
    // (incremental). In March Hobby spends 25000 (-15000) and Gifts 20000 (-10000).
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 300000 });
    await createBudget(api, { name: 'Groceries', amount: 40000, incremental: false });
    const hobby = await createBudget(api, { name: 'Hobby', amount: 10000, incremental: true });
    const gifts = await createBudget(api, { name: 'Gifts', amount: 10000, incremental: true });
    await addSpending(api, { date: '2026-03-10', amount: 25000, budgetId: hobby.id });
    await addSpending(api, { date: '2026-03-11', amount: 20000, budgetId: gifts.id });

    await openOn(page, wallet, '2026-04-03T08:00:00', '/budgets');
    // April: Hobby -15000 + 10000 = -5000 available, Gifts -10000 + 10000 = 0. Nothing is spent yet.
    // Over only counts once spent > available: -5000 is already over, 0 is on track until a cent goes.
    await expectBudgetCard(page, 'Hobby', {
      available: -5000,
      spent: 0,
      remaining: -5000,
      alert: 'over',
      usage: null,
    });
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried in from March 2026: -€150.00');
    await expectBudgetCard(page, 'Gifts', {
      available: 0,
      spent: 0,
      remaining: 0,
      alert: 'ok',
      usage: null,
    });
    await expect(budgetCard(page, 'Gifts')).toContainText('Carried in from March 2026: -€100.00');
    await openPage(page, 'Dashboard');
    await expectDashboardRow(page, 'Hobby', {
      available: -5000,
      spent: 0,
      remaining: -5000,
      alert: 'over',
      usage: null,
    });
    await expectDashboardRow(page, 'Gifts', {
      available: 0,
      spent: 0,
      remaining: 0,
      alert: 'ok',
      usage: null,
    });
    // Over budget comes first on the dashboard.
    expect(await dashboardOrder(page)).toEqual(['Hobby', 'Groceries', 'Gifts']);

    // A spending of 5.00 in Gifts: spent 500 > available 0, over by 5.00, still no percentage.
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, { amount: '5', budget: 'Gifts', description: 'Card' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €5.00 to Gifts. Over budget by €5.00.',
    );
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Gifts', {
      available: 0,
      spent: 500,
      remaining: -500,
      alert: 'over',
      usage: null,
    });

    // May: April closes with Hobby at -5000 and Gifts at -500, which carry on (incremental):
    // Hobby 10000 - 5000 = 5000 available, Gifts 10000 - 500 = 9500. Nothing is taken from savings.
    await openOn(page, wallet, '2026-05-03T08:00:00');
    await expectBudgetCard(page, 'Hobby', {
      available: 5000,
      spent: 0,
      remaining: 5000,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Hobby')).toContainText('Carried in from April 2026: -€50.00');
    await expectBudgetCard(page, 'Gifts', {
      available: 9500,
      spent: 0,
      remaining: 9500,
      alert: 'ok',
      usage: 0,
    });
    await expect(budgetCard(page, 'Gifts')).toContainText('Carried in from April 2026: -€5.00');
    // March: 300000 - 60000 = 240000 unallocated + 40000 from Groceries = 280000.
    // April: the same unallocated and Groceries, 280000 (the deficits stay in their budgets).
    const savings = await getSavings(wallet.api);
    expect(savings.outstanding.map((entry) => entry.outstanding)).toEqual([280000, 280000]);
  });
});

test.describe('unallocated income and over-allocation', () => {
  /**
   * No subscriptions, so every figure is the plain rule: salary 200000, opening savings 50000.
   * Budgets Rent 120000 and Groceries 50000 (not incremental), Fun 10000 (incremental): allocated 180000.
   *
   * March:  unallocated 200000 - 180000 = 20000. Rent spends 120000 (leaves 0), Groceries 42000
   *         (leaves 8000), Fun nothing (carries 10000).  due = 20000 + 8000 = 28000.
   * April:  the salary drops to 150000 from April on: unallocated 150000 - 180000 = -30000, over-allocated.
   *         Rent 120000 and Groceries 50000 are spent in full (0 left), Fun spends 4000 of
   *         10000 + 10000 = 20000 and carries 16000.   due = -30000 + 0 + 0 = -30000.
   */
  async function seedTightMonths(wallet: Wallet) {
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 200000, openingSavings: 50000 });
    const rent = await createBudget(api, { name: 'Rent', amount: 120000, incremental: false });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 50000,
      incremental: false,
    });
    const fun = await createBudget(api, { name: 'Fun', amount: 10000, incremental: true });
    await addSpending(api, { date: '2026-03-02', amount: 120000, budgetId: rent.id });
    await addSpending(api, { date: '2026-03-20', amount: 42000, budgetId: groceries.id });
    await wallet.setNow('2026-04-10T09:00:00');
    await setSalary(api, '2026-04', 150000);
    await addSpending(api, { date: '2026-04-02', amount: 120000, budgetId: rent.id });
    await addSpending(api, { date: '2026-04-05', amount: 50000, budgetId: groceries.id });
    await addSpending(api, { date: '2026-04-08', amount: 4000, budgetId: fun.id });
  }

  test('a month that spends more than it earns is taken from savings once it closes', async ({
    page,
    wallet,
  }) => {
    await seedTightMonths(wallet);

    // April is the current month and already over-allocated: the page warns, and says what happens.
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'April 2026 at a glance' })).toBeVisible();
    await expectGlance(page, {
      income: 150000,
      fixedCosts: 0,
      budgeted: 180000,
      spent: 174000,
      unallocated: -30000,
    });
    await expect(glance(page).getByText('Over-allocated', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Over-allocated by €300.00' }),
    ).toContainText(
      "Fixed costs and budgets add up to more than this month's income. Lower a budget or add income, or that amount will be taken from savings when the month closes.",
    );
    // March is closed already (the clock is in April) and waits with its unallocated income.
    await expectBadge(page, 1);
    await expect(savingsToMove(page)).toContainText('+€280.00');

    // The clock passes April.
    await openOn(page, wallet, '2026-05-04T09:00:00');
    await expect(page.getByRole('heading', { name: 'May 2026 at a glance' })).toBeVisible();
    await expectBadge(page, 2);
    // March +28000 and April -30000 add up to -2000: the total is the signed sum.
    await expect(savingsToMove(page)).toContainText('-€20.00');
    await expect(savingsToMove(page)).toContainText('2 months to settle. Take this from savings.');

    // April, closed: the tile and the warning say it was over-allocated and that it is taken.
    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('April 2026');
    await expect(glance(page)).toContainText('Closed month');
    await expectGlance(page, { unallocated: -30000 });
    await expect(
      page.getByRole('alert').filter({ hasText: 'Over-allocated by €300.00' }),
    ).toContainText(
      "Fixed costs and budgets added up to more than this month's income, so that amount is taken from savings.",
    );
    await expect(
      page.getByRole('alert').filter({ hasText: 'Over-allocated by €300.00' }),
    ).not.toContainText('Lower a budget');
    // Fun is incremental: its 16000 carries on, only the unallocated amount is taken.
    await openPage(page, 'Budgets');
    await expect(budgetCard(page, 'Fun')).toContainText('Carried into May 2026: €160.00');

    // The inbox asks to take 300.00 for April and to move 280.00 for March.
    await openPage(page, 'Savings');
    await expect(inbox(page)).toContainText(
      '2 months to settle. In total: take €20.00 from savings.',
    );
    const april = inboxEntry(page, 'April 2026');
    await expect(april).toContainText('April 2026: take €300.00 from savings');
    await expectBreakdown(april, {
      unallocated: -30000,
      budgetsSettled: 0,
      reservesReleased: 0,
      due: -30000,
      now: -30000,
    });
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €280.00 to savings',
    );

    // Done on April takes the money out: 50000 - 30000 = 20000. Done on March adds 28000: 48000.
    await doneButton(april).click();
    await expectBalance(page, { balance: 20000, unassigned: 20000 });
    await expectBadge(page, 1);
    await doneButton(inboxEntry(page, 'March 2026')).click();
    await expectBalance(page, { balance: 48000, unassigned: 48000 });
    await expectBadge(page, 0);
    expect((await getSavings(wallet.api)).balance).toBe(50000 + 28000 - 30000);
  });
});

test.describe('the last day of the month', () => {
  test.use({ walletNow: '2026-03-31T23:30:00' });

  test('a spending entered at 23:30 on the 31st belongs to March when April begins', async ({
    page,
    wallet,
  }) => {
    // Salary 200000, one budget Groceries 40000 (not incremental), no subscriptions.
    // March unallocated = 200000 - 40000 = 160000.
    await onboard(wallet.api, { startMonth: '2026-03', salary: 200000 });
    await createBudget(wallet.api, { name: 'Groceries', amount: 40000, incremental: false });

    await page.goto('/spendings');
    await expect(addForm(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-31');
    await addSpendingViaForm(page, {
      amount: '25',
      budget: 'Groceries',
      description: 'Late snack',
    });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €25.00 to Groceries. €375.00 left of €400.00.',
    );
    await expectBadge(page, 0);

    // Midnight passes while the page is open. The page still shows what it loaded, and the
    // next entry still goes where the form's date says: the 31st of March, a month that is closed now.
    await wallet.setNow('2026-04-01T00:05:00');
    await addSpendingViaForm(page, {
      amount: '5',
      budget: 'Groceries',
      description: 'Midnight tea',
    });
    await expect(addForm(page).getByRole('status')).toContainText('Added €5.00 to Groceries.');
    await expect(spendingRow(page, 'Midnight tea')).toBeVisible();

    // Opened again, the app lives in April and March is closed with both spendings in it.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Spendings', level: 1 })).toBeVisible();
    await expect(page.getByText('Server date: Apr 1, 2026')).toBeVisible();
    await expect(spendingsList(page)).toContainText('No spendings in April 2026');
    await openPage(page, 'Dashboard');
    await expect(page.getByRole('heading', { name: 'April 2026 at a glance' })).toBeVisible();
    await expectGlance(page, { spent: 0, unallocated: 160000 });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 0,
      remaining: 40000,
      alert: 'ok',
      usage: 0,
    });

    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('March 2026');
    await expect(glance(page)).toContainText('Closed month');
    // spent 2500 + 500 = 3000, left 40000 - 3000 = 37000, usage = floor(100 * 3000 / 40000) = 7.
    await expectGlance(page, { spent: 3000, unallocated: 160000 });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 3000,
      remaining: 37000,
      alert: 'ok',
      usage: 7,
    });

    // March is due its unallocated 160000 and what Groceries leaves, 37000: 197000. The badge
    // shows it, including for the spending that was entered after midnight.
    await expectBadge(page, 1);
    await expect(savingsToMove(page)).toContainText(signedEur(197000));
    await openPage(page, 'Savings');
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      `March 2026: move ${eur(197000)} to savings`,
    );
    expect((await getMonth(wallet.api, '2026-03')).status).toBe('closed');
  });
});
