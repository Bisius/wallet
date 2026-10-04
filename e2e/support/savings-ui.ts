import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { figure } from './month-ui';
import { eur, signedEur } from './money';

/*
 * Page-object style helpers for what is about savings: the badge on the navigation, the Savings
 * page (balance, "Move to savings" inbox, goals, history) and the dashboard's "Savings to move"
 * block. Amounts are integer cents, written as the user reads them only inside the assertions.
 */

/** The Savings link of the navigation, which carries the badge. */
export function savingsLink(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Savings/ });
}

/** The badge: how many closed months wait to be moved to savings. 0 means there is none. */
export async function expectBadge(page: Page, months: number): Promise<void> {
  const link = savingsLink(page);
  if (months === 0) {
    await expect(link).not.toContainText('to move to savings');
    await expect(link).toHaveText('Savings');
  } else {
    await expect(link).toContainText(
      `${months} ${months === 1 ? 'month' : 'months'} to move to savings`,
    );
  }
}

/** The dashboard's "Savings to move" block. */
export function savingsToMove(page: Page): Locator {
  return page.getByRole('region', { name: 'Savings to move' });
}

/** The "Your savings" block of the Savings page: the balance, and how much of it is in no goal. */
export async function expectBalance(
  page: Page,
  expected: { balance: number; unassigned?: number },
): Promise<void> {
  const summary = page.getByRole('region', { name: 'Your savings' });
  await expect(figure(summary, 'Savings balance'), 'savings balance').toHaveText(
    eur(expected.balance),
  );
  if (expected.unassigned !== undefined) {
    await expect(figure(summary, 'Unassigned'), 'unassigned savings').toHaveText(
      eur(expected.unassigned),
    );
  }
}

/** The "Move to savings" inbox. */
export function inbox(page: Page): Locator {
  return page.getByRole('region', { name: 'Move to savings' });
}

/** The row of one closed month in the inbox ("March 2026"). */
export function inboxEntry(page: Page, monthLabel: string): Locator {
  return inbox(page)
    .getByRole('listitem')
    .filter({ has: page.getByText(`${monthLabel}:`) });
}

/** The "Done" button of an inbox row. */
export function doneButton(entry: Locator): Locator {
  return entry.getByRole('button', { name: /^Mark .* as done$/ });
}

/** The "Split…" button of an inbox row. */
export function splitButton(entry: Locator): Locator {
  return entry.getByRole('button', { name: /^Split .* across goals$/ });
}

export interface Breakdown {
  unallocated: number;
  budgetsSettled: number;
  reservesReleased: number;
  /** "Due for the month". */
  due: number;
  /** "Already settled", shown for a month that was settled before. */
  settled?: number;
  /** "To move now" or "To take now". */
  now: number;
}

/** Opens "See the breakdown" of an inbox row and reads its lines, each with its sign. */
export async function expectBreakdown(entry: Locator, expected: Breakdown): Promise<void> {
  await entry.getByText('See the breakdown').click();
  const line = (label: string) =>
    entry
      .locator('dl > div')
      .filter({ has: entry.page().getByText(label) })
      .getByRole('definition');
  await expect(line('Unallocated income')).toHaveText(signedEur(expected.unallocated));
  await expect(line('Budgets settled')).toHaveText(signedEur(expected.budgetsSettled));
  await expect(line('Reserves released')).toHaveText(signedEur(expected.reservesReleased));
  await expect(line('Due for the month')).toHaveText(signedEur(expected.due));
  if (expected.settled !== undefined) {
    await expect(line('Already settled')).toHaveText(signedEur(expected.settled));
  } else {
    await expect(entry.getByText('Already settled')).toHaveCount(0);
  }
  await expect(line(expected.now < 0 ? 'To take now' : 'To move now')).toHaveText(
    signedEur(expected.now),
  );
}

/** The card of a goal. */
export function goalCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name, exact: true });
}

/** What a goal card says: saved, target, how far along, and what is still to save. */
export async function expectGoal(
  page: Page,
  name: string,
  expected: { saved: number; target: number; progress: number; stillToSave?: number },
): Promise<void> {
  const card = goalCard(page, name);
  await expect(figure(card, 'Saved'), `${name} saved`).toHaveText(eur(expected.saved));
  await expect(figure(card, 'Target'), `${name} target`).toHaveText(eur(expected.target));
  await expect(card.getByText(`${expected.progress}% of the target`)).toBeVisible();
  await expect(card.getByRole('progressbar', { name: `${name} progress` })).toHaveAttribute(
    'aria-valuenow',
    String(Math.min(100, expected.progress)),
  );
  if (expected.stillToSave !== undefined) {
    await expect(figure(card, 'Still to save'), `${name} still to save`).toHaveText(
      eur(expected.stillToSave),
    );
  }
}

/** The history block. */
export function history(page: Page): Locator {
  return page.getByRole('region', { name: 'History' });
}

/** The entries of the history, newest first (a reallocation or a settlement is one entry). */
export function historyEntries(page: Page): Locator {
  // An entry has its title in a paragraph; the lines of a settlement's slices, nested in it, have none.
  return history(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('paragraph') });
}

/** One entry of the history by its title ("Settled March 2026", "Deposit to Holiday"). */
export function historyEntry(page: Page, title: string): Locator {
  return historyEntries(page).filter({
    has: page.getByRole('paragraph').filter({ hasText: title }),
  });
}

/** The history entries, top to bottom, by what each one says first (its title). */
export async function expectHistory(page: Page, titles: readonly string[]): Promise<void> {
  const entries = historyEntries(page);
  await expect(entries).toHaveCount(titles.length);
  for (const [index, title] of titles.entries()) {
    await expect(entries.nth(index).getByRole('paragraph').first()).toHaveText(title);
  }
}
