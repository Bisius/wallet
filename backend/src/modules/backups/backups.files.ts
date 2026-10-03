import { parseBackupName } from '@wallet/shared';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The backup directory as the rest of the module sees it. Every function here goes through the
 * directory listing: a file is a backup only when it is a REGULAR file (a symbolic link is not one,
 * nor is a directory) and its name is a backup name for a real instant (`parseBackupName`). Nothing
 * ever builds a path from a request: a name is looked up among the names listed here, and the path
 * is made from the listed entry.
 */
export interface BackupFile {
  name: string;
  sizeBytes: number;
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** The backups in `dir`, newest first (names sort by time). A directory that does not exist yet has none. */
export async function listBackupFiles(dir: string): Promise<BackupFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files: BackupFile[] = [];
  for (const entry of entries) {
    // `Dirent.isFile()` is false for a symbolic link: it does not follow it.
    if (!entry.isFile() || parseBackupName(entry.name) === null) continue;
    try {
      const info = await lstat(join(dir, entry.name));
      if (info.isFile()) files.push({ name: entry.name, sizeBytes: info.size });
    } catch (error) {
      if (!isMissing(error)) throw error; // rotation removed it since the listing
    }
  }
  return files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** Every name in `dir`, whatever it is (a name a new backup must not take, even a symlink's). */
export async function listAllNames(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
}

/**
 * Opens the backup called `name` for reading, or null when it is not among the backups listed in
 * `dir` (or was removed since). The caller owns the handle and must close it. The open itself
 * refuses to follow a symbolic link, so a link swapped in after the listing is not read either; the
 * handle's own `fstat` says what was really opened, and an open handle keeps reading the same bytes
 * even when rotation removes the file meanwhile.
 */
export async function openBackupFile(
  dir: string,
  name: string,
): Promise<{ handle: FileHandle; sizeBytes: number } | null> {
  const listed = (await listBackupFiles(dir)).find((file) => file.name === name);
  if (!listed) return null;

  let handle: FileHandle;
  try {
    handle = await open(join(dir, listed.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    return null;
  }
  return { handle, sizeBytes: info.size };
}

/** Removes the listed backups. A file that is gone already is fine. */
export async function removeBackupFiles(dir: string, names: readonly string[]): Promise<void> {
  for (const name of names) await rm(join(dir, name), { force: true });
}

/** A half-written backup left by a crash: `wallet-YYYYMMDD-HHmmss.db.tmp` and SQLite's own side files. */
const STALE_TEMP_PATTERN = /^wallet-\d{8}-\d{6}\.db\.tmp(?:-journal|-wal|-shm)?$/;

/** The temporary names a backup called `name` writes under, for the cleanup after a failure. */
export const tempNames = (name: string): string[] =>
  ['', '-journal', '-wal', '-shm'].map((suffix) => `${name}.tmp${suffix}`);

/**
 * Deletes the temporary files a crash left behind (regular files of exactly those names; nothing
 * else in the directory is touched). Returns the names it removed.
 */
export async function removeStaleTemps(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const stale = entries
    .filter((entry) => entry.isFile() && STALE_TEMP_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  for (const name of stale) await rm(join(dir, name), { force: true });
  return stale;
}
