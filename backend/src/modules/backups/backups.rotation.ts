import { BACKUP_KEEP_DAILY, BACKUP_KEEP_MONTHLY, parseBackupName } from '@wallet/shared';

/**
 * Backup rotation (docs/DOMAIN.md, "Backups"). Pure: file names in, file names out, no clock and no
 * file system, so it is decided by the names alone and the same list always gives the same answer.
 */
export interface RotationRules {
  /** How many of the most recent UTC calendar days that have a backup keep their newest backup. */
  keepDaily: number;
  /** How many of the most recent UTC calendar months that have a backup keep their newest backup. */
  keepMonthly: number;
}

export const DEFAULT_ROTATION: RotationRules = {
  keepDaily: BACKUP_KEEP_DAILY,
  keepMonthly: BACKUP_KEEP_MONTHLY,
};

/**
 * Of the backup names in `names`, the ones to delete. Kept are the UNION of
 *
 * - the newest backup of each of the `keepDaily` most recent UTC days that have at least one, and
 * - the newest backup of each of the `keepMonthly` most recent UTC months that have at least one,
 *
 * plus every name in `protect` (the backup just made: the clock can move backwards, so the file
 * just written is not always the newest by name, and rotation must never take it away).
 *
 * "Most recent days that have a backup", not "the last 14 calendar days": a server that was off for
 * a month keeps what it had instead of deleting everything. The names are the whole input, so the
 * time zone, the clock and the files' modification times play no part.
 *
 * Only names that are backup file names (`parseBackupName`: the pattern and a real instant) are
 * considered, and only those can be returned: anything else in the list is none of rotation's
 * business. Duplicates count once. The result is ascending (oldest first).
 */
export function backupsToDelete(
  names: readonly string[],
  rules: RotationRules = DEFAULT_ROTATION,
  protect: readonly string[] = [],
): string[] {
  const backups = [...new Set(names)].filter((name) => parseBackupName(name) !== null).sort();

  // Names are fixed-width, so sorting them sorts by time and a prefix is a calendar bucket:
  // `wallet-YYYYMMDD` is the UTC day, `wallet-YYYYMM` the UTC month.
  const kept = new Set<string>(protect);
  for (const [prefixLength, count] of [
    [15, rules.keepDaily],
    [13, rules.keepMonthly],
  ] as const) {
    const newestOfBucket = new Map<string, string>();
    for (const name of backups) newestOfBucket.set(name.slice(0, prefixLength), name); // ascending: the last wins
    // Buckets are in ascending order too: the most recent ones are at the end.
    const recent = [...newestOfBucket.values()].slice(Math.max(0, newestOfBucket.size - count));
    for (const name of recent) kept.add(name);
  }

  return backups.filter((name) => !kept.has(name));
}
