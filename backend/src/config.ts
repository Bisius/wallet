import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { BACKEND_ROOT } from './lib/paths';
import { StartupError } from './lib/startup-checks';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3400),
  DATABASE_PATH: z.string().default('./data/wallet.db'),
  STATIC_DIR: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_API_ROOT: z.string().optional(),
  APP_URL: z.string().optional(),
});

/** Where the Telegram Bot API is, unless `TELEGRAM_API_ROOT` says otherwise (the e2e tests do). */
export const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databasePath: string;
  /** Built Angular app to serve, if any. */
  staticDir: string | undefined;
  /**
   * Where backups are kept (`BACKUP_DIR`; by default `backups` next to the database file). undefined
   * with the in-memory database and no `BACKUP_DIR`: there is then no backup at all
   * (docs/DOMAIN.md, "Backups").
   */
  backupDir: string | undefined;
  /**
   * The Telegram bot token (`TELEGRAM_BOT_TOKEN`, from @BotFather), trimmed. undefined when it is
   * unset, empty or only whitespace: the bot is then off and nothing else changes (docs/DOMAIN.md,
   * "Telegram bot"). A secret: it is never logged, returned by the API or stored.
   */
  telegramBotToken: string | undefined;
  /**
   * The Bot API root (`TELEGRAM_API_ROOT`, default `https://api.telegram.org`), without a trailing
   * slash. Only the tests point it somewhere else, at a fake Bot API.
   */
  telegramApiRoot: string;
  /**
   * The address of the app as the phone reaches it (`APP_URL`), without a trailing slash, or
   * undefined when it is unset or empty. It adds "Open" links to some bot messages.
   */
  appUrl: string | undefined;
}

/**
 * `value` as an http(s) address without trailing slashes, or a `StartupError` that names the
 * variable. Only the shape is checked (a scheme and a host), not that the address answers.
 */
function httpUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new StartupError(
      `${name} must be an http:// or https:// address such as https://wallet.example.ts.net, got "${value}". ` +
        `Fix it in the environment file, or remove it.`,
    );
  }
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const defaultStaticDir = resolve(BACKEND_ROOT, '../frontend/dist/frontend/browser');
  const staticDir = parsed.STATIC_DIR
    ? resolve(parsed.STATIC_DIR)
    : parsed.NODE_ENV === 'production' && existsSync(defaultStaticDir)
      ? defaultStaticDir
      : undefined;

  const databasePath =
    parsed.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(parsed.DATABASE_PATH);
  // An empty value (`BACKUP_DIR=` in an env file) means "not set": resolving it would give the
  // working directory, which must never be filled with backup files.
  const explicitBackupDir = parsed.BACKUP_DIR?.trim();
  const backupDir = explicitBackupDir
    ? resolve(explicitBackupDir)
    : databasePath === ':memory:'
      ? undefined
      : join(dirname(databasePath), 'backups');

  // An empty value (`APP_URL=` in an env file) means "not set", like BACKUP_DIR.
  const token = parsed.TELEGRAM_BOT_TOKEN?.trim();
  const apiRoot = parsed.TELEGRAM_API_ROOT?.trim();
  const appUrl = parsed.APP_URL?.trim();

  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath,
    staticDir,
    backupDir,
    telegramBotToken: token || undefined,
    telegramApiRoot: apiRoot ? httpUrl('TELEGRAM_API_ROOT', apiRoot) : DEFAULT_TELEGRAM_API_ROOT,
    appUrl: appUrl ? httpUrl('APP_URL', appUrl) : undefined,
  };
}
