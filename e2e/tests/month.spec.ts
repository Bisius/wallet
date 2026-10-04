import type { Page } from '@playwright/test';
import { expect, json, test, type Wallet } from '../support/fixtures';
import {
  type BudgetFigures,
  addForm,
  addSpendingViaForm,
  budgetCard,
  chooseBudget,
  dashboardOrder,
  expectBudgetCard,
  expectDashboardRow,
  expectFixedCosts,
  expectGlance,
  expectReserveLine,
  figure,
  glance,
  monthSwitcher,
  openFilters,
  openMore,
  openPage,
  spendingRow,
  spendingsList,
} from '../support/month-ui';
import { moreActions, rowAction } from '../support/menu';
import { eur } from '../support/money';
import {
  addIncome,
  addSpending,
  createBudget,
  createSubscription,
  getMonth,
  onboard,
} from '../support/seed';

/*
 * One month with spendings, through the browser. The fake clock stays at 2026-03-10, so the month in
 * view is March 2026 and "today" is Tuesday the 10th.
 *
 * The month (all amounts in cents; the rules are in docs/DOMAIN.md):
 *
 *   income        salary 300000 + a bonus of 20000 dated 03-05                      = 320000
 *   fixed costs   Streaming (monthly) 1250
 *                 + Insurance (yearly, 12000, renews in September 2026), saving from March:
 *                   N = 2026-09, monthsLeft = 9 - 3 + 1 = 7, contribution = ceilDiv(12000 - 0, 7)
 *                   = ceil(1714.28...) = 1715                                       = 1250 + 1715 = 2965
 *   budgets       Groceries 40000, Eating out 20000, Transport 10000   (not incremental)
 *                 Fun 15000                                            (incremental)
 *                                                                         allocated = 85000
 *   unallocated   320000 - 2965 - 85000                                             = 232035
 *
 * Spendings come out of the budgets, so they never move "unallocated". Every budget starts March with
 * nothing carried in (it is the first month of all of them).
 */

const INCOME = 320000;
const FIXED_COSTS = 2965;
const BUDGETED = 85000;
const UNALLOCATED = 232035;

const NAMES = ['Groceries', 'Eating out', 'Transport', 'Fun'] as const;
type BudgetName = (typeof NAMES)[number];
type Budgets = Record<BudgetName, BudgetFigures>;

/** Nothing spent yet. */
const UNTOUCHED: Budgets = {
  Groceries: { available: 40000, spent: 0, remaining: 40000, alert: 'ok', usage: 0 },
  'Eating out': { available: 20000, spent: 0, remaining: 20000, alert: 'ok', usage: 0 },
  Transport: { available: 10000, spent: 0, remaining: 10000, alert: 'ok', usage: 0 },
  Fun: { available: 15000, spent: 0, remaining: 15000, alert: 'ok', usage: 0 },
};

interface Snapshot {
  /** Σ spent over the budgets: the dashboard's "Spent". */
  spent: number;
  budgets: Budgets;
}

/** The yearly reserve of Insurance in March: 1715 goes in, 1715 is held, towards 12000. */
const MARCH_RESERVE = {
  monthLabel: 'March 2026',
  contribution: 1715,
  held: 1715,
  price: 12000,
  renewalLabel: 'September 2026',
};

async function seedMonth(wallet: Wallet) {
  const { api } = wallet;
  await onboard(api, { startMonth: '2026-03', salary: 300000, openingSavings: 100000 });
  await addIncome(api, { date: '2026-03-05', amount: 20000, description: 'Bonus' });
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
  const transport = await createBudget(api, {
    name: 'Transport',
    amount: 10000,
    incremental: false,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 15000, incremental: true });
  return { groceries, eatingOut, transport, fun };
}

/**
 * Looks at the month everywhere it is shown, like a user going through the pages: the dashboard (the
 * tiles and the rows of "Budget progress"), the budgets (tiles and cards) and the subscriptions (fixed
 * costs and the yearly reserve). It ends on the spendings page, where the next step starts.
 */
async function checkpoint(page: Page, snapshot: Snapshot): Promise<void> {
  const budgets = Object.entries(snapshot.budgets);

  await openPage(page, 'Dashboard');
  await expectGlance(page, {
    income: INCOME,
    fixedCosts: FIXED_COSTS,
    budgeted: BUDGETED,
    spent: snapshot.spent,
    unallocated: UNALLOCATED,
  });
  for (const [name, figures] of budgets) await expectDashboardRow(page, name, figures);

  // The budgets page's strip is slim: budgeted and unallocated (income and fixed costs are the
  // dashboard's above and the subscriptions page's below).
  await openPage(page, 'Budgets');
  await expectGlance(page, { budgeted: BUDGETED, unallocated: UNALLOCATED });
  for (const [name, figures] of budgets) await expectBudgetCard(page, name, figures);

  await openPage(page, 'Subscriptions');
  await expectFixedCosts(page, FIXED_COSTS);
  await expectReserveLine(page, 'Insurance', MARCH_RESERVE);

  await openPage(page, 'Spendings');
}

test.describe('adding spendings', () => {
  test('every spending moves its own budget, the warning and over states, and nothing else', async ({
    page,
    wallet,
  }) => {
    // It walks the whole month, with a look at every page after each of six spendings.
    test.slow();
    const { groceries } = await seedMonth(wallet);

    await page.goto('/spendings');
    await expect(page.getByText('March 2026 is closed')).toHaveCount(0);
    await expect(spendingsList(page)).toContainText('No spendings in March 2026');
    await checkpoint(page, { spent: 0, budgets: UNTOUCHED });

    // 1. Groceries 45.50 on today's date. The form starts on today (the server's), not the browser's.
    await expect(addForm(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-10');
    await addSpendingViaForm(page, {
      amount: '45.50',
      budget: 'Groceries',
      description: 'Weekly shop',
    });
    // 40000 - 4550 = 35450 left. usage = floor(100 * 4550 / 40000) = floor(11.375) = 11.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €45.50 to Groceries. €354.50 left of €400.00.',
    );
    // The form is ready for the next entry: amount and description cleared, the budget kept, and
    // the cursor back on the amount.
    await expect(addForm(page).getByLabel('Amount', { exact: true })).toHaveValue('');
    await expect(addForm(page).getByLabel('Amount', { exact: true })).toBeFocused();
    await expect(addForm(page).getByLabel('Description')).toHaveValue('');
    await expect(addForm(page).getByLabel('Budget', { exact: true })).toHaveValue(
      String(groceries.id),
    );
    await expect(spendingsList(page)).toContainText(
      '1 spending · €45.50 net. Refunds are subtracted.',
    );
    const afterFirst: Snapshot = {
      spent: 4550,
      budgets: {
        ...UNTOUCHED,
        Groceries: { available: 40000, spent: 4550, remaining: 35450, alert: 'ok', usage: 11 },
      },
    };
    await checkpoint(page, afterFirst);

    // 2. Groceries 32.20 dated the 8th: the list is grouped by day, newest day first.
    await addSpendingViaForm(page, {
      amount: '32.20',
      budget: 'Groceries',
      date: '2026-03-08',
      description: 'Bakery and cheese',
    });
    // spent 4550 + 3220 = 7770, left 40000 - 7770 = 32230, usage = floor(777000 / 40000) = floor(19.425) = 19.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €32.20 to Groceries. €322.30 left of €400.00.',
    );
    await expect(spendingsList(page)).toContainText(
      '2 spendings · €77.70 net. Refunds are subtracted.',
    );
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 10, 2026', level: 3 }),
    ).toBeVisible();
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Sun, Mar 8, 2026', level: 3 }),
    ).toBeVisible();
    await checkpoint(page, {
      spent: 7770,
      budgets: {
        ...UNTOUCHED,
        Groceries: { available: 40000, spent: 7770, remaining: 32230, alert: 'ok', usage: 19 },
      },
    });

    // 3. Transport 85.00 of 100.00: usage 85 >= 80, so the card turns to a warning. Not over.
    await addSpendingViaForm(page, {
      amount: '85',
      budget: 'Transport',
      description: 'Monthly pass',
    });
    // remaining 10000 - 8500 = 1500. usage = floor(850000 / 10000) = 85.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €85.00 to Transport. €15.00 left of €100.00. Warning: 85% used.',
    );
    const afterPass: Budgets = {
      ...UNTOUCHED,
      Groceries: { available: 40000, spent: 7770, remaining: 32230, alert: 'ok', usage: 19 },
      Transport: { available: 10000, spent: 8500, remaining: 1500, alert: 'warning', usage: 85 },
    };
    // spent total 7770 + 8500 = 16270.
    await checkpoint(page, { spent: 16270, budgets: afterPass });
    // The dashboard puts what needs attention first: the warning above the budget that is on track.
    await openPage(page, 'Dashboard');
    expect(await dashboardOrder(page)).toEqual(['Transport', 'Groceries', 'Eating out', 'Fun']);
    await openPage(page, 'Spendings');

    // 4. Eating out 120.00 of 200.00: 60%, fine.
    await addSpendingViaForm(page, {
      amount: '120',
      budget: 'Eating out',
      description: 'Dinner with Sam',
    });
    // remaining 20000 - 12000 = 8000, usage = floor(1200000 / 20000) = 60.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €120.00 to Eating out. €80.00 left of €200.00.',
    );
    const afterDinner: Budgets = {
      ...afterPass,
      'Eating out': { available: 20000, spent: 12000, remaining: 8000, alert: 'ok', usage: 60 },
    };
    // spent total 16270 + 12000 = 28270.
    await checkpoint(page, { spent: 28270, budgets: afterDinner });

    // 5. Eating out 130.00 more: 250.00 of 200.00. Over budget by 50.00, 125% used.
    await expect(
      addForm(page).getByLabel('Budget', { exact: true }).locator('option:checked'),
    ).toHaveText('Eating out · €80.00 left');
    await addSpendingViaForm(page, {
      amount: '130',
      budget: 'Eating out',
      description: 'Team lunch',
    });
    // spent 12000 + 13000 = 25000, remaining 20000 - 25000 = -5000, usage = floor(2500000 / 20000) = 125.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €130.00 to Eating out. Over budget by €50.00 (125% used).',
    );
    // The form's choice now says it is over.
    await expect(
      addForm(page).getByLabel('Budget', { exact: true }).locator('option:checked'),
    ).toHaveText('Eating out · over by €50.00');
    const afterLunch: Budgets = {
      ...afterDinner,
      'Eating out': { available: 20000, spent: 25000, remaining: -5000, alert: 'over', usage: 125 },
    };
    // spent total 28270 + 13000 = 41270.
    await checkpoint(page, { spent: 41270, budgets: afterLunch });
    await openPage(page, 'Dashboard');
    expect(await dashboardOrder(page)).toEqual(['Eating out', 'Transport', 'Groceries', 'Fun']);
    await openPage(page, 'Spendings');

    // 6. Fun 120.00 of 150.00: exactly the warning threshold, 100 * 12000 = 80 * 15000.
    await addSpendingViaForm(page, {
      amount: '120',
      budget: 'Fun',
      description: 'Cinema and bowling',
    });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €120.00 to Fun. €30.00 left of €150.00. Warning: 80% used.',
    );
    // spent total 41270 + 12000 = 53270, remaining 15000 - 12000 = 3000, usage = 80 exactly.
    await checkpoint(page, {
      spent: 53270,
      budgets: {
        ...afterLunch,
        Fun: { available: 15000, spent: 12000, remaining: 3000, alert: 'warning', usage: 80 },
      },
    });

    // What the UI added is what the server holds.
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.totals.spent).toBe(53270);
    expect(march.unallocated).toBe(UNALLOCATED);
  });

  test('a spending dated in a later month counts there and leaves this month alone', async ({
    page,
    wallet,
  }) => {
    await seedMonth(wallet);
    await page.goto('/spendings');
    await monthSwitcher(page).next();
    await monthSwitcher(page).expectShowing('April 2026');

    // A projection: the form says so, and the date starts on the first day of the month shown.
    await expect(addForm(page)).toContainText(
      'April 2026 has not started yet. A spending dated in it counts towards its projection.',
    );
    await expect(addForm(page).getByLabel('Date', { exact: true })).toHaveValue('2026-04-01');
    await addSpendingViaForm(page, {
      amount: '20',
      budget: 'Groceries',
      description: 'Easter eggs',
    });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €20.00 to Groceries. €380.00 left of €400.00.',
    );

    // April, a projection (nothing carried in, so every budget has its own amount): income is the
    // salary alone (the bonus was March's), 300000; fixed costs 1250 + 1715 (April: monthsLeft 6,
    // ceilDiv(12000 - 1715, 6) = ceil(1714.17) = 1715) = 2965; unallocated 300000 - 2965 - 85000 = 212035.
    await openPage(page, 'Dashboard');
    await expect(page.getByText('Projection', { exact: true }).first()).toBeVisible();
    await expectGlance(page, {
      income: 300000,
      fixedCosts: 2965,
      budgeted: 85000,
      spent: 2000,
      unallocated: 212035,
    });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: 2000,
      remaining: 38000,
      alert: 'ok',
      usage: 5,
    });

    // March is as it was: a spending dated in April never reaches back (causality).
    await monthSwitcher(page).previous();
    await monthSwitcher(page).expectShowing('March 2026');
    await expectGlance(page, { spent: 0, unallocated: UNALLOCATED });
    await expectDashboardRow(page, 'Groceries', UNTOUCHED.Groceries);
    await openPage(page, 'Budgets');
    await expect(figure(budgetCard(page, 'Groceries'), 'Spent')).toHaveText(eur(0));
    await expect(glance(page).getByText('Current month')).toBeVisible();
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(0);
    expect((await getMonth(wallet.api, '2026-04')).totals.spent).toBe(2000);
  });
});

test.describe('refund, edit and delete', () => {
  /** The six spendings of the first test, put in through the API so that this one starts from them. */
  async function seedSpendings(wallet: Wallet) {
    const { groceries, eatingOut, transport, fun } = await seedMonth(wallet);
    const { api } = wallet;
    await addSpending(api, {
      date: '2026-03-10',
      amount: 4550,
      budgetId: groceries.id,
      description: 'Weekly shop',
    });
    await addSpending(api, {
      date: '2026-03-08',
      amount: 3220,
      budgetId: groceries.id,
      description: 'Bakery and cheese',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 8500,
      budgetId: transport.id,
      description: 'Monthly pass',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 12000,
      budgetId: eatingOut.id,
      description: 'Dinner with Sam',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 13000,
      budgetId: eatingOut.id,
      description: 'Team lunch',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 12000,
      budgetId: fun.id,
      description: 'Cinema and bowling',
    });
  }

  test('a refund gives money back, an edit and a delete undo what they change', async ({
    page,
    wallet,
  }) => {
    await seedSpendings(wallet);
    const afterSix: Budgets = {
      Groceries: { available: 40000, spent: 7770, remaining: 32230, alert: 'ok', usage: 19 },
      'Eating out': { available: 20000, spent: 25000, remaining: -5000, alert: 'over', usage: 125 },
      Transport: { available: 10000, spent: 8500, remaining: 1500, alert: 'warning', usage: 85 },
      Fun: { available: 15000, spent: 12000, remaining: 3000, alert: 'warning', usage: 80 },
    };

    await page.goto('/spendings');
    // 7770 + 25000 + 8500 + 12000 = 53270 over 6 spendings.
    await expect(spendingsList(page)).toContainText(
      '6 spendings · €532.70 net. Refunds are subtracted.',
    );
    await checkpoint(page, { spent: 53270, budgets: afterSix });

    // 7. A refund of 30.00 into Eating out: the button and the confirmation say it is a refund.
    const form = addForm(page);
    await form.getByLabel('Amount', { exact: true }).fill('30');
    await expect(form.getByRole('button', { name: 'Add spending' })).toBeVisible();
    // The switch is under "More"; turning it on keeps "More" open.
    await openMore(page);
    await form.getByRole('checkbox', { name: 'Refund' }).check();
    await expect(form.getByRole('button', { name: 'Add refund' })).toBeVisible();
    await form.getByRole('checkbox', { name: 'Refund' }).uncheck();
    await expect(form.getByRole('button', { name: 'Add spending' })).toBeVisible();
    await addSpendingViaForm(page, {
      amount: '30',
      budget: 'Eating out',
      description: 'Returned dessert',
      refund: true,
    });
    // spent 25000 - 3000 = 22000, remaining 20000 - 22000 = -2000, usage = floor(2200000 / 20000) = 110.
    await expect(form.getByRole('status')).toHaveText(
      'Refund of €30.00 added to Eating out. Over budget by €20.00 (110% used).',
    );
    await expect(form.getByRole('checkbox', { name: 'Refund' })).not.toBeChecked();
    const refundRow = spendingRow(page, 'Returned dessert');
    await expect(refundRow).toContainText('Refund');
    await expect(refundRow).toContainText('-€30.00');
    // 53270 - 3000 = 50270, and the count includes the refund: 7 rows, net 502.70.
    await expect(spendingsList(page)).toContainText(
      '7 spendings · €502.70 net. Refunds are subtracted.',
    );
    const afterRefund: Budgets = {
      ...afterSix,
      'Eating out': { available: 20000, spent: 22000, remaining: -2000, alert: 'over', usage: 110 },
    };
    await checkpoint(page, { spent: 50270, budgets: afterRefund });

    // 8. Edit Team lunch from 130.00 to 110.00: Eating out lands on exactly 100%.
    // (The name of the row does it too: it is a button named for what it does.)
    await page.getByRole('button', { name: 'Edit Team lunch, €130.00', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit spending' });
    await expect(dialog.getByLabel('Amount', { exact: true })).toHaveValue('130.00');
    await expect(dialog.getByLabel('Description')).toHaveValue('Team lunch');
    await dialog.getByLabel('Amount', { exact: true }).fill('110');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Spending updated.')).toBeVisible();
    await expect(spendingRow(page, 'Team lunch')).toContainText('€110.00');
    // spent 12000 + 11000 - 3000 = 20000 = available: remaining 0, usage 100. 100 * 20000 >= 80 * 20000
    // but spent > available is false, so it is a warning and no longer "over".
    const atLimit: Budgets = {
      ...afterRefund,
      'Eating out': { available: 20000, spent: 20000, remaining: 0, alert: 'warning', usage: 100 },
    };
    // spent total 50270 - 2000 = 48270.
    await checkpoint(page, { spent: 48270, budgets: atLimit });
    await openPage(page, 'Dashboard');
    // Three warnings in the order of the budgets, then the one on track.
    expect(await dashboardOrder(page)).toEqual(['Eating out', 'Transport', 'Fun', 'Groceries']);
    await openPage(page, 'Spendings');

    // 9. Delete Bakery and cheese (32.20). The confirmation can be turned down first.
    await rowAction(spendingRow(page, 'Bakery and cheese'), 'Delete');
    const confirm = page.getByRole('dialog', { name: 'Delete this spending?' });
    await expect(confirm).toContainText(
      'Bakery and cheese, €32.20 on Sun, Mar 8, 2026 will be removed from Groceries.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(spendingRow(page, 'Bakery and cheese')).toBeVisible();
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(48270);

    await rowAction(spendingRow(page, 'Bakery and cheese'), 'Delete');
    await page
      .getByRole('dialog', { name: 'Delete this spending?' })
      .getByRole('button', { name: 'Delete spending' })
      .click();
    await expect(page.getByText('Spending deleted.')).toBeVisible();
    await expect(spendingRow(page, 'Bakery and cheese')).toHaveCount(0);
    // Groceries back to the first spending alone: spent 4550, remaining 35450, usage 11. Total 48270 - 3220 = 45050.
    await checkpoint(page, {
      spent: 45050,
      budgets: {
        ...atLimit,
        Groceries: { available: 40000, spent: 4550, remaining: 35450, alert: 'ok', usage: 11 },
      },
    });
    await expect(spendingsList(page)).toContainText(
      '6 spendings · €450.50 net. Refunds are subtracted.',
    );

    // The server's view agrees with what the pages showed.
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.totals.spent).toBe(45050);
    expect(march.totals.remaining).toBe(85000 - 45050);
    expect(march.unallocated).toBe(UNALLOCATED);
  });
});

test.describe('a refund before anything was spent', () => {
  test('makes the spent amount negative, and the budget has more than its amount to spend', async ({
    page,
    wallet,
  }) => {
    await seedMonth(wallet);
    await page.goto('/spendings');

    await addSpendingViaForm(page, {
      amount: '5',
      budget: 'Groceries',
      description: 'Returned jar',
      refund: true,
    });
    // spent = -500, remaining = 40000 - (-500) = 40500. The usage is max(0, floor(100 * -500 / 40000)) = 0.
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Refund of €5.00 added to Groceries. €405.00 left of €400.00.',
    );
    await expect(spendingsList(page)).toContainText(
      '1 spending · -€5.00 net. Refunds are subtracted.',
    );
    await expect(spendingRow(page, 'Returned jar')).toContainText('-€5.00');

    // The dashboard's spent is -500 too, and the unallocated income does not move.
    await openPage(page, 'Dashboard');
    await expectGlance(page, { spent: -500, unallocated: UNALLOCATED });
    await expectDashboardRow(page, 'Groceries', {
      available: 40000,
      spent: -500,
      remaining: 40500,
      alert: 'ok',
      usage: 0,
    });
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: -500,
      remaining: 40500,
      alert: 'ok',
      usage: 0,
    });
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.totals.spent).toBe(-500);
    expect(march.budgets[0]?.usagePercent).toBe(0);
  });
});

test.describe('the warning threshold', () => {
  test('is reached on the exact cent, and a budget can have a threshold of its own', async ({
    page,
    wallet,
  }) => {
    // No subscriptions: salary 200000, Transport 10000 (the default threshold, 80%) and Coffee 10000
    // that warns at 50%.
    await onboard(wallet.api, { startMonth: '2026-03', salary: 200000 });
    await createBudget(wallet.api, { name: 'Transport', amount: 10000, incremental: false });
    await createBudget(wallet.api, {
      name: 'Coffee',
      amount: 10000,
      incremental: false,
      alertWarnPercent: 50,
    });
    await page.goto('/spendings');

    // 79.99 of 100.00 is 79.99%, shown as 79%: below the 80% threshold, so no warning.
    // 100 * 7999 = 799900 < 80 * 10000 = 800000.
    await addSpendingViaForm(page, { amount: '79.99', budget: 'Transport' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €79.99 to Transport. €20.01 left of €100.00.',
    );
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Transport', {
      available: 10000,
      spent: 7999,
      remaining: 2001,
      alert: 'ok',
      usage: 79,
    });
    // One cent more is exactly 80%: 100 * 8000 = 80 * 10000.
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, { amount: '0.01', budget: 'Transport' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €0.01 to Transport. €20.00 left of €100.00. Warning: 80% used.',
    );
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Transport', {
      available: 10000,
      spent: 8000,
      remaining: 2000,
      alert: 'warning',
      usage: 80,
    });

    // Coffee has its own threshold: 49.99 is 49%, and the 50th percent is the warning.
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, { amount: '49.99', budget: 'Coffee' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €49.99 to Coffee. €50.01 left of €100.00.',
    );
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Coffee', {
      available: 10000,
      spent: 4999,
      remaining: 5001,
      alert: 'ok',
      usage: 49,
      warnAt: 50,
    });
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, { amount: '0.01', budget: 'Coffee' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €0.01 to Coffee. €50.00 left of €100.00. Warning: 50% used.',
    );
    await openPage(page, 'Dashboard');
    await expectDashboardRow(page, 'Coffee', {
      available: 10000,
      spent: 5000,
      remaining: 5000,
      alert: 'warning',
      usage: 50,
      warnAt: 50,
    });
    await expectDashboardRow(page, 'Transport', {
      available: 10000,
      spent: 8000,
      remaining: 2000,
      alert: 'warning',
      usage: 80,
    });
    // One cent over the whole amount is over, at 100% (floor(100.01) = 100): 8000 + 2001 > 10000.
    await openPage(page, 'Spendings');
    await addSpendingViaForm(page, { amount: '20.01', budget: 'Transport' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €20.01 to Transport. Over budget by €0.01 (100% used).',
    );
    await openPage(page, 'Budgets');
    await expectBudgetCard(page, 'Transport', {
      available: 10000,
      spent: 10001,
      remaining: -1,
      alert: 'over',
      usage: 100,
    });
  });
});

test.describe('search and filters', () => {
  test('narrow the list and its net total, never the budgets', async ({ page, wallet }) => {
    const { groceries, eatingOut, transport, fun } = await seedMonth(wallet);
    const { api } = wallet;
    const work = await json<{ id: number }>(
      await api.post('/api/tags', { data: { name: 'Work' } }),
    );
    await addSpending(api, {
      date: '2026-03-10',
      amount: 4550,
      budgetId: groceries.id,
      description: 'Weekly shop',
      notes: 'Organic vegetables from the market',
    });
    await addSpending(api, {
      date: '2026-03-08',
      amount: 3220,
      budgetId: groceries.id,
      description: 'Bakery and cheese',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 8500,
      budgetId: transport.id,
      description: 'Monthly pass',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 12000,
      budgetId: eatingOut.id,
      description: 'Dinner with Sam',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 13000,
      budgetId: eatingOut.id,
      description: 'Team lunch',
      tagIds: [work.id],
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 12000,
      budgetId: fun.id,
      description: 'Cinema and bowling',
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: -3000,
      budgetId: eatingOut.id,
      description: 'Returned dessert',
    });
    // Dated in April, which has not started: the list of March does not have it.
    await addSpending(api, {
      date: '2026-04-01',
      amount: 2000,
      budgetId: groceries.id,
      description: 'Easter eggs',
    });

    const list = spendingsList(page);
    const summary = (count: number, net: number) =>
      `${count} ${count === 1 ? 'spending' : 'spendings'} · ${eur(net)} net. Refunds are subtracted.`;
    const search = page.getByRole('searchbox', { name: 'Search' });
    const budgetFilter = page.getByLabel('Filter by budget');
    const minimum = page.getByLabel('Minimum amount');
    const maximum = page.getByLabel('Maximum amount');
    const clearFilters = () =>
      page
        .getByRole('search', { name: 'Search and filter spendings' })
        .getByRole('button', { name: 'Clear filters' })
        .click();

    await page.goto('/spendings');
    // 4550 + 3220 + 8500 + 12000 + 13000 + 12000 - 3000 = 50270 over 7 rows. April's 2000 is not here.
    await expect(list).toContainText(summary(7, 50270));
    await expect(list.getByRole('status')).toHaveText('Showing 7 of 7');
    await expect(spendingRow(page, 'Easter eggs')).toHaveCount(0);

    // Text: the description, any case.
    await search.fill('LUNCH');
    await expect(list).toContainText(summary(1, 13000));
    await expect(spendingRow(page, 'Team lunch')).toBeVisible();
    await expect(spendingRow(page, 'Weekly shop')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]q=LUNCH/);
    // ... and the notes.
    await search.fill('vegetables');
    await expect(list).toContainText(summary(1, 4550));
    await expect(spendingRow(page, 'Weekly shop')).toBeVisible();
    // A search nobody matches says so, and Clear filters brings everything back.
    await search.fill('zzz');
    await expect(list).toContainText('Nothing matches these filters');
    await expect(list).toContainText(summary(0, 0));
    // The empty state has a button of its own, below the one of the filter bar.
    await list.getByRole('button', { name: 'Clear filters' }).last().click();
    await expect(list).toContainText(summary(7, 50270));
    await expect(search).toHaveValue('');

    // The rest of the filters are in the panel under the search box.
    await openFilters(page);
    // One budget: 12000 + 13000 - 3000 = 22000 over 3 rows (the refund is one of them).
    await budgetFilter.selectOption({ label: 'Eating out' });
    await expect(list).toContainText(summary(3, 22000));
    await expect(spendingRow(page, 'Monthly pass')).toHaveCount(0);

    // The amounts are signed as stored: a maximum below zero finds the refunds.
    await maximum.fill('-0.01');
    await expect(list).toContainText(summary(1, -3000));
    await expect(spendingRow(page, 'Returned dessert')).toContainText('-€30.00');
    // A range the wrong way round is not sent: the field says so, and the list stays as it was.
    await minimum.fill('100');
    await expect(
      page.getByText("The minimum amount can't be above the maximum.").first(),
    ).toBeVisible();
    await expect(list).toContainText(summary(1, -3000));
    // Without the maximum: at least 100.00 in Eating out is 12000 + 13000 = 25000 over 2 rows.
    await maximum.fill('');
    await expect(list).toContainText(summary(2, 25000));
    // ... and in every budget, 12000 (dinner) + 13000 (lunch) + 12000 (cinema) = 37000 over 3 rows.
    await budgetFilter.selectOption({ label: 'All budgets' });
    await expect(list).toContainText(summary(3, 37000));

    // A tag.
    await clearFilters();
    await expect(list).toContainText(summary(7, 50270));
    await page.getByLabel('Filter by tag').selectOption({ label: 'Work' });
    await expect(list).toContainText(summary(1, 13000));
    await expect(spendingRow(page, 'Team lunch')).toBeVisible();

    // The filters are in the address: a reload keeps them.
    await page.reload();
    await expect(page.getByLabel('Filter by tag')).toHaveValue(String(work.id));
    await expect(list).toContainText(summary(1, 13000));
    await clearFilters();

    // Every month: April's spending joins, and the totals follow. 50270 + 2000 = 52270 over 8 rows.
    await list.getByText('All months', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'All months' })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Spendings in all months' })).toBeVisible();
    await expect(list).toContainText(summary(8, 52270));
    await expect(spendingRow(page, 'Easter eggs')).toBeVisible();
    await expect(list.getByRole('heading', { name: 'Wed, Apr 1, 2026', level: 3 })).toBeVisible();
    await search.fill('eggs');
    await expect(list).toContainText(summary(1, 2000));
    // Back to March alone: no egg in it.
    await list.getByText('March 2026', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'March 2026' })).toBeChecked();
    await expect(list).toContainText('Nothing matches these filters');

    // An address that asks for a range the wrong way round (a hand-made link) is told so, not searched.
    await page.goto('/spendings?minAmount=10000&maxAmount=-1');
    await expect(list).toContainText('Fix the amount range to search');
    await expect(list).not.toContainText('Showing');

    // Searching never moved a figure: the budgets and the dashboard are those of seven spendings.
    await openPage(page, 'Dashboard');
    await expectGlance(page, { spent: 50270, unallocated: UNALLOCATED });
  });
});

test.describe('the spending form and its dialogs', () => {
  test('say what is wrong with an entry, and keep a month closed to bad dates', async ({
    page,
    wallet,
  }) => {
    await seedMonth(wallet);
    await page.goto('/spendings');
    const form = addForm(page);
    const amount = form.getByLabel('Amount', { exact: true });
    const add = form.getByRole('button', { name: 'Add spending' });

    // Nothing typed: the form stays, says what is missing, and puts the cursor on it.
    await add.click();
    await expect(form.getByText('Amount is required.')).toBeVisible();
    await expect(amount).toBeFocused();
    await expect(spendingsList(page)).toContainText('No spendings in March 2026');

    await amount.fill('0');
    await add.click();
    await expect(form.getByText('Enter an amount greater than zero.')).toBeVisible();

    // A minus sign is a second way to say "refund": the form asks for the switch instead.
    await amount.fill('-5');
    await add.click();
    await expect(
      form.getByText(
        'Enter the amount without a minus sign. Turn on Refund for money coming back.',
      ),
    ).toBeVisible();

    await amount.fill('abc');
    await add.click();
    await expect(form.getByText('Enter an amount like 12.50 or 12,50.')).toBeVisible();

    // A date has to be inside the month shown, and has to be there at all.
    const date = form.getByLabel('Date', { exact: true });
    await amount.fill('12,5');
    await date.fill('2026-04-02');
    await add.click();
    await expect(form.getByText('Choose a date in March 2026.')).toBeVisible();
    await date.fill('');
    await add.click();
    await expect(form.getByText('Date is required.')).toBeVisible();

    // Nothing of this reached the server.
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(0);
    await expect(spendingsList(page)).toContainText('No spendings in March 2026');

    // A correct entry on the last day of the month is accepted ("12,5" is 12.50 for a comma user).
    await date.fill('2026-03-31');
    await add.click();
    await expect(form.getByRole('status')).toHaveText(
      'Added €12.50 to Groceries. €387.50 left of €400.00.',
    );
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 31, 2026', level: 3 }),
    ).toBeVisible();
    // The old messages are gone with the entry.
    await expect(form.getByText('Date is required.')).toHaveCount(0);
    await expect(form.getByText('Choose a date in March 2026.')).toHaveCount(0);
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(1250);
  });

  test('the edit dialog can be cancelled, closed with Escape and refuses a wrong amount', async ({
    page,
    wallet,
  }) => {
    const { groceries } = await seedMonth(wallet);
    await addSpending(wallet.api, {
      date: '2026-03-10',
      amount: 4550,
      budgetId: groceries.id,
      description: 'Weekly shop',
    });
    await page.goto('/spendings');

    const row = spendingRow(page, 'Weekly shop');
    // Edit is in the menu of the row, and the title of the row does it too; the dialog gives focus
    // back to the button of the menu either way.
    const menu = moreActions(row);
    const edit = () => rowAction(row, 'Edit');
    const dialog = page.getByRole('dialog', { name: 'Edit spending' });
    const amount = dialog.getByLabel('Amount', { exact: true });

    // Cancel throws the change away.
    await edit();
    await expect(amount).toBeFocused();
    await amount.fill('99');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('€45.50');
    await expect(menu).toBeFocused();

    // So does Escape, and the dialog starts again from what is stored.
    await edit();
    await expect(amount).toHaveValue('45.50');
    await amount.fill('99');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('€45.50');
    await edit();
    await expect(amount).toHaveValue('45.50');

    // A wrong amount keeps the dialog open and says why; nothing is sent.
    await amount.fill('0');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('Enter an amount greater than zero.')).toBeVisible();
    await expect(dialog).toBeVisible();
    // A date outside the month the spending is dated in is refused too.
    await amount.fill('45.50');
    await dialog.getByLabel('Date', { exact: true }).fill('2026-04-02');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('Choose a date in March 2026.')).toBeVisible();
    await dialog.getByLabel('Date', { exact: true }).fill('2026-03-10');

    // Saving what is already stored just closes the dialog: no request, no "updated" message.
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Spending updated.')).toHaveCount(0);
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(4550);

    // Moving the spending to another budget moves it between the cards: Groceries 0, Fun 4550.
    await edit();
    await chooseBudget(dialog, 'Fun');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Spending updated.')).toBeVisible();
    await openPage(page, 'Budgets');
    // Fun: 15000 available, 4550 spent, 10450 left, usage floor(455000 / 15000) = floor(30.33) = 30.
    await expectBudgetCard(page, 'Fun', {
      available: 15000,
      spent: 4550,
      remaining: 10450,
      alert: 'ok',
      usage: 30,
    });
    await expectBudgetCard(page, 'Groceries', UNTOUCHED.Groceries);
  });

  test('the delete confirmation can be turned down with Cancel, Escape or a click outside', async ({
    page,
    wallet,
  }) => {
    const { groceries } = await seedMonth(wallet);
    await addSpending(wallet.api, {
      date: '2026-03-10',
      amount: 4550,
      budgetId: groceries.id,
      description: 'Weekly shop',
    });
    await page.goto('/spendings');

    const remove = () => rowAction(spendingRow(page, 'Weekly shop'), 'Delete');
    const confirm = page.getByRole('dialog', { name: 'Delete this spending?' });

    await remove();
    // Focus starts on Cancel, so a stray Enter never deletes.
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(spendingRow(page, 'Weekly shop')).toBeVisible();

    await remove();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm).toBeHidden();
    await expect(spendingRow(page, 'Weekly shop')).toBeVisible();

    // A click on the dimmed page behind it is a click outside the dialog.
    await remove();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.mouse.click(5, 5);
    await expect(confirm).toBeHidden();
    await expect(spendingRow(page, 'Weekly shop')).toBeVisible();
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(4550);
  });
});
