import type { Locator, Page } from '@playwright/test';
import type { FakeTelegram } from './fake-telegram';
import { OWNER } from './fake-telegram';
import { expect, type Wallet } from './fixtures';
import { chooseMenuItem, moreActions } from './menu';
import { expectDialogOpen, openDialog, settle, type Stop } from './pages';
import { getTelegramStatus, linkTelegram } from './seed';
import {
  connectingNotice,
  makeCode,
  notificationsRegion,
  openSettings,
  sectionAlert,
  telegramSection,
} from './telegram-ui';

/*
 * The states of the Telegram section of Settings, as stops for the sweeps and the screenshots
 * (`a11y.spec.ts`, `mobile.spec.ts`, `visual.spec.ts`), next to the stops of `richStops()` in `pages.ts`.
 *
 * The state of this section lives in the server and in Telegram, not in the page, so a stop first brings
 * the bot to its state (`arrange`) and then opens Settings from the address, like every stop. A server
 * that has no token is the "not configured" state, which is the ordinary `settings` stop; the others need
 * the bot (`test.use({ telegramBot: true })`) and its fake Bot API, which the stops are given.
 *
 * A stop does not depend on the one before it: `arrange` ends whatever the previous one left (a failure
 * that was made, a held connection, a link, a code), restarting the server where the bot had given up
 * (a wrong token stays off until Wallet restarts).
 */

/** What a stop needs: the server of the test, and the fake Telegram it talks to. */
export interface TelegramWorld {
  wallet: Wallet;
  telegram: FakeTelegram;
}

export type BotState =
  'connecting' | 'ready' | 'linked' | 'invalid_token' | 'conflict' | 'blocked' | 'unreachable';

/** The gate that holds the bot "connecting", per fake (released when the next state is arranged). */
const gates = new WeakMap<FakeTelegram, { release(): void }>();

async function connection(world: TelegramWorld): Promise<string> {
  const status = await getTelegramStatus(world.wallet.api);
  return `${status.connection}/${status.problem}`;
}

async function waitForConnection(world: TelegramWorld, expected: string): Promise<void> {
  await expect
    .poll(() => connection(world), { message: `the bot's connection, wanted ${expected}` })
    .toBe(expected);
}

/** A server that has been started again: Wallet restarts as a service manager does it. */
async function restart(world: TelegramWorld): Promise<void> {
  await world.wallet.stop();
  await world.wallet.start();
}

/**
 * Brings the bot to a clean, running, unlinked state with no code: no failure in the fake, no held
 * call, nobody blocked, nothing linked and no pending code.
 */
async function reset(world: TelegramWorld): Promise<void> {
  const { wallet, telegram } = world;
  telegram.heal();
  telegram.unblock(OWNER);
  gates.get(telegram)?.release();
  gates.delete(telegram);

  const before = await getTelegramStatus(wallet.api);
  // A bot that gave up, or is retrying after 30 seconds, or is held: a restart is the quick way back.
  if (before.connection !== 'running' || before.problem !== null) await restart(world);
  await waitForConnection(world, 'running/null');
  await telegram.waitUntilPolling();

  if ((await getTelegramStatus(wallet.api)).link) {
    await wallet.api.delete('/api/telegram/link');
  }
  await wallet.api.delete('/api/telegram/pairing');
}

/** Puts the bot in `state` (the page is not touched). */
export async function arrange(world: TelegramWorld, state: BotState): Promise<void> {
  const { wallet, telegram } = world;
  await reset(world);
  switch (state) {
    case 'ready':
      return;
    case 'connecting': {
      const gate = telegram.hold('getMe');
      gates.set(telegram, gate);
      await restart(world);
      await waitForConnection(world, 'connecting/null');
      return;
    }
    case 'linked':
      await linkTelegram(wallet.api, telegram);
      return;
    case 'invalid_token':
      // Telegram answers every call of a token it does not know with a 401.
      telegram.failAlways('*', 401);
      await restart(world);
      await waitForConnection(world, 'error/invalid_token');
      return;
    case 'conflict':
      telegram.failAlways('getUpdates', 409);
      await waitForConnection(world, 'error/conflict');
      return;
    case 'unreachable':
      telegram.failAlways('getUpdates', 502);
      await waitForConnection(world, 'error/unreachable');
      return;
    case 'blocked': {
      await linkTelegram(wallet.api, telegram);
      telegram.block(OWNER);
      // Wallet finds out when it writes to the chat: the test message is how.
      const refused = await wallet.api.post('/api/telegram/test', { failOnStatusCode: false });
      expect(refused.status()).toBe(503);
      await waitForConnection(world, 'error/blocked');
      return;
    }
  }
}

/** The button that does the page's main thing in a dialog: the last one (Cancel comes first). */
const dialogPrimary = (page: Page): Locator => openDialog(page).getByRole('button').last();

/**
 * Settings with the Telegram section in each state of the table in `docs/TELEGRAM-PLAN.md` that needs a
 * bot, plus the confirmations of Re-link and Unlink and the menu that opens them. "Not configured" is
 * the plain `settings` stop (a server with no token).
 */
export function telegramStops(source: TelegramWorld | (() => TelegramWorld)): Stop[] {
  // A function lets a spec list the stops (their names, for the titles of its tests) before the server
  // of any test exists: the world is read when a stop is opened.
  const world = () => (typeof source === 'function' ? source() : source);
  const section = (page: Page) => telegramSection(page);

  function stop(
    name: string,
    state: BotState,
    extra: {
      then?: (page: Page) => Promise<void>;
      primary?: Stop['primary'];
      modal?: boolean;
      menu?: boolean;
    } = {},
  ): Stop {
    return {
      name: `settings > Telegram, ${name}`,
      modal: extra.modal,
      menu: extra.menu,
      primary: extra.primary,
      open: async (page) => {
        // The page of the stop before reads the status every 3 seconds while a code is pending or the bot
        // is connecting: leave it before the server is restarted, or its request is refused (and logged).
        await page.goto('about:blank');
        await arrange(world(), state);
        await openSettings(page);
        await extra.then?.(page);
        await settle(page);
      },
    };
  }

  return [
    stop('connecting', 'connecting', {
      then: (page) => expect(connectingNotice(page)).toBeVisible(),
      primary: (page) => section(page).getByRole('button', { name: 'Link Telegram' }),
    }),
    stop('ready to link', 'ready', {
      primary: (page) => section(page).getByRole('button', { name: 'Link Telegram' }),
    }),
    stop('pairing code', 'ready', {
      then: async (page) => {
        await makeCode(page);
        await expect(section(page).getByRole('link', { name: /Open in Telegram/ })).toBeVisible();
      },
      primary: (page) => section(page).getByRole('link', { name: /Open in Telegram/ }),
    }),
    stop('code expired', 'ready', {
      then: async (page) => {
        await makeCode(page);
        // A code lasts 10 minutes of the server's clock; the page finds out at its next read (3 s).
        const { wallet } = world();
        await wallet.setNow(
          new Date(Date.parse(await wallet.getNow()) + 11 * 60_000).toISOString(),
        );
        await expect(sectionAlert(page, 'The code expired')).toBeVisible({ timeout: 15_000 });
      },
      primary: (page) => section(page).getByRole('button', { name: 'Create a new code' }),
    }),
    stop('linked', 'linked', {
      primary: (page) => section(page).getByRole('button', { name: 'Send test message' }),
    }),
    stop('linked, test message sent', 'linked', {
      then: async (page) => {
        await section(page).getByRole('button', { name: 'Send test message' }).click();
        await expect(sectionAlert(page, 'Test message sent')).toBeVisible();
      },
    }),
    stop('linked, notification settings with errors', 'linked', {
      then: async (page) => {
        const form = notificationsRegion(page);
        await form.getByLabel('Yearly renewals: days before').fill('31');
        await form.getByLabel('Monthly renewals: days before').fill('-1');
        await form.getByRole('button', { name: 'Save notification settings' }).click();
        await expect(form.locator('[aria-invalid="true"]').first()).toBeVisible();
      },
      primary: (page) =>
        notificationsRegion(page).getByRole('button', { name: 'Save notification settings' }),
    }),
    stop('wrong token', 'invalid_token'),
    stop('another program uses the bot', 'conflict'),
    stop("can't be reached", 'unreachable'),
    stop('bot blocked', 'blocked', {
      then: (page) => expect(sectionAlert(page, 'You blocked the bot')).toBeVisible(),
    }),
    stop('menu open', 'linked', {
      menu: true,
      then: async (page) => {
        const button = moreActions(section(page));
        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
      },
    }),
    stop('Unlink confirmation', 'linked', {
      modal: true,
      primary: dialogPrimary,
      then: async (page) => {
        await chooseMenuItem(moreActions(section(page)), 'Unlink');
        await expectDialogOpen(page);
      },
    }),
    stop('Re-link confirmation', 'linked', {
      modal: true,
      primary: dialogPrimary,
      then: async (page) => {
        await chooseMenuItem(moreActions(section(page)), 'Re-link');
        await expectDialogOpen(page);
      },
    }),
  ];
}
