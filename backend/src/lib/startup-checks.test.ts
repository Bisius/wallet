import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { StartupError, ensureWritableDir, explainDatabaseError } from './startup-checks';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wallet-startup-'));
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

const isRoot = process.getuid?.() === 0; // root can write anywhere: permission tests mean nothing then

/** The error `fn` throws, which must be a StartupError. */
function startupError(fn: () => unknown): StartupError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    return error as StartupError;
  }
  throw new Error('expected a StartupError');
}

describe('ensureWritableDir', () => {
  it('creates a missing folder with its parents, and accepts one that exists', () => {
    const dir = join(root, 'a', 'b', 'backups');
    ensureWritableDir(dir, 'backup folder');
    expect(existsSync(dir)).toBe(true);
    expect(() => ensureWritableDir(dir, 'backup folder')).not.toThrow();
  });

  it('names the path and says a part of it is a file when it cannot be created', () => {
    writeFileSync(join(root, 'file'), 'x');
    const dir = join(root, 'file', 'backups');
    const error = startupError(() => ensureWritableDir(dir, 'backup folder'));
    expect(error.message).toContain(dir);
    expect(error.message).toContain('backup folder');
    expect(error.message).toMatch(/is a file, not a folder/);
  });

  it('names the path when the folder is a file', () => {
    const file = join(root, 'data');
    writeFileSync(file, 'x');
    const error = startupError(() => ensureWritableDir(file, 'database folder'));
    expect(error.message).toContain(file);
    expect(error.message).toContain('database folder');
  });

  it.skipIf(isRoot)('names the path and the user when the folder is not writable', () => {
    const dir = join(root, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    const error = startupError(() => ensureWritableDir(dir, 'database folder'));
    expect(error.message).toContain(dir);
    expect(error.message).toMatch(/not writable/);
    expect(error.message).toMatch(/no write permission/);
    expect(error.message).toMatch(/uid \d+/);
  });

  it.skipIf(isRoot)(
    'names the parent problem when the folder cannot be created in a locked one',
    () => {
      const parent = join(root, 'locked');
      mkdirSync(parent);
      chmodSync(parent, 0o500);
      const dir = join(parent, 'backups');
      const error = startupError(() => ensureWritableDir(dir, 'backup folder'));
      expect(error.message).toContain(dir);
      expect(error.message).toMatch(/Cannot create the backup folder/);
      chmodSync(parent, 0o700);
    },
  );
});

describe('explainDatabaseError', () => {
  it('names the file when SQLite cannot open it (here: the path is a folder)', () => {
    const path = join(root, 'wallet.db');
    mkdirSync(path);
    let raw: unknown;
    try {
      createDb(path);
    } catch (error) {
      raw = error;
    }
    expect((raw as Error).message).toMatch(/unable to open database file/); // all the raw error says
    const explained = explainDatabaseError(path, raw);
    expect(explained).toBeInstanceOf(StartupError);
    expect((explained as StartupError).message).toContain(path);
    expect((explained as StartupError).message).toMatch(/writable by the user running Wallet/);
  });

  it.skipIf(isRoot)('names the file when the folder is not writable', () => {
    const dir = join(root, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    const path = join(dir, 'wallet.db');
    let raw: unknown;
    try {
      createDb(path);
    } catch (error) {
      raw = error;
    }
    const explained = explainDatabaseError(path, raw);
    expect(explained).toBeInstanceOf(StartupError);
    expect((explained as StartupError).message).toContain(path);
  });

  it('says what is wrong, and not to delete it, when the file is not a database', () => {
    const path = join(root, 'wallet.db');
    writeFileSync(path, 'x'.repeat(4096));
    let raw: unknown;
    try {
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
    } catch (error) {
      raw = error;
    }
    const explained = explainDatabaseError(path, raw);
    expect(explained).toBeInstanceOf(StartupError);
    expect((explained as StartupError).message).toContain(path);
    expect((explained as StartupError).message).toMatch(/not a valid SQLite database/);
    expect((explained as StartupError).message).toMatch(/Do not delete it/);
  });

  it('gives any other error back unchanged, so a failing migration keeps its own message and stack', () => {
    const migration = new Error('near "CREAT": syntax error');
    expect(explainDatabaseError('/x/wallet.db', migration)).toBe(migration);
    const coded = Object.assign(new Error('boom'), { code: 'SQLITE_ERROR' });
    expect(explainDatabaseError('/x/wallet.db', coded)).toBe(coded);
    expect(explainDatabaseError('/x/wallet.db', 'text')).toBe('text');
  });
});
