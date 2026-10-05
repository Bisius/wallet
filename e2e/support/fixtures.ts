import {
  type APIRequestContext,
  type PlaywrightWorkerArgs,
  expect,
  test as base,
} from '@playwright/test';
import { withReadableErrors } from './api';
import { BrowserErrors, type BrowserErrorMatcher } from './browser-errors';
import { FakeTelegram } from './fake-telegram';
import { WalletServer } from './server';

export { ApiRequestError, json } from './api';
export { failedResponse, type BrowserErrorMatcher } from './browser-errors';
export { FakeTelegram, FAKE_BOT_TOKEN, FAKE_BOT_USERNAME } from './fake-telegram';

/** Where the fake clock starts unless a file says otherwise (`test.use({ walletNow })`). */
export const DEFAULT_NOW = '2026-03-10T09:00:00';

/**
 * A real Wallet server (the production build) that belongs to one test: its own database, backup
 * folder, port and clock. It is started before the test and removed after it.
 */
export interface Wallet {
  /** `http://127.0.0.1:<port>`. The `page` and `context` fixtures are bound to it. */
  readonly baseURL: string;
  /** The private temp folder of this server (also its working directory). Kept when the test fails. */
  readonly dir: string;
  /** The SQLite file (`DATABASE_PATH`). */
  readonly dbPath: string;
  /** The backup folder (`BACKUP_DIR`). */
  readonly backupDir: string;
  /** The instant the clock started at, as given (`walletNow`). It does not follow `setNow`. */
  readonly now: string;
  /**
   * Seeds and inspects the server through the real HTTP API. A response outside 2xx throws an
   * `ApiRequestError` whose message holds the request and the response body; pass
   * `{ failOnStatusCode: false }` to a call to get an expected error response back instead.
   * `support/seed.ts` has typed helpers for the common calls.
   */
  readonly api: APIRequestContext;
  /**
   * Moves the server's clock, which then keeps ticking from there. The instant is in the server's
   * local time zone, which is UTC (`'2026-04-01T09:00:00'`), or has its own zone (`...Z`, `+02:00`).
   * Months close by the clock passing them, so this is how a test closes one: the app shows the
   * new date after its next request (`page.reload()`).
   */
  setNow(instant: string): Promise<void>;
  /** The clock's current instant as an ISO string in UTC. */
  getNow(): Promise<string>;
  /** Stops the server (SIGTERM, as a service manager does) and waits until it is gone. */
  stop(): Promise<void>;
  /**
   * Starts it again after `stop()`: same database, same port, and the clock resumes where it was
   * stopped. For restore drills (stop, replace `dbPath`, start) and restart checks.
   */
  start(): Promise<void>;
  /** What the server printed so far. */
  log(): string;
}

interface WalletOptions {
  /** The instant the fake clock starts at. Zone-less means UTC, the server's time zone. */
  walletNow: string;
  /** Fail the test when the browser logs a console error or throws. On by default. */
  failOnConsoleErrors: boolean;
  /** Console errors that are expected in every test of the file (see `failedResponse`). */
  allowedConsoleErrors: BrowserErrorMatcher[];
  /**
   * Starts the server WITH the Telegram bot: a fake Bot API (`telegram`) is started before it and
   * closed after it, and the server gets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API_ROOT` pointing at the
   * fake (and `APP_URL`, with `{ appUrl }`). Off by default: a server without the option has no token,
   * so its bot is off, whatever the shell that runs the suite exports.
   */
  telegramBot: boolean | { appUrl?: string };
}

interface WalletFixtures {
  wallet: Wallet;
  /**
   * The fake Bot API of this test, and the person who types to the bot (`telegram.say(...)`,
   * `telegram.tap(...)`, `telegram.lastMessage()`). Only with `test.use({ telegramBot: true })`: asking
   * for it without the option is an error.
   */
  telegram: FakeTelegram;
  /** The fake, or undefined when the option is off. Started before `wallet`, closed after it. */
  fakeTelegram: FakeTelegram | undefined;
  /** The console errors and uncaught exceptions of this test's browser, with `allow()` for expected ones. */
  browserErrors: BrowserErrors;
}

async function newApiContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { accept: 'application/json' },
  });
}

/**
 * `test` for Wallet specs: `import { test, expect } from '../support/fixtures'`.
 *
 * - `wallet`: a fresh server per test (see `Wallet`). Anything that uses `page`, `context` or `request`
 *   gets it too, because `baseURL` points at it.
 * - `page` and `context`: service workers blocked, and the test fails on any console error or
 *   uncaught exception of the page unless it is allowed (`browserErrors`, `allowedConsoleErrors`,
 *   or `failOnConsoleErrors: false`).
 * - Options for `test.use`: `walletNow`, `failOnConsoleErrors`, `allowedConsoleErrors`.
 */
export const test = base.extend<WalletFixtures & WalletOptions>({
  walletNow: [DEFAULT_NOW, { option: true }],
  failOnConsoleErrors: [true, { option: true }],
  allowedConsoleErrors: [[], { option: true }],
  telegramBot: [false, { option: true }],
  // The service worker would cache pages and answer from the cache, between tests and across a
  // restart. A spec that is about the worker turns it back on with `test.use({ serviceWorkers: 'allow' })`.
  serviceWorkers: async ({}, use) => {
    await use('block');
  },

  fakeTelegram: async ({ telegramBot }, use, testInfo) => {
    if (!telegramBot) {
      await use(undefined);
      return;
    }
    const fake = await FakeTelegram.start();
    try {
      await use(fake);
    } finally {
      // The server of the test is gone by now (it depends on this fixture), so nothing is polling.
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('telegram-chat.txt', {
          body: fake.transcript(),
          contentType: 'text/plain',
        });
      }
      await fake.close();
    }
  },

  telegram: async ({ fakeTelegram }, use) => {
    if (!fakeTelegram) {
      throw new Error('The `telegram` fixture needs the bot: test.use({ telegramBot: true })');
    }
    await use(fakeTelegram);
  },

  wallet: async ({ playwright, walletNow, fakeTelegram, telegramBot }, use, testInfo) => {
    const appUrl = typeof telegramBot === 'object' ? telegramBot.appUrl : undefined;
    const server = await WalletServer.start(walletNow, {
      env: fakeTelegram?.serverEnv({ appUrl }),
    });
    let apiContext = await newApiContext(playwright, server.baseURL);

    const wallet: Wallet = {
      baseURL: server.baseURL,
      dir: server.dir,
      dbPath: server.dbPath,
      backupDir: server.backupDir,
      now: walletNow,
      api: withReadableErrors(() => apiContext),
      setNow: (instant) => server.setNow(instant),
      getNow: () => server.getNow(),
      stop: () => server.stop(),
      start: async () => {
        await server.start();
        // A connection to the old process must not be reused.
        await apiContext.dispose();
        apiContext = await newApiContext(playwright, server.baseURL);
      },
      log: () => server.log(),
    };

    try {
      await use(wallet);
    } finally {
      await apiContext.dispose();
      await server.stop();
      if (testInfo.status === testInfo.expectedStatus) {
        await server.remove();
      } else {
        // Keep the database for a look, and put the server's output into the report.
        await testInfo.attach('wallet-server.log', {
          body: `Data folder kept at ${server.dir}\n\n${server.log()}`,
          contentType: 'text/plain',
        });
      }
    }
  },

  baseURL: async ({ wallet }, use) => {
    await use(wallet.baseURL);
  },

  browserErrors: async ({ allowedConsoleErrors }, use) => {
    await use(new BrowserErrors(allowedConsoleErrors));
  },

  context: async ({ context, browserErrors, failOnConsoleErrors }, use) => {
    browserErrors.watch(context);
    await use(context);
    if (failOnConsoleErrors) browserErrors.assertNone();
  },
});

export { expect };
