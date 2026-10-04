import type { Locator, Page } from '@playwright/test';
import type { ImportDateFormat } from '@wallet/shared';
import type { Upload } from './csv-fixtures';
import { expect } from './fixtures';

/*
 * The import wizard (`/import`) as a person drives it: choose the file, say how it is laid out, tick
 * the rows and pick the budgets, import. Each helper does one step and waits for the next page of the
 * wizard to show, so a spec reads as the story of the import and keeps its own assertions for what it
 * is about. Everything is found by role, label and visible text.
 */

/** The option text of the date format select: the format with the 25th of March written in it. */
const DATE_FORMAT_OPTION: Record<ImportDateFormat, string> = {
  'YYYY-MM-DD': 'YYYY-MM-DD (2026-03-25)',
  'YYYY/MM/DD': 'YYYY/MM/DD (2026/03/25)',
  YYYYMMDD: 'YYYYMMDD (20260325)',
  'DD/MM/YYYY': 'DD/MM/YYYY (25/03/2026)',
  'MM/DD/YYYY': 'MM/DD/YYYY (03/25/2026)',
  'DD.MM.YYYY': 'DD.MM.YYYY (25.03.2026)',
  'DD-MM-YYYY': 'DD-MM-YYYY (25-03-2026)',
  'MM-DD-YYYY': 'MM-DD-YYYY (03-25-2026)',
};

export const DECIMAL_OPTION = {
  '.': 'Dot (1,234.56)',
  ',': 'Comma (1.234,56)',
} as const;

export const SIGN_OPTION = {
  expenses_negative: 'Expenses are negative (-12.30 is money spent)',
  expenses_positive: 'Expenses are positive (12.30 is money spent)',
} as const;

export const DELIMITER_OPTION = {
  ',': 'Comma (,)',
  ';': 'Semicolon (;)',
  '\t': 'Tab',
  '|': 'Pipe (|)',
} as const;

/** What a person picks on the "Columns" step. A field that is left out stays as the app set it. */
export interface ColumnChoices {
  /** The name of the column in the header row (or "Column 2: ..." for a file without one). */
  date?: string;
  amount?: string;
  description?: string;
  dateFormat?: ImportDateFormat;
  decimal?: keyof typeof DECIMAL_OPTION;
  sign?: keyof typeof SIGN_OPTION;
}

/** Opens the wizard on its first step. */
export async function openImport(page: Page): Promise<void> {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: "Choose your bank's file" })).toBeVisible();
}

/** Step 1: chooses the file and waits until the server has said what it found in it. */
export async function chooseFile(page: Page, file: Upload | string): Promise<void> {
  await page.getByLabel('CSV file').setInputFiles(file);
  await expect(page.getByText('Rows found')).toBeVisible();
}

/** Step 1 to 2. */
export async function toColumns(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next: choose the columns' }).click();
  await expect(page.getByRole('heading', { name: 'How is the file laid out?' })).toBeVisible();
}

/** Step 2: the selects, as a person sets them. */
export async function chooseColumns(page: Page, choices: ColumnChoices): Promise<void> {
  if (choices.date) await page.getByLabel('Date column').selectOption({ label: choices.date });
  if (choices.amount)
    await page.getByLabel('Amount column').selectOption({ label: choices.amount });
  if (choices.description) {
    await page.getByLabel('Description column').selectOption({ label: choices.description });
  }
  if (choices.dateFormat) {
    await page
      .getByLabel('Date format')
      .selectOption({ label: DATE_FORMAT_OPTION[choices.dateFormat] });
  }
  if (choices.decimal) {
    await page
      .getByLabel('Decimal separator')
      .selectOption({ label: DECIMAL_OPTION[choices.decimal] });
  }
  if (choices.sign) {
    await page.getByLabel('Sign of an expense').selectOption({ label: SIGN_OPTION[choices.sign] });
  }
}

/** Step 2 to 3. */
export async function toReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next: review the rows' }).click();
  await expect(page.getByRole('heading', { name: 'Review the rows' })).toBeVisible();
}

/** The review step as a whole. */
export function review(page: Page): Locator {
  return page.getByRole('region', { name: 'Review the rows' });
}

/** One of the five counts above the table ("Rows", "Ready to import", "Already imported", "Credits", "With errors"). */
export function reviewCount(page: Page, label: string): Locator {
  return review(page)
    .locator('dl > div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .getByRole('definition');
}

/** The row of the table that starts on this line of the file. */
export function reviewRow(page: Page, line: number): Locator {
  return page.getByRole('row').filter({ has: page.getByText(`Line ${line}`, { exact: true }) });
}

/** The "Import line N" checkbox of a row. */
export function rowCheckbox(page: Page, line: number): Locator {
  return page.getByRole('checkbox', { name: `Import line ${line}` });
}

/** The budget select of a row. */
export function rowBudget(page: Page, line: number): Locator {
  return page.getByRole('combobox', { name: `Budget for line ${line}` });
}

/** Picks the budget of a row by name, as a person does (which also ticks a row that is ready to import). */
export async function pickBudget(page: Page, line: number, budget: string): Promise<void> {
  await rowBudget(page, line).selectOption({ label: budget });
}

/** The filter above the table, by its option as written with the count: "Already imported (8)". */
export async function showRows(page: Page, option: string): Promise<void> {
  await page.getByLabel('Show', { exact: true }).selectOption({ label: option });
}

/** Presses the Import button of the review step: "Import N spendings". */
export function importButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Import \d+ spendings?$/ });
}

/** The last step: "Imported N spendings." */
export async function expectImported(page: Page, count: number): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Imported / })).toHaveText(
    `Imported ${count} ${count === 1 ? 'spending' : 'spendings'}.`,
  );
}
