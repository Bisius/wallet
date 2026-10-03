import {
  BACKUP_INTERVAL_HOURS,
  type BackupDto,
  type BackupsDto,
  backupNameOf,
  parseBackupName,
} from '@wallet/shared';
import Database from 'better-sqlite3';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Db } from '../../db/client';
import type { Clock } from '../../lib/clock';
import { apiError, notFound } from '../../lib/errors';
import { DEFAULT_ROTATION, backupsToDelete } from './backups.rotation';
import {
  type BackupFile,
  listAllNames,
  listBackupFiles,
  openBackupFile,
  removeBackupFiles,
  removeStaleTemps,
  tempNames,
} from './backups.files';

/**
 * What the backup service needs: the database to copy, the clock and the backup directory
 * (`Config.backupDir`, undefined when there is none, see shared/src/backups.ts). `db` is the real
 * database, not a transaction: a backup is the online backup of the whole file.
 */
export interface BackupDeps {
  db: Db;
  clock: Clock;
  backupDir: string | undefined;
}

const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = BACKUP_INTERVAL_HOURS * HOUR_MS;

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

/**
 * One queue per backup directory, shared by the routes and the scheduler (which are created
 * separately), so two backups of the same directory never run at the same time: overlapping POSTs
 * and the scheduled one take their turn, each choosing its name and rotating after the one before
 * it finished. The value is the tail of the chain; it never rejects.
 */
const queues = new Map<string, Promise<void>>();

function enqueue<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const result = (queues.get(key) ?? Promise.resolve()).then(job);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

/** Resolves when no backup of `dir` is running or waiting (what shutdown waits for). */
export async function whenBackupsIdle(dir: string): Promise<void> {
  const key = resolve(dir);
  for (let tail = queues.get(key); tail; tail = queues.get(key)) await tail;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const unavailable = () =>
  apiError('backups_unavailable', 'This server has no backup directory (set BACKUP_DIR)');

const toDto = (file: BackupFile): BackupDto => ({
  name: file.name,
  createdAt: parseBackupName(file.name) as string, // listed names are valid by construction
  sizeBytes: file.sizeBytes,
});

/** When the next automatic backup is due, given the newest one's `createdAt` (null for none) and now. */
export function nextBackupDueAt(lastBackupAt: string | null, now: Date): string {
  return lastBackupAt === null
    ? now.toISOString()
    : new Date(Date.parse(lastBackupAt) + INTERVAL_MS).toISOString();
}

/** An automatic backup is due when there is none or the newest is `BACKUP_INTERVAL_HOURS` old or more. */
export function isBackupDue(lastBackupAt: string | null, now: Date): boolean {
  return lastBackupAt === null || now.getTime() - Date.parse(lastBackupAt) >= INTERVAL_MS;
}

export async function listBackups({ backupDir, clock }: BackupDeps): Promise<BackupsDto> {
  if (!backupDir) return { automatic: false, backups: [], lastBackupAt: null, nextDueAt: null };
  const backups = (await listBackupFiles(backupDir)).map(toDto);
  const lastBackupAt = backups[0]?.createdAt ?? null;
  return {
    automatic: true,
    backups,
    lastBackupAt,
    nextDueAt: nextBackupDueAt(lastBackupAt, clock.now()),
  };
}

/** The backup called `name`, opened for download (the caller closes the handle), or a 404. */
export async function openBackup({ backupDir }: BackupDeps, name: string) {
  const file = backupDir ? await openBackupFile(backupDir, name) : null;
  if (!file) throw notFound('Backup');
  return file;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The online backup leaves a copy that is flagged as a write-ahead-log database (the source is
 * one), and opening such a file, even to read it, creates `-wal` and `-shm` files next to it. The
 * copy is switched to the plain rollback journal, so a backup is one self-contained file that can
 * be opened, downloaded and restored without side files.
 */
export function makeSelfContained(path: string): void {
  const copy = new Database(path, { fileMustExist: true });
  try {
    const mode = copy.pragma('journal_mode = DELETE', { simple: true });
    if (mode !== 'delete')
      throw new Error(`could not leave write-ahead mode (journal_mode: ${mode})`);
  } finally {
    copy.close();
  }
}

const tablesOf = (db: Database.Database): Set<string> =>
  new Set(
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and substr(name, 1, 7) <> 'sqlite_'",
      )
      .pluck()
      .all() as string[],
  );

const MIGRATIONS_TABLE = '__drizzle_migrations';
const migrationCount = (db: Database.Database): number =>
  db.prepare(`select count(*) from ${MIGRATIONS_TABLE}`).pluck().get() as number;

/**
 * Opens the finished copy read-only and checks it is a sound database that has what the live one
 * has: `PRAGMA integrity_check` is ok, every table of the source is there, and so are as many
 * applied migrations. Throws on the first problem. A backup that fails this is never given its
 * final name.
 */
export function verifyCopy(path: string, source: Database.Database): void {
  const copy = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const problems = (copy.pragma('integrity_check') as { integrity_check: string }[]).map(
      (row) => row.integrity_check,
    );
    if (problems.length !== 1 || problems[0] !== 'ok') {
      throw new Error(`integrity_check failed: ${problems.slice(0, 3).join('; ')}`);
    }

    const copied = tablesOf(copy);
    const missing = [...tablesOf(source)].filter((table) => !copied.has(table));
    if (missing.length > 0) throw new Error(`tables missing from the copy: ${missing.join(', ')}`);

    if (copied.has(MIGRATIONS_TABLE) && migrationCount(copy) !== migrationCount(source)) {
      throw new Error('the copy lists a different set of applied migrations');
    }
  } finally {
    copy.close();
  }
}

/** Flushes the directory entry of the new name to disk; a file system that cannot is not an error. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the backup is complete either way.
  }
}

/** Rotation after a successful backup. It never fails the backup: the new file is already safe. */
async function rotate(dir: string, justMade: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    const names = (await listBackupFiles(dir)).map((file) => file.name);
    for (const name of backupsToDelete(names, DEFAULT_ROTATION, [justMade])) {
      try {
        await removeBackupFiles(dir, [name]);
        removed.push(name);
      } catch (error) {
        console.error(`Backup rotation could not remove ${join(dir, name)}: ${describe(error)}`);
      }
    }
  } catch (error) {
    console.error(`Backup rotation failed in ${dir}: ${describe(error)}`);
  }
  return removed;
}

async function removeTemps(dir: string, name: string): Promise<void> {
  for (const temp of tempNames(name)) await rm(join(dir, temp), { force: true });
}

/**
 * One backup, then rotation. Runs inside the queue. The steps, in order, and what a failure at each
 * leaves behind (nothing under a final name, and no temporary file):
 *
 * 1. the name: the clock's current second in UTC, or the second after the newest backup name;
 * 2. `db.backup()` to `<name>.tmp`, which is not a backup name, so a half-written file is never
 *    listed or rotated;
 * 3. the copy is made self-contained and verified (`integrity_check`, tables, migrations);
 * 4. `rename` to the final name, which is atomic: the name only ever points at a whole backup.
 */
async function takeBackup(
  deps: BackupDeps,
  dir: string,
): Promise<{ backup: BackupDto; removed: string[] }> {
  await mkdir(dir, { recursive: true });

  // The name is the current second (UTC) or, when that is not later than the newest name in the
  // directory (a second backup in the same second, a clock set back), the second after it. So a
  // name is never reused, not even one that rotation has just removed, and names keep the order of
  // creation. Anything named like a backup counts, a folder or a link included: it holds the name.
  const newest = [...(await listAllNames(dir))]
    .map(parseBackupName)
    .reduce<number | null>((latest, iso) => {
      const time = iso === null ? null : Date.parse(iso);
      return time !== null && (latest === null || time > latest) ? time : latest;
    }, null);
  const now = Math.floor(deps.clock.now().getTime() / 1000) * 1000;
  const name = backupNameOf(new Date(newest === null ? now : Math.max(now, newest + 1000)));

  const finalPath = join(dir, name);
  const tempPath = `${finalPath}.tmp`;
  const source = deps.db.$client;
  await removeTemps(dir, name); // a leftover of an earlier crash with this very name
  try {
    await source.backup(tempPath);
    makeSelfContained(tempPath);
    verifyCopy(tempPath, source);
    await rename(tempPath, finalPath);
  } catch (error) {
    await removeTemps(dir, name).catch(() => undefined);
    throw new Error(`Backup ${name} failed: ${describe(error)}`, { cause: error });
  }
  await syncDirectory(dir);

  const removed = await rotate(dir, name);
  const { size } = await lstat(finalPath);
  return { backup: toDto({ name, sizeBytes: size }), removed };
}

/**
 * POST /api/backups: takes a backup now and rotates. 409 `backups_unavailable` without a backup
 * directory; any other failure (a full disk, a copy that does not verify) rejects and becomes a 500.
 */
export async function createBackup(deps: BackupDeps): Promise<BackupDto> {
  const dir = deps.backupDir;
  if (!dir) throw unavailable();
  return (await enqueue(dir, () => takeBackup(deps, dir))).backup;
}

/**
 * The scheduler's backup: takes one when none exists or the newest is `BACKUP_INTERVAL_HOURS` old
 * or more, decided inside the queue so that a backup that finished while this one waited counts.
 * `cancelled` is asked when its turn comes (the scheduler was stopped). Resolves to the backup and
 * the names rotation removed, or null when nothing was due.
 */
export async function createBackupIfDue(
  deps: BackupDeps,
  cancelled: () => boolean = () => false,
): Promise<{ backup: BackupDto; removed: string[] } | null> {
  const dir = deps.backupDir;
  if (!dir) return null;
  return enqueue(dir, async () => {
    if (cancelled()) return null;
    const newest = (await listBackupFiles(dir))[0];
    const last = newest ? parseBackupName(newest.name) : null;
    return isBackupDue(last, deps.clock.now()) ? takeBackup(deps, dir) : null;
  });
}

/** Deletes the temporary files a crash left in the backup directory. Returns their names. */
export function removeBackupLeftovers(dir: string): Promise<string[]> {
  return enqueue(dir, () => removeStaleTemps(dir));
}
