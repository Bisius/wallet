import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { figure } from './month-ui';
import { openPage } from './pages';

/*
 * The Telegram part of Settings (`telegram-section.ts` of the frontend) as a person finds it: by region,
 * role and label. Toasts and the section's own alerts both have role "alert", so every alert query is
 * scoped to the Telegram region.
 */

/** Opens Settings and waits for the page. */
export async function openSettings(page: Page): Promise<void> {
  await openPage(page, '/settings', 'Settings');
}

/** The region "Telegram" (an h2). */
export function telegramSection(page: Page): Locator {
  return page.getByRole('region', { name: 'Telegram', exact: true });
}

/** The region "Notifications" (an h3 of the section): it exists only while an account is linked. */
export function notificationsRegion(page: Page): Locator {
  return telegramSection(page).getByRole('region', { name: 'Notifications', exact: true });
}

/** The value of a row of the section's lists ("Bot", "Linked account", "Username", "Linked since", "Expires"). */
export function fact(page: Page, label: string): Locator {
  return figure(telegramSection(page), label);
}

/** The `<code>` of the "Pairing code" row. */
export function pairingCode(page: Page): Locator {
  return fact(page, 'Pairing code').locator('code');
}

/** The "Open in Telegram" link (only when the bot has told its username). */
export function openInTelegram(page: Page): Locator {
  return telegramSection(page).getByRole('link', { name: /Open in Telegram/ });
}

/**
 * A notice of the section (`app-alert`): an error of the connection, a warning, the result of a button
 * ("Test message sent", "The code expired"). Only inside the section: a toast of the page has role
 * "alert" or "status" too. An error is announced as an "alert", a success or an expiry as a "status",
 * and a warning has no live role: so the notice is found by its words, and a spec that is about the
 * role asks `telegramSection(page).getByRole(...)` itself.
 */
export function sectionAlert(page: Page, title: string | RegExp): Locator {
  return telegramSection(page).locator('app-alert').filter({ hasText: title });
}

/** The "Connecting to Telegram…" notice (a status, not an alert). */
export function connectingNotice(page: Page): Locator {
  return telegramSection(page).getByRole('status').filter({ hasText: 'Connecting to Telegram' });
}

/** Presses "Link Telegram" and returns the code that appears. */
export async function makeCode(page: Page): Promise<string> {
  await telegramSection(page).getByRole('button', { name: 'Link Telegram' }).click();
  await expect(pairingCode(page)).toBeVisible();
  const code = (await pairingCode(page).innerText()).trim();
  expect(code, 'a pairing code: 8 characters, none of 0 O 1 I').toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  return code;
}

/** The values of the notification form, as a person reads them. */
export interface NotificationFields {
  budgetAlerts: boolean;
  yearly: string;
  monthly: string;
  monthlyRecap: boolean;
  notifyAt: string;
}

export const NOTIFICATION_LABELS = {
  budgetAlerts: 'Budget alerts',
  yearly: 'Yearly renewals: days before',
  monthly: 'Monthly renewals: days before',
  monthlyRecap: 'Monthly recap',
  notifyAt: "Time of day (server's time zone)",
} as const;

/** What the notification form shows now. */
export async function expectNotificationFields(
  page: Page,
  expected: NotificationFields,
): Promise<void> {
  const form = notificationsRegion(page);
  const alerts = form.getByRole('switch', { name: NOTIFICATION_LABELS.budgetAlerts });
  const recap = form.getByRole('switch', { name: NOTIFICATION_LABELS.monthlyRecap });
  if (expected.budgetAlerts) await expect(alerts).toBeChecked();
  else await expect(alerts).not.toBeChecked();
  if (expected.monthlyRecap) await expect(recap).toBeChecked();
  else await expect(recap).not.toBeChecked();
  await expect(form.getByLabel(NOTIFICATION_LABELS.yearly)).toHaveValue(expected.yearly);
  await expect(form.getByLabel(NOTIFICATION_LABELS.monthly)).toHaveValue(expected.monthly);
  await expect(form.getByLabel(NOTIFICATION_LABELS.notifyAt)).toHaveValue(expected.notifyAt);
}
