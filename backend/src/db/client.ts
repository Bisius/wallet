import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS_DIR } from '../lib/paths';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/**
 * Anything queries can run on: the database itself or the `tx` handed to a `db.transaction`
 * callback. Services take this so the same code works inside and outside a transaction.
 */
export type DbOrTx = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

/** Opens (or creates) the SQLite database. Pass ":memory:" for tests. */
export function createDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return drizzle({ client: sqlite, schema, casing: 'snake_case' });
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
