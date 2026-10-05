/**
 * A `TelegramHandle` for the route tests: `createApp({ telegram: fakeTelegram(db) })`. It records what
 * would have been sent and lets a test choose the connection state and make a send fail. Like the
 * real runtime it reads the linked chat from the database, and refuses a send while nobody is linked.
 */
import { vi } from 'vitest';
import { createApp } from '../app';
import { type Db, createDb, runMigrations } from '../db/client';
import { telegramLink } from '../db/schema';
import { type Clock, fixedClock } from '../lib/clock';
import { findLink } from '../modules/telegram/telegram.access';
import type { TelegramNotify } from '../modules/telegram/telegram.notifications';
import {
  type TelegramHandle,
  type TelegramLog,
  type TelegramRuntimeStatus,
  type TelegramSendExtra,
  TelegramSendError,
} from '../modules/telegram/telegram.types';

export interface SentMessage {
  chatId: number;
  text: string;
  extra: TelegramSendExtra | undefined;
}

export interface FakeTelegram extends TelegramHandle {
  /** Every message that was accepted, in order. */
  readonly sent: SentMessage[];
  /** Every message that was tried, accepted or not (an unlink notice that failed is in here only). */
  readonly attempts: SentMessage[];
  readonly notify: { [K in keyof TelegramNotify]: ReturnType<typeof vi.fn> } & TelegramNotify;
  readonly logLines: string[];
  setStatus(status: Partial<TelegramRuntimeStatus>): void;
  /** The next send rejects with `error` (default: a refusal by Telegram). */
  failNextSend(error?: Error): void;
  stopped: boolean;
}

export function fakeTelegram(db: Db, initial: Partial<TelegramRuntimeStatus> = {}): FakeTelegram {
  let status: TelegramRuntimeStatus = {
    connection: 'running',
    problem: null,
    bot: { username: 'wallet_test_bot' },
    ...initial,
  };
  const sent: SentMessage[] = [];
  const attempts: SentMessage[] = [];
  const logLines: string[] = [];
  let failure: Error | undefined;

  const log: TelegramLog = {
    info: (message) => logLines.push(message),
    error: (message) => logLines.push(message),
  };
  const notify = {
    recordBaseline: vi.fn(),
    markNotified: vi.fn(),
    checkBudgetAlerts: vi.fn(async () => undefined),
    scheduleBudgetAlertCheck: vi.fn(),
    stop: vi.fn(),
  };

  const sendMessage = async (chatId: number, text: string, extra?: TelegramSendExtra) => {
    attempts.push({ chatId, text, extra });
    if (failure) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    sent.push({ chatId, text, extra });
  };

  const fake: FakeTelegram = {
    sent,
    attempts,
    notify: notify as unknown as FakeTelegram['notify'],
    logLines,
    log,
    stopped: false,
    status: () => status,
    setStatus: (next) => {
      status = { ...status, ...next };
    },
    failNextSend: (
      error = new TelegramSendError('refused', 'Telegram did not accept the message'),
    ) => {
      failure = error;
    },
    sendMessage,
    sendToLinked: async (text, extra) => {
      const link = findLink(db);
      if (!link) throw new TelegramSendError('not_linked', 'No Telegram account is linked');
      await sendMessage(link.chatId, text, extra);
    },
    stop: async () => {
      fake.stopped = true;
    },
  };
  return fake;
}

/**
 * Links `person` straight in the database, as a successful pairing would have (the chat is the
 * private chat of the user, whose id is the user's).
 */
export function linkTelegramAccount(
  db: Db,
  person: { id: number; first_name: string; username?: string },
  linkedAt = '2026-03-01T08:00:00.000Z',
): void {
  const values = {
    userId: person.id,
    chatId: person.id,
    firstName: person.first_name,
    username: person.username ?? null,
    linkedAt,
  };
  db.insert(telegramLink)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: telegramLink.id, set: values })
    .run();
}

/**
 * An in-memory app wired to a `fakeTelegram`, like `createTestApp` (src/testing/test-app.ts) is
 * wired to no bot at all. The clock can be a `mutableClock`, to move time.
 */
export function createTelegramTestApp(
  clock: Clock = fixedClock('2026-03-15T10:00:00Z'),
  status: Partial<TelegramRuntimeStatus> = {},
) {
  const db = createDb(':memory:');
  runMigrations(db);
  const telegram = fakeTelegram(db, status);
  const app = createApp({ db, clock, config: { env: 'test', staticDir: undefined }, telegram });
  return { app, db, clock, telegram };
}
