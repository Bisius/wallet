import type { Page } from '@playwright/test';
import type { BackupDto, SpendingDto } from '@wallet/shared';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BotMessage,
  FAKE_BOT_TOKEN,
  FAKE_BOT_USERNAME,
  type FakeTelegram,
  GROUP,
  OWNER,
  STRANGER,
} from '../support/fake-telegram';
import { failedResponse, json, type Wallet } from '../support/fixtures';
import { simpleText, SIMPLE_MAPPING } from '../support/csv-fixtures';
import { chooseMenuItem, moreActions } from '../support/menu';
import {
  addForm,
  addSpendingViaForm,
  expectBudgetCard,
  expectGlance,
  figure,
  spendingRow,
  spendingsList,
} from '../support/month-ui';
import { openDialog } from '../support/pages';
import { restoreBackup } from '../support/restore';
import { expectBadge, expectBreakdown, inboxEntry } from '../support/savings-ui';
import {
  addSpending,
  createBudget,
  createSubscription,
  getMonth,
  getSavings,
  getTelegramStatus,
  linkTelegram,
  onboard,
} from '../support/seed';
import { expect, test } from '../support/servers';
import {
  connectingNotice,
  expectNotificationFields,
  fact,
  makeCode,
  notificationsRegion,
  openInTelegram,
  openSettings,
  pairingCode,
  sectionAlert,
  telegramSection,
} from '../support/telegram-ui';

/*
 * The Telegram bot, end to end: a real Wallet server (the production build) with the bot switched on,
 * talking to a fake Bot API in this process (`support/fake-telegram.ts`), and a browser for what
 * Settings and the other pages show. The person on the phone is `telegram` (`say`, `tap`,
 * `lastMessage`): every message it asserts is the text the chat shows, and every figure of a message
 * is compared with the web app, to the cent.
 *
 * The fake clock starts on 2026-03-10 09:00 (a Tuesday) unless a describe says otherwise. The rules are
 * in docs/DOMAIN.md, "Telegram bot"; each amount below is worked out by hand from the rules of the
 * month (comments), never read back from the code under test.
 *
 * TIMING. The notification scheduler is a real one-minute timer that reads the fake clock at every tick
 * (no way to hurry it), so a test that waits for a reminder or the recap waits up to a minute of real
 * time after it moves the clock, and says so. A web write raises its alert about 2 seconds later.
 */

test.use({ telegramBot: true });

/** What the bot says, word for word (backend/src/modules/telegram/telegram.messages.ts). */
const INVALID_CODE = 'Invalid or expired code.';
const NO_LONGER_LINKED = 'This chat is no longer linked to Wallet';
const TEST_MESSAGE = '✅ Wallet is connected';
const EXPIRED_BUTTON = 'This entry expired, start again with /spending';

/** March 2026, the month of the harness clock: three budgets, nothing else. Unallocated is 2,300.00. */
async function seedBudgets(api: Parameters<typeof onboard>[0]) {
  await onboard(api, { startMonth: '2026-03', salary: 300000, openingSavings: 100000 });
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
    icon: '🛒',
  });
  const eatingOut = await createBudget(api, {
    name: 'Eating out',
    amount: 20000,
    incremental: false,
    icon: '🍝',
  });
  const fuel = await createBudget(api, {
    name: 'Fuel',
    amount: 10000,
    incremental: true,
    icon: '⛽',
  });
  return { groceries, eatingOut, fuel };
}

/** The labels of the keyboard of a message, row by row. */
const keyboardOf = (message: BotMessage): string[][] =>
  message.buttons.map((row) => row.map((button) => button.text));

/** The labels of all the buttons of a message. */
const buttonsOf = (message: BotMessage): string[] => keyboardOf(message).flat();

/** `Groceries: €376.60 left of €400.00 (5% used)` as printed: what is left, of what, and the percentage. */
function printedFigure(text: string): { left: string; of: string; percent: number } {
  const found = /(-?€[\d,]+\.\d\d) left of (€[\d,]+\.\d\d) \((\d+)% used/.exec(text);
  if (!found) throw new Error(`No "left of ... (n% used)" in: ${text}`);
  return { left: found[1] ?? '', of: found[2] ?? '', percent: Number(found[3]) };
}

/** The option of the budget choice of the Spendings form: the web's own "what is left". */
async function budgetChoice(page: Page, name: string): Promise<string> {
  const option = addForm(page)
    .getByLabel('Budget', { exact: true })
    .locator('option')
    .filter({ hasText: new RegExp(`^\\s*${name}\\s*·`) });
  return (await option.innerText()).replace(/\s+/g, ' ').trim();
}

/** The month view's line of a budget, as the web app gets it (a second witness next to the hand-worked figures). */
async function budgetLine(api: Parameters<typeof onboard>[0], month: string, name: string) {
  const view = await getMonth(api, month);
  const line = view.budgets.find((candidate) => candidate.name === name);
  if (!line) throw new Error(`No budget ${name} in ${month}`);
  return line;
}

/** The app is still usable: a spending can be added on the Spendings page. */
async function expectAppStillWorks(page: Page): Promise<void> {
  await page.goto('/spendings');
  await expect(page.getByRole('heading', { name: 'Spendings', level: 1 })).toBeVisible();
  await addSpendingViaForm(page, { amount: '1', budget: 'Groceries', description: 'Still works' });
  await expect(addForm(page).getByRole('status')).toContainText('Added €1.00 to Groceries.');
}

// ------------------------------------------------------------------------------------------------
// Linking
// ------------------------------------------------------------------------------------------------

test.describe('linking from Settings', () => {
  test('without a token the bot is off: four steps to turn it on, no way to link, and nothing else changes', async ({
    page,
    wallet,
    servers,
  }) => {
    // The wallet of this test has the bot (the file's option), so start a plain one next to it.
    const plain = await servers.start();
    await seedBudgets(plain.api);

    await page.goto(`${plain.baseURL}/settings`);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const section = telegramSection(page);
    await expect(section.getByRole('heading', { name: 'Telegram', level: 2 })).toBeVisible();
    await expect(section).toContainText(
      'Telegram is off. To record spendings from your phone, set the bot up:',
    );
    const steps = section.getByRole('listitem');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toContainText('@BotFather');
    await expect(steps.nth(0)).toContainText('/newbot');
    await expect(steps.nth(1)).toContainText('TELEGRAM_BOT_TOKEN=your-bot-token');
    await expect(steps.nth(2)).toHaveText('Restart Wallet. It reads the token when it starts.');
    await expect(steps.nth(3)).toHaveText('Come back to this page and press Link Telegram.');
    await expect(section).toContainText(
      'The README has the details, in the section “Telegram bot”.',
    );
    // No way to link, nothing linked, no error.
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0);
    await expect(sectionAlert(page, /./)).toHaveCount(0);
    await expect(notificationsRegion(page)).toHaveCount(0);

    expect(await getTelegramStatus(plain.api)).toMatchObject({
      configured: false,
      connection: 'off',
      problem: null,
      bot: null,
      link: null,
      pairing: null,
    });
    const pairing = await plain.api.post('/api/telegram/pairing', { failOnStatusCode: false });
    expect(pairing.status()).toBe(409);
    expect(await pairing.json()).toMatchObject({ error: { code: 'telegram_not_configured' } });

    // Everything else works as before: a spending, through the form.
    await page.goto(`${plain.baseURL}/spendings`);
    await addSpendingViaForm(page, { amount: '12.50', budget: 'Groceries', description: 'Lunch' });
    await expect(addForm(page).getByRole('status')).toContainText(
      'Added €12.50 to Groceries. €387.50 left of €400.00.',
    );
    // The bot of the other server did not hear of any of it.
    expect(wallet.baseURL).not.toBe(plain.baseURL);
  });

  test('shows "Connecting to Telegram…" while the bot starts, and the way to link once it is running', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    // The server is brought up again with Telegram not answering: it listens, and the bot is "connecting".
    const gate = telegram.hold('getMe');
    await wallet.stop();
    await wallet.start();
    await expect
      .poll(async () => (await getTelegramStatus(wallet.api)).connection)
      .toBe('connecting');

    await openSettings(page);
    const section = telegramSection(page);
    await expect(connectingNotice(page)).toContainText(
      'This takes a few seconds. The page updates by itself.',
    );
    await expect(section.getByRole('alert')).toHaveCount(0);
    // The bot does not know its own name yet, so it is not shown; a code can already be made, and with
    // no deep link the page says what to send by hand.
    await expect(fact(page, 'Bot')).toHaveCount(0);
    const code = await makeCode(page);
    await expect(openInTelegram(page)).toHaveCount(0);
    await expect(section).toContainText(`In Telegram, send /start ${code} to your bot.`);

    // Telegram answers: the page notices by itself (it reads the status every 3 seconds), the notice
    // goes, and the link that sends the code appears.
    gate.release();
    await expect(connectingNotice(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(openInTelegram(page)).toHaveAttribute(
      'href',
      `https://t.me/${FAKE_BOT_USERNAME}?start=${code}`,
    );
    await expect(fact(page, 'Bot')).toHaveText(`@${FAKE_BOT_USERNAME}`);
    await expect(pairingCode(page)).toHaveText(code);
    expect(await getTelegramStatus(wallet.api)).toMatchObject({
      connection: 'running',
      problem: null,
      bot: { username: FAKE_BOT_USERNAME },
    });
    // The code made while it was connecting works.
    await telegram.say(`/start ${code}`);
    await expect(fact(page, 'Linked account')).toHaveText('Olivia', { timeout: 15_000 });
  });

  test('links with a one-time code: wrong codes and strangers get nothing, the right one links, and a test message arrives', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await telegram.waitUntilPolling();
    await openSettings(page);
    const section = telegramSection(page);

    // Not linked yet: the bot is known, and there is one button.
    await expect(fact(page, 'Bot')).toHaveText(`@${FAKE_BOT_USERNAME}`);
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Send test message' })).toHaveCount(0);
    await expect(notificationsRegion(page)).toHaveCount(0);

    // A code, and the link that sends it. It is shown for 10 minutes and works once.
    const code = await makeCode(page);
    await expect(openInTelegram(page)).toHaveAttribute(
      'href',
      `https://t.me/${FAKE_BOT_USERNAME}?start=${code}`,
    );
    await expect(openInTelegram(page)).toHaveAttribute('target', '_blank');
    await expect(section).toContainText('This code links your Telegram account. It works once.');
    await expect(section.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0);
    const pending = await getTelegramStatus(wallet.api);
    expect(pending.pairing).toMatchObject({
      code,
      deepLink: `https://t.me/${FAKE_BOT_USERNAME}?start=${code}`,
    });
    // Valid for 10 minutes of the server's clock: the harness starts at 09:00:00, so by 09:10 and a bit.
    expect(
      Date.parse(pending.pairing?.expiresAt ?? '') - Date.parse(await wallet.getNow()),
    ).toBeGreaterThan(9 * 60_000);

    // A wrong code from the owner: the one answer a bot gives while a code is open.
    await telegram.say('/start WRONGCODE');
    expect(telegram.texts()).toEqual([INVALID_CODE]);

    // Strangers get no reply at all, whatever they send, in a private chat or a group.
    const stranger = telegram.as(STRANGER);
    await stranger.say('/spending');
    await stranger.say('/help');
    await stranger.say('4,50 coffee');
    await stranger.say('/start');
    expect(stranger.messages()).toEqual([]);
    // Not even the right code links from a group, or is answered there. Nor is it used up.
    const groupMember = telegram.as(STRANGER, GROUP);
    await groupMember.say(`/start ${code}`);
    await telegram.as(OWNER, GROUP).say(`/start ${code}`);
    expect(groupMember.messages()).toEqual([]);
    expect(telegram.as(OWNER, GROUP).messages()).toEqual([]);
    expect(telegram.texts()).toEqual([INVALID_CODE]);
    expect((await getTelegramStatus(wallet.api)).link).toBeNull();
    await expect(pairingCode(page)).toHaveText(code);

    // The owner taps "Open in Telegram": Telegram sends `/start <code>`. The page switches by itself.
    await telegram.say(`/start ${code}`);
    await expect(fact(page, 'Linked account')).toHaveText('Olivia', { timeout: 15_000 });
    await expect(fact(page, 'Username')).toHaveText('@olivia');
    await expect(fact(page, 'Linked since')).toHaveText(/^Mar 10, 2026, 9:0\d AM$/);
    await expect(page.getByText('Telegram linked: Olivia (@olivia).')).toBeVisible();
    await expect(pairingCode(page)).toHaveCount(0);
    await expect(openInTelegram(page)).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Send test message' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'More actions for Telegram' })).toBeVisible();
    await expect(notificationsRegion(page)).toBeVisible();

    // The greeting: the link, then the help.
    const [answer, greeting, ...others] = telegram.texts();
    expect(answer).toBe(INVALID_CODE);
    expect(others).toEqual([]);
    expect(greeting).toContain('✅ Linked to Wallet, Olivia.');
    for (const command of [
      '/spending – Record a spending',
      '/income – Record an income',
      '/status – What is left in each budget',
      '/recent – Last spendings, delete one',
      '/undo – Remove what you added last',
      '/cancel – Stop the entry in progress',
      '/help – What I can do',
    ]) {
      expect(greeting, command).toContain(command);
    }
    expect(telegram.commands().map(({ command }) => command)).toEqual([
      'spending',
      'income',
      'status',
      'recent',
      'undo',
      'cancel',
      'help',
    ]);

    // The code is used up, and a stranger is still silent (the owner's chat keeps its one answer).
    await stranger.say(`/start ${code}`);
    await stranger.say('/status');
    expect(stranger.messages()).toEqual([]);

    // "Send test message" reaches the chat, and says so.
    await section.getByRole('button', { name: 'Send test message' }).click();
    await expect(sectionAlert(page, 'Test message sent')).toContainText(
      'A test message is in your Telegram chat.',
    );
    expect((await telegram.waitForMessage((message) => message.text === TEST_MESSAGE)).text).toBe(
      TEST_MESSAGE,
    );
    expect(telegram.messages()).toHaveLength(3);
  });

  test('saves the notification settings, and they are still there after a reload', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);
    await openSettings(page);

    // The defaults of docs/DOMAIN.md: alerts on, 7 days before a yearly renewal, 1 before a monthly one, the recap on, 09:00.
    await expect(notificationsRegion(page)).toBeVisible();
    await expectNotificationFields(page, {
      budgetAlerts: true,
      yearly: '7',
      monthly: '1',
      monthlyRecap: true,
      notifyAt: '09:00',
    });
    const form = notificationsRegion(page);

    // Out of range: nothing is saved, and the field says what is wanted.
    await form.getByLabel('Yearly renewals: days before').fill('31');
    await form.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(form.getByText('Enter a whole number from 0 to 30.')).toBeVisible();
    await expect(form.getByLabel('Yearly renewals: days before')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect((await getTelegramStatus(wallet.api)).notifications).toMatchObject({
      renewalYearlyDays: 7,
    });

    // Change all five: recap off, 10 and 2 days, 08:30. A switch is pressed by its label.
    await form.getByLabel('Yearly renewals: days before').fill('10');
    await form.getByLabel('Monthly renewals: days before').fill('2');
    await form.getByText('Monthly recap', { exact: true }).click();
    await expect(form.getByRole('switch', { name: 'Monthly recap' })).not.toBeChecked();
    await form.getByLabel("Time of day (server's time zone)").fill('08:30');
    await form.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(page.getByText('Notification settings saved.')).toBeVisible();
    expect((await getTelegramStatus(wallet.api)).notifications).toEqual({
      budgetAlerts: true,
      renewalYearlyDays: 10,
      renewalMonthlyDays: 2,
      monthlyRecap: false,
      notifyAt: '08:30',
    });

    // Reload: what the server holds is what the form shows.
    await openSettings(page);
    await expectNotificationFields(page, {
      budgetAlerts: true,
      yearly: '10',
      monthly: '2',
      monthlyRecap: false,
      notifyAt: '08:30',
    });

    // 0 turns a reminder off, and the alerts can be switched off too.
    await form.getByLabel('Yearly renewals: days before').fill('0');
    await form.getByText('Budget alerts', { exact: true }).click();
    await form.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(page.getByText('Notification settings saved.').last()).toBeVisible();
    expect((await getTelegramStatus(wallet.api)).notifications).toMatchObject({
      budgetAlerts: false,
      renewalYearlyDays: 0,
    });
  });

  test('unlinks behind a confirmation: the old chat is told, and nobody gets an answer after that', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);
    await telegram.say('/status');
    expect(telegram.lastMessage().text).toContain('Groceries');
    await openSettings(page);
    const section = telegramSection(page);
    await expect(fact(page, 'Linked account')).toHaveText('Olivia');

    // The confirmation says who, and "Cancel" changes nothing.
    await chooseMenuItem(moreActions(section), 'Unlink');
    const dialog = openDialog(page);
    await expect(
      dialog.getByRole('heading', { name: 'Unlink this Telegram account?' }),
    ).toBeVisible();
    await expect(dialog).toContainText('Olivia (@olivia) can no longer use the bot');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await getTelegramStatus(wallet.api)).link).not.toBeNull();
    await expect(fact(page, 'Linked account')).toHaveText('Olivia');

    // Unlink: the link is gone from Settings and from the server, and the preferences stay.
    await chooseMenuItem(moreActions(section), 'Unlink');
    await openDialog(page).getByRole('button', { name: 'Unlink', exact: true }).click();
    await expect(page.getByText('Telegram unlinked.')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Send test message' })).toHaveCount(0);
    await expect(notificationsRegion(page)).toHaveCount(0);
    expect(await getTelegramStatus(wallet.api)).toMatchObject({
      link: null,
      notifications: { budgetAlerts: true, renewalYearlyDays: 7, monthlyRecap: true },
    });

    // The chat that was linked gets the best-effort notice.
    await telegram.waitForMessage((message) => message.text === NO_LONGER_LINKED);

    // After that the bot answers nobody: the old owner, a stranger, in a private chat or a group.
    const before = telegram.messages().length;
    await telegram.say('/status');
    await telegram.say('/spending');
    await telegram.say('4,50 coffee');
    await telegram.as(STRANGER).say('/status');
    await telegram.as(STRANGER, GROUP).say('/help');
    expect(telegram.messages()).toHaveLength(before);
    expect(telegram.as(STRANGER).messages()).toEqual([]);
    expect(telegram.as(STRANGER, GROUP).messages()).toEqual([]);
  });

  test('re-links to another account behind a confirmation: the old chat is told and silenced', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);
    await openSettings(page);
    const section = telegramSection(page);

    await chooseMenuItem(moreActions(section), 'Re-link');
    const dialog = openDialog(page);
    await expect(
      dialog.getByRole('heading', { name: 'Link another Telegram account?' }),
    ).toBeVisible();
    await expect(dialog).toContainText('Olivia (@olivia) stays linked until the new code is used.');
    await dialog.getByRole('button', { name: 'Create a new code' }).click();

    await expect(section).toContainText('This code links another account. It works once.');
    const code = (await pairingCode(page).innerText()).trim();
    // Until the code is used the first account is the one that works.
    await telegram.say('/status');
    expect(telegram.lastMessage().text).toContain('Groceries');

    // Somebody else sends it: they are linked, the page says so, and the old chat is told.
    const mallory = telegram.as(STRANGER);
    await mallory.say(`/start ${code}`);
    await expect(fact(page, 'Linked account')).toHaveText('Mallory', { timeout: 15_000 });
    await expect(fact(page, 'Username')).toHaveText('@mallory');
    expect(mallory.messages()).toHaveLength(1);
    expect(mallory.lastMessage().text).toContain('✅ Linked to Wallet, Mallory.');
    await telegram.waitForMessage((message) => message.text === NO_LONGER_LINKED);

    const before = telegram.messages().length;
    await telegram.say('/status');
    expect(telegram.messages()).toHaveLength(before);
    await mallory.say('/status');
    expect(mallory.lastMessage().text).toContain('Groceries');
  });
});

// ------------------------------------------------------------------------------------------------
// The state of the connection, in Settings
// ------------------------------------------------------------------------------------------------

test.describe('the connection, as Settings shows it', () => {
  /** Waits until the server says the bot is in this state. */
  async function expectConnection(
    api: Parameters<typeof onboard>[0],
    connection: string,
    problem: string | null,
  ) {
    await expect
      .poll(async () => {
        const status = await getTelegramStatus(api);
        return `${status.connection}/${status.problem}`;
      })
      .toBe(`${connection}/${problem}`);
  }

  test.use({
    // The test message is refused with a 503 when the bot is blocked: the browser logs the failed request.
    allowedConsoleErrors: [failedResponse(503, /\/api\/telegram\/test$/)],
  });

  test('a token Telegram refuses: "Telegram refused the bot token", and the rest of the app works', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    // Every call of a token that is wrong is a 401. The bot gives up until Wallet restarts.
    telegram.failAlways('*', 401);
    await wallet.stop();
    await wallet.start();
    await expectConnection(wallet.api, 'error', 'invalid_token');

    await openSettings(page);
    const section = telegramSection(page);
    await expect(sectionAlert(page, 'Telegram refused the bot token')).toContainText(
      'The token in TELEGRAM_BOT_TOKEN is wrong or was revoked.',
    );
    // An error is announced to a screen reader.
    await expect(section.getByRole('alert')).toContainText('Telegram refused the bot token');
    // No way to link while it cannot connect, and no steps for a bot that is set up.
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toHaveCount(0);
    await expect(section.getByRole('listitem')).toHaveCount(0);
    await expectAppStillWorks(page);

    // It stays off until a restart, even when Telegram would answer now (nobody retries a wrong token).
    telegram.heal();
    await wallet.stop();
    await wallet.start();
    await expectConnection(wallet.api, 'running', null);
    await openSettings(page);
    await expect(sectionAlert(page, 'Telegram refused the bot token')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Link Telegram' })).toBeVisible();
  });

  test('another program on the same bot: "Another program is using this bot", and the app is unaffected', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await telegram.waitUntilPolling();
    await expectConnection(wallet.api, 'running', null);

    // Telegram ends the poll that is held with a 409, as it does when a second program polls the token.
    telegram.failAlways('getUpdates', 409);
    await expectConnection(wallet.api, 'error', 'conflict');

    await openSettings(page);
    await expect(sectionAlert(page, 'Another program is using this bot')).toContainText(
      'Usually a second Wallet that has the same token',
    );
    await expect(telegramSection(page).getByRole('button', { name: 'Link Telegram' })).toHaveCount(
      0,
    );
    await expect(fact(page, 'Bot')).toHaveText(`@${FAKE_BOT_USERNAME}`);
    await expectAppStillWorks(page);
  });

  test('two Wallets with one token: the older one reports the conflict and keeps working', async ({
    page,
    wallet,
    telegram,
    servers,
  }) => {
    await seedBudgets(wallet.api);
    await telegram.waitUntilPolling();
    await expectConnection(wallet.api, 'running', null);

    // From now on Telegram behaves as it does with two pollers: the new call ends the held one.
    telegram.enforceSinglePoller();
    const second = await servers.start(undefined, { telegram });
    await seedBudgets(second.api);
    await expectConnection(wallet.api, 'error', 'conflict');
    await expectConnection(second.api, 'running', null);

    await openSettings(page);
    await expect(sectionAlert(page, 'Another program is using this bot')).toBeVisible();
    await expectAppStillWorks(page);
  });

  test('a bot the owner blocked: "You blocked the bot" until a message goes through', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);
    await openSettings(page);
    const section = telegramSection(page);
    await expect(sectionAlert(page, /./)).toHaveCount(0);

    // The owner blocks the bot. Wallet finds out when it tries to write: here, the test message.
    telegram.block(OWNER);
    await section.getByRole('button', { name: 'Send test message' }).click();
    await expect(sectionAlert(page, 'No test message was sent')).toContainText(
      'The bot is not running right now, or Telegram refused the message.',
    );
    await expectConnection(wallet.api, 'error', 'blocked');
    // The refusal makes Settings read the status again, so the cause shows without a reload.
    await expect(sectionAlert(page, 'You blocked the bot')).toContainText(
      "The bot can't write to your chat while it is blocked.",
    );
    // The link is still there, and the rest of Settings with it; the bot keeps polling.
    await expect(fact(page, 'Linked account')).toHaveText('Olivia');
    await expect(section.getByRole('button', { name: 'Send test message' })).toBeVisible();
    await expectAppStillWorks(page);

    // Unblocked: a message to the chat that goes through (the answer to the owner) clears it.
    telegram.unblock(OWNER);
    await telegram.say('/help');
    await expectConnection(wallet.api, 'running', null);
    await openSettings(page);
    await expect(sectionAlert(page, /./)).toHaveCount(0);
  });

  test('a Telegram that cannot be reached: "Telegram can\'t be reached", and Wallet keeps working', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await telegram.waitUntilPolling();
    telegram.failAlways('getUpdates', 502);
    await expectConnection(wallet.api, 'error', 'unreachable');

    await openSettings(page);
    await expect(sectionAlert(page, "Telegram can't be reached")).toContainText(
      'It tries again by itself',
    );
    await expect(telegramSection(page).getByRole('button', { name: 'Link Telegram' })).toHaveCount(
      0,
    );
    await expectAppStillWorks(page);
  });
});

// ------------------------------------------------------------------------------------------------
// /spending
// ------------------------------------------------------------------------------------------------

test.describe('recording a spending', () => {
  test('/spending goes budget, amount, note, date, and what it prints is what the web shows, to the cent', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);

    // 1. The budgets of this month, two to a row, each with what is left, and a way out.
    await telegram.say('/spending');
    expect(telegram.lastMessage().text).toBe('Which budget?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([
      ['🛒 Groceries · €400.00', '🍝 Eating out · €200.00'],
      ['⛽ Fuel · €100.00'],
      ['✖ Cancel'],
    ]);
    await telegram.tap('Groceries');
    // 2. The budget's message is edited in place: the question, and no keyboard.
    expect(telegram.lastMessage().text).toBe(
      '🛒 Groceries\nHow much? You can add a note after the amount, like 12,50 lunch',
    );
    expect(telegram.lastMessage().buttons).toEqual([]);
    // A wrong amount is asked again, with an example (and nothing is stored).
    await telegram.say('abc');
    expect(telegram.lastMessage().text).toBe(
      "I couldn't read an amount there. Try 12.50 or 12,50 lunch.",
    );
    await telegram.say('0');
    expect(telegram.lastMessage().text).toBe(
      "The amount can't be 0. Try 12.50, or -5 for a refund.",
    );
    await telegram.say('£5');
    expect(telegram.lastMessage().text).toBe(
      "I couldn't read an amount there. Try 12.50 or 12,50 lunch.",
    );
    await telegram.say('23,40');
    // 3. The note, with a way to skip it.
    expect(telegram.lastMessage().text).toBe('€23.40 · Groceries\nA note?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Skip']]);
    await telegram.say('Lidl');
    // 4. The date. The Skip button of the note's question is gone.
    expect(telegram.lastMessage().text).toBe('€23.40 · Groceries · Lidl\nWhen?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Today', 'Yesterday', 'Earlier…']]);
    expect(telegram.messages().flatMap(buttonsOf)).not.toContain('Skip');
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(0);
    await telegram.tap('Today');

    // The confirmation: 40000 - 2340 = 37660 left, usage floor(100 * 2340 / 40000) = floor(5.85) = 5.
    const saved =
      '✅ €23.40 · Groceries · Lidl · Tue, Mar 10\nGroceries: €376.60 left of €400.00 (5% used)';
    expect(telegram.lastMessage().text).toBe(saved);
    expect(keyboardOf(telegram.lastMessage())).toEqual([['↩ Undo', '📅 Change date']]);
    const line = await budgetLine(wallet.api, '2026-03', 'Groceries');
    expect([line.remaining, line.available, line.usagePercent, line.alert]).toEqual([
      37660,
      40000,
      5,
      'ok',
    ]);

    // The web says the same: the Spendings page (the row, and the budget choice of its form) and the Budgets page.
    await page.goto('/spendings');
    await expect(spendingRow(page, 'Lidl')).toContainText('€23.40');
    await expect(spendingRow(page, 'Lidl')).toContainText('Groceries');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 10, 2026', level: 3 }),
    ).toBeVisible();
    await expect(spendingsList(page)).toContainText('1 spending · €23.40 net.');
    const printed = printedFigure(telegram.lastMessage().text);
    expect(await budgetChoice(page, 'Groceries')).toBe(`Groceries · ${printed.left} left`);
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 2340,
      remaining: 37660,
      alert: 'ok',
      usage: 5,
    });
    const card = page.getByRole('article', { name: 'Groceries', exact: true });
    await expect(figure(card, 'Remaining')).toHaveText(printed.left);
    await expect(figure(card, 'Available')).toHaveText(printed.of);

    // Undo removes exactly that spending and says where the budget stands now. (What a button carries is
    // the bot's business: a test reads it off the screen, and keeps it to tap a button that has gone.)
    const undoButton = telegram.lastMessage().buttons[0]?.[0];
    expect(undoButton?.text).toBe('↩ Undo');
    await telegram.tap('↩ Undo');
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed €23.40 · Groceries · Lidl · Tue, Mar 10\nGroceries: €400.00 left of €400.00 (0% used)',
    );
    expect(telegram.lastMessage().buttons).toEqual([]);
    await page.reload();
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 0,
      remaining: 40000,
      alert: 'ok',
      usage: 0,
    });
    await page.goto('/spendings');
    await expect(spendingsList(page)).toContainText('No spendings in March 2026');
    // A second tap of that Undo (a message that was not refreshed) finds nothing to remove.
    const undone = telegram.lastMessage();
    await telegram.tapData(undoButton?.data ?? '', undone.id);
    expect(telegram.lastToast()).toBe('Already removed.');

    // Skip the note: 12.50 on today's date. 40000 - 1250 = 38750, usage floor(3.125) = 3.
    await telegram.say('/spending');
    await telegram.tap('Groceries');
    await telegram.say('12.50');
    expect(telegram.lastMessage().text).toBe('€12.50 · Groceries\nA note?');
    await telegram.tap('Skip');
    expect(telegram.lastMessage().text).toBe('€12.50 · Groceries\nWhen?');
    await telegram.tap('Today');
    expect(telegram.lastMessage().text).toBe(
      '✅ €12.50 · Groceries · Tue, Mar 10\nGroceries: €387.50 left of €400.00 (3% used)',
    );

    // An earlier day: text after the amount is the note (no note step), and "Earlier…" offers the days
    // from 2 to 6 days ago. 20000 - 800 = 19200, usage floor(4) = 4.
    await telegram.say('/spending');
    await telegram.tap('Eating out');
    await telegram.say('8 coffee');
    expect(telegram.lastMessage().text).toBe('€8.00 · Eating out · coffee\nWhen?');
    await telegram.tap('Earlier…');
    expect(buttonsOf(telegram.lastMessage())).toEqual([
      '8 Sun',
      '7 Sat',
      '6 Fri',
      '5 Thu',
      '4 Wed',
    ]);
    await telegram.tap('6 Fri');
    expect(telegram.lastMessage().text).toBe(
      '✅ €8.00 · Eating out · coffee · Fri, Mar 6\nEating out: €192.00 left of €200.00 (4% used)',
    );

    // A refund: a negative amount. It gives money back to the budget: 12.50 - 5.00 = 7.50 spent,
    // 40000 - 750 = 39250 left, usage floor(1.875) = 1.
    await telegram.say('/spending');
    await telegram.tap('Groceries');
    await telegram.say('-5 returned jar');
    expect(telegram.lastMessage().text).toBe('↩ Refund €5.00 · Groceries · returned jar\nWhen?');
    await telegram.tap('Today');
    expect(telegram.lastMessage().text).toBe(
      '↩ Refund €5.00 · Groceries · returned jar · Tue, Mar 10\nGroceries: €392.50 left of €400.00 (1% used)',
    );

    // Cancel at the first question stores nothing.
    await telegram.say('/spending');
    await telegram.tap('✖ Cancel');
    expect(telegram.lastMessage().text).toBe('Cancelled.');

    // Everything the web shows afterwards: three spendings (12.50, 8.00 and the refund), 15.50 net.
    await page.goto('/spendings');
    await expect(spendingsList(page)).toContainText('3 spendings · €15.50 net.');
    await expect(spendingRow(page, 'coffee')).toContainText('€8.00');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Fri, Mar 6, 2026', level: 3 }),
    ).toBeVisible();
    await expect(spendingRow(page, 'returned jar')).toContainText('-€5.00');
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 750,
      remaining: 39250,
      alert: 'ok',
      usage: 1,
    });
    await expectBudgetCard(page, 'Eating out', {
      available: 20000,
      spent: 800,
      remaining: 19200,
      alert: 'ok',
      usage: 4,
    });
    await page.goto('/dashboard');
    await expectGlance(page, { spent: 1550, unallocated: 230000 });
  });

  test('a quick entry takes the usual budget for the description first, saves on one tap dated today, and has Undo and Change date', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    const { groceries, eatingOut } = await seedBudgets(wallet.api);
    // History for the suggestion: "coffee" went to Eating out twice and to Groceries once.
    await addSpending(wallet.api, {
      date: '2026-03-02',
      amount: 300,
      budgetId: eatingOut.id,
      description: 'coffee',
    });
    await addSpending(wallet.api, {
      date: '2026-03-03',
      amount: 350,
      budgetId: eatingOut.id,
      description: 'Coffee',
    });
    await addSpending(wallet.api, {
      date: '2026-03-04',
      amount: 400,
      budgetId: groceries.id,
      description: 'coffee',
    });
    await linkTelegram(wallet.api, telegram);

    // The message starts with an amount: it asks for the budget, the suggested one first with a star.
    // Left now: Eating out 20000 - 650 = 19350, Groceries 40000 - 400 = 39600, Fuel 10000.
    await telegram.say('4,50 coffee');
    expect(telegram.lastMessage().text).toBe('€4.50 · coffee. Which budget?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([
      ['⭐ 🍝 Eating out · €193.50', '🛒 Groceries · €396.00'],
      ['⛽ Fuel · €100.00'],
      ['✖ Cancel'],
    ]);
    // Nothing is stored before the tap.
    expect((await getMonth(wallet.api, '2026-03')).totals.spent).toBe(1050);
    await telegram.tap('Eating out');
    // One tap: dated today. 650 + 450 = 1100 spent, 20000 - 1100 = 18900 left, usage floor(5.5) = 5.
    expect(telegram.lastMessage().text).toBe(
      '✅ €4.50 · Eating out · coffee · Tue, Mar 10\nEating out: €189.00 left of €200.00 (5% used)',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['↩ Undo', '📅 Change date']]);
    const line = await budgetLine(wallet.api, '2026-03', 'Eating out');
    expect([line.remaining, line.available, line.usagePercent]).toEqual([18900, 20000, 5]);

    await page.goto('/spendings');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 10, 2026', level: 3 }),
    ).toBeVisible();
    await expect(spendingsList(page)).toContainText('4 spendings · €15.00 net.');
    await expect(
      spendingsList(page).getByRole('listitem').filter({ hasText: '€4.50' }),
    ).toContainText('Eating out');
    expect(await budgetChoice(page, 'Eating out')).toBe('Eating out · €189.00 left');
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Eating out', {
      available: 20000,
      spent: 1100,
      remaining: 18900,
      alert: 'ok',
      usage: 5,
    });

    // Undo: back to 650 spent, 19350 left, usage floor(3.25) = 3.
    await telegram.tap('↩ Undo');
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed €4.50 · Eating out · coffee · Tue, Mar 10\nEating out: €193.50 left of €200.00 (3% used)',
    );
    await page.reload();
    await expectBudgetCard(page, 'Eating out', {
      available: 20000,
      spent: 650,
      remaining: 19350,
      alert: 'ok',
      usage: 3,
    });

    // A description with no history has no star, and the budgets keep their order.
    await telegram.say('12 pizza');
    expect(keyboardOf(telegram.lastMessage())).toEqual([
      ['🛒 Groceries · €396.00', '🍝 Eating out · €193.50'],
      ['⛽ Fuel · €100.00'],
      ['✖ Cancel'],
    ]);
    await telegram.tap('Fuel');
    // 10000 - 1200 = 8800 left, usage 12.
    expect(telegram.lastMessage().text).toBe(
      '✅ €12.00 · Fuel · pizza · Tue, Mar 10\nFuel: €88.00 left of €100.00 (12% used)',
    );

    // Change date: the last 7 days in one keyboard, and a way back.
    await telegram.tap('📅 Change date');
    expect(keyboardOf(telegram.lastMessage())).toEqual([
      ['Today', 'Yesterday', '8 Sun'],
      ['7 Sat', '6 Fri', '5 Thu'],
      ['4 Wed', '‹ Back'],
    ]);
    await telegram.tap('‹ Back');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['↩ Undo', '📅 Change date']]);
    await telegram.tap('📅 Change date');
    await telegram.tap('Yesterday');
    // The row and its figure are rewritten for the new date (same month: nothing else moves).
    expect(telegram.lastMessage().text).toBe(
      '✅ €12.00 · Fuel · pizza · Mon, Mar 9\nFuel: €88.00 left of €100.00 (12% used)',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['↩ Undo', '📅 Change date']]);
    await page.goto('/spendings');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Mon, Mar 9, 2026', level: 3 }),
    ).toBeVisible();
    await expect(
      spendingsList(page).getByRole('listitem').filter({ hasText: 'pizza' }),
    ).toContainText('€12.00');
    // Changing it to the day it has is a no-op the bot says so about.
    await telegram.tap('📅 Change date');
    await telegram.tap('Yesterday');
    expect(telegram.lastToast()).toBe('It is dated that day already.');
  });
});

test.describe('the other commands', () => {
  test('/status, /recent, /income and /undo print what the web shows, and anything else gets a pointer to /help', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    const { api } = wallet;
    const { groceries, fuel } = await seedBudgets(api);
    await addSpending(api, {
      date: '2026-03-07',
      amount: 1250,
      budgetId: groceries.id,
      description: 'lunch',
    });
    await addSpending(api, {
      date: '2026-03-09',
      amount: 800,
      budgetId: fuel.id,
      description: 'train',
    });
    await linkTelegram(api, telegram);

    // /status: a line per budget as the month view has it, and the days left in the month (31 - 10 = 21).
    // Groceries 40000 - 1250 = 38750, usage floor(3.125) = 3; Fuel 10000 - 800 = 9200, usage 8.
    await telegram.say('/status');
    expect(telegram.lastMessage().text).toBe(
      [
        '🛒 Groceries · €387.50 left of €400.00 (3%)',
        '🍝 Eating out · €200.00 left of €200.00 (0%)',
        '⛽ Fuel · €92.00 left of €100.00 (8%)',
        '',
        '21 days left in March · Unallocated €2,300.00',
      ].join('\n'),
    );
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 1250,
      remaining: 38750,
      alert: 'ok',
      usage: 3,
    });
    await expectBudgetCard(page, 'Fuel', {
      available: 10000,
      spent: 800,
      remaining: 9200,
      alert: 'ok',
      usage: 8,
    });
    await expectGlance(page, { budgeted: 70000, unallocated: 230000 });

    // /recent: the last spendings from any source, newest first, each with its own delete button.
    await telegram.say('/recent');
    expect(telegram.lastMessage().text).toBe(
      'Last spendings\n1. €8.00 · Fuel · train · Mon, Mar 9\n2. €12.50 · Groceries · lunch · Sat, Mar 7',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['🗑 1', '🗑 2']]);
    await telegram.tap('🗑 1');
    expect(telegram.lastMessage().text).toBe('Delete €8.00 · Fuel · train (Mon, Mar 9)?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Delete', 'Keep']]);
    await telegram.tap('Keep');
    expect(telegram.lastMessage().text).toBe('Kept.');
    expect((await getMonth(api, '2026-03')).totals.spent).toBe(2050);
    await telegram.say('/recent');
    await telegram.tap('🗑 1');
    await telegram.tap('Delete');
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed €8.00 · Fuel · train · Mon, Mar 9\nFuel: €100.00 left of €100.00 (0% used)',
    );
    await page.goto('/spendings');
    await expect(spendingsList(page)).toContainText('1 spending · €12.50 net.');
    await expect(spendingRow(page, 'train')).toHaveCount(0);

    // /income: amount and description in one message, the date, and the month's figures after it.
    // Income 3,000.00 + 200.00 = 3,200.00, unallocated 3,000.00 - 700.00 + 200.00 = 2,500.00.
    await telegram.say('/income');
    expect(telegram.lastMessage().text).toBe(
      'How much was the income? You can add a description after the amount, like 200 Bonus',
    );
    await telegram.say('0');
    expect(telegram.lastMessage().text).toBe("The amount can't be 0. Try 200 Bonus.");
    await telegram.say('-5');
    expect(telegram.lastMessage().text).toBe('An income is a positive amount. Try 200 Bonus.');
    await telegram.say('200 Bonus');
    expect(telegram.lastMessage().text).toBe('Income €200.00 · Bonus\nWhen?');
    await telegram.tap('Today');
    expect(telegram.lastMessage().text).toBe(
      '✅ Income €200.00 · Bonus · Tue, Mar 10\nMarch: income €3,200.00 · Unallocated €2,500.00',
    );
    await page.goto('/dashboard');
    await expectGlance(page, { income: 320000, unallocated: 250000, spent: 1250 });

    // /undo: the latest thing that was recorded from Telegram, and it always asks. The spending that
    // /recent deleted was not the bot's, and the one from the web never was.
    await telegram.say('/undo');
    expect(telegram.lastMessage().text).toBe('Remove Income €200.00 · Bonus (Tue, Mar 10)?');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Remove', 'Keep']]);
    await telegram.tap('Remove');
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed Income €200.00 · Bonus · Tue, Mar 10\nMarch: income €3,000.00 · Unallocated €2,300.00',
    );
    await page.reload();
    await expectGlance(page, { income: 300000, unallocated: 230000 });
    await telegram.say('/undo');
    expect(telegram.lastMessage().text).toBe('Nothing to undo.');

    // Nothing in progress, and text that is neither a command nor an amount.
    await telegram.say('/cancel');
    expect(telegram.lastMessage().text).toBe('Nothing to cancel.');
    await telegram.say('coffee 4');
    expect(telegram.lastMessage().text).toBe(
      "I didn't understand that. Send /help to see what I can do.",
    );
    await telegram.say('/help');
    expect(telegram.lastMessage().text).toContain('/spending – Record a spending');
  });
});

test.describe('across midnight', () => {
  test.use({ walletNow: '2026-03-10T23:58:00' });

  test('a date button keeps the day it showed, a quick entry takes the day it is tapped on, and Change date fixes it', async ({
    page,
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);

    // The date question is asked on the 10th, and answered after midnight: "Today" was the 10th.
    await telegram.say('/spending');
    await telegram.tap('Groceries');
    await telegram.say('10 bread');
    expect(telegram.lastMessage().text).toBe('€10.00 · Groceries · bread\nWhen?');
    await wallet.setNow('2026-03-11T00:02:00');
    await telegram.tap('Today');
    // 40000 - 1000 = 39000 left, usage floor(2.5) = 2.
    expect(telegram.lastMessage().text).toBe(
      '✅ €10.00 · Groceries · bread · Tue, Mar 10\nGroceries: €390.00 left of €400.00 (2% used)',
    );

    // A quick entry is typed at 23:59 and the budget is tapped after midnight: it is dated by the clock
    // when the tap is handled, the 11th. 3900 - 500 = 3400 left, usage floor(3.75) = 3.
    await wallet.setNow('2026-03-10T23:59:30');
    await telegram.say('5 snack');
    await wallet.setNow('2026-03-11T00:01:00');
    await telegram.tap('Groceries');
    expect(telegram.lastMessage().text).toBe(
      '✅ €5.00 · Groceries · snack · Wed, Mar 11\nGroceries: €385.00 left of €400.00 (3% used)',
    );
    // "Yesterday" is the 10th now: one tap puts it where the owner meant it.
    await telegram.tap('📅 Change date');
    await telegram.tap('Yesterday');
    expect(telegram.lastMessage().text).toBe(
      '✅ €5.00 · Groceries · snack · Tue, Mar 10\nGroceries: €385.00 left of €400.00 (3% used)',
    );

    await page.goto('/spendings');
    await expect(spendingsList(page)).toContainText('2 spendings · €15.00 net.');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Tue, Mar 10, 2026', level: 3 }),
    ).toBeVisible();
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Wed, Mar 11, 2026', level: 3 }),
    ).toHaveCount(0);
  });
});

test.describe('a button acts on one row', () => {
  test('Undo shows the row as the web edited it, and the button of a row that a restore took away removes nothing', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    const { api } = wallet;
    await seedBudgets(api);
    await linkTelegram(api, telegram);
    const spendings = async () =>
      (await json<{ items: SpendingDto[] }>(await api.get('/api/spendings?limit=100'))).items;

    // A spending saved from Telegram and then edited on the web (15.00 and another description):
    // Undo removes it as it is now, and the message says so.
    await telegram.say('9 bread');
    await telegram.tap('Groceries');
    const [bread] = await spendings();
    await api.patch(`/api/spendings/${bread?.id}`, {
      data: { amount: 1500, description: 'bread (edited)' },
    });
    await telegram.tap('↩ Undo');
    // Nothing left in Groceries: 40000 left, usage 0.
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed €15.00 · Groceries · bread (edited) · Tue, Mar 10\nGroceries: €400.00 left of €400.00 (0% used)',
    );
    expect(await spendings()).toEqual([]);

    // A backup, then a spending from Telegram, then the restore takes that spending away. The next
    // spending (from the web) takes its id: a button of the chat still names that number.
    const made = await json<BackupDto>(await api.post('/api/backups'));
    await telegram.say('7 tea');
    await telegram.tap('Groceries');
    const tea = telegram.lastMessage();
    const [teaRow] = await spendings();
    await restoreBackup(wallet, join(wallet.backupDir, made.name));
    await expect.poll(async () => (await getTelegramStatus(api)).connection).toBe('running');
    expect(await spendings()).toEqual([]);
    const lunch = await addSpending(api, {
      date: '2026-03-10',
      amount: 2000,
      budgetId: (await getMonth(api, '2026-03')).budgets[0]?.id ?? 0,
      description: 'Web lunch',
    });
    expect(lunch.id, 'the web spending got the id the restore freed').toBe(teaRow?.id);

    await telegram.tap('↩ Undo', { on: tea });
    expect(telegram.lastToast()).toBe('Already removed.');
    expect(telegram.owner.message(tea.id).buttons).toEqual([]);
    expect((await spendings()).map(({ description }) => description)).toEqual(['Web lunch']);
    await page.goto('/spendings');
    await expect(spendingRow(page, 'Web lunch')).toContainText('€20.00');
  });
});

// ------------------------------------------------------------------------------------------------
// A closed month
// ------------------------------------------------------------------------------------------------

test.describe('a month that is closed', () => {
  /**
   * March 2026 (salary 3,000.00, no subscriptions, Groceries 400.00 and Eating out 200.00, neither
   * incremental): Groceries 300.00 and Eating out 50.00 spent. At its end Groceries has 100.00 and
   * Eating out 150.00 left, which go to savings with the unallocated 3,000.00 - 600.00 = 2,400.00:
   * 2,400.00 + 100.00 + 150.00 = 2,650.00 due.
   */
  async function closedMarch(wallet: Wallet, telegram: FakeTelegram) {
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 300000, openingSavings: 100000 });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
      icon: '🛒',
    });
    const eatingOut = await createBudget(api, {
      name: 'Eating out',
      amount: 20000,
      incremental: false,
      icon: '🍝',
    });
    await addSpending(api, { date: '2026-03-12', amount: 30000, budgetId: groceries.id });
    await addSpending(api, { date: '2026-03-15', amount: 5000, budgetId: eatingOut.id });
    await linkTelegram(api, telegram);
    await wallet.setNow('2026-04-02T08:00:00'); // a Thursday: March is closed, April is current
    expect((await getMonth(api, '2026-03')).status).toBe('closed');
    expect((await getSavings(api)).outstanding.map((entry) => entry.outstanding)).toEqual([265000]);
  }

  test('a late entry asks first, adds on Save and changes what is due to savings; Undo and Change date ask first too', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    await closedMarch(wallet, telegram);

    // Today is Thursday 2 April. The budgets are April's (nothing carries out of a budget that is not incremental).
    await telegram.say('/spending');
    expect(keyboardOf(telegram.lastMessage())).toEqual([
      ['🛒 Groceries · €400.00', '🍝 Eating out · €200.00'],
      ['✖ Cancel'],
    ]);
    await telegram.tap('Groceries');
    await telegram.say('15');
    await telegram.tap('Skip');
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Today', 'Yesterday', 'Earlier…']]);
    await telegram.tap('Earlier…');
    expect(buttonsOf(telegram.lastMessage())).toEqual([
      '31 Tue',
      '30 Mon',
      '29 Sun',
      '28 Sat',
      '27 Fri',
    ]);
    await telegram.tap('31 Tue');
    // March is closed: it asks before it writes anything.
    const question =
      '€15.00 · Groceries · Tue, Mar 31\nMarch is closed. Adding this changes what is due to savings for March.';
    expect(telegram.lastMessage().text).toBe(question);
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Save', 'Other date']]);
    expect((await budgetLine(wallet.api, '2026-03', 'Groceries')).spent).toBe(30000);

    // "Other date" goes back to the days; the same question comes again.
    await telegram.tap('Other date');
    expect(telegram.lastMessage().text).toBe('€15.00 · Groceries\nWhen?');
    await telegram.tap('Earlier…');
    await telegram.tap('31 Tue');
    expect(telegram.lastMessage().text).toBe(question);
    expect((await getSavings(wallet.api)).outstanding[0]?.outstanding).toBe(265000);

    // Save: Groceries in March spent 300.00 + 15.00 = 315.00, 40000 - 31500 = 8500 left, usage floor(78.75) = 78.
    await telegram.tap('Save');
    expect(telegram.lastMessage().text).toBe(
      '✅ €15.00 · Groceries · Tue, Mar 31\nGroceries in March (closed): €85.00 left of €400.00 (78% used)',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['↩ Undo', '📅 Change date']]);
    const march = await budgetLine(wallet.api, '2026-03', 'Groceries');
    expect([march.remaining, march.available, march.usagePercent]).toEqual([8500, 40000, 78]);

    // The web: what March is due drops by 15.00, 2,650.00 - 15.00 = 2,635.00 (the budget leaves 85.00, not 100.00).
    await page.goto('/savings');
    await expectBadge(page, 1);
    const entry = inboxEntry(page, 'March 2026');
    await expect(entry).toContainText('March 2026: move €2,635.00 to savings');
    await expectBreakdown(entry, {
      unallocated: 240000,
      budgetsSettled: 23500, // Groceries 8500 + Eating out 15000
      reservesReleased: 0,
      due: 263500,
      now: 263500,
    });
    // April is untouched by it.
    expect((await budgetLine(wallet.api, '2026-04', 'Groceries')).remaining).toBe(40000);

    // Undo of a spending in a closed month asks first, and "Keep" gives the confirmation back.
    await telegram.tap('↩ Undo');
    expect(telegram.lastMessage().text).toBe(
      '€15.00 · Groceries · Tue, Mar 31\nMarch is closed. Removing this changes what is due to savings for March.',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Remove', 'Keep']]);
    expect((await budgetLine(wallet.api, '2026-03', 'Groceries')).spent).toBe(31500);
    await telegram.tap('Keep');
    expect(telegram.lastMessage().text).toBe(
      '✅ €15.00 · Groceries · Tue, Mar 31\nGroceries in March (closed): €85.00 left of €400.00 (78% used)',
    );
    await telegram.tap('↩ Undo');
    await telegram.tap('Remove');
    // Back to 300.00 spent: 10000 left, usage 75, and 2,650.00 due again.
    expect(telegram.lastMessage().text).toBe(
      '🗑 Removed €15.00 · Groceries · Tue, Mar 31\nGroceries in March (closed): €100.00 left of €400.00 (75% used)',
    );
    expect(telegram.lastMessage().buttons).toEqual([]);
    expect((await getSavings(wallet.api)).outstanding[0]?.outstanding).toBe(265000);
    await page.reload();
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,650.00 to savings',
    );

    // Change date that moves a spending of today into the closed month asks too: 5.00 dated 2 April, then
    // 31 March. April's 5.00 is gone from April (400.00 left again) and March has 95.00 left of 400.00.
    await telegram.say('5 snack');
    await telegram.tap('Groceries');
    expect(telegram.lastMessage().text).toBe(
      '✅ €5.00 · Groceries · snack · Thu, Apr 2\nGroceries: €395.00 left of €400.00 (1% used)',
    );
    await telegram.tap('📅 Change date');
    expect(buttonsOf(telegram.lastMessage())).toEqual([
      'Today',
      'Yesterday',
      '31 Tue',
      '30 Mon',
      '29 Sun',
      '28 Sat',
      '27 Fri',
      '‹ Back',
    ]);
    await telegram.tap('31 Tue');
    expect(telegram.lastMessage().text).toBe(
      '€5.00 · Groceries · snack · Thu, Apr 2\nNew date: Tue, Mar 31\nMarch is closed. Moving this changes what is due to savings for March.',
    );
    expect(keyboardOf(telegram.lastMessage())).toEqual([['Save', 'Other date']]);
    expect((await budgetLine(wallet.api, '2026-04', 'Groceries')).spent).toBe(500);
    await telegram.tap('Save');
    // March: 300.00 + 5.00 spent, 40000 - 30500 = 9500 left, usage floor(76.25) = 76.
    expect(telegram.lastMessage().text).toBe(
      '✅ €5.00 · Groceries · snack · Tue, Mar 31\nGroceries in March (closed): €95.00 left of €400.00 (76% used)',
    );
    expect((await getSavings(wallet.api)).outstanding[0]?.outstanding).toBe(264500);
    expect((await budgetLine(wallet.api, '2026-04', 'Groceries')).remaining).toBe(40000);
    await page.reload();
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,645.00 to savings',
    );
  });
});

// ------------------------------------------------------------------------------------------------
// Notifications
// ------------------------------------------------------------------------------------------------

/** Longer than the 2 seconds an alert check waits for more writes: nothing else is coming after this. */
const QUIET_MS = 3500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test.describe('budget alerts', () => {
  test('a spending entered on the web raises one alert per level crossed, an import commit one message per budget, and a failed send is tried again', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    const { api } = wallet;
    const { groceries, eatingOut, fuel } = await seedBudgets(api);
    const hobby = await createBudget(api, {
      name: 'Hobby',
      amount: 10000,
      incremental: false,
      icon: '🎨',
    });
    await linkTelegram(api, telegram); // the baseline: every budget is "ok"
    /** What the bot said after the greeting. */
    const alerts = () => telegram.texts().slice(1);

    // 1. Through the form: 330.00 of 400.00 is 82%, past the warning at 80%. The web says so at once...
    await page.goto('/spendings');
    await addSpendingViaForm(page, { amount: '330', budget: 'Groceries', description: 'Big shop' });
    await expect(addForm(page).getByRole('status')).toHaveText(
      'Added €330.00 to Groceries. €70.00 left of €400.00. Warning: 82% used.',
    );
    // ...and the bot a couple of seconds later, once: usage floor(100 * 33000 / 40000) = floor(82.5) = 82.
    await telegram.waitForMessage((message) => message.text.startsWith('⚠️ Groceries'), 15_000);
    expect(alerts()).toEqual(['⚠️ Groceries: 82% used, €70.00 left of €400.00']);

    // 2. Another spending in the same level says nothing. 10.00 more on Groceries (85%, still a warning)
    // and 250.00 on Eating out (over its 200.00 by 50.00): only the budget that went up is announced.
    await addSpendingViaForm(page, { amount: '10', budget: 'Groceries', description: 'Bread' });
    await expect(addForm(page).getByRole('status')).toContainText('Warning: 85% used.');
    await addSpendingViaForm(page, { amount: '250', budget: 'Eating out', description: 'Dinner' });
    await expect(addForm(page).getByRole('status')).toContainText('Over budget by €50.00');
    await telegram.waitForMessage((message) => message.text.startsWith('🔴 Eating out'), 15_000);
    expect(alerts()).toEqual([
      '⚠️ Groceries: 82% used, €70.00 left of €400.00',
      '🔴 Eating out is over by €50.00',
    ]);

    // 3. A message that Telegram refuses is not lost: the next check sends it. Fuel 105.00 of 100.00.
    telegram.failNext('sendMessage', 500, {
      when: (params) => String(params['text']).startsWith('🔴 Fuel'),
    });
    await addSpending(api, {
      date: '2026-03-10',
      amount: 10500,
      budgetId: fuel.id,
      description: 'Tank',
    });
    await telegram.waitForCall('sendMessage', (call) => call.status === 500, 15_000);
    expect(alerts()).toHaveLength(2);
    // Any later write asks for a check (Eating out stays over: that level was announced already).
    await addSpending(api, {
      date: '2026-03-10',
      amount: 100,
      budgetId: eatingOut.id,
      description: 'Gum',
    });
    await telegram.waitForMessage((message) => message.text.startsWith('🔴 Fuel'), 15_000);
    expect(alerts()).toEqual([
      '⚠️ Groceries: 82% used, €70.00 left of €400.00',
      '🔴 Eating out is over by €50.00',
      '🔴 Fuel is over by €5.00',
    ]);

    // 4. A CSV import commit is one write: five rows, two budgets that cross, two messages.
    // Groceries 340.00 + 40.00 + 35.00 = 415.00 of 400.00 (over by 15.00); Hobby 40.00 + 40.00 + 25.00
    // = 105.00 of 100.00 (over by 5.00).
    const csv = simpleText([
      '2026-03-04,-40.00,Shop A',
      '2026-03-05,-35.00,Shop B',
      '2026-03-06,-40.00,Craft A',
      '2026-03-07,-40.00,Craft B',
      '2026-03-08,-25.00,Craft C',
    ]);
    await api.post('/api/import/commit', {
      data: {
        csv,
        mapping: SIMPLE_MAPPING,
        rows: [
          { line: 2, budgetId: groceries.id },
          { line: 3, budgetId: groceries.id },
          { line: 4, budgetId: hobby.id },
          { line: 5, budgetId: hobby.id },
          { line: 6, budgetId: hobby.id },
        ],
      },
    });
    await telegram.waitForMessage((message) => message.text.startsWith('🔴 Hobby'), 15_000);
    await sleep(QUIET_MS); // anything that was going to follow the commit would have by now
    expect(alerts()).toEqual([
      '⚠️ Groceries: 82% used, €70.00 left of €400.00',
      '🔴 Eating out is over by €50.00',
      '🔴 Fuel is over by €5.00',
      '🔴 Groceries is over by €15.00',
      '🔴 Hobby is over by €5.00',
    ]);

    // What the web shows for the same budgets (usage is floor(100 * spent / available)).
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 41500,
      remaining: -1500,
      alert: 'over',
      usage: 103,
    });
    await expectBudgetCard(page, 'Eating out', {
      available: 20000,
      spent: 25100,
      remaining: -5100,
      alert: 'over',
      usage: 125,
    });
    await expectBudgetCard(page, 'Fuel', {
      available: 10000,
      spent: 10500,
      remaining: -500,
      alert: 'over',
      usage: 105,
    });
    await expectBudgetCard(page, 'Hobby', {
      available: 10000,
      spent: 10500,
      remaining: -500,
      alert: 'over',
      usage: 105,
    });
  });

  test('a spending recorded in Telegram shows its own warning and its own over mark, and no second message follows', async ({
    wallet,
    telegram,
  }) => {
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);

    await telegram.say('330 shop');
    await telegram.tap('Groceries');
    // 40000 - 33000 = 7000 left, usage 82, warning at 80.
    expect(telegram.lastMessage().text).toBe(
      '✅ €330.00 · Groceries · shop · Tue, Mar 10\n⚠️ Groceries: €70.00 left of €400.00 (82% used, warning at 80%)',
    );
    await telegram.say('250 dinner');
    await telegram.tap('Eating out');
    // 20000 - 25000 = -5000: over by 50.00, 125% of 200.00.
    expect(telegram.lastMessage().text).toBe(
      '✅ €250.00 · Eating out · dinner · Tue, Mar 10\n🔴 Eating out: over by €50.00 (125% of €200.00 used)',
    );
    // The confirmations were the messages: the alert watcher is told what they showed, and stays quiet.
    await sleep(QUIET_MS);
    expect(telegram.texts()).toHaveLength(3); // the greeting and the two confirmations
  });
});

test.describe('renewals and the monthly recap', () => {
  // The link is made on 14 March, before April begins. The clock then goes to the 14th at 09:00 and to
  // 1 April at 09:00, and the scheduler (a real minute timer that reads the fake clock) acts at its next ticks.
  test.use({
    walletNow: '2026-03-14T08:30:00',
    telegramBot: { appUrl: 'https://wallet.example.test' },
  });

  test('a reminder the day before and the recap on the 1st, each once, with the figures of the web', async ({
    page,
    wallet,
    telegram,
  }) => {
    // Up to three ticks of a minute: the reminder, the recap, and one more to see that nothing repeats.
    test.setTimeout(480_000);
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 300000, openingSavings: 100000 });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
      icon: '🛒',
    });
    const eatingOut = await createBudget(api, {
      name: 'Eating out',
      amount: 20000,
      incremental: false,
      icon: '🍝',
    });
    const fuel = await createBudget(api, {
      name: 'Fuel',
      amount: 10000,
      incremental: true,
      icon: '⛽',
    });
    // Streaming bills on the 15th (tomorrow), Gym on the 2nd (next on 2 April), Domain yearly on 21 March.
    await createSubscription(api, {
      name: 'Streaming',
      frequency: 'monthly',
      anchorDate: '2026-03-15',
      amount: 1250,
    });
    await createSubscription(api, {
      name: 'Gym',
      frequency: 'monthly',
      anchorDate: '2026-03-02',
      amount: 3000,
    });
    await createSubscription(api, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2026-03-21',
      amount: 1500,
    });
    await addSpending(api, { date: '2026-03-05', amount: 30000, budgetId: groceries.id });
    await addSpending(api, { date: '2026-03-08', amount: 25000, budgetId: eatingOut.id });
    await addSpending(api, { date: '2026-03-09', amount: 4000, budgetId: fuel.id });
    await linkTelegram(api, telegram);
    // March by hand: salary 3,000.00, fixed costs 12.50 + 30.00 + 15.00 (Domain renews in its own start
    // month, so the whole price) = 57.50, budgets 700.00: unallocated 3,000.00 - 57.50 - 700.00 = 2,242.50.
    expect((await getMonth(api, '2026-03')).unallocated).toBe(224250);

    // 14 March, 09:00: tomorrow is Streaming's day, and Domain renews in 7 days (the yearly lead). Gym is
    // 19 days away. Domain renews in the month it started, so the whole price is set aside.
    await wallet.setNow('2026-03-14T09:00:05');
    const first = await telegram.waitForMessage(
      (message) => message.text.startsWith('🔔'),
      100_000,
    );
    expect(first.text).toBe(
      '🔔 Renewals\nStreaming · tomorrow (Sun, Mar 15) · €12.50\nDomain · in 7 days (Sat, Mar 21) · €15.00 · set aside ✅',
    );
    const upcoming = await json<
      {
        name: string;
        date: string;
        daysUntil: number;
        amount: number;
        reserved: number | null;
        unreserved: number | null;
      }[]
    >(await api.get('/api/subscriptions/upcoming?days=30'));
    expect(
      upcoming.map(({ name, date, daysUntil, amount, reserved, unreserved }) => [
        name,
        date,
        daysUntil,
        amount,
        reserved,
        unreserved,
      ]),
    ).toEqual([
      ['Streaming', '2026-03-15', 1, 1250, null, null],
      ['Domain', '2026-03-21', 7, 1500, 1500, 0],
      ['Gym', '2026-04-02', 19, 3000, null, null],
    ]);

    // 1 April, 09:00: March is closed. Gym is due tomorrow (the 2nd), and the recap goes out.
    await wallet.setNow('2026-04-01T09:00:05');
    const recap = await telegram.waitForMessage(
      (message) => message.text.startsWith('📅'),
      100_000,
    );
    const recapAt = Date.now();
    // March by hand. Spent 300.00 + 250.00 + 40.00 = 590.00. Left: Groceries 100.00, Eating out -50.00,
    // Fuel 60.00 = 110.00. Over: Eating out by 50.00. Carried into April: Fuel's 60.00 (the others settle
    // with savings). Due: 2,242.50 unallocated + 100.00 - 50.00 = 2,292.50, not settled yet.
    expect(recap.text).toBe(
      [
        '📅 March 2026 is closed',
        'Spent €590.00 · €110.00 left over',
        '🔴 Over: Eating out by €50.00',
        '↪ Carried into April: €60.00',
        '💰 Due to savings: €2,292.50 · not settled yet',
      ].join('\n'),
    );
    expect(recap.buttons).toEqual([
      [{ text: 'Open savings', data: null, url: 'https://wallet.example.test/savings' }],
    ]);
    expect(telegram.texts().slice(1)).toEqual([
      first.text,
      '🔔 Renewals\nGym · tomorrow (Thu, Apr 2) · €30.00',
      recap.text,
    ]);

    // The same March on the web: the view, the dashboard of the month and the savings inbox.
    const march = await getMonth(api, '2026-03');
    expect(march.status).toBe('closed');
    expect([march.totals.spent, march.totals.remaining, march.savingsDue.total]).toEqual([
      59000, 11000, 229250,
    ]);
    expect(march.budgets.reduce((sum, line) => sum + line.carriedOut, 0)).toBe(6000);
    await page.goto('/dashboard?month=2026-03');
    await expectGlance(page, { spent: 59000, fixedCosts: 5750, unallocated: 224250 });
    await page.goto('/savings');
    await expectBadge(page, 1);
    await expect(inboxEntry(page, 'March 2026')).toContainText(
      'March 2026: move €2,292.50 to savings',
    );

    // Neither is sent again at the next tick: a minute after the one that sent them (and a margin).
    await sleep(Math.max(0, recapAt + 66_000 - Date.now()));
    expect(telegram.texts()).toHaveLength(4); // the greeting, two reminders, the recap
  });
});

// ------------------------------------------------------------------------------------------------
// A restart
// ------------------------------------------------------------------------------------------------

test.describe('a restart of the server', () => {
  test('keeps the link, keeps the buttons of what was saved, makes a flow of before stale, and answers what was said while it was down', async ({
    page,
    wallet,
    telegram,
  }) => {
    test.slow();
    await seedBudgets(wallet.api);
    await linkTelegram(wallet.api, telegram);

    // Two saved spendings, and a flow that is waiting for a budget.
    await telegram.say('9 bread');
    await telegram.tap('Groceries');
    const bread = telegram.lastMessage();
    expect(bread.text).toBe(
      '✅ €9.00 · Groceries · bread · Tue, Mar 10\nGroceries: €391.00 left of €400.00 (2% used)',
    );
    await telegram.say('6 milk');
    await telegram.tap('Groceries');
    const milk = telegram.lastMessage();
    expect(milk.text).toBe(
      '✅ €6.00 · Groceries · milk · Tue, Mar 10\nGroceries: €385.00 left of €400.00 (3% used)',
    );
    await telegram.say('/spending');
    const openFlow = telegram.lastMessage();
    expect(openFlow.text).toBe('Which budget?');

    // The server goes down, and the owner writes while it is down: Telegram keeps the message.
    await wallet.stop();
    await telegram.say('3,20 tea', { wait: false });
    await wallet.start();

    // The link is in the database: it came back with the server.
    await expect.poll(async () => (await getTelegramStatus(wallet.api)).link?.name).toBe('Olivia');
    await openSettings(page);
    await expect(fact(page, 'Linked account')).toHaveText('Olivia');
    // What was said while it was down is answered now, as a new quick entry.
    const prompt = await telegram.waitForMessage(
      (message) => message.text === '€3.20 · tea. Which budget?',
      20_000,
    );

    // The flow of before is gone with the old process: its button is stale, and loses its keyboard.
    await telegram.tap('Groceries', { on: openFlow });
    expect(telegram.lastToast()).toBe(EXPIRED_BUTTON);
    expect(telegram.owner.message(openFlow.id).buttons).toEqual([]);

    // The buttons of what was saved carry the row, not a flow: they work after the restart.
    // Undo of the bread: 600 spent, 39400 left, usage floor(1.5) = 1.
    await telegram.tap('↩ Undo', { on: bread });
    expect(telegram.owner.message(bread.id).text).toBe(
      '🗑 Removed €9.00 · Groceries · bread · Tue, Mar 10\nGroceries: €394.00 left of €400.00 (1% used)',
    );
    // Change date of the milk, to yesterday.
    await telegram.tap('📅 Change date', { on: milk });
    await telegram.tap('Yesterday', { on: milk });
    expect(telegram.owner.message(milk.id).text).toBe(
      '✅ €6.00 · Groceries · milk · Mon, Mar 9\nGroceries: €394.00 left of €400.00 (1% used)',
    );

    // And the quick entry that was waiting is still there: today is the day the clock resumed on.
    // 600 + 320 = 920 spent, 39080 left, usage floor(2.3) = 2.
    await telegram.tap('Groceries', { on: prompt });
    expect(telegram.owner.message(prompt.id).text).toBe(
      '✅ €3.20 · Groceries · tea · Tue, Mar 10\nGroceries: €390.80 left of €400.00 (2% used)',
    );

    await page.goto('/spendings');
    await expect(spendingsList(page)).toContainText('2 spendings · €9.20 net.');
    await expect(spendingRow(page, 'milk')).toContainText('€6.00');
    await expect(
      spendingsList(page).getByRole('heading', { name: 'Mon, Mar 9, 2026', level: 3 }),
    ).toBeVisible();
    await expect(spendingRow(page, 'bread')).toHaveCount(0);
    await page.goto('/budgets');
    await expectBudgetCard(page, 'Groceries', {
      available: 40000,
      spent: 920,
      remaining: 39080,
      alert: 'ok',
      usage: 2,
    });
  });
});

// ------------------------------------------------------------------------------------------------
// What the bot keeps
// ------------------------------------------------------------------------------------------------

test.describe('the data of the bot', () => {
  test.use({ allowedConsoleErrors: [failedResponse(503, /\/api\/telegram\/test$/)] });

  test('a restored backup brings the link and the preferences back, and the bot answers its owner again', async ({
    page,
    wallet,
    telegram,
  }) => {
    const { api } = wallet;
    await seedBudgets(api);
    await linkTelegram(api, telegram);
    const preferences = {
      budgetAlerts: false,
      renewalYearlyDays: 3,
      renewalMonthlyDays: 2,
      monthlyRecap: false,
      notifyAt: '07:45',
    };
    await api.put('/api/telegram/notifications', { data: preferences });
    const made = await json<BackupDto>(await api.post('/api/backups'));

    // After the backup: unlinked, and other preferences.
    await api.delete('/api/telegram/link');
    await api.put('/api/telegram/notifications', {
      data: { ...preferences, budgetAlerts: true, renewalYearlyDays: 7, notifyAt: '09:00' },
    });
    await telegram.say('/status');
    const silent = telegram.messages().length;
    expect((await getTelegramStatus(api)).link).toBeNull();

    // The README's restore: stop, move the database aside, copy the backup in, start.
    await restoreBackup(wallet, join(wallet.backupDir, made.name));
    await expect.poll(async () => (await getTelegramStatus(api)).connection).toBe('running');
    const status = await getTelegramStatus(api);
    expect(status.link).toMatchObject({ name: 'Olivia', username: 'olivia' });
    expect(status.notifications).toEqual(preferences);

    // The owner is answered again (the stored user id is what lets them in), a stranger still is not.
    await telegram.say('/status');
    expect(telegram.messages()).toHaveLength(silent + 1);
    expect(telegram.lastMessage().text).toContain('Groceries · €400.00 left of €400.00 (0%)');
    await telegram.as(STRANGER).say('/status');
    expect(telegram.as(STRANGER).messages()).toEqual([]);

    await openSettings(page);
    await expect(fact(page, 'Linked account')).toHaveText('Olivia');
    await expectNotificationFields(page, {
      budgetAlerts: false,
      yearly: '3',
      monthly: '2',
      monthlyRecap: false,
      notifyAt: '07:45',
    });
  });

  test('the bot token never reaches the API, the pages, the log, the database or a backup', async ({
    page,
    wallet,
    telegram,
  }) => {
    const { api } = wallet;
    const secret = FAKE_BOT_TOKEN.split(':')[1] ?? '';
    expect(secret.length).toBeGreaterThan(20);
    await seedBudgets(api);
    await linkTelegram(api, telegram);

    // Make the bot log what goes wrong with Telegram: a connection that dies (whose error names the
    // address, which holds the token), an answer that is an error, and a Telegram that is down.
    telegram.dropNext('sendMessage', 1);
    expect((await api.post('/api/telegram/test', { failOnStatusCode: false })).status()).toBe(503);
    telegram.failNext('sendMessage', 500);
    expect((await api.post('/api/telegram/test', { failOnStatusCode: false })).status()).toBe(503);
    expect((await api.post('/api/telegram/test')).status()).toBe(204);
    telegram.failAlways('getUpdates', 502);
    await expect.poll(async () => (await getTelegramStatus(api)).problem).toBe('unreachable');
    telegram.heal();
    await api.post('/api/backups');
    // The server logged those failures (so the check below looks at something).
    expect(wallet.log()).toMatch(/could not send a message/);
    // ...and that where the address of Telegram was in an error, the token was taken out of it.
    expect(wallet.log()).toContain('[redacted]');

    const everything: [what: string, text: string][] = [
      ['the Telegram status', await (await api.get('/api/telegram')).text()],
      ['the settings', await (await api.get('/api/settings')).text()],
      ['the page that serves the app', await (await api.get('/')).text()],
      ['the server log', wallet.log()],
    ];
    await openSettings(page);
    everything.push(['the Settings page', await page.locator('body').innerText()]);
    for (const [what, text] of everything) {
      expect(text, `${what} holds the token`).not.toContain(secret);
      expect(text, `${what} holds the token`).not.toContain(FAKE_BOT_TOKEN);
    }

    // On disk: the database (its log is folded in when the server stops) and every backup.
    await wallet.stop();
    const files: string[] = [];
    for (const entry of await readdir(wallet.dir, { recursive: true })) {
      const path = join(wallet.dir, entry);
      if ((await stat(path)).isFile()) files.push(path);
    }
    expect(files.some((file) => file.endsWith('wallet.db'))).toBe(true);
    expect(files.filter((file) => file.includes('backups'))).not.toEqual([]);
    for (const file of files) {
      const bytes = await readFile(file);
      expect(bytes.includes(secret), `${file.replace(wallet.dir, '')} holds the token`).toBe(false);
    }
  });
});
