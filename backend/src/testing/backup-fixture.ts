/**
 * A real directory for the backup tests: an app whose database may be a file (WAL, like the
 * server's) and whose backup directory is a temporary folder under `os.tmpdir()`, removed by
 * `cleanUpBackupFixtures()` (call it in `afterEach`). The default `createTestApp` has no backup
 * directory, which is what the contract says for the in-memory database.
 */
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app';
import { createDb, runMigrations, type Db } from '../db/client';
import { type MutableClock, mutableClock } from './helpers';

export interface BackupFixture {
  /** The temporary folder that holds everything of this fixture. */
  root: string;
  /** `root/wallet.db` when the database is a file, `:memory:` otherwise. */
  dbPath: string;
  /** The backup directory the app was given, or undefined for none. It may not exist yet. */
  backupDir: string | undefined;
  app: Express;
  db: Db;
  clock: MutableClock;
}

export interface BackupFixtureOptions {
  /** The clock's start (default 2026-03-15T10:00:00Z). */
  now?: string;
  /** A file database `root/wallet.db` (default) or the in-memory one. */
  file?: boolean;
  /** `root/backups` (default), or `null` for no backup directory. */
  backupDir?: string | null;
}

const fixtures: BackupFixture[] = [];
const tempDirs: string[] = [];

export function createBackupFixture(options: BackupFixtureOptions = {}): BackupFixture {
  const { now = '2026-03-15T10:00:00Z', file = true, backupDir = 'backups' } = options;
  const root = mkdtempSync(join(tmpdir(), 'wallet-backup-test-'));
  const dbPath = file ? join(root, 'wallet.db') : ':memory:';
  const db = createDb(dbPath);
  runMigrations(db);
  const clock = mutableClock(now);
  const dir = backupDir === null ? undefined : join(root, backupDir);
  const app = createApp({
    db,
    clock,
    config: { env: 'test', staticDir: undefined, backupDir: dir },
  });
  const fixture: BackupFixture = { root, dbPath, backupDir: dir, app, db, clock };
  fixtures.push(fixture);
  return fixture;
}

/** Closes every database and removes every folder the fixtures made. */
export function cleanUpBackupFixtures(): void {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.db.$client.close();
    } catch {
      // already closed by the test
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A throw-away folder for a test that needs no app. */
export function makeTempDir(prefix = 'wallet-backup-dir-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Writes small files named like backups, to set up a directory without taking real backups. */
export function writeFakeBackups(dir: string, names: readonly string[], content = 'x'): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), content);
}

/**
 * Every table of an open SQLite file as text (rows in rowid order), to compare what a backup
 * holds with what the database held when it was taken.
 */
export function dumpSqlite(sqlite: Database.Database): string {
  const tables = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and substr(name, 1, 7) <> 'sqlite_' order by name",
    )
    .pluck()
    .all() as string[];
  return JSON.stringify(
    tables.map((name) => [name, sqlite.prepare(`select * from "${name}" order by rowid`).all()]),
  );
}

/** Opens a backup file read-only, the way a person inspecting or restoring it would. */
export const openBackupReadOnly = (path: string) =>
  new Database(path, { readonly: true, fileMustExist: true });
