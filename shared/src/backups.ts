import { z } from 'zod';

// The constants live in './limits' (no zod); they are re-exported so import paths stay uniform.
export { BACKUP_INTERVAL_HOURS, BACKUP_KEEP_DAILY, BACKUP_KEEP_MONTHLY } from './limits';

// Backups of the database file. The consistency guarantee and how to restore are in
// docs/DOMAIN.md, "Backups"; the schedule and the rotation are in docs/PLAN.md, Phase 7.
//
// WHERE THEY ARE KEPT. The server reads the environment variable `BACKUP_DIR`: a directory (a
// relative path is resolved against the working directory, like `DATABASE_PATH`). Without it the
// directory is `backups` next to the database file (`./data/backups` for `./data/wallet.db`). The
// directory is created on the first backup, and its path is never sent to the client. With the
// in-memory database (`DATABASE_PATH=:memory:`, which is what the tests use) there is no file to
// put a directory next to, so there is NO backup directory unless `BACKUP_DIR` is set explicitly:
// automatic backups are off (`automatic: false`), `POST /api/backups` answers 409
// `backups_unavailable` and `GET /api/backups/:name` answers 404. A test that wants backups
// passes a temporary directory.
//
// WHAT COUNTS AS A BACKUP. A regular file of that directory whose name matches
// `BACKUP_NAME_PATTERN` and names a real instant. Any other file in the directory is not listed
// and is never touched by rotation. A backup is written under a temporary name and renamed to
// its final one when it is complete, so a name that matches is always a whole backup.

/**
 * The only file names the endpoints know: `wallet-YYYYMMDD-HHmmss.db`, the UTC time the backup was
 * made (a server in another time zone, or a clock change, can neither repeat a name nor reorder
 * them), e.g. `wallet-20261003-142530.db` is 2026-10-03T14:25:30Z. Names sort in time order.
 */
export const BACKUP_NAME_PATTERN = /^wallet-\d{8}-\d{6}\.db$/;

/**
 * The instant a backup file name stands for, as an ISO-8601 UTC timestamp
 * (`2026-10-03T14:25:30.000Z`), or null when the name does not match `BACKUP_NAME_PATTERN` or is
 * not a real date and time (`wallet-20261340-000000.db`). `createdAt` of a `BackupDto` is this:
 * it comes from the name, never from the file's modification time.
 */
export function parseBackupName(name: string): string | null {
  const match = /^wallet-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const iso = date.toISOString();
  // A date that rolled over (31 February) or an hour of 24 or more does not read back the same.
  const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  return iso.startsWith(expected) ? iso : null;
}

/**
 * The file name of a backup made at `at` (its whole seconds, in UTC). When that is not later than
 * the newest backup name in the directory (two backups in the same second, or a clock that was set
 * back) the server names the backup after the second following that newest name instead, so a name
 * is never reused (not even one that rotation has just removed) and the order of names stays the
 * order of creation.
 */
export function backupNameOf(at: Date): string {
  const iso = at.toISOString(); // 2026-10-03T14:25:30.123Z
  return `wallet-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.db`;
}

/**
 * Path `/:name` of GET /api/backups/:name. A value that is not a backup file name
 * (`BACKUP_NAME_PATTERN` and a real date) is a 400 `validation_error` at `name`. That is the whole
 * defence against path traversal, and it holds by construction: the pattern has no "/", "\", ".."
 * or NUL, and the server does not build a path from the value either: it looks the name up among
 * the files it lists in the backup directory (regular files only, symbolic links are skipped) and
 * answers 404 when it is not there. A name that matches and is not there is a 404, never a 400.
 */
export const backupNameParamsSchema = z.strictObject({
  name: z
    .string()
    .refine(
      (name) => parseBackupName(name) !== null,
      'Expected a backup file name like wallet-20261003-142530.db',
    ),
});
export type BackupNameParams = z.infer<typeof backupNameParamsSchema>;

/**
 * One backup file: an element of `BackupsDto.backups`, and the response of POST /api/backups
 * (201): it takes a backup now, with no body, a transactionally consistent copy of the whole
 * database made while the app keeps serving (docs/DOMAIN.md, "Backups"), and then applies rotation,
 * which never removes the backup just made. 409 `backups_unavailable` when there is no backup
 * directory. A disk error is a 500.
 *
 * GET /api/backups/:name → 200, the file itself, as a download:
 *
 *     Content-Type: application/octet-stream
 *     Content-Disposition: attachment; filename="wallet-20261003-142530.db"
 *     Content-Length: <sizeBytes>
 *
 * 400 `validation_error` for a malformed name (`backupNameParamsSchema`), 404 `not_found` for a
 * valid name that is not among the backups (also when there is no backup directory). Rotation can
 * remove a file between listing and downloading it, so a download can be a 404 for a name the
 * list showed a moment before.
 *
 * There are no other endpoints: a backup cannot be deleted, restored or uploaded through the API
 * (restoring replaces the database file while the app is stopped).
 */
export interface BackupDto {
  /** The file name, matching `BACKUP_NAME_PATTERN`. It is the id: `GET /api/backups/:name`. */
  name: string;
  /** When it was made: ISO-8601 UTC, from the name (`parseBackupName`). */
  createdAt: string;
  /** The size of the file in bytes. */
  sizeBytes: number;
}

/**
 * GET /api/backups → 200 BackupsDto. The backups newest first (by name, descending, which is by
 * `createdAt`), and the state of the automatic ones. Without a backup directory (see the notes at
 * the top of this file) it is 200 with `automatic: false`, `backups: []` and both timestamps null. Every backup has
 * the same kind: there is no daily or monthly label, because rotation keeps a file for either
 * reason and a file can be both.
 */
export interface BackupsDto {
  /**
   * A backup directory is configured, so backups run by themselves: at startup when the newest one
   * is older than `BACKUP_INTERVAL_HOURS` (24 h) or there is none, and then daily. false only
   * without a directory (the in-memory database and no `BACKUP_DIR`).
   */
  automatic: boolean;
  /** Newest first. Empty when there is none yet. */
  backups: BackupDto[];
  /** `createdAt` of the newest backup, or null when there is none. */
  lastBackupAt: string | null;
  /**
   * When the next automatic backup is due: `lastBackupAt` plus 24 hours, or the current time when
   * there is no backup yet. A time in the past means one is overdue and runs on the scheduler's
   * next check. null when `automatic` is false.
   */
  nextDueAt: string | null;
}
