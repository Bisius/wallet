import { copyFile, rm } from 'node:fs/promises';
import type { PlaywrightWorkerArgs } from '@playwright/test';
import { withReadableErrors } from './api';
import { expect, test as base, type Wallet } from './fixtures';
import type { FakeTelegram } from './fake-telegram';
import { WalletServer } from './server';

/**
 * More Wallet servers next to the test's own `wallet`, for specs about two instances at once: a
 * fresh wallet that an export is imported into, a scratch copy of a backup that runs while the live
 * one keeps running, a server that is killed instead of stopped.
 *
 * Each is the same thing the `wallet` fixture gives (its own folder, database, backup folder, port
 * and clock) and is stopped and removed with the test. As with `wallet`, a failed test keeps the
 * folder and puts the server's output into the report.
 */
export interface ExtraWallet extends Wallet {
  /**
   * Ends the process with SIGKILL: no clean shutdown, so SQLite never gets to checkpoint and delete
   * its `-wal` and `-shm` files. It is what a crash, a power cut or `docker kill` leaves behind, and
   * what `stop()` (SIGTERM, a clean exit) never does. `start()` brings it back afterwards.
   */
  kill(): Promise<void>;
}

export interface ServerOptions {
  /**
   * Gives the server a bot that talks to this fake Bot API (the same one as another server's, for two
   * programs with one token). Without it the server has no token and its bot is off. The test owns the
   * fake and closes it: a `telegramBot: true` test's own is `telegram`.
   */
  telegram?: FakeTelegram;
  /** `APP_URL` of the server with the bot. */
  appUrl?: string;
}

export interface Servers {
  /** Starts a server on a new, empty database. The clock starts at `now` (default: where `wallet`'s clock is now). */
  start(now?: string, options?: ServerOptions): Promise<ExtraWallet>;
  /**
   * Starts a server whose database is a copy of the file `database` (a backup). The server is
   * started on its own empty database first, stopped, given the copy, and started again, so it
   * has its own folder, port and backup folder, as the README's scratch drill does.
   */
  startOnCopyOf(database: string, now?: string): Promise<ExtraWallet>;
}

interface Running {
  server: WalletServer;
  dispose: () => Promise<void>;
}

async function newApi(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string) {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { accept: 'application/json' },
  });
}

/**
 * `test` for specs that need more than one server: everything of `../support/fixtures`, plus
 * `servers`.
 */
export const test = base.extend<{ servers: Servers }>({
  servers: async ({ playwright, wallet }, use, testInfo) => {
    const running: Running[] = [];

    const adopt = async (server: WalletServer): Promise<ExtraWallet> => {
      let api = await newApi(playwright, server.baseURL);
      const extra: ExtraWallet = {
        baseURL: server.baseURL,
        dir: server.dir,
        dbPath: server.dbPath,
        backupDir: server.backupDir,
        now: server.initialNow,
        api: withReadableErrors(() => api),
        setNow: (instant) => server.setNow(instant),
        getNow: () => server.getNow(),
        stop: () => server.stop(),
        start: async () => {
          await server.start();
          await api.dispose();
          api = await newApi(playwright, server.baseURL);
        },
        kill: () => server.kill(),
        log: () => server.log(),
      };
      running.push({ server, dispose: () => api.dispose() });
      return extra;
    };

    const servers: Servers = {
      async start(now, options) {
        return adopt(
          await WalletServer.start(now ?? (await wallet.getNow()), {
            env: options?.telegram?.serverEnv({ appUrl: options.appUrl }),
          }),
        );
      },
      async startOnCopyOf(database, now) {
        const server = await WalletServer.start(now ?? (await wallet.getNow()));
        // Track it before anything can fail, so that the teardown removes the folder.
        const extra = await adopt(server);
        await server.stop();
        await rm(`${server.dbPath}-wal`, { force: true });
        await rm(`${server.dbPath}-shm`, { force: true });
        await copyFile(database, server.dbPath);
        await extra.start();
        return extra;
      },
    };

    try {
      await use(servers);
    } finally {
      for (const { server, dispose } of running.reverse()) {
        await dispose();
        await server.stop();
        if (testInfo.status === testInfo.expectedStatus) {
          await server.remove();
        } else {
          await testInfo.attach(`extra-server-${server.dir.split('/').pop()}.log`, {
            body: `Data folder kept at ${server.dir}\n\n${server.log()}`,
            contentType: 'text/plain',
          });
        }
      }
    }
  },
});

export { expect };
