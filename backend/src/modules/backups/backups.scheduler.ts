import type { Config } from '../../config';
import type { Db } from '../../db/client';
import type { Clock } from '../../lib/clock';
import { createBackupIfDue, removeBackupLeftovers, whenBackupsIdle } from './backups.service';

const HOUR_MS = 60 * 60 * 1000;

export interface BackupSchedulerOptions {
  db: Db;
  /** The only source of "now": the age of the newest backup is measured against it. */
  clock: Clock;
  config: Pick<Config, 'backupDir'>;
  /** Where messages go (default: the console). */
  log?: Pick<Console, 'log' | 'error'>;
  /** How often to check whether a backup is due (default: every hour). */
  checkEveryMs?: number;
}

export interface BackupScheduler {
  /**
   * Stops checking and resolves once no backup of the directory is running or waiting, so the
   * database can be closed. Never rejects.
   */
  stop(): Promise<void>;
  /** Runs one check now, as the timer does: a backup when one is due. Never rejects. For tests. */
  tick(): Promise<void>;
}

const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
};

/**
 * The automatic backups (docs/DOMAIN.md, "Backups"). Used by `index.ts` only: `createApp` and the
 * tests never start a timer. At startup it removes the temporary files of a crashed backup and
 * makes a backup when there is none or the newest is `BACKUP_INTERVAL_HOURS` (24 h) old or more,
 * without delaying `listen`: the first check runs in the background. Then it checks once an hour
 * on an `unref`'d timer, which never keeps the process alive, and backs up on the same rule.
 *
 * A failure is logged and the next check tries again: a full disk must not take the server down.
 * A check that finds the previous one still running is skipped, and the backups themselves share a
 * queue with `POST /api/backups` (see the service), so they never overlap.
 */
export function startBackupScheduler({
  db,
  clock,
  config,
  log = console,
  checkEveryMs = HOUR_MS,
}: BackupSchedulerOptions): BackupScheduler {
  const dir = config.backupDir;
  if (!dir) {
    log.log('Automatic backups are off: no backup directory (set BACKUP_DIR)');
    return { stop: async () => undefined, tick: async () => undefined };
  }

  const deps = { db, clock, backupDir: dir };
  let stopped = false;
  let running: Promise<void> | undefined;

  const check = async (): Promise<void> => {
    try {
      const made = await createBackupIfDue(deps, () => stopped);
      if (made) {
        const pruned = made.removed.length > 0 ? `, removed ${made.removed.length} old` : '';
        log.log(`Backup ${made.backup.name} written (${made.backup.sizeBytes} bytes${pruned})`);
      }
    } catch (error) {
      log.error(`Scheduled backup failed, will retry at the next check: ${describe(error)}`);
    }
  };

  // One check at a time: a check that finds the previous one still running joins it.
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= check().finally(() => {
      running = undefined;
    });
    return running;
  };

  const startup = removeBackupLeftovers(dir)
    .then((removed) => {
      if (removed.length > 0)
        log.log(`Removed leftovers of an interrupted backup: ${removed.join(', ')}`);
    })
    .catch((error: unknown) => log.error(`Could not clean ${dir}: ${describe(error)}`))
    .then(tick);

  const timer = setInterval(() => void tick(), checkEveryMs);
  timer.unref();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await startup;
      await whenBackupsIdle(dir);
    },
  };
}
