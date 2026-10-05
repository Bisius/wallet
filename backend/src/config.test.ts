import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TELEGRAM_API_ROOT, loadConfig } from './config';
import { StartupError } from './lib/startup-checks';

describe('loadConfig: the backup directory (BACKUP_DIR)', () => {
  it('defaults to "backups" next to the database file', () => {
    expect(loadConfig({}).backupDir).toBe(resolve('./data/backups')); // ./data/wallet.db
    expect(loadConfig({ DATABASE_PATH: '/srv/wallet/money.db' }).backupDir).toBe(
      '/srv/wallet/backups',
    );
    // A relative database path is resolved against the working directory first.
    const config = loadConfig({ DATABASE_PATH: 'var/wallet.db' });
    expect(config.backupDir).toBe(join(dirname(config.databasePath), 'backups'));
    expect(config.backupDir).toBe(resolve('var/backups'));
  });

  it('is the directory named by BACKUP_DIR, resolved against the working directory like DATABASE_PATH', () => {
    expect(loadConfig({ BACKUP_DIR: '/mnt/nas/wallet' }).backupDir).toBe('/mnt/nas/wallet');
    expect(loadConfig({ BACKUP_DIR: './elsewhere/b' }).backupDir).toBe(resolve('./elsewhere/b'));
    expect(
      loadConfig({ DATABASE_PATH: '/data/wallet.db', BACKUP_DIR: '/data/backups' }).backupDir,
    ).toBe('/data/backups');
  });

  it('is undefined for the in-memory database, unless BACKUP_DIR is set', () => {
    expect(loadConfig({ DATABASE_PATH: ':memory:' })).toMatchObject({
      databasePath: ':memory:',
      backupDir: undefined,
    });
    expect(loadConfig({ DATABASE_PATH: ':memory:', BACKUP_DIR: '/tmp/b' }).backupDir).toBe(
      '/tmp/b',
    );
  });

  it('treats an empty value as not set: the working directory is never the backup directory', () => {
    expect(loadConfig({ BACKUP_DIR: '' }).backupDir).toBe(resolve('./data/backups'));
    expect(loadConfig({ BACKUP_DIR: '   ' }).backupDir).toBe(resolve('./data/backups'));
    expect(loadConfig({ DATABASE_PATH: ':memory:', BACKUP_DIR: '' }).backupDir).toBeUndefined();
  });

  it('leaves the other settings as they were', () => {
    expect(loadConfig({})).toMatchObject({
      env: 'development',
      host: '0.0.0.0',
      port: 3400,
      databasePath: resolve('./data/wallet.db'),
    });
  });
});

describe('loadConfig: the Telegram bot (TELEGRAM_BOT_TOKEN, TELEGRAM_API_ROOT, APP_URL)', () => {
  it('is off by default: no token, the real Bot API, no app address', () => {
    expect(loadConfig({})).toMatchObject({
      telegramBotToken: undefined,
      telegramApiRoot: 'https://api.telegram.org',
      appUrl: undefined,
    });
    expect(DEFAULT_TELEGRAM_API_ROOT).toBe('https://api.telegram.org');
  });

  it('takes the token as it is, without the whitespace around it', () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: '123456:ABC-def' }).telegramBotToken).toBe(
      '123456:ABC-def',
    );
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: '  123456:ABC-def\n' }).telegramBotToken).toBe(
      '123456:ABC-def',
    );
  });

  it('treats an empty or blank token as off, like an unset one', () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: '' }).telegramBotToken).toBeUndefined();
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: '   ' }).telegramBotToken).toBeUndefined();
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: '\t\n' }).telegramBotToken).toBeUndefined();
  });

  it('takes the Bot API root from TELEGRAM_API_ROOT, without trailing slashes', () => {
    expect(loadConfig({ TELEGRAM_API_ROOT: 'http://127.0.0.1:8081' }).telegramApiRoot).toBe(
      'http://127.0.0.1:8081',
    );
    expect(loadConfig({ TELEGRAM_API_ROOT: 'http://127.0.0.1:8081/' }).telegramApiRoot).toBe(
      'http://127.0.0.1:8081',
    );
    expect(
      loadConfig({ TELEGRAM_API_ROOT: ' https://bot-api.example.net// ' }).telegramApiRoot,
    ).toBe('https://bot-api.example.net');
  });

  it('falls back to the real Bot API when TELEGRAM_API_ROOT is empty', () => {
    expect(loadConfig({ TELEGRAM_API_ROOT: '' }).telegramApiRoot).toBe(DEFAULT_TELEGRAM_API_ROOT);
    expect(loadConfig({ TELEGRAM_API_ROOT: '  ' }).telegramApiRoot).toBe(DEFAULT_TELEGRAM_API_ROOT);
  });

  it('takes the app address from APP_URL, without the trailing slash', () => {
    expect(loadConfig({ APP_URL: 'https://wallet.tail1234.ts.net' }).appUrl).toBe(
      'https://wallet.tail1234.ts.net',
    );
    expect(loadConfig({ APP_URL: 'https://wallet.tail1234.ts.net/' }).appUrl).toBe(
      'https://wallet.tail1234.ts.net',
    );
    expect(loadConfig({ APP_URL: ' http://192.168.1.20:3400/wallet/ ' }).appUrl).toBe(
      'http://192.168.1.20:3400/wallet',
    );
  });

  it('treats an empty APP_URL as not set', () => {
    expect(loadConfig({ APP_URL: '' }).appUrl).toBeUndefined();
    expect(loadConfig({ APP_URL: '   ' }).appUrl).toBeUndefined();
  });

  it.each([
    ['a word', 'wallet'],
    ['a host without a scheme', 'wallet.example.net'],
    ['another scheme', 'ftp://wallet.example.net'],
    ['a scheme with no host', 'https://'],
    ['a path only', '/wallet'],
  ])('refuses an APP_URL that is %s, with an error that names the variable', (_label, value) => {
    expect(() => loadConfig({ APP_URL: value })).toThrow(StartupError);
    expect(() => loadConfig({ APP_URL: value })).toThrow(/APP_URL must be an http/);
  });

  it('refuses a TELEGRAM_API_ROOT that is not an http(s) address, naming the variable', () => {
    expect(() => loadConfig({ TELEGRAM_API_ROOT: 'api.telegram.org' })).toThrow(
      /TELEGRAM_API_ROOT must be an http/,
    );
  });

  it('never puts the token in an error about another variable', () => {
    const token = '123456:SECRET-token-value';
    try {
      loadConfig({ TELEGRAM_BOT_TOKEN: token, APP_URL: 'nope' });
      throw new Error('expected a StartupError');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(token);
    }
  });
});
