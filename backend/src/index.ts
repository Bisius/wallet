import { dirname } from 'node:path';
import { createApp } from './app';
import { type Config, loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { systemClock } from './lib/clock';
import { StartupError, ensureWritableDir, explainDatabaseError } from './lib/startup-checks';
import { startBackupScheduler } from './modules/backups/backups.scheduler';
import { createTelegramRuntime } from './modules/telegram/telegram.runtime';
import { startTelegramScheduler } from './modules/telegram/telegram.scheduler';

/** A mistake in the environment (an `APP_URL` that is not an address) exits with its message, not a stack. */
function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof StartupError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();

/** Checks the folders, then opens and migrates the database. A setup mistake exits with a message that names the path. */
function openDatabase() {
  try {
    if (config.databasePath !== ':memory:') {
      ensureWritableDir(dirname(config.databasePath), 'database folder');
    }
    if (config.backupDir) ensureWritableDir(config.backupDir, 'backup folder');
  } catch (error) {
    if (error instanceof StartupError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  try {
    const db = createDb(config.databasePath);
    runMigrations(db);
    return db;
  } catch (error) {
    const explained = explainDatabaseError(config.databasePath, error);
    if (explained instanceof StartupError) {
      console.error(explained.message);
      process.exit(1);
    }
    throw explained;
  }
}

const db = openDatabase();

// The bot exists only with a token. It is created here so that the routes can report on it, and it
// starts after `listen` (below). `createApp` and the tests never start one.
const telegram = config.telegramBotToken
  ? createTelegramRuntime({ db, clock: systemClock, config })
  : undefined;
const app = createApp({ db, config, telegram });
let scheduler: ReturnType<typeof startBackupScheduler> | undefined;
let telegramScheduler: ReturnType<typeof startTelegramScheduler> | undefined;
// Express 5 passes a listen failure (such as EADDRINUSE) to this callback instead of throwing, so
// it must be handled here: otherwise the process would claim to listen, then exit with code 0.
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `Wallet listening on http://${config.host}:${config.port} (db: ${config.databasePath})`,
  );
  if (config.staticDir) console.log(`Serving frontend from ${config.staticDir}`);
  // After listening, so a port that is taken exits before a backup starts; the first check runs in
  // the background and never delays the server.
  scheduler = startBackupScheduler({ db, clock: systemClock, config });
  if (telegram) {
    telegram.start();
    telegramScheduler = startTelegramScheduler({ db, clock: systemClock, config, telegram });
  } else {
    console.log('Telegram bot is off (TELEGRAM_BOT_TOKEN is not set)');
  }
});

let shuttingDown = false;
async function shutdown() {
  // A second signal does not wait for the backup that the first one is waiting for.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  // Stop taking requests and let the running ones finish, and stop the scheduler and let a backup
  // in flight finish, and stop the Telegram scheduler, then the bot (it waits for the update in
  // progress), and only then close the database: they all read and write it until they are done.
  await Promise.all([
    scheduler?.stop(),
    (async () => {
      await telegramScheduler?.stop();
      await telegram?.stop();
    })(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  db.$client.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
