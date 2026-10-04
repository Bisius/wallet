import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { eur, escapeRegExp } from './money';
import { goToPage } from './nav';

/*
 * Page-object style helpers for the pages that show a month: the dashboard, the budgets, the
 * spendings and the subscriptions, and for the month switcher of the shell. They find things the way a
 * user does (role, label, visible text), and every figure they expect is given in integer cents.
 */

export type AppPage =
  'Dashboard' | 'Budgets' | 'Spendings' | 'Subscriptions' | 'Income' | 'Savings';

/** Opens a page through the navigation, as a user does (`goToPage`: it works on a phone too). The month selection travels with the link. */
export async function openPage(page: Page, name: AppPage): Promise<void> {
  await goToPage(page, name);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** The month switcher of the shell (the pages that show one month at a time have it). */
export function monthSwitcher(page: Page) {
  const group = page.getByRole('group', { name: 'Month', exact: true });
  return {
    previous: () => group.getByRole('button', { name: /^Previous month/ }).click(),
    next: () => group.getByRole('button', { name: /^Next month/ }).click(),
    thisMonth: () => group.getByRole('button', { name: /^Go to this month/ }).click(),
    /** The month on show, by its long name ("March 2026"). */
    expectShowing: (label: string) => expect(group).toContainText(label),
  };
}

/** The figure of the tile (a `dt` and its `dd`) that is labelled `label` inside `region`. */
export function figure(region: Locator, label: string): Locator {
  return region
    .locator('dl > div')
    .filter({ has: region.page().getByText(label, { exact: true }) })
    .getByRole('definition')
    .first();
}

/**
 * The "<Month> at a glance" strip: the dashboard's has all five figures, the budgets page's is slim
 * (`budgeted` and `unallocated`).
 */
export function glance(page: Page): Locator {
  return page.getByRole('region', { name: /at a glance$/ });
}

export interface GlanceFigures {
  /** Only the dashboard's strip has it. */
  income: number;
  /** Only the dashboard's strip has it (the subscriptions page has it as its own figure). */
  fixedCosts: number;
  budgeted: number;
  /** Only the dashboard's strip has it. */
  spent: number;
  unallocated: number;
}

const GLANCE_LABELS: Record<keyof GlanceFigures, string> = {
  income: 'Income',
  fixedCosts: 'Fixed costs',
  budgeted: 'Budgeted',
  spent: 'Spent',
  unallocated: 'Unallocated',
};

/** The tiles of the strip on the current page, each as the user reads it. */
export async function expectGlance(page: Page, expected: Partial<GlanceFigures>): Promise<void> {
  const strip = glance(page);
  for (const key of Object.keys(GLANCE_LABELS) as (keyof GlanceFigures)[]) {
    const cents = expected[key];
    if (cents === undefined) continue;
    await expect(figure(strip, GLANCE_LABELS[key]), `${GLANCE_LABELS[key]} at a glance`).toHaveText(
      eur(cents),
    );
  }
}

export type Alert = 'ok' | 'warning' | 'over';

const ALERT_WORDS: Record<Alert, string> = {
  ok: 'On track',
  warning: 'Warning',
  over: 'Over budget',
};

/** What one budget shows in a month, in cents: the same on the budget card and on the dashboard. */
export interface BudgetFigures {
  available: number;
  spent: number;
  remaining: number;
  alert: Alert;
  /** `usagePercent` as shown, or null when nothing is available (no bar, no percentage). */
  usage: number | null;
  /** The warning threshold the card names ("warns at 80%"). 80 unless the spec changed it. */
  warnAt?: number;
}

/** The bar and the words under it: the alert state, the percentage, and what it means. */
async function expectUsage(scope: Locator, name: string, expected: BudgetFigures): Promise<void> {
  const word = ALERT_WORDS[expected.alert];
  await expect(scope.getByText(word, { exact: true }), `${name} alert`).toBeVisible();
  // The other two states are not shown.
  for (const other of Object.keys(ALERT_WORDS) as Alert[]) {
    if (other !== expected.alert) {
      await expect(scope.getByText(ALERT_WORDS[other], { exact: true })).toHaveCount(0);
    }
  }
  const bar = scope.getByRole('progressbar', { name: `${name} usage` });
  if (expected.usage === null) {
    // Nothing available (zero or less): no bar and no percentage. It is "over" once anything is spent
    // (spent > available), and "on track" with the words below while nothing has been.
    await expect(bar).toHaveCount(0);
    if (expected.alert === 'over') {
      await expect(scope).toContainText(`by ${eur(-expected.remaining)}`);
      await expect(scope).not.toContainText('% used');
    } else {
      await expect(scope).toContainText('Nothing available this month.');
    }
    return;
  }
  await expect(bar).toHaveAttribute(
    'aria-valuetext',
    `${expected.usage}% used, ${word.toLowerCase()}`,
  );
  // The bar fills up to 100 and no further.
  await expect(bar).toHaveAttribute('aria-valuenow', String(Math.min(100, expected.usage)));
  if (expected.alert === 'over') {
    await expect(scope).toContainText(`by ${eur(-expected.remaining)} · ${expected.usage}% used`);
  } else {
    await expect(scope).toContainText(
      `${expected.usage}% used, warns at ${expected.warnAt ?? 80}%`,
    );
  }
}

/** The card of a budget on the budgets page. */
export function budgetCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name, exact: true });
}

/** Available, spent and remaining of a card, and its usage bar and alert. */
export async function expectBudgetCard(
  page: Page,
  name: string,
  expected: BudgetFigures,
): Promise<void> {
  const card = budgetCard(page, name);
  await expect(figure(card, 'Available'), `${name} available`).toHaveText(eur(expected.available));
  await expect(figure(card, 'Spent'), `${name} spent`).toHaveText(eur(expected.spent));
  await expect(figure(card, 'Remaining'), `${name} remaining`).toHaveText(eur(expected.remaining));
  await expectUsage(card, name, expected);
}

/**
 * The "Budget progress" row of one budget on the dashboard. A row names its budget in its first
 * paragraph, after the budget's icon when it has one (the icon is decoration).
 */
export function dashboardRow(page: Page, name: string): Locator {
  return page
    .getByRole('region', { name: 'Budget progress' })
    .getByRole('listitem')
    .filter({
      has: page
        .getByRole('paragraph')
        .filter({ hasText: new RegExp(`^\\s*(\\S+\\s+)?${escapeRegExp(name)}\\s*$`) }),
    });
}

/** What the dashboard's row of a budget says: what was spent and available, what is left, and the bar. */
export async function expectDashboardRow(
  page: Page,
  name: string,
  expected: BudgetFigures,
): Promise<void> {
  const row = dashboardRow(page, name);
  await expect(row, `${name} remaining`).toContainText(
    new RegExp(`${escapeRegExp(eur(expected.remaining))}\\s*remaining`),
  );
  await expect(row, `${name} spent and available`).toContainText(
    new RegExp(
      `Spent\\s*${escapeRegExp(eur(expected.spent))}\\s*·\\s*Available\\s*${escapeRegExp(eur(expected.available))}`,
    ),
  );
  await expectUsage(row, name, expected);
}

/** The names of the dashboard's budget rows, top to bottom. */
export async function dashboardOrder(page: Page): Promise<(string | null)[]> {
  return page
    .getByRole('region', { name: 'Budget progress' })
    .getByRole('listitem')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('p')?.textContent?.trim() ?? null));
}

/** The card of a subscription on the subscriptions page. */
export function subscriptionCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name, exact: true });
}

/** What the subscriptions page says about the month's fixed costs. */
export async function expectFixedCosts(page: Page, cents: number): Promise<void> {
  await expect(page.getByRole('region', { name: /^Fixed costs in / })).toContainText(eur(cents));
}

/**
 * The yearly reserve line of a subscription card while it is saving: what goes in this month, what is
 * held after it, and what it is saving towards.
 */
export async function expectReserveLine(
  page: Page,
  name: string,
  expected: {
    monthLabel: string;
    contribution: number;
    held: number;
    price: number;
    renewalLabel: string;
  },
): Promise<void> {
  const card = subscriptionCard(page, name);
  await expect(card, `${name} contribution`).toContainText(
    `In ${expected.monthLabel}, ${eur(expected.contribution)} goes into the reserve.`,
  );
  await expect(card, `${name} reserve`).toContainText(
    `${eur(expected.held)} of ${eur(expected.price)} set aside so the ${expected.renewalLabel} renewal is already paid.`,
  );
}

// --- the spendings page -----------------------------------------------------------------------

/** The form that adds a spending (the edit dialog has a form of its own). */
export function addForm(page: Page): Locator {
  return page.getByRole('region', { name: 'Add a spending' });
}

/**
 * Unfolds "More" of the quick add, where the description, the tags and the Refund switch are. It opens
 * by itself once one of them has a value, so this leaves it as it is when it is open already.
 */
export async function openMore(page: Page): Promise<void> {
  const more = addForm(page).locator('details', {
    has: page.locator('summary', { hasText: /^More/ }),
  });
  if (await more.evaluate((details: HTMLDetailsElement) => details.open)) return;
  await more.locator('summary').click();
  await expect(more).toHaveJSProperty('open', true);
}

/**
 * Unfolds the panel under the search box of the spendings list (the months to look in, the budget, the
 * tag and the range of amounts). The search box is always there, and the panel is folded until the
 * "Filters" button opens it (or the page arrives with one of its filters on), so a spec that uses
 * one of them opens it first, with this. It leaves the panel as it is when it is open already.
 */
export async function openFilters(page: Page): Promise<void> {
  const toggle = page
    .getByRole('search', { name: 'Search and filter spendings' })
    .getByRole('button', { name: /^Filters/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** The list of spendings, and its summary line. */
export function spendingsList(page: Page): Locator {
  return page.getByRole('region', { name: /^Spendings in / });
}

/** A row of the list, found by its description. */
export function spendingRow(page: Page, description: string): Locator {
  return spendingsList(page)
    .getByRole('listitem')
    .filter({ has: page.getByText(description, { exact: true }) });
}

export interface SpendingEntry {
  /** As typed: `45.50`. */
  amount: string;
  /** The budget's name, as the form's choice starts with it. */
  budget: string;
  /** `YYYY-MM-DD`. Left alone, it is today (the server's) inside the month shown. */
  date?: string;
  description?: string;
  refund?: boolean;
}

/** Picks a budget in a form's "Budget" choice by its name (the option also says what is left). */
export async function chooseBudget(form: Locator, name: string): Promise<void> {
  const select = form.getByLabel('Budget', { exact: true });
  const option = select
    .locator('option')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*·`) });
  const value = await option.getAttribute('value');
  if (value === null) throw new Error(`The budget choice has no "${name}"`);
  await select.selectOption(value);
}

/** Fills the "Add a spending" form like a user does, and presses its button. */
export async function addSpendingViaForm(page: Page, entry: SpendingEntry): Promise<void> {
  const form = addForm(page);
  await form.getByLabel('Amount', { exact: true }).fill(entry.amount);
  await chooseBudget(form, entry.budget);
  if (entry.date !== undefined) await form.getByLabel('Date', { exact: true }).fill(entry.date);
  if (entry.description !== undefined || entry.refund) await openMore(page);
  if (entry.description !== undefined) {
    await form.getByLabel('Description').fill(entry.description);
  }
  if (entry.refund) await form.getByRole('checkbox', { name: 'Refund' }).check();
  await form.getByRole('button', { name: entry.refund ? 'Add refund' : 'Add spending' }).click();
}
