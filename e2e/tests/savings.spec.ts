import type { Locator, Page } from '@playwright/test';
import type { SavingsTransactionDto } from '@wallet/shared';
import { expect, failedResponse, json, test, type Wallet } from '../support/fixtures';
import { openPage } from '../support/month-ui';
import { eur } from '../support/money';
import {
  doneButton,
  expectBadge,
  expectBalance,
  expectBreakdown,
  expectGoal,
  expectHistory,
  goalCard,
  historyEntry,
  inbox,
  inboxEntry,
  savingsToMove,
  splitButton,
} from '../support/savings-ui';
import {
  addSpending,
  createBudget,
  createGoal,
  getSavings,
  onboard,
  setSalary,
  settleMonth,
} from '../support/seed';

/*
 * Settling savings, through the browser. The fake clock ends at 2026-05-06, so March and April 2026
 * are closed months and May is the current one. Amounts are integer cents; the rules are in
 * docs/DOMAIN.md ("Savings", "Settling a month", "Manual money", "Goals").
 *
 * The wallet of most tests: salary 200000, opening savings 50000, no subscriptions, two budgets:
 * Groceries 40000 (not incremental) and Fun 10000 (incremental). So every month has
 * unallocated = 200000 - 50000 = 150000, and:
 *
 *   March   Groceries spends 30000 -> leaves 10000 (moves to savings), Fun spends 4000 -> carries 6000.
 *           due = 150000 + 10000 = 160000
 *   April   Groceries spends 45000 -> overspent by 5000 (taken from savings), Fun carries
 *           6000 + 10000 - 0 = 16000.
 *           due = 150000 - 5000 = 145000
 *
 * Savings balance = opening balance + the settled amounts + goal movements (deposits, withdrawals).
 */

const OPENING = 50000;
const MARCH_DUE = 160000;
const APRIL_DUE = 145000;

async function seedClosedMonths(wallet: Wallet) {
  const { api } = wallet;
  await onboard(api, { startMonth: '2026-03', salary: 200000, openingSavings: OPENING });
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 10000, incremental: true });
  await addSpending(api, { date: '2026-03-12', amount: 30000, budgetId: groceries.id });
  await addSpending(api, { date: '2026-03-20', amount: 4000, budgetId: fun.id });
  // April has not started: a spending dated in it counts there.
  await addSpending(api, { date: '2026-04-10', amount: 45000, budgetId: groceries.id });
  await wallet.setNow('2026-05-06T09:00:00');
  return { groceries, fun };
}

/** The toast that says what happened (they dismiss themselves). */
function toast(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

/** A check that the numbers add up: what the server says is what the user was shown. */
async function expectServerBalance(
  wallet: Wallet,
  expected: { balance: number; unassigned: number; goals?: Record<string, number> },
): Promise<void> {
  const savings = await getSavings(wallet.api);
  expect(savings.balance).toBe(expected.balance);
  expect(savings.unassigned).toBe(expected.unassigned);
  // savingsBalance = unassigned + Σ goal balances (docs/DOMAIN.md, "Savings").
  expect(savings.unassigned + savings.goals.reduce((sum, goal) => sum + goal.balance, 0)).toBe(
    savings.balance,
  );
  for (const [name, balance] of Object.entries(expected.goals ?? {})) {
    expect(savings.goals.find((goal) => goal.name === name)?.balance).toBe(balance);
  }
}

test.describe('the Move to savings inbox', () => {
  test('lists every closed month with its amount, and Done moves them one by one', async ({
    page,
    wallet,
  }) => {
    await seedClosedMonths(wallet);

    // Two closed months wait: the badge, the dashboard and the inbox agree.
    // 160000 + 145000 = 305000.
    await page.goto('/dashboard');
    await expectBadge(page, 2);
    await expect(savingsToMove(page)).toContainText('+€3,050.00');
    await expect(savingsToMove(page)).toContainText('2 months to settle. Move this to savings.');

    await openPage(page, 'Savings');
    await expectBalance(page, { balance: OPENING, unassigned: OPENING });
    await expect(inbox(page)).toContainText(
      '2 months to settle. In total: move €3,050.00 to savings.',
    );
    const march = inboxEntry(page, 'March 2026');
    const april = inboxEntry(page, 'April 2026');
    await expect(march).toContainText('March 2026: move €1,600.00 to savings');
    await expect(april).toContainText('April 2026: move €1,450.00 to savings');
    await expect(march).not.toContainText('Correction');
    // March: unallocated 150000 + Groceries 10000 = 160000. April: 150000 - 5000 = 145000.
    await expectBreakdown(march, {
      unallocated: 150000,
      budgetsSettled: 10000,
      reservesReleased: 0,
      due: MARCH_DUE,
      now: MARCH_DUE,
    });
    await expectBreakdown(april, {
      unallocated: 150000,
      budgetsSettled: -5000,
      reservesReleased: 0,
      due: APRIL_DUE,
      now: APRIL_DUE,
    });

    // Done on March raises the balance by exactly its amount: 50000 + 160000 = 210000. The toast
    // offers an Undo, and with it the month is back in the list and the balance as it was.
    await doneButton(march).click();
    await expect(toast(page, 'March 2026 is done: €1,600.00 moved to savings.')).toBeVisible();
    await expectBalance(page, { balance: OPENING + MARCH_DUE, unassigned: OPENING + MARCH_DUE });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      toast(page, 'Settlement of March 2026 undone. The month is back in the list.'),
    ).toBeVisible();
    await expectBalance(page, { balance: OPENING, unassigned: OPENING });
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €1,600.00 to savings',
    );
    await expect(inboxEntry(page, 'March 2026')).not.toContainText('Correction');
    await expectBadge(page, 2);

    // Done again, and this time it stays: the inbox, the badge and the dashboard show April alone.
    await doneButton(inboxEntry(page, 'March 2026')).click();
    await expectBalance(page, { balance: OPENING + MARCH_DUE, unassigned: OPENING + MARCH_DUE });
    await expect(inboxEntry(page, 'March 2026')).toHaveCount(0);
    await expect(inbox(page)).toContainText(
      '1 month to settle. In total: move €1,450.00 to savings.',
    );
    await expectBadge(page, 1);
    await openPage(page, 'Dashboard');
    await expect(savingsToMove(page)).toContainText('+€1,450.00');
    await expect(savingsToMove(page)).toContainText('1 month to settle. Move this to savings.');
    await expectBadge(page, 1);
    await openPage(page, 'Savings');

    // Now both: the inbox is empty, the badge and the dashboard's block are gone.
    await doneButton(inboxEntry(page, 'April 2026')).click();
    await expect(inbox(page)).toContainText('All months are settled');
    // 50000 + 160000 + 145000 = 355000.
    await expectBalance(page, { balance: 355000, unassigned: 355000 });
    await expectBadge(page, 0);
    await openPage(page, 'Dashboard');
    await expect(savingsToMove(page)).toContainText('All settled');
    await expect(savingsToMove(page)).not.toContainText('to settle');
    await expectBadge(page, 0);
    await expectServerBalance(wallet, { balance: 355000, unassigned: 355000 });

    // The history says it all, newest first: April settled last, then March, then the opening.
    await openPage(page, 'Savings');
    await expectHistory(page, ['Settled April 2026', 'Settled March 2026', 'Opening balance']);
    await expect(historyEntry(page, 'Settled April 2026')).toContainText('May 6, 2026');
    await expect(historyEntry(page, 'Settled April 2026')).toContainText(
      'Unassigned savings: +€1,450.00',
    );
    await expect(historyEntry(page, 'Settled March 2026')).toContainText(
      'Unassigned savings: +€1,600.00',
    );
    await expect(historyEntry(page, 'Opening balance')).toContainText('+€500.00');

    // Undoing a settlement from the history asks first, and puts the month back as a first move.
    const undo = page.getByRole('button', { name: 'Undo Settled April 2026' });
    await undo.click();
    const confirm = page.getByRole('dialog', { name: 'Undo the settlement of April 2026?' });
    await expect(confirm).toContainText(
      'Your savings balance goes back to what it was before the month was settled.',
    );
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expectBalance(page, { balance: 355000 });
    await undo.click();
    await confirm.getByRole('button', { name: 'Undo settlement' }).click();
    await expect(
      toast(page, 'Settlement of April 2026 undone. The month is back in the list.'),
    ).toBeVisible();
    // 355000 - 145000 = 210000.
    await expectBalance(page, { balance: 210000, unassigned: 210000 });
    await expect(inboxEntry(page, 'April 2026')).toContainText(
      'April 2026: move €1,450.00 to savings',
    );
    await expectHistory(page, ['Settled March 2026', 'Opening balance']);
    await expectBadge(page, 1);
    await expectServerBalance(wallet, { balance: 210000, unassigned: 210000 });
    expect((await getSavings(wallet.api)).outstanding.map((entry) => entry.month)).toEqual([
      '2026-04',
    ]);
  });

  test('a month edited while it was on screen is not settled for the old amount', async ({
    page,
    wallet,
    browserErrors,
  }) => {
    // The server refuses to settle an amount that is not the current one (409 outstanding_changed,
    // an optimistic lock), and Chromium logs that refusal as a console error. It is by design, and
    // the page is expected to explain it, so it is allowed here and for this one request only.
    browserErrors.allow(failedResponse(409, /\/api\/savings\/settle\/2026-03$/));
    const { groceries } = await seedClosedMonths(wallet);

    await page.goto('/savings');
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €1,600.00 to savings',
    );

    // Somewhere else a forgotten spending of 10.00 is entered in March: Groceries leaves 9000, not 10000.
    await addSpending(wallet.api, { date: '2026-03-25', amount: 1000, budgetId: groceries.id });

    await doneButton(inboxEntry(page, 'March 2026')).click();
    // Nothing was settled, and the row says why and asks again with the new amount: 160000 - 1000.
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'The amount for March 2026 changed while you were looking. It is now: move €1,590.00 to savings (it was: move €1,600.00 to savings). Check it, then press Done to confirm.',
    );
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €1,590.00 to savings',
    );
    await expectBalance(page, { balance: OPENING });
    await expectServerBalance(wallet, { balance: OPENING, unassigned: OPENING });

    await doneButton(inboxEntry(page, 'March 2026')).click();
    await expect(toast(page, 'March 2026 is done: €1,590.00 moved to savings.')).toBeVisible();
    // 50000 + 159000 = 209000.
    await expectBalance(page, { balance: 209000, unassigned: 209000 });
    await expect(inboxEntry(page, 'March 2026')).toHaveCount(0);
  });
});

test.describe('splitting a settlement across goals', () => {
  test('shares the amount out, checks that it adds up, and the goals show their progress', async ({
    page,
    wallet,
  }) => {
    await seedClosedMonths(wallet);
    await createGoal(wallet.api, { name: 'Holiday', targetAmount: 100000 });
    await createGoal(wallet.api, { name: 'Car', targetAmount: 500000 });

    await page.goto('/savings');
    await expectGoal(page, 'Holiday', {
      saved: 0,
      target: 100000,
      progress: 0,
      stillToSave: 100000,
    });

    const march = inboxEntry(page, 'March 2026');
    await splitButton(march).click();
    const dialog = page.getByRole('dialog', { name: 'Split March 2026' });
    const status = dialog.getByRole('status');
    const place = (name: string) => dialog.getByLabel(name, { exact: true });
    await expect(dialog).toContainText('March 2026: move €1,600.00 to savings.');
    await expect(dialog.getByRole('group', { name: 'Move to' })).toBeVisible();
    await expect(status).toHaveText('€1,600.00 left to allocate');

    // Cancel and Escape settle nothing.
    await place('Holiday').fill('100');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await splitButton(march).click();
    await expect(place('Holiday')).toHaveValue('');
    await place('Holiday').fill('100');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expectBalance(page, { balance: OPENING });
    await expect(march).toContainText('March 2026: move €1,600.00 to savings');

    // Confirming with nothing shared out says so.
    await splitButton(march).click();
    await dialog.getByRole('button', { name: 'Confirm split' }).click();
    await expect(dialog).toContainText(
      'Give the whole amount a place first: €1,600.00 is still left to allocate.',
    );

    // Holiday 600.00, Car 400.00, and the rest (600.00) to the unassigned savings.
    await place('Holiday').fill('600');
    await expect(status).toHaveText('€1,000.00 left to allocate');
    await place('Car').fill('400');
    await expect(status).toHaveText('€600.00 left to allocate');
    // Too much: 1300 + 400 = 1700 is 100.00 more than the 1600 to share.
    await place('Holiday').fill('1300');
    await expect(status).toHaveText('€100.00 too much: lower an amount');
    await dialog.getByRole('button', { name: 'Confirm split' }).click();
    await expect(dialog).toContainText(
      'The amounts add up to more than €1,600.00: lower one by €100.00.',
    );
    await expect(
      dialog.getByRole('button', { name: 'Put the rest in Unassigned savings' }),
    ).toBeDisabled();
    await place('Holiday').fill('600');
    await expect(status).toHaveText('€600.00 left to allocate');
    await dialog.getByRole('button', { name: 'Put the rest in Unassigned savings' }).click();
    await expect(place('Unassigned savings')).toHaveValue('600.00');
    await expect(status).toHaveText('Everything is allocated.');

    await dialog.getByRole('button', { name: 'Confirm split' }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'March 2026 is done: €1,600.00 moved to savings.')).toBeVisible();

    // Balance 50000 + 160000 = 210000. Unassigned 50000 + 60000 = 110000, Holiday 60000, Car 40000.
    await expectBalance(page, { balance: 210000, unassigned: 110000 });
    // Holiday 60000 of 100000: 60%, 40000 to go. Car 40000 of 500000: 8%, 460000 to go.
    await expectGoal(page, 'Holiday', {
      saved: 60000,
      target: 100000,
      progress: 60,
      stillToSave: 40000,
    });
    await expectGoal(page, 'Car', {
      saved: 40000,
      target: 500000,
      progress: 8,
      stillToSave: 460000,
    });
    await expect(inboxEntry(page, 'March 2026')).toHaveCount(0);
    await expectBadge(page, 1);
    await expectServerBalance(wallet, {
      balance: 210000,
      unassigned: 110000,
      goals: { Holiday: 60000, Car: 40000 },
    });

    // One history entry for the settlement, with where each part went.
    await expectHistory(page, ['Settled March 2026', 'Opening balance']);
    const entry = historyEntry(page, 'Settled March 2026');
    await expect(entry).toContainText('Unassigned savings: +€600.00');
    await expect(entry).toContainText('Holiday: +€600.00');
    await expect(entry).toContainText('Car: +€400.00');

    // Undo takes the parts back from every place at once.
    await page.getByRole('button', { name: 'Undo Settled March 2026' }).click();
    await page
      .getByRole('dialog', { name: 'Undo the settlement of March 2026?' })
      .getByRole('button', { name: 'Undo settlement' })
      .click();
    await expect(
      toast(page, 'Settlement of March 2026 undone. The month is back in the list.'),
    ).toBeVisible();
    await expectBalance(page, { balance: OPENING, unassigned: OPENING });
    await expectGoal(page, 'Holiday', {
      saved: 0,
      target: 100000,
      progress: 0,
      stillToSave: 100000,
    });
    await expectGoal(page, 'Car', { saved: 0, target: 500000, progress: 0, stillToSave: 500000 });
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €1,600.00 to savings',
    );
  });

  test('a goal reaches its target with a settlement, and the progress is capped at 100 on the bar only', async ({
    page,
    wallet,
  }) => {
    await seedClosedMonths(wallet);
    await createGoal(wallet.api, { name: 'Laptop', targetAmount: 120000 });

    await page.goto('/savings');
    await splitButton(inboxEntry(page, 'March 2026')).click();
    const dialog = page.getByRole('dialog', { name: 'Split March 2026' });
    // The whole 1,600.00 into a goal of 1,200.00: 133%, reached, nothing left to save.
    await dialog.getByRole('button', { name: 'Put the rest in Laptop' }).click();
    await expect(dialog.getByLabel('Laptop', { exact: true })).toHaveValue('1600.00');
    await dialog.getByRole('button', { name: 'Confirm split' }).click();
    await expect(dialog).toBeHidden();

    // progress = floor(100 * 160000 / 120000) = floor(133.33) = 133, not capped as a number.
    const card = goalCard(page, 'Laptop');
    await expectGoal(page, 'Laptop', { saved: 160000, target: 120000, progress: 133 });
    await expect(card).toContainText('Target reached.');
    await expect(card.getByText('Still to save')).toHaveCount(0);
    await expectBalance(page, { balance: 210000, unassigned: OPENING });
  });
});

test.describe('a month that takes money out of savings', () => {
  /**
   * Salary 100000, opening savings 50000. Rent 80000 (not incremental) and Fun 30000 (incremental)
   * allocate 110000, so March is over-allocated: unallocated = 100000 - 110000 = -10000. Rent spends
   * all of it (leaves 0) and Fun 10000 (carries 20000), so due = -10000.
   */
  async function seedShortMonth(wallet: Wallet, openingSavings = OPENING) {
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 100000, openingSavings });
    const rent = await createBudget(api, { name: 'Rent', amount: 80000, incremental: false });
    const fun = await createBudget(api, { name: 'Fun', amount: 30000, incremental: true });
    await addSpending(api, { date: '2026-03-01', amount: 80000, budgetId: rent.id });
    await addSpending(api, { date: '2026-03-15', amount: 10000, budgetId: fun.id });
    await wallet.setNow('2026-04-05T09:00:00');
  }

  test('a negative amount says "take", and Done takes it out of the balance', async ({
    page,
    wallet,
  }) => {
    await seedShortMonth(wallet);

    await page.goto('/dashboard');
    await expectBadge(page, 1);
    await expect(savingsToMove(page)).toContainText('-€100.00');
    await expect(savingsToMove(page)).toContainText('1 month to settle. Take this from savings.');

    await openPage(page, 'Savings');
    await expect(inbox(page)).toContainText(
      '1 month to settle. In total: take €100.00 from savings.',
    );
    const march = inboxEntry(page, 'March 2026');
    await expect(march).toContainText('March 2026: take €100.00 from savings');
    await expectBreakdown(march, {
      unallocated: -10000,
      budgetsSettled: 0,
      reservesReleased: 0,
      due: -10000,
      now: -10000,
    });

    await doneButton(march).click();
    await expect(toast(page, 'March 2026 is done: €100.00 taken from savings.')).toBeVisible();
    // 50000 - 10000 = 40000.
    await expectBalance(page, { balance: 40000, unassigned: 40000 });
    await expect(inbox(page)).toContainText('All months are settled');
    await expectBadge(page, 0);
    await expect(historyEntry(page, 'Settled March 2026')).toContainText(
      'Unassigned savings: -€100.00',
    );
    await expectServerBalance(wallet, { balance: 40000, unassigned: 40000 });

    // Undo gives it back: 40000 + 10000 = 50000, and the month waits again.
    await page.getByRole('button', { name: 'Undo Settled March 2026' }).click();
    await page
      .getByRole('dialog', { name: 'Undo the settlement of March 2026?' })
      .getByRole('button', { name: 'Undo settlement' })
      .click();
    await expectBalance(page, { balance: OPENING, unassigned: OPENING });
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: take €100.00 from savings',
    );
  });

  test('a settlement is never refused for lack of money: the balance can go below zero', async ({
    page,
    wallet,
  }) => {
    // Opening savings of 50.00, and March asks for 100.00 to be taken out.
    await seedShortMonth(wallet, 5000);

    await page.goto('/savings');
    await expectBalance(page, { balance: 5000, unassigned: 5000 });
    await doneButton(inboxEntry(page, 'March 2026')).click();
    await expect(toast(page, 'March 2026 is done: €100.00 taken from savings.')).toBeVisible();

    // 5000 - 10000 = -5000: shown as it is, with an explanation that is not an error.
    await expectBalance(page, { balance: -5000, unassigned: -5000 });
    const summary = page.getByRole('region', { name: 'Your savings' });
    await expect(summary).toContainText(
      'More has been taken out of savings than was put in. It rises again as you move money to savings.',
    );
    await expect(summary).toContainText(
      'More was taken out of unassigned savings than it held, so your goals hold more than the whole balance.',
    );
    await expectServerBalance(wallet, { balance: -5000, unassigned: -5000 });

    // A withdrawal is checked against what the place holds, and this holds nothing.
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const withdraw = page.getByRole('dialog', { name: 'Withdraw' });
    await expect(withdraw).toContainText(
      'Unassigned savings holds -€50.00: there is nothing to take from it.',
    );
    await withdraw.getByLabel('Amount', { exact: true }).fill('1');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(withdraw.getByText('Unassigned savings has nothing to take.')).toBeVisible();
    await withdraw.getByRole('button', { name: 'Cancel' }).click();

    // A deposit of 80.00 brings it back up: -5000 + 8000 = 3000.
    await page.getByRole('button', { name: 'Deposit', exact: true }).click();
    const deposit = page.getByRole('dialog', { name: 'Deposit' });
    await deposit.getByLabel('Amount', { exact: true }).fill('80');
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(toast(page, 'Deposited €80.00 into Unassigned savings.')).toBeVisible();
    await expectBalance(page, { balance: 3000, unassigned: 3000 });
    await expect(summary).not.toContainText('Below zero.');
  });

  test('a split takes each part from its own place, even below zero', async ({ page, wallet }) => {
    await seedShortMonth(wallet);
    const holiday = await createGoal(wallet.api, { name: 'Holiday', targetAmount: 100000 });
    // 300.00 deposited into the goal: balance 50000 + 30000 = 80000, of which Holiday 30000.
    await json<SavingsTransactionDto[]>(
      await wallet.api.post('/api/savings/transactions', {
        data: { kind: 'deposit', amount: 30000, goalId: holiday.id },
      }),
    );
    await expectServerBalance(wallet, {
      balance: 80000,
      unassigned: OPENING,
      goals: { Holiday: 30000 },
    });

    await page.goto('/savings');
    await splitButton(inboxEntry(page, 'March 2026')).click();
    const dialog = page.getByRole('dialog', { name: 'Split March 2026' });
    await expect(dialog).toContainText('March 2026: take €100.00 from savings.');
    await expect(dialog).toContainText('say how much comes out of each place');
    await expect(dialog.getByRole('group', { name: 'Take from' })).toBeVisible();

    // 40.00 from Holiday, and the rest, 60.00, from the unassigned savings.
    await dialog.getByLabel('Holiday', { exact: true }).fill('40');
    await expect(dialog.getByRole('status')).toHaveText('€60.00 left to allocate');
    await dialog.getByRole('button', { name: 'Put the rest in Unassigned savings' }).click();
    await dialog.getByRole('button', { name: 'Confirm split' }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'March 2026 is done: €100.00 taken from savings.')).toBeVisible();

    // 80000 - 10000 = 70000. Holiday 30000 - 4000 = 26000, unassigned 50000 - 6000 = 44000.
    await expectBalance(page, { balance: 70000, unassigned: 44000 });
    await expectGoal(page, 'Holiday', {
      saved: 26000,
      target: 100000,
      progress: 26,
      stillToSave: 74000,
    });
    const entry = historyEntry(page, 'Settled March 2026');
    await expect(entry).toContainText('Unassigned savings: -€60.00');
    await expect(entry).toContainText('Holiday: -€40.00');
    await expectServerBalance(wallet, {
      balance: 70000,
      unassigned: 44000,
      goals: { Holiday: 26000 },
    });
  });
});

test.describe('months that cancel each other out', () => {
  /**
   * Salary 100000, opening savings 50000, one budget Rent 90000 (not incremental) that is spent in
   * full every month, so nothing is left in it and each month is due its unallocated income alone:
   *
   *   March  100000 - 90000 =  10000   move 100.00
   *   April  salary 80000:   80000 - 90000 = -10000   take 100.00
   *   May    salary 90000:   90000 - 90000 =      0   nothing to settle: not in the list
   */
  async function seedCancelling(wallet: Wallet) {
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 100000, openingSavings: OPENING });
    const rent = await createBudget(api, { name: 'Rent', amount: 90000, incremental: false });
    await setSalary(api, '2026-04', 80000);
    await setSalary(api, '2026-05', 90000);
    for (const date of ['2026-03-02', '2026-04-02', '2026-05-02']) {
      await addSpending(api, { date, amount: 90000, budgetId: rent.id });
    }
    await wallet.setNow('2026-06-03T09:00:00');
  }

  test('say so, and a month that is due nothing is not in the list', async ({ page, wallet }) => {
    await seedCancelling(wallet);

    // +10000 and -10000 add up to nothing, and May (due 0) is not counted.
    await page.goto('/dashboard');
    await expectBadge(page, 2);
    await expect(savingsToMove(page)).toContainText('€0.00');
    await expect(savingsToMove(page)).toContainText(
      '2 months to settle. They cancel each other out.',
    );

    await openPage(page, 'Savings');
    await expect(inbox(page)).toContainText(
      '2 months to settle. In total: the months cancel each other out.',
    );
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €100.00 to savings',
    );
    await expect(inboxEntry(page, 'April 2026')).toContainText(
      'April 2026: take €100.00 from savings',
    );
    await expect(inboxEntry(page, 'May 2026')).toHaveCount(0);

    // Settling both leaves the balance where it started: 50000 + 10000 - 10000.
    await doneButton(inboxEntry(page, 'March 2026')).click();
    await expectBalance(page, { balance: 60000, unassigned: 60000 });
    await expect(inbox(page)).toContainText(
      '1 month to settle. In total: take €100.00 from savings.',
    );
    await doneButton(inboxEntry(page, 'April 2026')).click();
    await expectBalance(page, { balance: OPENING, unassigned: OPENING });
    await expect(inbox(page)).toContainText('All months are settled');
    await expectBadge(page, 0);
    await expectHistory(page, ['Settled April 2026', 'Settled March 2026', 'Opening balance']);
    await expectServerBalance(wallet, { balance: OPENING, unassigned: OPENING });
  });
});

test.describe('money by hand', () => {
  /**
   * Both months settled (50000 + 160000 + 145000 = 355000), and a goal Holiday of 1,000.00.
   * `model` is the test's own account of the balance: opening + settled + deposits - withdrawals.
   */
  async function seedSettled(wallet: Wallet) {
    await seedClosedMonths(wallet);
    await settleMonth(wallet.api, '2026-03');
    await settleMonth(wallet.api, '2026-04');
    const holiday = await createGoal(wallet.api, { name: 'Holiday', targetAmount: 100000 });
    return {
      holidayId: holiday.id,
      model: { opening: OPENING, settled: MARCH_DUE + APRIL_DUE, deposits: 0, withdrawals: 0 },
    };
  }

  const balanceOf = (model: {
    opening: number;
    settled: number;
    deposits: number;
    withdrawals: number;
  }) => model.opening + model.settled + model.deposits - model.withdrawals;

  test('deposits, withdrawals and reallocations keep the balance and the goals consistent', async ({
    page,
    wallet,
  }) => {
    const { model, holidayId } = await seedSettled(wallet);
    await page.goto('/savings');
    const holiday = goalCard(page, 'Holiday');
    // 50000 + 305000.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 355000 });

    // --- Deposit 300.00 into Holiday from its card. Cancel and Escape first.
    await page.getByRole('button', { name: 'Deposit to Holiday' }).click();
    const deposit = page.getByRole('dialog', { name: 'Deposit' });
    const amount = deposit.getByLabel('Amount', { exact: true });
    await expect(amount).toBeFocused();
    await expect(deposit.getByLabel('Deposit into')).toHaveValue(String(holidayId));
    await amount.fill('300');
    await deposit.getByRole('button', { name: 'Cancel' }).click();
    await expect(deposit).toBeHidden();
    await expectBalance(page, { balance: balanceOf(model) });
    await page.getByRole('button', { name: 'Deposit to Holiday' }).click();
    await expect(amount).toHaveValue('');
    await amount.fill('300');
    await page.keyboard.press('Escape');
    await expect(deposit).toBeHidden();
    await expectBalance(page, { balance: balanceOf(model) });

    // The form checks what it can before it asks the server.
    await page.getByRole('button', { name: 'Deposit to Holiday' }).click();
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(deposit.getByText('Amount is required.')).toBeVisible();
    await amount.fill('0');
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(deposit.getByText('Enter an amount greater than zero.')).toBeVisible();
    await amount.fill('300');
    await deposit.getByLabel('Date', { exact: true }).fill('2026-05-07');
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(deposit.getByText("The date can't be in the future.")).toBeVisible();
    await deposit.getByLabel('Date', { exact: true }).fill('2026-02-28');
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(
      deposit.getByText("The date can't be before the start month (Mar 1, 2026)."),
    ).toBeVisible();
    await deposit.getByLabel('Date', { exact: true }).fill('2026-05-06');
    await deposit.getByLabel('Note').fill('Birthday money');
    await deposit.getByRole('button', { name: 'Deposit' }).click();
    await expect(deposit).toBeHidden();
    await expect(toast(page, 'Deposited €300.00 into Holiday.')).toBeVisible();
    model.deposits += 30000;
    // 355000 + 30000 = 385000. Holiday 30000 of 100000: 30%.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 355000 });
    await expectGoal(page, 'Holiday', {
      saved: 30000,
      target: 100000,
      progress: 30,
      stillToSave: 70000,
    });
    await expectServerBalance(wallet, {
      balance: 385000,
      unassigned: 355000,
      goals: { Holiday: 30000 },
    });

    // --- Withdraw 50.00 from Holiday: more than it holds is refused, with what it holds.
    await holiday.getByRole('button', { name: 'Withdraw from Holiday' }).click();
    const withdraw = page.getByRole('dialog', { name: 'Withdraw' });
    await expect(withdraw).toContainText('Holiday holds €300.00.');
    await withdraw.getByLabel('Amount', { exact: true }).fill('300.01');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(withdraw.getByText('Holiday holds only €300.00.')).toBeVisible();
    await expectBalance(page, { balance: balanceOf(model) });
    await withdraw.getByLabel('Amount', { exact: true }).fill('50');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(withdraw).toBeHidden();
    await expect(toast(page, 'Withdrew €50.00 from Holiday.')).toBeVisible();
    model.withdrawals += 5000;
    // 385000 - 5000 = 380000. Holiday 25000: 25%.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 355000 });
    await expectGoal(page, 'Holiday', {
      saved: 25000,
      target: 100000,
      progress: 25,
      stillToSave: 75000,
    });

    // --- Reallocate 100.00 from the unassigned savings to Holiday: the balance does not change.
    await page.getByRole('button', { name: 'Reallocate', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Reallocate' });
    await expect(move.getByLabel('Move from')).toHaveValue('unassigned');
    await expect(move.getByLabel('Move to')).toHaveValue(String(holidayId));
    await expect(move).toContainText('Unassigned savings holds €3,550.00.');
    // The same place twice is refused.
    await move.getByLabel('Move to').selectOption({ label: 'Unassigned savings · €3,550.00' });
    await move.getByLabel('Amount', { exact: true }).fill('100');
    await move.getByRole('button', { name: 'Reallocate' }).click();
    await expect(
      move.getByText('Choose two different places to move the money between.'),
    ).toBeVisible();
    await move.getByLabel('Move to').selectOption({ label: 'Holiday · €250.00' });
    await move.getByRole('button', { name: 'Reallocate' }).click();
    await expect(move).toBeHidden();
    await expect(toast(page, 'Moved €100.00 from Unassigned savings to Holiday.')).toBeVisible();
    // Unassigned 355000 - 10000 = 345000, Holiday 25000 + 10000 = 35000, the balance still 380000.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 345000 });
    await expectGoal(page, 'Holiday', {
      saved: 35000,
      target: 100000,
      progress: 35,
      stillToSave: 65000,
    });

    // ... and 40.00 back from Holiday to the unassigned savings. (An active goal's card has no
    // Reallocate button of its own: the one under "Your savings" is the way in.)
    await expect(holiday.getByRole('button', { name: /^Reallocate/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Reallocate', exact: true }).click();
    await move.getByLabel('Move from').selectOption({ label: 'Holiday · €350.00' });
    await move.getByLabel('Move to').selectOption({ label: 'Unassigned savings · €3,450.00' });
    await expect(move.getByLabel('Move from')).toHaveValue(String(holidayId));
    await expect(move.getByLabel('Move to')).toHaveValue('unassigned');
    await move.getByLabel('Amount', { exact: true }).fill('40');
    await move.getByRole('button', { name: 'Reallocate' }).click();
    await expect(toast(page, 'Moved €40.00 from Holiday to Unassigned savings.')).toBeVisible();
    // Unassigned 345000 + 4000 = 349000, Holiday 35000 - 4000 = 31000.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 349000 });
    await expectGoal(page, 'Holiday', {
      saved: 31000,
      target: 100000,
      progress: 31,
      stillToSave: 69000,
    });
    await expectServerBalance(wallet, {
      balance: 380000,
      unassigned: 349000,
      goals: { Holiday: 31000 },
    });

    // A reallocation is two rows with one group and a sum of zero.
    const rows = await json<{ items: SavingsTransactionDto[] }>(
      await wallet.api.get('/api/savings/transactions?kind=reallocation'),
    );
    expect(rows.items).toHaveLength(4);
    const groups = new Map<number, number[]>();
    for (const row of rows.items) {
      expect(row.groupId).not.toBeNull();
      groups.set(row.groupId ?? 0, [...(groups.get(row.groupId ?? 0) ?? []), row.amount]);
    }
    // Newest first: the 40.00 back from Holiday, then the 100.00 into it.
    expect([...groups.values()].map((amounts) => amounts.slice().sort((a, b) => a - b))).toEqual([
      [-4000, 4000],
      [-10000, 10000],
    ]);

    // The history lists everything, newest first. A reallocation is one entry.
    await expectHistory(page, [
      'Moved €40.00 from Holiday to Unassigned savings',
      'Moved €100.00 from Unassigned savings to Holiday',
      'Withdrawal from Holiday',
      'Deposit to Holiday',
      'Settled April 2026',
      'Settled March 2026',
      'Opening balance',
    ]);
    await expect(historyEntry(page, 'Deposit to Holiday')).toContainText('Birthday money');
    await expect(historyEntry(page, 'Deposit to Holiday')).toContainText('+€300.00');
    await expect(historyEntry(page, 'Withdrawal from Holiday')).toContainText('-€50.00');

    // The filters narrow the list: deposits only, then Holiday only (its half of each reallocation).
    await page.getByLabel('Filter by type').selectOption({ label: 'Deposits' });
    await expectHistory(page, ['Deposit to Holiday']);
    await page.getByLabel('Filter by type').selectOption({ label: 'All types' });
    await page.getByLabel('Filter by goal').selectOption({ label: 'Holiday' });
    await expectHistory(page, [
      'Moved out of Holiday',
      'Moved into Holiday',
      'Withdrawal from Holiday',
      'Deposit to Holiday',
    ]);
    await page.getByLabel('Filter by goal').selectOption({ label: 'All savings' });

    // --- Deleting the deposit takes its money out again (asks first): 380000 - 30000 = 350000.
    await page.getByRole('button', { name: /^Delete Deposit to Holiday, / }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this entry?' });
    await expect(confirm).toContainText('Deposit to Holiday, May 6, 2026 (€300.00).');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expectBalance(page, { balance: balanceOf(model) });
    await page.getByRole('button', { name: /^Delete Deposit to Holiday, / }).click();
    await confirm.getByRole('button', { name: 'Delete entry' }).click();
    await expect(toast(page, 'Entry deleted.')).toBeVisible();
    model.deposits -= 30000;
    // Holiday 31000 - 30000 = 1000, unassigned unchanged.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 349000 });
    await expectGoal(page, 'Holiday', {
      saved: 1000,
      target: 100000,
      progress: 1,
      stillToSave: 99000,
    });
    await expectHistory(page, [
      'Moved €40.00 from Holiday to Unassigned savings',
      'Moved €100.00 from Unassigned savings to Holiday',
      'Withdrawal from Holiday',
      'Settled April 2026',
      'Settled March 2026',
      'Opening balance',
    ]);
    // opening 50000 + settled 305000 - withdrawn 5000 = 350000.
    expect(balanceOf(model)).toBe(350000);
    await expectServerBalance(wallet, {
      balance: 350000,
      unassigned: 349000,
      goals: { Holiday: 1000 },
    });

    // --- A deposit dated in the past is listed by its date, not by when it was entered: it sits
    // below the settlements of the 6th of May, above the opening balance of the 1st of March.
    await page.getByRole('button', { name: 'Deposit', exact: true }).click();
    const early = page.getByRole('dialog', { name: 'Deposit' });
    await early.getByLabel('Amount', { exact: true }).fill('20');
    await early.getByLabel('Date', { exact: true }).fill('2026-05-01');
    await early.getByRole('button', { name: 'Deposit' }).click();
    await expect(toast(page, 'Deposited €20.00 into Unassigned savings.')).toBeVisible();
    model.deposits += 2000;
    // 350000 + 2000 = 352000, all of it unassigned: 349000 + 2000.
    await expectBalance(page, { balance: balanceOf(model), unassigned: 351000 });
    await expectHistory(page, [
      'Moved €40.00 from Holiday to Unassigned savings',
      'Moved €100.00 from Unassigned savings to Holiday',
      'Withdrawal from Holiday',
      'Settled April 2026',
      'Settled March 2026',
      'Deposit to Unassigned savings',
      'Opening balance',
    ]);
    await expect(historyEntry(page, 'Deposit to Unassigned savings')).toContainText('May 1, 2026');
    await expectServerBalance(wallet, {
      balance: 352000,
      unassigned: 351000,
      goals: { Holiday: 1000 },
    });
  });

  test('an archived goal takes no new money, but what it holds can still be taken out', async ({
    page,
    wallet,
  }) => {
    await seedClosedMonths(wallet);
    await createGoal(wallet.api, { name: 'Holiday', targetAmount: 100000 });
    const old = await createGoal(wallet.api, { name: 'Old car', targetAmount: 500000 });
    await json<SavingsTransactionDto[]>(
      await wallet.api.post('/api/savings/transactions', {
        data: { kind: 'deposit', amount: 10000, goalId: old.id },
      }),
    );
    await wallet.api.patch(`/api/goals/${old.id}`, { data: { archived: true } });

    await page.goto('/savings');
    // 50000 opening + 10000 in the goal: 60000, of which 50000 is unassigned.
    await expectBalance(page, { balance: 60000, unassigned: 50000 });

    // A settlement cannot be split into it...
    await splitButton(inboxEntry(page, 'March 2026')).click();
    const split = page.getByRole('dialog', { name: 'Split March 2026' });
    await expect(split.getByLabel('Holiday', { exact: true })).toBeVisible();
    await expect(split.getByLabel('Old car', { exact: true })).toHaveCount(0);
    await split.getByRole('button', { name: 'Cancel' }).click();

    // ... nor a deposit made into it, nor a reallocation to it ...
    await page.getByRole('button', { name: 'Deposit', exact: true }).click();
    const deposit = page.getByRole('dialog', { name: 'Deposit' });
    await expect(deposit.getByLabel('Deposit into').locator('option')).toHaveText([
      'Unassigned savings · €500.00',
      'Holiday · €0.00',
    ]);
    await deposit.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Reallocate', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Reallocate' });
    await expect(move.getByLabel('Move to').locator('option')).toHaveText([
      'Unassigned savings · €500.00',
      'Holiday · €0.00',
    ]);
    // ... but it can give: it is a place to move money from, and to withdraw from.
    await expect(move.getByLabel('Move from').locator('option')).toHaveText([
      'Unassigned savings · €500.00',
      'Holiday · €0.00',
      'Old car (archived) · €100.00',
    ]);
    await move.getByLabel('Move from').selectOption({ label: 'Old car (archived) · €100.00' });
    await move.getByLabel('Move to').selectOption({ label: 'Holiday · €0.00' });
    await move.getByLabel('Amount', { exact: true }).fill('60');
    await move.getByRole('button', { name: 'Reallocate' }).click();
    await expect(toast(page, 'Moved €60.00 from Old car (archived) to Holiday.')).toBeVisible();
    // Old car 10000 - 6000 = 4000, Holiday 6000, the balance did not move.
    await expectBalance(page, { balance: 60000, unassigned: 50000 });
    await expectServerBalance(wallet, {
      balance: 60000,
      unassigned: 50000,
      goals: { 'Old car': 4000, Holiday: 6000 },
    });

    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const withdraw = page.getByRole('dialog', { name: 'Withdraw' });
    await withdraw
      .getByLabel('Withdraw from')
      .selectOption({ label: 'Old car (archived) · €40.00' });
    await withdraw.getByLabel('Amount', { exact: true }).fill('40');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(toast(page, 'Withdrew €40.00 from Old car (archived).')).toBeVisible();
    // 60000 - 4000 = 56000: the archived goal is empty and the money left savings.
    await expectBalance(page, { balance: 56000, unassigned: 50000 });
    await expectServerBalance(wallet, {
      balance: 56000,
      unassigned: 50000,
      goals: { 'Old car': 0, Holiday: 6000 },
    });
  });

  test('a withdrawal from the unassigned savings, and nothing to take from an empty goal', async ({
    page,
    wallet,
  }) => {
    await seedSettled(wallet);
    await page.goto('/savings');

    // 355000 in the unassigned savings: 3,000.00 out, for the holiday.
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const withdraw = page.getByRole('dialog', { name: 'Withdraw' });
    await expect(withdraw.getByLabel('Withdraw from')).toHaveValue('unassigned');
    await expect(withdraw).toContainText('Unassigned savings holds €3,550.00.');
    await withdraw.getByLabel('Amount', { exact: true }).fill('3000');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(toast(page, 'Withdrew €3,000.00 from Unassigned savings.')).toBeVisible();
    // 355000 - 300000 = 55000.
    await expectBalance(page, { balance: 55000, unassigned: 55000 });

    // The goal has nothing: the dialog says so before an amount is typed, and refuses any.
    await page.getByRole('button', { name: 'Withdraw from Holiday' }).click();
    await expect(withdraw).toContainText('Holiday holds €0.00: there is nothing to take from it.');
    await withdraw.getByLabel('Amount', { exact: true }).fill('1');
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await expect(withdraw.getByText('Holiday has nothing to take.')).toBeVisible();
    await withdraw.getByRole('button', { name: 'Cancel' }).click();
    await expectBalance(page, { balance: 55000, unassigned: 55000 });
    await expectServerBalance(wallet, { balance: 55000, unassigned: 55000, goals: { Holiday: 0 } });
  });
});
