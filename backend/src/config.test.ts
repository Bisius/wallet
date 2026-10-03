import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

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
