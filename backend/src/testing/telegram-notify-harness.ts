/**
 * A setup for the tests of the notifications (budget alerts, renewal reminders, the monthly recap
 * and the scheduler): an in-memory database, a clock a test can move, a fake handle that records
 * what was sent (`fakeTelegram`) with the REAL alert watcher (`createTelegramNotify`) in place of its
 * mock, and an app without a bot to set the facts up through the API (so that a setup call never
 * triggers the write hook).
 *
 * Time. The clock is a `mutableClock`; the tests run with `TZ=UTC`, so a zone-less ISO instant is
 * the server's local time. `link` is when the owner linked (the default is early March 2026).
 * Sending. `failSends(1)` makes the next send fail, `failSends(2)` the one after it (`failSendsWith`
 * fails it with a given error, such as one that carries Telegram's error code); `blockSends()`
 * holds every send until the returned function is called, to test what happens while Telegram is
 * slow. `sent` is what Telegram accepted, `attempts` everything that was tried.
 */
import type { TelegramNotificationSettingsInput } from '@wallet/shared';
import { vi } from 'vitest';
import { createApp } from '../app';
import { createDb, runMigrations } from '../db/client';
import { telegramNotifications } from '../db/schema';
import {
  getTelegramNotificationSettings,
  saveTelegramNotificationSettings,
} from '../modules/telegram/telegram.service';
import { createTelegramNotify } from '../modules/telegram/telegram.notifications';
import {
  type TelegramScheduler,
  startTelegramScheduler,
} from '../modules/telegram/telegram.scheduler';
import type {
  TelegramHandle,
  TelegramRuntimeStatus,
  TelegramSendExtra,
} from '../modules/telegram/telegram.types';
import { OWNER } from './fake-bot-api';
import { fakeTelegram, linkTelegramAccount } from './fake-telegram';
import { mutableClock } from './helpers';

export interface NotifyHarnessOptions {
  /** The clock's start (default 2026-03-15T10:00:00Z). */
  now?: string;
  /** When the owner linked, or null for nobody (default 2026-03-01T08:00:00.000Z). */
  linkedAt?: string | null;
  /** `APP_URL` as the notifications see it. */
  appUrl?: string;
  /** The connection state of the fake bot (default `running`). */
  status?: Partial<TelegramRuntimeStatus>;
  /** The debounce of the alert check (default 2 s, as in production). */
  debounceMs?: number;
}

export function createNotifyHarness(options: NotifyHarnessOptions = {}) {
  const { now = '2026-03-15T10:00:00Z', appUrl, status, debounceMs } = options;
  const linkedAt = options.linkedAt === undefined ? '2026-03-01T08:00:00.000Z' : options.linkedAt;

  const db = createDb(':memory:');
  runMigrations(db);
  const clock = mutableClock(now);
  const fake = fakeTelegram(db, status);
  if (linkedAt !== null) linkTelegramAccount(db, OWNER, linkedAt);

  // --- Sends: a way to fail the nth one, and a way to hold them back ------------------------
  let calls = 0;
  const failing = new Map<number, Error | undefined>();
  let gate: Promise<void> | undefined;
  const sendToLinked = async (text: string, extra?: TelegramSendExtra): Promise<void> => {
    calls++;
    if (gate) await gate;
    if (failing.has(calls)) {
      fake.failNextSend(failing.get(calls));
      failing.delete(calls);
    }
    await fake.sendToLinked(text, extra);
  };

  /** Counts every look at the connection state, which every check makes once. */
  const statusSpy = vi.fn(() => fake.status());
  const notify = createTelegramNotify({
    db,
    clock,
    config: { appUrl },
    status: statusSpy,
    sendToLinked,
    log: fake.log,
    debounceMs,
  });
  const telegram: TelegramHandle = { ...fake, status: statusSpy, sendToLinked, notify };

  const schedulers: TelegramScheduler[] = [];
  /** A scheduler on this database. `tickEveryMs` is huge by default: tests call `tick()`. */
  const startScheduler = (tickEveryMs = 2_000_000_000): TelegramScheduler => {
    const scheduler = startTelegramScheduler({
      db,
      clock,
      config: { appUrl },
      telegram,
      tickEveryMs,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  return {
    db,
    clock,
    fake,
    notify,
    telegram,
    statusSpy,
    /** The app without a bot, for setup calls through the API. */
    setup: createApp({ db, clock, config: { env: 'test', staticDir: undefined } }),
    /** An app wired to the fake bot and the real watcher, like `index.ts` wires the real one. */
    appWithBot: () =>
      createApp({ db, clock, config: { env: 'test', staticDir: undefined }, telegram }),
    startScheduler,
    /** What Telegram accepted, as text, in order. */
    texts: () => fake.sent.map((message) => message.text),
    /** The dedupe log, as `kind key value` strings sorted by kind and key. */
    log: () =>
      db
        .select()
        .from(telegramNotifications)
        .all()
        .map((row) => `${row.kind} ${row.key}${row.value === null ? '' : ` ${row.value}`}`)
        .sort(),
    /**
     * Saves notification preferences through the service, as `PUT /api/telegram/notifications` does:
     * `changes` on top of the preferences saved so far (the defaults before the first save).
     */
    savePrefs: (changes: Partial<TelegramNotificationSettingsInput>) =>
      saveTelegramNotificationSettings(
        { db, clock },
        { ...getTelegramNotificationSettings(db), ...changes },
      ),
    /** The nth send from now fails (1 is the next one). Several may be given. */
    failSends: (...nth: number[]) => {
      for (const n of nth) failing.set(calls + n, undefined);
    },
    /** The nth send from now fails with `error`, such as a `TelegramSendError` that carries Telegram's code. */
    failSendsWith: (error: Error, ...nth: number[]) => {
      for (const n of nth) failing.set(calls + n, error);
    },
    /** Holds every send until the returned function is called. */
    blockSends: (): (() => void) => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    /** Stops every scheduler and the watcher. Call it after each test. */
    close: async () => {
      notify.stop();
      await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
    },
  };
}

export type NotifyHarness = ReturnType<typeof createNotifyHarness>;
