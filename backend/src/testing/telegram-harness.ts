/**
 * The bot, wired for a test with no network: an in-memory database with the migrations applied, a
 * clock, the fake Bot API (`FakeBotApi`) and the real bot built by `createTelegramBot`. A test sends
 * updates with `say()` / `tap()` (which call `bot.handleUpdate()`) and reads what the bot did from
 * `fake.calls` and `fake.sentTexts()`.
 *
 * It is the harness of the guard tests, and meant to be reused by the tests of the flows and the
 * notifications. The bot token is a fixed fake, `TOKEN`, so tests can check that it never leaks.
 */
import { vi } from 'vitest';
import { createDb, runMigrations } from '../db/client';
import { createTelegramBot } from '../modules/telegram/telegram.runtime';
import { createTelegramLog } from '../modules/telegram/telegram.log';
import type { TelegramNotify } from '../modules/telegram/telegram.notifications';
import { findLink } from '../modules/telegram/telegram.access';
import type { TelegramContext } from '../modules/telegram/telegram.types';
import {
  FakeBotApi,
  OWNER,
  type Person,
  type UpdateOptions,
  callbackUpdate,
  messageUpdate,
} from './fake-bot-api';
import { linkTelegramAccount } from './fake-telegram';
import { mutableClock } from './helpers';

/** A token shaped like @BotFather's, never a real one. */
export const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk';

export interface BotHarnessOptions {
  /** The clock's start (default 2026-03-15T10:00:00Z). */
  now?: string;
  /** Link this person from the start (default: nobody is linked). */
  linked?: Person | null;
  /** `APP_URL` as the bot sees it. */
  appUrl?: string;
}

export function createBotHarness(options: BotHarnessOptions = {}) {
  const { now = '2026-03-15T10:00:00Z', linked = null, appUrl } = options;
  const db = createDb(':memory:');
  runMigrations(db);
  const clock = mutableClock(now);
  const fake = new FakeBotApi();

  /** Everything the module logged, already redacted. */
  const logged: string[] = [];
  const log = createTelegramLog(TOKEN, {
    log: (message: string) => logged.push(message),
    error: (message: string) => logged.push(message),
  });

  const notify: { [K in keyof TelegramNotify]: ReturnType<typeof vi.fn> } = {
    recordBaseline: vi.fn(),
    markNotified: vi.fn(),
    checkBudgetAlerts: vi.fn(async () => undefined),
    scheduleBudgetAlertCheck: vi.fn(),
    stop: vi.fn(),
  };

  const tg: TelegramContext = {
    db,
    clock,
    config: { appUrl },
    notify: notify as unknown as TelegramNotify,
    sendToLinked: async (text, extra) => {
      const link = findLink(db);
      if (!link) throw new Error('not linked');
      await bot.api.sendMessage(link.chatId, text, extra);
    },
    log,
  };
  const bot = createTelegramBot(tg, {
    token: TOKEN,
    botInfo: fake.me,
    transformer: fake.transformer,
  });

  const linkPerson = (person: Person) => linkTelegramAccount(db, person);
  if (linked) linkPerson(linked);

  return {
    db,
    clock,
    fake,
    bot,
    tg,
    notify,
    logged,
    linkPerson,
    /** The owner (or `from`) writes `text` to the bot. */
    say: (text: string, update?: UpdateOptions) => bot.handleUpdate(messageUpdate(text, update)),
    /** The owner (or `from`) taps a button whose callback data is `data`. */
    tap: (data: string, update?: UpdateOptions) => bot.handleUpdate(callbackUpdate(data, update)),
  };
}

export type BotHarness = ReturnType<typeof createBotHarness>;

export { OWNER };
