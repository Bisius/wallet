import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { BudgetDto, SpendingDto, TagDto } from '@wallet/shared';
import {
  MARCH_FILE_ROWS,
  MARCH_ROWS,
  SIMPLE_MAPPING,
  SPARKASSE_ENGLISH_HEADER,
  SPARKASSE_HEADER,
  SPARKASSE_MAPPING,
  csvText,
  simpleFile,
  simpleText,
  sparkasseFile,
  sparkasseText,
  utf8Upload,
} from '../support/csv-fixtures';
import { json } from '../support/fixtures';
import {
  chooseColumns,
  chooseFile,
  expectImported,
  importButton,
  openImport,
  pickBudget,
  review,
  reviewCount,
  reviewRow,
  rowBudget,
  rowCheckbox,
  showRows,
  toColumns,
  toReview,
} from '../support/import-flow';
import { expect, test } from '../support/servers';
import {
  addIncome,
  addSpending,
  createBudget,
  createGoal,
  createSubscription,
  getMonth,
  getSavings,
  onboard,
  settleMonth,
} from '../support/seed';

/*
 * CSV import through the wizard (File, Columns, Review, Done) against the production build. The fake
 * clock is 2026-03-10 09:00 (the harness default), so March 2026 is the current month.
 *
 * The main statement is a German bank's file in windows-1252: semicolons, dd/mm/yyyy, a decimal comma
 * with a dot for thousands, debits as negative amounts (`MARCH_ROWS` in support/csv-fixtures.ts says
 * what each row is for). Expected amounts are worked out by hand from docs/DOMAIN.md, "CSV import".
 */

/** A figure of the "at a glance" strip of the dashboard. */
function glanceFigure(page: Page, label: string): Locator {
  return page
    .getByRole('region', { name: /at a glance$/ })
    .locator('dl > div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .getByRole('definition')
    .first();
}

/** The "Budget progress" row of one budget on the dashboard. */
function budgetRow(page: Page, name: string): Locator {
  return page
    .getByRole('region', { name: 'Budget progress' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

/** The spending of the list on /spendings that carries this text. */
function spendingItem(page: Page, text: string | RegExp): Locator {
  return page.getByRole('listitem').filter({ hasText: text });
}

interface Budgets {
  groceries: BudgetDto;
  fun: BudgetDto;
  transport: BudgetDto;
  home: BudgetDto;
}

/**
 * The wallet of the main statement: March 2026 is the first month, salary 2,500.00, a Netflix
 * subscription of 12.99 and four budgets, none of them with a carry-over yet. Allocated
 * 400.00 + 150.00 + 80.00 + 1,200.00 = 1,830.00, so unallocated is
 * 2,500.00 - 12.99 - 1,830.00 = 657.01.
 */
async function setUpWallet(api: Parameters<typeof onboard>[0]): Promise<Budgets> {
  await onboard(api, { startMonth: '2026-03', salary: 250000 });
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 15000, incremental: true });
  const transport = await createBudget(api, {
    name: 'Transport',
    amount: 8000,
    incremental: false,
  });
  const home = await createBudget(api, { name: 'Home', amount: 120000, incremental: false });
  await createSubscription(api, {
    name: 'Netflix',
    frequency: 'monthly',
    amount: 1299,
    anchorDate: '2026-03-15',
  });
  return { groceries, fun, transport, home };
}

/**
 * Three spendings entered by hand earlier, so that the importer has something to learn suggestions
 * from: it suggests the budget most used for the same description (case folded, accents kept).
 * 30.00 + 12.50 + 2.80 = 45.30 spent.
 */
async function addEarlierSpendings(api: Parameters<typeof onboard>[0], budgets: Budgets) {
  await addSpending(api, {
    date: '2026-03-01',
    amount: 3000,
    budgetId: budgets.groceries.id,
    description: 'REWE Markt "Süd" Straße',
  });
  await addSpending(api, {
    date: '2026-03-01',
    amount: 1250,
    budgetId: budgets.fun.id,
    description: 'Café de Flore',
  });
  await addSpending(api, {
    date: '2026-03-01',
    amount: 280,
    budgetId: budgets.transport.id,
    description: 'Straßenbahn "Ticket" Zone 1',
  });
}

test.describe('a bank statement through the wizard', () => {
  test('a windows-1252 file with semicolons, a decimal comma, a refund and two bad rows is imported row by row', async ({
    page,
    wallet,
  }) => {
    const budgets = await setUpWallet(wallet.api);
    await addEarlierSpendings(wallet.api, budgets);

    // Before: income 2,500.00, fixed costs 12.99, budgeted 1,830.00, spent 30.00 + 12.50 + 2.80 =
    // 45.30, unallocated 657.01. Remaining per budget: 400.00 - 30.00 = 370.00, 150.00 - 12.50 =
    // 137.50, 80.00 - 2.80 = 77.20 and the whole 1,200.00 of Home.
    await page.goto('/dashboard');
    await expect(glanceFigure(page, 'Income')).toHaveText('€2,500.00');
    await expect(glanceFigure(page, 'Fixed costs')).toHaveText('€12.99');
    await expect(glanceFigure(page, 'Budgeted')).toHaveText('€1,830.00');
    await expect(glanceFigure(page, 'Spent')).toHaveText('€45.30');
    await expect(glanceFigure(page, 'Unallocated')).toHaveText('€657.01');
    await expect(budgetRow(page, 'Groceries')).toContainText(/Remaining\s*€370\.00/);
    await expect(budgetRow(page, 'Fun')).toContainText(/Remaining\s*€137\.50/);
    await expect(budgetRow(page, 'Transport')).toContainText(/Remaining\s*€77\.20/);
    await expect(budgetRow(page, 'Home')).toContainText(/Remaining\s*€1,200\.00/);

    // 1. The file. It is not valid UTF-8 (ü, ß and É are single bytes), so the app reads it as
    //    windows-1252 and says so. The server found the semicolon by itself.
    const statement = sparkasseFile('sparkasse-2026-03.csv', MARCH_FILE_ROWS);
    await page.getByRole('link', { name: 'Spendings', exact: true }).click();
    await page.getByRole('link', { name: 'Import CSV' }).click();
    await expect(page).toHaveURL(/\/import$/);
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await chooseFile(page, statement);
    await expect(
      page.getByText(`sparkasse-2026-03.csv (${statement.buffer.length} B)`),
    ).toBeVisible();
    await expect(page.getByText('11 (the first one may be a header)')).toBeVisible();
    await expect(page.getByText('Semicolon (;), detected')).toBeVisible();
    await expect(page.getByText(/read as windows-1252/)).toBeVisible();

    // 2. The columns. Nothing is chosen yet, so the next step is off and says why.
    await toColumns(page);
    await expect(page.getByLabel('Delimiter')).toHaveValue(';');
    await expect(page.getByRole('checkbox', { name: /First row is a header/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Next: review the rows' })).toBeDisabled();
    await expect(page.getByText('Choose the date, amount and description columns.')).toBeVisible();
    await chooseColumns(page, {
      date: 'Buchungstag',
      amount: 'Betrag',
      description: 'Verwendungszweck',
      dateFormat: 'DD/MM/YYYY',
      decimal: ',',
    });
    // The page shows the file's own first date and amount next to the formats, to compare by eye.
    await expect(page.getByText('Your file\'s first date reads "02/03/2026".')).toBeVisible();
    await expect(page.getByText('Your file\'s first amount reads "-45,90".').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next: review the rows' })).toBeEnabled();
    await toReview(page);

    // 3. The review. Ten data rows: seven can be imported, one is a credit, two have errors.
    await expect(reviewCount(page, 'Rows')).toHaveText('10');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('7');
    await expect(reviewCount(page, 'Already imported')).toHaveText('0');
    await expect(reviewCount(page, 'Credits')).toHaveText('1');
    await expect(reviewCount(page, 'With errors')).toHaveText('2');

    // The server suggested a budget for the three descriptions that were spent on before, and the
    // rows that have one start ticked: 45.90 + 9.80 + 2.80 + 2.80 = 61.30. 'CAFÉ DE FLORE' got
    // Fun from 'Café de Flore' (case is folded, the accent is kept).
    await expect(rowBudget(page, 2)).toHaveValue(String(budgets.groceries.id));
    await expect(rowBudget(page, 5)).toHaveValue(String(budgets.fun.id));
    await expect(rowBudget(page, 6)).toHaveValue(String(budgets.transport.id));
    await expect(rowBudget(page, 7)).toHaveValue(String(budgets.transport.id));
    for (const line of [2, 5, 6, 7]) await expect(rowCheckbox(page, line)).toBeChecked();
    await expect(page.getByText('4 rows selected of 10.')).toBeVisible();
    await expect(page.getByText(/Together\s*€61\.30/)).toBeVisible();
    await expect(importButton(page)).toHaveText(/Import 4 spendings/);

    // No suggestion for the rest: they wait for a decision.
    for (const line of [3, 4, 10]) {
      await expect(rowBudget(page, line)).toHaveValue('');
      await expect(rowCheckbox(page, line)).not.toBeChecked();
      await expect(rowCheckbox(page, line)).toBeEnabled();
    }

    // The description reads as the person wrote it: quotes, ß, ü, a formula, an en dash and a euro sign.
    await expect(reviewRow(page, 2)).toContainText('REWE Markt "Süd" Straße');
    await expect(reviewRow(page, 2)).toContainText('€45.90');
    await expect(reviewRow(page, 3)).toContainText('Möbel Weiß GmbH Küche');
    await expect(reviewRow(page, 3)).toContainText('€1,049.00');
    await expect(reviewRow(page, 4)).toContainText('=1+1');
    await expect(reviewRow(page, 10)).toContainText('Mensa Café – Tagesmenü 7,40 €');

    // The two bad rows say what is wrong, quote what the file says, and cannot be ticked.
    await expect(reviewRow(page, 9)).toContainText(
      'The date can\'t be read in the chosen date format: "31/02/2026"',
    );
    await expect(reviewRow(page, 11)).toContainText('The amount isn\'t a valid number: "-abc"');
    await expect(rowCheckbox(page, 9)).toBeDisabled();
    await expect(rowCheckbox(page, 11)).toBeDisabled();
    await showRows(page, 'With errors (2)');
    await expect(reviewRow(page, 9)).toBeVisible();
    await expect(reviewRow(page, 11)).toBeVisible();
    await expect(reviewRow(page, 2)).toHaveCount(0);

    // The credit is marked and stays unticked until the person decides: it would be stored as a refund.
    await showRows(page, 'Credits (1)');
    await expect(reviewRow(page, 8)).toContainText('Credit: money in');
    await expect(reviewRow(page, 8)).toContainText('-€19.99');
    await showRows(page, 'All rows (10)');
    await expect(rowCheckbox(page, 8)).not.toBeChecked();

    // Ticking it without a budget blocks the import and says which rows to fix.
    await rowCheckbox(page, 8).check();
    await expect(importButton(page)).toBeDisabled();
    await expect(
      page.getByText('1 ticked row needs a budget before you can import.'),
    ).toBeVisible();
    await pickBudget(page, 8, 'Groceries');
    await expect(importButton(page)).toBeEnabled();

    // Picking a budget for a row that was waiting is the decision to import it (and ticks it).
    await pickBudget(page, 3, 'Home');
    await pickBudget(page, 4, 'Fun');
    await pickBudget(page, 10, 'Groceries');
    for (const line of [3, 4, 10]) await expect(rowCheckbox(page, line)).toBeChecked();

    // Eight rows, a refund among them, subtracted from the sum:
    // 45.90 + 1,049.00 + 12.50 + 9.80 + 2.80 + 2.80 + 7.40 - 19.99 = 1,110.21.
    await expect(page.getByText('8 rows selected of 10.')).toBeVisible();
    await expect(page.getByText(/Together\s*€1,110\.21/)).toBeVisible();
    await expect(importButton(page)).toHaveText(/Import 8 spendings/);

    // 4. Import.
    await importButton(page).click();
    await expectImported(page, 8);
    await expect(page.getByRole('link', { name: 'March 2026' })).toBeVisible();

    // After, to the cent. Spent per budget:
    //   Groceries 30.00 + 45.90 + 7.40 - 19.99 = 63.31   remaining 400.00 - 63.31 = 336.69
    //   Fun       12.50 + 12.50 + 9.80         = 34.80   remaining 150.00 - 34.80 = 115.20
    //   Transport  2.80 +  2.80 + 2.80         =  8.40   remaining  80.00 -  8.40 =  71.60
    //   Home      1,049.00                                remaining 1,200.00 - 1,049.00 = 151.00
    // Total spent 63.31 + 34.80 + 8.40 + 1,049.00 = 1,155.51 (45.30 before plus 1,110.21 imported).
    // Nothing about income, fixed costs or the allocations changes.
    await page.getByRole('link', { name: 'March 2026' }).click();
    await expect(page).toHaveURL(/\/spendings\?month=2026-03/);
    await expect(
      page.getByText('11 spendings · €1,155.51 net. Refunds are subtracted.'),
    ).toBeVisible();

    // The list: the stored descriptions are the cleaned cells, in the budget that was picked.
    const refund = spendingItem(page, 'Rückerstattung REWE');
    await expect(refund).toContainText('Groceries');
    await expect(refund).toContainText('Refund');
    await expect(refund).toContainText('-€19.99');
    const formula = spendingItem(page, '=1+1');
    await expect(formula).toContainText('Fun');
    await expect(formula).toContainText('€12.50');
    const furniture = spendingItem(page, 'Möbel Weiß GmbH Küche');
    await expect(furniture).toContainText('Home');
    await expect(furniture).toContainText('€1,049.00');
    const canteen = spendingItem(page, 'Mensa Café – Tagesmenü 7,40 €');
    await expect(canteen).toContainText('Groceries');
    await expect(canteen).toContainText('€7.40');
    await expect(spendingItem(page, 'Straßenbahn "Ticket" Zone 1')).toHaveCount(3);
    // The two bad rows were not imported.
    await expect(spendingItem(page, 'Bäckerei Müller')).toHaveCount(0);
    await expect(spendingItem(page, 'Tankstelle Aral')).toHaveCount(0);

    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(glanceFigure(page, 'Income')).toHaveText('€2,500.00');
    await expect(glanceFigure(page, 'Fixed costs')).toHaveText('€12.99');
    await expect(glanceFigure(page, 'Budgeted')).toHaveText('€1,830.00');
    await expect(glanceFigure(page, 'Spent')).toHaveText('€1,155.51');
    await expect(glanceFigure(page, 'Unallocated')).toHaveText('€657.01');
    await expect(budgetRow(page, 'Groceries')).toContainText(/Remaining\s*€336\.69/);
    await expect(budgetRow(page, 'Fun')).toContainText(/Remaining\s*€115\.20/);
    await expect(budgetRow(page, 'Transport')).toContainText(/Remaining\s*€71\.60/);
    await expect(budgetRow(page, 'Home')).toContainText(/Remaining\s*€151\.00/);

    // The server's month view says the same, in cents, and the spendings are ordinary ones.
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.totals.spent).toBe(115551);
    expect(march.unallocated).toBe(65701);
    expect(march.budgets.map(({ name, spent, remaining }) => [name, spent, remaining])).toEqual([
      ['Groceries', 6331, 33669],
      ['Fun', 3480, 11520],
      ['Transport', 840, 7160],
      ['Home', 104900, 15100],
    ]);
    const stored = await json<{ items: SpendingDto[]; total: number }>(
      await wallet.api.get('/api/spendings?month=2026-03&limit=100'),
    );
    expect(stored.total).toBe(11);
    const imported = stored.items.filter((spending) => spending.id > 3);
    expect(imported.map(({ date, amount, description }) => [date, amount, description])).toEqual(
      expect.arrayContaining([
        ['2026-03-02', 4590, 'REWE Markt "Süd" Straße'],
        ['2026-03-03', 104900, 'Möbel Weiß GmbH Küche'],
        ['2026-03-04', 1250, '=1+1'],
        ['2026-03-05', 980, 'CAFÉ DE FLORE'],
        ['2026-03-06', 280, 'Straßenbahn "Ticket" Zone 1'],
        ['2026-03-09', -1999, 'Rückerstattung REWE'],
        ['2026-03-10', 740, 'Mensa Café – Tagesmenü 7,40 €'],
      ]),
    );
    expect(imported).toHaveLength(8);
  });
});

test.describe('a file that was imported before', () => {
  /** What the commit endpoint answers when it refuses rows: 422 and every refused line with its codes. */
  interface Refusal {
    error: { code: string; details: { rows: { line: number; errors: string[] }[] } };
  }

  test('every imported row is flagged, committing it again adds nothing, and a corrected file brings in only its fixed rows', async ({
    page,
    wallet,
  }) => {
    const budgets = await setUpWallet(wallet.api);
    const statement = sparkasseFile('sparkasse-2026-03.csv', MARCH_FILE_ROWS);

    // The first time, straight through the API (the wizard did it in the previous test): the eight
    // good rows go into the budgets of the previous test, the refund among them.
    const imported = [
      { line: 2, budgetId: budgets.groceries.id },
      { line: 3, budgetId: budgets.home.id },
      { line: 4, budgetId: budgets.fun.id },
      { line: 5, budgetId: budgets.fun.id },
      { line: 6, budgetId: budgets.transport.id },
      { line: 7, budgetId: budgets.transport.id },
      { line: 8, budgetId: budgets.groceries.id },
      { line: 10, budgetId: budgets.groceries.id },
    ];
    const csv = sparkasseText(MARCH_FILE_ROWS);
    const first = await wallet.api.post('/api/import/commit', {
      data: { csv, mapping: SPARKASSE_MAPPING, rows: imported },
    });
    expect(await first.json()).toMatchObject({ created: 8 });

    // Spent per budget: Groceries 45.90 + 7.40 - 19.99 = 33.31, Fun 12.50 + 9.80 = 22.30,
    // Transport 2.80 + 2.80 = 5.60, Home 1,049.00. Total 33.31 + 22.30 + 5.60 + 1,049.00 = 1,110.21.
    const before = await getMonth(wallet.api, '2026-03');
    expect(before.budgets.map(({ name, spent }) => [name, spent])).toEqual([
      ['Groceries', 3331],
      ['Fun', 2230],
      ['Transport', 560],
      ['Home', 104900],
    ]);
    expect(before.totals.spent).toBe(111021);

    // The same file, chosen again.
    await openImport(page);
    await chooseFile(page, statement);
    await toColumns(page);
    await chooseColumns(page, {
      date: 'Buchungstag',
      amount: 'Betrag',
      description: 'Verwendungszweck',
      dateFormat: 'DD/MM/YYYY',
      decimal: ',',
    });
    await toReview(page);

    // Every row that was imported says so, the refund too (it is a credit and a duplicate at once).
    // The two rows with errors never had a hash, so they are errors again, not duplicates.
    await expect(reviewCount(page, 'Rows')).toHaveText('10');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('0');
    await expect(reviewCount(page, 'Already imported')).toHaveText('8');
    await expect(reviewCount(page, 'Credits')).toHaveText('1');
    await expect(reviewCount(page, 'With errors')).toHaveText('2');
    for (const { line } of imported) {
      await expect(reviewRow(page, line)).toContainText('Already imported');
      await expect(rowCheckbox(page, line)).toBeDisabled();
      await expect(rowCheckbox(page, line)).not.toBeChecked();
    }
    await expect(reviewRow(page, 9)).not.toContainText('Already imported');
    await expect(reviewRow(page, 11)).not.toContainText('Already imported');

    // Nothing can be ticked, not even with "Tick all shown rows", so there is nothing to import.
    await page.getByRole('button', { name: 'Tick all shown rows', exact: true }).click();
    await expect(page.getByText('0 rows selected of 10.')).toBeVisible();
    await expect(importButton(page)).toBeDisabled();
    await expect(page.getByText('Tick at least one row to import.')).toBeVisible();
    await showRows(page, 'Already imported (8)');
    await expect(review(page).getByRole('row')).toHaveCount(1 + 8); // the header and the eight rows
    await showRows(page, 'Ready to import (0)');
    await expect(page.getByText('No rows match this filter.')).toBeVisible();

    // The wizard has nothing left to send, so ask the server directly: the same lines again are
    // refused as duplicates, all of them together, and nothing is stored.
    const again = await wallet.api.post('/api/import/commit', {
      data: { csv, mapping: SPARKASSE_MAPPING, rows: imported },
      failOnStatusCode: false,
    });
    expect(again.status()).toBe(422);
    const refusal = (await again.json()) as Refusal;
    expect(refusal.error.code).toBe('import_rows_rejected');
    expect(refusal.error.details.rows).toEqual(
      imported.map(({ line }) => ({ line, errors: ['duplicate'] })),
    );
    const afterRefusal = await json<{ total: number }>(await wallet.api.get('/api/spendings'));
    expect(afterRefusal.total).toBe(8);
    expect(await getMonth(wallet.api, '2026-03')).toEqual(before);

    // The person fixes the two bad rows in the bank's file (the 31st of February becomes the 30th of
    // March, "-abc" becomes 61.15) and chooses it. Going back to the first step keeps nothing of the
    // old file, so the columns are chosen again.
    const corrected = sparkasseFile(
      'sparkasse-2026-03-corrected.csv',
      MARCH_FILE_ROWS.map((row) =>
        row === MARCH_ROWS.badDate
          ? '30/03/2026;30/03/2026;-5,00;Bäckerei Müller;1.892,19'
          : row === MARCH_ROWS.badAmount
            ? '11/03/2026;11/03/2026;-61,15;Tankstelle Aral;1.884,79'
            : row,
      ),
    );
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: "Choose your bank's file" })).toBeVisible();
    await chooseFile(page, corrected);
    await toColumns(page);
    await chooseColumns(page, {
      date: 'Buchungstag',
      amount: 'Betrag',
      description: 'Verwendungszweck',
      dateFormat: 'DD/MM/YYYY',
      decimal: ',',
    });
    await toReview(page);

    // The eight rows keep their hash (it does not depend on the rows around them), so they are
    // still flagged. The two that were broken are new.
    await expect(reviewCount(page, 'Ready to import')).toHaveText('2');
    await expect(reviewCount(page, 'Already imported')).toHaveText('8');
    await expect(reviewCount(page, 'With errors')).toHaveText('0');
    await expect(reviewRow(page, 9)).toContainText('Mar 30, 2026');
    await expect(reviewRow(page, 11)).toContainText('€61.15');
    await pickBudget(page, 9, 'Groceries');
    await pickBudget(page, 11, 'Transport');
    // 5.00 + 61.15 = 66.15.
    await expect(page.getByText('2 rows selected of 10.')).toBeVisible();
    await expect(page.getByText(/Together\s*€66\.15/)).toBeVisible();
    await importButton(page).click();
    await expectImported(page, 2);

    // Groceries 33.31 + 5.00 = 38.31 (remaining 361.69), Transport 5.60 + 61.15 = 66.75 (remaining
    // 80.00 - 66.75 = 13.25), Fun and Home as before. Total 1,110.21 + 66.15 = 1,176.36.
    const after = await getMonth(wallet.api, '2026-03');
    expect(after.budgets.map(({ name, spent, remaining }) => [name, spent, remaining])).toEqual([
      ['Groceries', 3831, 36169],
      ['Fun', 2230, 12770],
      ['Transport', 6675, 1325],
      ['Home', 104900, 15100],
    ]);
    expect(after.totals.spent).toBe(117636);
    const stored = await json<{ total: number }>(await wallet.api.get('/api/spendings'));
    expect(stored.total).toBe(10);
  });

  test('an imported spending is an ordinary one: editing it keeps its row imported and deleting it frees the row', async ({
    page,
    wallet,
  }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 250000 });
    const groceries = await createBudget(wallet.api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    // A spending that was typed in by hand has no hash, so a file row that looks just like it is
    // still new (and would make a second copy).
    const byHand = await addSpending(wallet.api, {
      date: '2026-03-05',
      amount: 320,
      budgetId: groceries.id,
      description: 'Kiosk',
    });
    const rows = [
      '2026-03-02,-25.00,Lidl',
      '2026-03-03,-14.50,Pharmacy',
      '2026-03-04,-9.99,Bakery',
      '2026-03-05,-3.20,Kiosk',
    ];
    const csv = simpleText(rows);
    const commit = await wallet.api.post('/api/import/commit', {
      data: {
        csv,
        mapping: SIMPLE_MAPPING,
        rows: [2, 3, 4].map((line) => ({ line, budgetId: groceries.id })),
      },
    });
    const { items } = (await commit.json()) as { items: { line: number; id: number }[] };
    const [lidl, pharmacy, bakery] = items.map(({ id }) => id);
    expect(items.map(({ line }) => line)).toEqual([2, 3, 4]);
    expect(byHand.id).toBe(1);
    expect([lidl, pharmacy, bakery]).toEqual([2, 3, 4]);

    // Edited by hand: the amount, the description and the date. Deleted: the Pharmacy.
    await wallet.api.patch(`/api/spendings/${lidl}`, {
      data: { amount: 2600, description: 'Lidl (corrected by hand)', date: '2026-03-06' },
    });
    await wallet.api.delete(`/api/spendings/${pharmacy}`);

    await openImport(page);
    await chooseFile(page, simpleFile('bank.csv', rows));
    await toColumns(page);
    await chooseColumns(page, { date: 'Date', amount: 'Amount', description: 'Description' });
    await toReview(page);

    // Lidl was edited and is still imported (it keeps its hash), the Pharmacy is free to import
    // again, the Bakery is untouched, and the Kiosk row is new because the hand-made spending that
    // looks like it never had a hash.
    await expect(reviewCount(page, 'Already imported')).toHaveText('2');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('2');
    await expect(reviewRow(page, 2)).toContainText('Already imported');
    await expect(reviewRow(page, 3)).not.toContainText('Already imported');
    await expect(reviewRow(page, 4)).toContainText('Already imported');
    await expect(reviewRow(page, 5)).not.toContainText('Already imported');
    await pickBudget(page, 3, 'Groceries');
    await pickBudget(page, 5, 'Groceries');
    await importButton(page).click();
    await expectImported(page, 2);

    // Hand-made Kiosk 3.20, Lidl 26.00 (edited), Bakery 9.99 and, new, Pharmacy 14.50 and a second
    // Kiosk 3.20: 3.20 + 26.00 + 9.99 + 14.50 + 3.20 = 56.89 in five spendings.
    const month = await getMonth(wallet.api, '2026-03');
    expect(month.totals.spent).toBe(5689);
    const stored = await json<{ total: number; items: SpendingDto[] }>(
      await wallet.api.get('/api/spendings?limit=100'),
    );
    expect(stored.total).toBe(5);
    expect(stored.items.map(({ description }) => description).sort()).toEqual([
      'Bakery',
      'Kiosk',
      'Kiosk',
      'Lidl (corrected by hand)',
      'Pharmacy',
    ]);
  });
});

test.describe('saved mapping profiles', () => {
  const statementA = [
    '02/03/2026;02/03/2026;-15,80;Bäckerei Schmidt;984,20',
    '03/03/2026;03/03/2026;-1.234,50;Küchenstudio Nord;0,00',
  ];
  const statementB = [
    '04/03/2026;04/03/2026;-22,05;Metzgerei Böhm;2.000,00',
    '05/03/2026;05/03/2026;-7,00;Zeitschriften Kiosk;1.993,00',
  ];
  const statementC = ['06/03/2026;06/03/2026;-31,40;Wochenmarkt;1.961,60'];

  async function twoBudgets(api: Parameters<typeof onboard>[0]) {
    await onboard(api, { startMonth: '2026-03', salary: 250000 });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    const home = await createBudget(api, { name: 'Home', amount: 150000, incremental: false });
    return { groceries, home };
  }

  /** The mapping step as the saved profile fills it in: what each select shows. */
  async function expectSparkasseMapping(page: Page): Promise<void> {
    await expect(page.getByLabel('Delimiter')).toHaveValue(';');
    await expect(page.getByRole('checkbox', { name: /First row is a header/ })).toBeChecked();
    await expect(page.getByLabel('Date column')).toHaveValue('0');
    await expect(page.getByLabel('Amount column')).toHaveValue('2');
    await expect(page.getByLabel('Description column')).toHaveValue('3');
    await expect(page.getByLabel('Date format')).toHaveValue('DD/MM/YYYY');
    await expect(page.getByLabel('Decimal separator')).toHaveValue(',');
    await expect(page.getByLabel('Sign of an expense')).toHaveValue('expenses_negative');
    await expect(page.getByRole('button', { name: 'Next: review the rows' })).toBeEnabled();
  }

  test('a mapping is saved with the first import, applies itself to the next file of the bank and can be chosen for another', async ({
    page,
    wallet,
  }) => {
    await twoBudgets(wallet.api);
    await openImport(page);

    // The first file: nothing is saved yet, so the columns are chosen by hand and then saved.
    await chooseFile(page, sparkasseFile('giro-1.csv', statementA));
    await toColumns(page);
    await expect(page.getByLabel('Saved profile')).toHaveValue('');
    await expect(page.getByLabel('Saved profile')).toContainText('None: set the columns below');
    await chooseColumns(page, {
      date: 'Buchungstag',
      amount: 'Betrag',
      description: 'Verwendungszweck',
      dateFormat: 'DD/MM/YYYY',
      decimal: ',',
    });
    await page.getByText('Save these settings as a profile').click();
    await page.getByLabel('Profile name').fill('Sparkasse Giro');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(
      page.getByText(
        'Profile "Sparkasse Giro" saved. The next file with the same column titles will use it.',
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Saved profile').locator('option:checked')).toHaveText(
      'Sparkasse Giro',
    );
    await toReview(page);
    await pickBudget(page, 2, 'Groceries');
    await pickBudget(page, 3, 'Home');
    await importButton(page).click();
    await expectImported(page, 2);

    // The server kept what was saved, with the titles of the columns it needs to recognise the bank.
    const saved = await json<
      { id: number; name: string; mapping: unknown; header: string[] | null }[]
    >(await wallet.api.get('/api/import/profiles'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Sparkasse Giro', mapping: SPARKASSE_MAPPING });
    expect(saved[0]?.header?.slice(0, 4)).toEqual([
      'buchungstag',
      'wertstellung',
      'betrag',
      'verwendungszweck',
    ]);

    // The next statement of the same bank: its titles match, so the app applies the profile by
    // itself and says so. Nothing is chosen by hand, and the next step is open at once.
    await page.getByRole('button', { name: 'Import another file' }).click();
    await chooseFile(page, sparkasseFile('giro-2.csv', statementB));
    await toColumns(page);
    await expect(
      page.getByText(
        'This file looks like your "Sparkasse Giro" profile, so its columns and formats are filled in.',
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Saved profile').locator('option:checked')).toHaveText(
      'Sparkasse Giro',
    );
    await expectSparkasseMapping(page);
    await toReview(page);
    // Read the way the profile says (dd/mm/yyyy, decimal comma): the 4th of March, 22.05.
    await expect(reviewRow(page, 2)).toContainText('Mar 4, 2026');
    await expect(reviewRow(page, 2)).toContainText('€22.05');
    await expect(reviewRow(page, 3)).toContainText('Mar 5, 2026');
    await expect(reviewRow(page, 3)).toContainText('€7.00');
    // Metzgerei and Kiosk were never spent on, so the budget is for the person to say.
    await pickBudget(page, 2, 'Groceries');
    await pickBudget(page, 3, 'Groceries');
    await importButton(page).click();
    await expectImported(page, 2);

    // A file whose titles differ (the same layout with English headings) is not recognised: no
    // notice, nothing filled in. The person picks the profile, and it is applied.
    await page.getByRole('button', { name: 'Import another file' }).click();
    await chooseFile(page, sparkasseFile('giro-3.csv', statementC, SPARKASSE_ENGLISH_HEADER));
    await toColumns(page);
    await expect(page.getByLabel('Saved profile')).toHaveValue('');
    await expect(page.getByText(/looks like your/)).toHaveCount(0);
    await expect(page.getByLabel('Date column')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Next: review the rows' })).toBeDisabled();
    await page.getByLabel('Saved profile').selectOption({ label: 'Sparkasse Giro' });
    await expect(
      page.getByText(
        'Profile "Sparkasse Giro" applied. Check the columns against the first rows below.',
      ),
    ).toBeVisible();
    await expectSparkasseMapping(page);
    await toReview(page);
    await expect(reviewRow(page, 2)).toContainText('€31.40');
    await pickBudget(page, 2, 'Groceries');
    await importButton(page).click();
    await expectImported(page, 1);

    // Groceries 15.80 + 22.05 + 7.00 + 31.40 = 76.25, Home 1,234.50, five spendings in all.
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.budgets.map(({ name, spent }) => [name, spent])).toEqual([
      ['Groceries', 7625],
      ['Home', 123450],
    ]);
  });

  test('profiles are renamed and deleted from the wizard, a name is unique ignoring case, and a deleted one is no longer applied', async ({
    page,
    wallet,
    browserErrors,
  }) => {
    // The clash below is a 409 that the app is expected to show on the field.
    browserErrors.allow({ text: /status of 409/, url: /\/api\/import\/profiles\/\d+$/ });
    await twoBudgets(wallet.api);
    const header = SPARKASSE_HEADER.split(';');
    await wallet.api.post('/api/import/profiles', {
      data: { name: 'Sparkasse Giro', mapping: SPARKASSE_MAPPING, header },
    });
    await wallet.api.post('/api/import/profiles', {
      data: { name: 'Postbank', mapping: SPARKASSE_MAPPING },
    });

    await openImport(page);
    await chooseFile(page, sparkasseFile('giro-2.csv', statementB));
    await toColumns(page);
    await expect(page.getByLabel('Saved profile').locator('option:checked')).toHaveText(
      'Sparkasse Giro',
    );

    await page.getByRole('button', { name: 'Manage profiles' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import profiles' });
    // Listed by name, ignoring case: Postbank before Sparkasse Giro.
    await expect(dialog.getByRole('listitem')).toHaveText([/Postbank/, /Sparkasse Giro/]);

    // A name that another profile has, in other letters, is refused and says so on the field.
    await dialog.getByRole('button', { name: 'Rename profile Sparkasse Giro' }).click();
    await dialog.getByLabel('New name for Sparkasse Giro').fill('POSTBANK');
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(
      dialog.getByText('Another import profile is already called "Postbank"'),
    ).toBeVisible();
    await expect(dialog.getByLabel('New name for Sparkasse Giro')).toBeVisible();

    // A free name works, and the picker behind the dialog shows it.
    await dialog.getByLabel('New name for Sparkasse Giro').fill('Sparkasse Girokonto');
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByText('Profile renamed to Sparkasse Girokonto.')).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([/Postbank/, /Sparkasse Girokonto/]);
    const renamed = await json<{ name: string; mapping: unknown; header: string[] | null }[]>(
      await wallet.api.get('/api/import/profiles'),
    );
    expect(renamed.map(({ name }) => name)).toEqual(['Postbank', 'Sparkasse Girokonto']);
    // Renaming replaces the profile with the same mapping and the same titles: it still matches.
    expect(renamed[1]).toMatchObject({ mapping: SPARKASSE_MAPPING });
    expect(renamed[1]?.header).toHaveLength(5);

    // Deleting asks first. Cancelling keeps it, confirming removes it.
    await dialog.getByRole('button', { name: 'Delete profile Postbank' }).click();
    const confirm = page.getByRole('dialog', { name: /^Delete the profile "/ });
    await expect(confirm).toHaveAccessibleName('Delete the profile "Postbank"?');
    await expect(confirm).toContainText('Nothing you imported changes.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Delete profile Postbank' }).click();
    await confirm.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await expect(page.getByText('Profile Postbank deleted.')).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([/Sparkasse Girokonto/]);

    // Deleting the one in use takes it off the picker. The columns on the page stay as they are, so
    // the person can still go on with this file.
    await dialog.getByRole('button', { name: 'Delete profile Sparkasse Girokonto' }).click();
    await confirm.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await expect(page.getByText('Profile Sparkasse Girokonto deleted.')).toBeVisible();
    await expect(dialog.getByText('No profiles yet')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Saved profile')).toHaveValue('');
    await expectSparkasseMapping(page);
    expect(await json<unknown[]>(await wallet.api.get('/api/import/profiles'))).toEqual([]);

    // A new file of the same bank is not recognised any more.
    await page.getByRole('button', { name: 'Back' }).click();
    await chooseFile(page, sparkasseFile('giro-2.csv', statementB));
    await toColumns(page);
    await expect(page.getByText(/looks like your/)).toHaveCount(0);
    await expect(page.getByLabel('Date column')).toHaveValue('');

    // Nothing that was imported depends on a profile: there is no spending here and none was lost.
    expect((await json<{ total: number }>(await wallet.api.get('/api/spendings'))).total).toBe(0);
  });
});

test.describe('importing into closed and current months', () => {
  test('rows dated in a closed month change what is due to savings, rows in the current month change only the budgets', async ({
    page,
    wallet,
  }) => {
    // February is closed and March is the current month. February's salary is 2,500.00 and its
    // budgets 400.00 (Groceries, leftovers go to savings) and 100.00 (Fun, carried over).
    await onboard(wallet.api, {
      startMonth: '2026-02',
      salary: 250000,
      openingSavings: 100000,
      budgets: [
        { name: 'Groceries', amount: 40000, incremental: false },
        { name: 'Fun', amount: 10000, incremental: true },
      ],
    });

    // Before: February is due 2,500.00 - 400.00 - 100.00 = 2,000.00 unallocated, plus the whole 400.00
    // of Groceries (Fun's 100.00 is carried into March, so none of it is due) = 2,400.00.
    const february = await getMonth(wallet.api, '2026-02');
    expect(february.status).toBe('closed');
    expect(february.savingsDue.total).toBe(240000);
    await page.goto('/dashboard');
    const toMove = page.getByRole('region', { name: 'Savings to move' });
    await expect(toMove).toContainText('+€2,400.00');
    await expect(toMove).toContainText('1 month to settle. Move this to savings.');
    await page.getByRole('link', { name: /^Savings/ }).click();
    await expect(page.getByText('February 2026: move €2,400.00 to savings')).toBeVisible();

    // A card export with no header row: ISO dates, a dot, expenses as positive numbers, a BOM.
    const file = utf8Upload(
      'card.csv',
      csvText([
        '2026-02-03,45.00,Lidl Wien',
        '2026-02-14,30.00,Restaurant Zur Post',
        '2026-02-20,12.00,Kino',
        '2026-03-04,20.00,Lidl Wien',
        '2026-01-15,9.99,Too early',
      ]),
      { bom: true },
    );
    await openImport(page);
    await chooseFile(page, file);
    await expect(page.getByText('5 (the first one may be a header)')).toBeVisible();
    await toColumns(page);
    // The first row is data: say so, and the columns are named after what the first row holds.
    await page.getByText('First row is a header', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /First row is a header/ })).not.toBeChecked();
    await chooseColumns(page, {
      date: 'Column 1: 2026-02-03',
      amount: 'Column 2: 45.00',
      description: 'Column 3: Lidl Wien',
      sign: 'expenses_positive',
    });
    await expect(page.getByText('The file has 5 data rows.')).toBeVisible();
    await toReview(page);

    // A date before the start month is an error like any fact before it, and cannot be imported.
    await expect(reviewCount(page, 'Rows')).toHaveText('5');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('4');
    await expect(reviewCount(page, 'With errors')).toHaveText('1');
    await expect(reviewRow(page, 5)).toContainText('The date is before your start month');
    await expect(rowCheckbox(page, 5)).toBeDisabled();
    await pickBudget(page, 1, 'Groceries');
    await pickBudget(page, 2, 'Groceries');
    await pickBudget(page, 3, 'Fun');
    await pickBudget(page, 4, 'Groceries');
    // 45.00 + 30.00 + 12.00 + 20.00 = 107.00.
    await expect(page.getByText(/Together\s*€107\.00/)).toBeVisible();
    await importButton(page).click();
    await expectImported(page, 4);
    // The months the rows are dated in get a link each, the closed one first.
    await expect(page.getByRole('link', { name: 'February 2026' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'March 2026' })).toBeVisible();

    // February: Groceries 45.00 + 30.00 = 75.00 spent, 325.00 left, which is due to savings. Fun
    // spent 12.00 and carries the remaining 88.00. Due: 2,000.00 + 325.00 = 2,325.00, which is
    // 75.00 less than before. Nothing was settled, so all of it is outstanding.
    const after = await getMonth(wallet.api, '2026-02');
    expect(
      after.budgets.map(({ name, spent, remaining, carriedOut, toSavings }) => [
        name,
        spent,
        remaining,
        carriedOut,
        toSavings,
      ]),
    ).toEqual([
      ['Groceries', 7500, 32500, 0, 32500],
      ['Fun', 1200, 8800, 8800, 0],
    ]);
    expect(after.savingsDue.total).toBe(232500);
    const savings = await getSavings(wallet.api);
    expect(savings.outstanding).toMatchObject([
      {
        month: '2026-02',
        savingsDue: 232500,
        settled: 0,
        outstanding: 232500,
        direction: 'move',
        adjustment: false,
      },
    ]);
    await page.goto('/dashboard');
    await expect(page.getByRole('region', { name: 'Savings to move' })).toContainText('+€2,325.00');
    await page.getByRole('link', { name: /^Savings/ }).click();
    await expect(page.getByText('February 2026: move €2,325.00 to savings')).toBeVisible();

    // March, the current month: Groceries 20.00 spent. Fun's available is its 100.00 plus the 88.00
    // carried in. The income and the allocations are what they were, so unallocated is 2,000.00 and
    // nothing of March is due to savings yet (it is not closed).
    const march = await getMonth(wallet.api, '2026-03');
    expect(march.status).toBe('current');
    expect(
      march.budgets.map(({ name, carriedIn, available, spent, remaining }) => [
        name,
        carriedIn,
        available,
        spent,
        remaining,
      ]),
    ).toEqual([
      ['Groceries', 0, 40000, 2000, 38000],
      ['Fun', 8800, 18800, 0, 18800],
    ]);
    expect(march.unallocated).toBe(200000);
    expect(savings.outstanding.map(({ month }) => month)).toEqual(['2026-02']);

    // The person moves February's 2,325.00 to savings and ticks it off.
    await settleMonth(wallet.api, '2026-02');
    expect((await getSavings(wallet.api)).balance).toBe(332500); // 1,000.00 + 2,325.00
    expect((await getSavings(wallet.api)).outstanding).toEqual([]);

    // A forgotten spending of February arrives in a later file, together with one of March.
    const late = simpleFile('late.csv', [
      '2026-02-25,-15.00,Bakery Mayer',
      '2026-03-08,-4.00,Bakery Mayer',
    ]);
    await openImport(page);
    await chooseFile(page, late);
    await toColumns(page);
    await chooseColumns(page, { date: 'Date', amount: 'Amount', description: 'Description' });
    await toReview(page);
    await pickBudget(page, 2, 'Groceries');
    await pickBudget(page, 3, 'Groceries');
    await importButton(page).click();
    await expectImported(page, 2);

    // February was settled at 2,325.00 and is now due 2,310.00 (Groceries has 310.00 left): the
    // difference is a correction of 15.00 to take from savings. March only spent 4.00 more.
    await page.getByRole('link', { name: /^Savings/ }).click();
    await expect(page.getByText('February 2026: take €15.00 more from savings')).toBeVisible();
    await expect(page.getByText('You settled this month before.')).toBeVisible();
    await expect(
      page.getByText('1 month to settle. In total: take €15.00 from savings.'),
    ).toBeVisible();
    const corrected = await getSavings(wallet.api);
    expect(corrected.balance).toBe(332500); // nothing moved until the person settles the correction
    expect(corrected.outstandingTotal).toBe(-1500);
    expect(corrected.outstanding).toEqual([
      {
        month: '2026-02',
        savingsDue: 231000,
        settled: 232500,
        outstanding: -1500,
        direction: 'take',
        breakdown: { unallocated: 200000, budgetsSettled: 31000, reservesReleased: 0 },
        adjustment: true,
      },
    ]);
    const marchAgain = await getMonth(wallet.api, '2026-03');
    expect(marchAgain.budgets[0]).toMatchObject({
      name: 'Groceries',
      spent: 2400,
      remaining: 37600,
    });
    expect(marchAgain.unallocated).toBe(200000);
  });
});

/** The file a download link gave: its name, its bytes and where the browser put it. */
async function download(page: Page, link: Locator) {
  const [downloaded] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const path = await downloaded.path();
  return { filename: downloaded.suggestedFilename(), path, bytes: await readFile(path) };
}

/** The text of an export without its byte order mark, which the caller has checked. */
function exportBody(bytes: Buffer): string {
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  expect(text.startsWith('﻿')).toBe(true);
  return text.slice(1);
}

const SPENDINGS_HEADER = 'id,date,amount,budget,description,notes,tags';

/**
 * A wallet with spendings that are awkward to write as CSV: quotes and a comma, a formula, a plus, a
 * minus, an at sign, a semicolon, a refund, a cent, a million, tags. Created out of date order on
 * purpose, so that the export's order (by date, then id) is visible. March 2026 is the first month.
 */
async function setUpExportState(api: Parameters<typeof onboard>[0]) {
  await onboard(api, { startMonth: '2026-03', salary: 250000, openingSavings: 100000 });
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 15000, incremental: true });
  const weekly = await json<TagDto>(await api.post('/api/tags', { data: { name: 'weekly' } }));
  const treat = await json<TagDto>(await api.post('/api/tags', { data: { name: 'treat' } }));
  const spend = (input: Parameters<typeof addSpending>[1]) => addSpending(api, input);
  await spend({ date: '2026-03-06', amount: 1250, budgetId: fun.id, description: '=1+1' }); // 1
  await spend({
    date: '2026-03-02',
    amount: 4590,
    budgetId: groceries.id,
    description: 'REWE Markt "Süd" Straße',
    notes: 'weekly shop, big',
    tagIds: [weekly.id],
  }); // 2
  await spend({
    date: '2026-03-06',
    amount: -1999,
    budgetId: groceries.id,
    description: 'Rückerstattung REWE',
  }); // 3
  await spend({
    date: '2026-03-05',
    amount: 5,
    budgetId: fun.id,
    description: '+49 roaming',
    notes: '@boss;=cmd',
  }); // 4
  await spend({
    date: '2026-03-08',
    amount: 123456789,
    budgetId: groceries.id,
    description: 'Shop;=cmd',
  }); // 5
  await spend({
    date: '2026-03-03',
    amount: 100000,
    budgetId: fun.id,
    description: '-minus start',
    tagIds: [weekly.id, treat.id],
  }); // 6
  return { groceries, fun, weekly, treat, spend };
}

test.describe('CSV export', () => {
  test('spendings.csv has a byte order mark, a header, exact amounts and cells that a spreadsheet will not run', async ({
    page,
    wallet,
  }) => {
    const { groceries, spend } = await setUpExportState(wallet.api);
    // 7: no description at all (the API allows it): an empty cell.
    await spend({ date: '2026-03-07', amount: 1230, budgetId: groceries.id });

    await page.goto('/settings');
    const exportSection = page.getByRole('region', { name: 'Export' });
    await expect(exportSection).toBeVisible();
    const all = await download(
      page,
      exportSection.getByRole('link', { name: 'Download spendings CSV' }),
    );
    expect(all.filename).toBe('wallet-spendings-all.csv');

    // Ordered by date, then id. Amounts are decimal text built from cents: no thousands separator,
    // always two digits, a refund keeps its minus (an amount is a number, never guarded). A cell is
    // quoted only when it needs it (a quote, a comma), with the quotes doubled. A text cell that
    // begins with = + - or @ gets a ' in front, and so does the text right after a ; inside a cell.
    expect(exportBody(all.bytes)).toBe(
      csvText([
        SPENDINGS_HEADER,
        '2,2026-03-02,45.90,Groceries,"REWE Markt ""Süd"" Straße","weekly shop, big",weekly',
        "6,2026-03-03,1000.00,Fun,'-minus start,,treat|weekly",
        "4,2026-03-05,0.05,Fun,'+49 roaming,'@boss;'=cmd,",
        "1,2026-03-06,12.50,Fun,'=1+1,,",
        '3,2026-03-06,-19.99,Groceries,Rückerstattung REWE,,',
        '7,2026-03-07,12.30,Groceries,,,',
        "5,2026-03-08,1234567.89,Groceries,Shop;'=cmd,,",
      ]),
    );
    // Every record ends with CRLF, the last one too, and there is no bare line feed anywhere.
    expect(all.bytes.toString('utf8').endsWith('\r\n')).toBe(true);
    expect(all.bytes.toString('utf8').replaceAll('\r\n', '')).not.toContain('\n');

    // The same bytes come from the API, with the headers that make a browser save a file.
    const direct = await wallet.api.get('/api/export/spendings.csv');
    expect(direct.headers()['content-type']).toBe('text/csv; charset=utf-8');
    expect(direct.headers()['content-disposition']).toBe(
      'attachment; filename="wallet-spendings-all.csv"',
    );
    expect(direct.headers()['cache-control']).toBe('no-store');
    expect(Buffer.compare(await direct.body(), all.bytes)).toBe(0);

    // A range: both ends count. 3 to 6 March keeps the rows of the 3rd, 5th and 6th (two of them).
    await exportSection.getByLabel('From').fill('2026-03-03');
    await exportSection.getByLabel('To').fill('2026-03-06');
    const link = exportSection.getByRole('link', { name: 'Download spendings CSV' });
    await expect(link).toHaveAttribute(
      'href',
      '/api/export/spendings.csv?from=2026-03-03&to=2026-03-06',
    );
    const ranged = await download(page, link);
    expect(ranged.filename).toBe('wallet-spendings-2026-03-03_to_2026-03-06.csv');
    expect(exportBody(ranged.bytes)).toBe(
      csvText([
        SPENDINGS_HEADER,
        "6,2026-03-03,1000.00,Fun,'-minus start,,treat|weekly",
        "4,2026-03-05,0.05,Fun,'+49 roaming,'@boss;'=cmd,",
        "1,2026-03-06,12.50,Fun,'=1+1,,",
        '3,2026-03-06,-19.99,Groceries,Rückerstattung REWE,,',
      ]),
    );

    // One bound only: everything from the 7th, and everything up to the 2nd (the 2nd is in).
    await exportSection.getByLabel('To').fill('');
    await exportSection.getByLabel('From').fill('2026-03-07');
    const fromOnly = await download(page, link);
    expect(fromOnly.filename).toBe('wallet-spendings-from-2026-03-07.csv');
    expect(exportBody(fromOnly.bytes)).toBe(
      csvText([
        SPENDINGS_HEADER,
        '7,2026-03-07,12.30,Groceries,,,',
        "5,2026-03-08,1234567.89,Groceries,Shop;'=cmd,,",
      ]),
    );
    await exportSection.getByLabel('From').fill('');
    await exportSection.getByLabel('To').fill('2026-03-02');
    const toOnly = await download(page, link);
    expect(toOnly.filename).toBe('wallet-spendings-until-2026-03-02.csv');
    expect(exportBody(toOnly.bytes)).toBe(
      csvText([
        SPENDINGS_HEADER,
        '2,2026-03-02,45.90,Groceries,"REWE Markt ""Süd"" Straße","weekly shop, big",weekly',
      ]),
    );

    // A range with nothing in it is still a file: the byte order mark and the header row.
    await exportSection.getByLabel('From').fill('2026-02-01');
    await exportSection.getByLabel('To').fill('2026-02-28');
    const empty = await download(page, link);
    expect(empty.filename).toBe('wallet-spendings-2026-02-01_to_2026-02-28.csv');
    expect(exportBody(empty.bytes)).toBe(csvText([SPENDINGS_HEADER]));

    // A range that ends before it starts turns the links off and says why. Nothing is requested.
    await exportSection.getByLabel('From').fill('2026-03-09');
    await exportSection.getByLabel('To').fill('2026-03-01');
    await expect(
      exportSection.getByText(
        '"From" is after "To". Choose a From date that is on or before the To date.',
      ),
    ).toBeVisible();
    await expect(exportSection.getByRole('link', { name: /^Download .* CSV$/ })).toHaveCount(0);
    await expect(exportSection.getByRole('button', { name: /^Download .* CSV$/ })).toHaveCount(3);
    for (const button of await exportSection
      .getByRole('button', { name: /^Download .* CSV$/ })
      .all()) {
      await expect(button).toBeDisabled();
    }
    const refused = await wallet.api.get(
      '/api/export/spendings.csv?from=2026-03-09&to=2026-03-01',
      {
        failOnStatusCode: false,
      },
    );
    expect(refused.status()).toBe(400);
  });

  test('incomes.csv and savings.csv guard their text cells too and write amounts as signed decimals', async ({
    wallet,
  }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 250000, openingSavings: 100000 });
    await addIncome(wallet.api, { date: '2026-03-05', amount: 50000, description: '=SUM(A1:A9)' });
    await addIncome(wallet.api, {
      date: '2026-03-02',
      amount: 1,
      description: 'Cashback, "April"',
    });
    const goal = await createGoal(wallet.api, { name: '@Holiday', targetAmount: 300000 });
    await wallet.api.post('/api/savings/transactions', {
      data: { kind: 'deposit', amount: 25000, goalId: goal.id, date: '2026-03-04', note: '+bonus' },
    });
    await wallet.api.post('/api/savings/transactions', {
      data: { kind: 'withdrawal', amount: 1005, goalId: goal.id, date: '2026-03-06' },
    });

    // Income: the salary is not a row. Ordered by date, then id; the text is guarded or quoted.
    const incomes = await wallet.api.get('/api/export/incomes.csv');
    expect(exportBody(await incomes.body())).toBe(
      csvText([
        'id,date,amount,description',
        '2,2026-03-02,0.01,"Cashback, ""April"""',
        "1,2026-03-05,500.00,'=SUM(A1:A9)",
      ]),
    );

    // Savings: every kind, the withdrawal negative, a missing goal or note an empty cell.
    const savings = await wallet.api.get('/api/export/savings.csv');
    expect(exportBody(await savings.body())).toBe(
      csvText([
        'id,date,kind,amount,goal_id,goal,settles_month,note,group_id',
        '1,2026-03-01,opening,1000.00,,,,,',
        `2,2026-03-04,deposit,250.00,${goal.id},'@Holiday,,'+bonus,`,
        `3,2026-03-06,withdrawal,-10.05,${goal.id},'@Holiday,,,`,
      ]),
    );
  });

  test('exporting spendings and importing that file into a fresh wallet gives the same month, minus a spending with no description', async ({
    page,
    wallet,
    servers,
  }) => {
    await setUpExportState(wallet.api);

    // A fresh wallet with the same start month, salary and budgets.
    const fresh = await servers.start();
    await onboard(fresh.api, { startMonth: '2026-03', salary: 250000, openingSavings: 100000 });
    await createBudget(fresh.api, { name: 'Groceries', amount: 40000, incremental: false });
    await createBudget(fresh.api, { name: 'Fun', amount: 15000, incremental: true });

    // Spent in March: Groceries 45.90 - 19.99 + 1,234,567.89 = 1,234,593.80 and Fun
    // 12.50 + 0.05 + 1,000.00 = 1,012.55. The same figures must come out of the other wallet.
    const original = await getMonth(wallet.api, '2026-03');
    expect(original.budgets.map(({ name, spent, remaining }) => [name, spent, remaining])).toEqual([
      ['Groceries', 123459380, -123419380],
      ['Fun', 101255, -86255],
    ]);
    expect(original.totals.spent).toBe(123560635);
    expect((await getMonth(fresh.api, '2026-03')).totals.spent).toBe(0);

    // Export from Settings, as a person does.
    await page.goto('/settings');
    const exported = await download(
      page,
      page
        .getByRole('region', { name: 'Export' })
        .getByRole('link', { name: 'Download spendings CSV' }),
    );

    // Import that file into the other wallet. The export has its own columns (id, date, amount,
    // budget, description, notes, tags), dates as YYYY-MM-DD, a dot and expenses as positive numbers.
    await page.goto(`${fresh.baseURL}/import`);
    await expect(page.getByRole('heading', { name: "Choose your bank's file" })).toBeVisible();
    await chooseFile(page, exported.path);
    await expect(page.getByText('Comma (,), detected')).toBeVisible();
    await expect(page.getByText('7 (the first one may be a header)')).toBeVisible();
    await toColumns(page);
    await chooseColumns(page, {
      date: 'date',
      amount: 'amount',
      description: 'description',
      sign: 'expenses_positive',
    });
    await toReview(page);

    // Six rows, one of them (the refund, -19.99) is a credit under this sign. No budget is known
    // here, so nothing starts ticked: the person says which budget each row goes to. The file's
    // `budget` column is for reading, the importer does not use it.
    await expect(reviewCount(page, 'Rows')).toHaveText('6');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('5');
    await expect(reviewCount(page, 'Credits')).toHaveText('1');
    await expect(reviewCount(page, 'With errors')).toHaveText('0');
    await expect(page.getByText('0 rows selected of 6.')).toBeVisible();
    // Lines: 2 REWE (Groceries), 3 -minus (Fun), 4 +49 (Fun), 5 =1+1 (Fun), 6 refund (Groceries), 7 Shop (Groceries).
    await expect(reviewRow(page, 5)).toContainText("'=1+1");
    await expect(reviewRow(page, 6)).toContainText('Credit: money in');
    await expect(reviewRow(page, 6)).toContainText('-€19.99');
    await expect(reviewRow(page, 7)).toContainText("Shop;'=cmd");
    await expect(reviewRow(page, 7)).toContainText('€1,234,567.89');
    await rowCheckbox(page, 6).check();
    for (const [line, budget] of [
      [2, 'Groceries'],
      [3, 'Fun'],
      [4, 'Fun'],
      [5, 'Fun'],
      [6, 'Groceries'],
      [7, 'Groceries'],
    ] as const) {
      await pickBudget(page, line, budget);
    }
    // 45.90 + 1,000.00 + 0.05 + 12.50 - 19.99 + 1,234,567.89 = 1,235,606.35.
    await expect(page.getByText(/Together\s*€1,235,606\.35/)).toBeVisible();
    await importButton(page).click();
    await expectImported(page, 6);

    // The same month, to the cent: every figure of the two month views is equal.
    expect(await getMonth(fresh.api, '2026-03')).toEqual(original);

    // What the guard changed comes back as it was written to the file: the text keeps its '.
    await page.goto(`${fresh.baseURL}/spendings?month=2026-03`);
    await expect(spendingItem(page, "'=1+1")).toContainText('€12.50');
    await expect(spendingItem(page, "Shop;'=cmd")).toContainText('€1,234,567.89');
    await expect(spendingItem(page, 'Rückerstattung REWE')).toContainText('-€19.99');
    await expect(page.getByText('6 spendings · €1,235,606.35 net.')).toBeVisible();

    // The one thing that does not come back: a spending with no description. Its cell is empty, so
    // the importer refuses the row. The six others are flagged as imported already (their hash is
    // made from the date, the amount and the text, which are the same in the new file).
    await wallet.api.post('/api/spendings', {
      data: { date: '2026-03-07', amount: 1230, budgetId: 1 },
    });
    const second = await wallet.api.get('/api/export/spendings.csv');
    await page.goto(`${fresh.baseURL}/import`);
    await chooseFile(page, {
      name: 'wallet-spendings-all.csv',
      mimeType: 'text/csv',
      buffer: await second.body(),
    });
    await toColumns(page);
    await chooseColumns(page, {
      date: 'date',
      amount: 'amount',
      description: 'description',
      sign: 'expenses_positive',
    });
    await toReview(page);
    await expect(reviewCount(page, 'Rows')).toHaveText('7');
    await expect(reviewCount(page, 'Already imported')).toHaveText('6');
    await expect(reviewCount(page, 'With errors')).toHaveText('1');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('0');
    await expect(reviewRow(page, 7)).toContainText('The description is empty');
    await expect(rowCheckbox(page, 7)).toBeDisabled();
    await expect(importButton(page)).toBeDisabled();
  });
});
