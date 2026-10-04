import type { APIRequestContext } from '@playwright/test';
import type { ImportMapping, MonthKey } from '@wallet/shared';
import Database from 'better-sqlite3';
import { copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { json, type Wallet } from './fixtures';

/*
 * The restore drill's tools: the steps of the README's "Restore" section as Node file operations,
 * a read-only look into a SQLite file, and a snapshot of everything a person can observe through the
 * API, so that "the restored app is the app at the time of the backup" is one deep equality.
 */

/** The folder the README moves the old database into. */
export const BEFORE_RESTORE = 'before-restore';

/** The names in a folder, sorted (`ls`). */
export async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/**
 * The README's second step: `mkdir before-restore` and `mv wallet.db* before-restore/`. The glob is
 * every name in the folder that starts with `wallet.db`: the database and its `-wal` and `-shm`
 * files, whichever exist. `mkdir` without `-p` fails when the folder is there already, as the
 * README's does. Returns the names that were moved.
 */
export async function moveDatabaseAside(dir: string): Promise<string[]> {
  const aside = join(dir, BEFORE_RESTORE);
  await mkdir(aside);
  const moved = (await names(dir)).filter((name) => name.startsWith('wallet.db'));
  for (const name of moved) await rename(join(dir, name), join(aside, name));
  return moved;
}

/** The README's third step: `cp <backup> wallet.db`. */
export async function copyBackupIn(backupFile: string, database: string): Promise<void> {
  await copyFile(backupFile, database);
}

/**
 * The whole documented restore of a running server: stop it, move `wallet.db*` into
 * `before-restore`, copy the backup to `wallet.db`, start it. Returns what was moved aside.
 */
export async function restoreBackup(wallet: Wallet, backupFile: string): Promise<string[]> {
  await wallet.stop();
  const moved = await moveDatabaseAside(wallet.dir);
  await copyBackupIn(backupFile, wallet.dbPath);
  await wallet.start();
  return moved;
}

// ---------------------------------------------------------------------------------------------
// Looking into a database file
// ---------------------------------------------------------------------------------------------

/** What `PRAGMA integrity_check` and `foreign_key_check` say about a file, and how many rows its tables hold. */
export interface DatabaseFacts<Table extends string = string> {
  integrity: string[];
  foreignKeyViolations: unknown[];
  counts: Record<Table, number>;
}

/**
 * Opens a database file read-only (a second reader next to the app or on a file the app is not
 * using) and reports what is in it. `better-sqlite3` is the app's own driver, declared in this
 * workspace's devDependencies with the backend's version.
 */
export function inspectDatabase<Table extends string>(
  file: string,
  tables: readonly Table[],
): DatabaseFacts<Table> {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = (database.pragma('integrity_check') as { integrity_check: string }[]).map(
      (row) => row.integrity_check,
    );
    const counts = {} as Record<Table, number>;
    for (const table of tables) {
      // The names come from the specs, never from outside.
      counts[table] = database.prepare(`select count(*) from ${table}`).pluck().get() as number;
    }
    return {
      integrity,
      foreignKeyViolations: database.pragma('foreign_key_check') as unknown[],
      counts,
    };
  } finally {
    database.close();
  }
}

/** One value out of a file opened read-only: `select ...` with its parameters, first column of the first row. */
export function queryDatabase<T>(file: string, sql: string, ...parameters: unknown[]): T {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare(sql)
      .pluck()
      .get(...parameters) as T;
  } finally {
    database.close();
  }
}

/**
 * Edits a file that no server is using (a copy of a backup): hands the database to `edit` and closes it.
 * It is how a backup "from an older version" is made.
 */
export function editDatabase(file: string, edit: (database: Database.Database) => void): void {
  const database = new Database(file, { fileMustExist: true });
  try {
    edit(database);
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Everything a person can see through the API
// ---------------------------------------------------------------------------------------------

export interface ObserveOptions {
  months: readonly MonthKey[];
  years: readonly number[];
  /** A file to preview again: the answer shows which of its rows count as imported already. */
  preview?: { csv: string; mapping: ImportMapping };
}

interface Page<T> {
  items: T[];
  total: number;
}

async function allPages(api: APIRequestContext, path: string, size: number): Promise<unknown[]> {
  const items: unknown[] = [];
  for (;;) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await json<Page<unknown>>(
      await api.get(`${path}${separator}limit=${size}&offset=${items.length}`),
    );
    items.push(...page.items);
    if (items.length >= page.total || page.items.length === 0) return items;
  }
}

/**
 * A snapshot of the wallet as the API shows it: the settings, every list, the month views, the
 * savings, the yearly report, the three exports (as text), the import profiles and, when asked for,
 * the preview of a file (which says what counts as imported). Two snapshots that are `toEqual` are
 * the same wallet to everyone using it. Not in it: the backup list (it changes when a backup is made).
 */
export async function observe(
  api: APIRequestContext,
  { months, years, preview }: ObserveOptions,
): Promise<Record<string, unknown>> {
  const get = async (path: string): Promise<unknown> => json<unknown>(await api.get(path));
  const text = async (path: string): Promise<string> => (await api.get(path)).text();

  const snapshot: Record<string, unknown> = {
    settings: await get('/api/settings'),
    salary: await get('/api/salary'),
    budgets: await get('/api/budgets'),
    subscriptions: await get('/api/subscriptions'),
    upcoming: await get('/api/subscriptions/upcoming?days=366'),
    incomes: await get('/api/incomes'),
    transfers: await get('/api/transfers'),
    spendings: await allPages(api, '/api/spendings', 200),
    tags: await get('/api/tags'),
    goals: await get('/api/goals'),
    savings: await get('/api/savings'),
    savingsTransactions: await allPages(api, '/api/savings/transactions', 200),
    profiles: await get('/api/import/profiles'),
    exportSpendings: await text('/api/export/spendings.csv'),
    exportIncomes: await text('/api/export/incomes.csv'),
    exportSavings: await text('/api/export/savings.csv'),
  };
  for (const month of months) snapshot[`month ${month}`] = await get(`/api/months/${month}`);
  for (const year of years) snapshot[`report ${year}`] = await get(`/api/reports/yearly/${year}`);
  if (preview) {
    snapshot['preview'] = await json<unknown>(
      await api.post('/api/import/preview', { data: preview }),
    );
  }
  return snapshot;
}
