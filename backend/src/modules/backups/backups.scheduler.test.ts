import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanUpBackupFixtures,
  createBackupFixture,
  writeFakeBackups,
} from '../../testing/backup-fixture';
import { createTestApp } from '../../testing/test-app';
import { startBackupScheduler } from './backups.scheduler';
import { createBackup, whenBackupsIdle } from './backups.service';

const HOUR = 3_600_000;

const started: { stop(): Promise<void> }[] = [];
const logger = () => ({ log: vi.fn(), error: vi.fn() });

/** A real wait (the file system is not faked) until `check` holds, for work the timer started. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const files = (dir: string) => readdirSync(dir).sort();

function start(fixture: ReturnType<typeof createBackupFixture>, log = logger()) {
  const scheduler = startBackupScheduler({
    db: fixture.db,
    clock: fixture.clock,
    config: { backupDir: fixture.backupDir },
    log,
  });
  started.push(scheduler);
  return { scheduler, log };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // the file system stays real
});

afterEach(async () => {
  // Never leave a timer or a backup behind, and close the databases only after the backups ended.
  await Promise.all(started.splice(0).map((scheduler) => scheduler.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanUpBackupFixtures();
});

describe('the scheduler at startup', () => {
  it('makes a backup when there is none, without delaying the caller', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const { scheduler, log } = start(fixture);
    // startBackupScheduler returned synchronously: the backup runs in the background.
    expect(existsSync(join(fixture.backupDir as string, 'wallet-20260315-100000.db'))).toBe(false);
    await scheduler.tick();
    expect(files(fixture.backupDir as string)).toEqual(['wallet-20260315-100000.db']);
    expect(log.log).toHaveBeenCalledWith(
      expect.stringContaining('Backup wallet-20260315-100000.db written'),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('makes one when the newest is exactly 24 hours old, or older', async () => {
    for (const newest of ['wallet-20260314-100000.db', 'wallet-20260301-030000.db']) {
      const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
      writeFakeBackups(fixture.backupDir as string, [newest]);
      const { scheduler } = start(fixture);
      await scheduler.tick();
      expect(files(fixture.backupDir as string)).toContain('wallet-20260315-100000.db');
    }
  });

  it('makes none when the newest is less than 24 hours old, and says nothing', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    writeFakeBackups(fixture.backupDir as string, ['wallet-20260314-100001.db']); // 23 h 59 m 59 s
    const { scheduler, log } = start(fixture);
    await scheduler.tick();
    expect(files(fixture.backupDir as string)).toEqual(['wallet-20260314-100001.db']);
    expect(log.log).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('removes the temporary files of a crashed backup, and only those', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    writeFakeBackups(dir, [
      'wallet-20260315-090000.db', // a finished backup: kept (and fresh, so none is due)
      'wallet-20260315-090500.db.tmp', // crashed
      'wallet-20260315-090500.db.tmp-journal',
      'wallet-20260315-090500.db.tmp-wal',
      'notes.tmp', // not ours
      'other.db.tmp',
    ]);
    mkdirSync(join(dir, 'wallet-20260315-091000.db.tmp')); // a folder of that name is not a leftover either
    symlinkSync(join(fixture.root, 'nowhere'), join(dir, 'wallet-20260315-091500.db.tmp'));
    const { scheduler, log } = start(fixture);
    await scheduler.tick();
    await whenBackupsIdle(dir);
    expect(files(dir)).toEqual([
      'notes.tmp',
      'other.db.tmp',
      'wallet-20260315-090000.db',
      'wallet-20260315-091000.db.tmp',
      'wallet-20260315-091500.db.tmp',
    ]);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('wallet-20260315-090500.db.tmp'));
  });

  it('does nothing without a backup directory: no timer, no files, one line in the log', async () => {
    const fixture = createBackupFixture({ backupDir: null });
    const { scheduler, log } = start(fixture);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.tick();
    await scheduler.stop();
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('Automatic backups are off'));
    expect(existsSync(join(fixture.root, 'backups'))).toBe(false);
  });

  it('is never started by the app factory or by the test app', () => {
    createTestApp();
    createBackupFixture();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the hourly check', () => {
  it('runs once an hour on an unref-ed timer and backs up when the newest reaches 24 hours', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:30:00Z' });
    const dir = fixture.backupDir as string;
    writeFakeBackups(dir, ['wallet-20260315-100000.db']);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { scheduler } = start(fixture);
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(intervals.mock.calls[0]?.[1]).toBe(HOUR);
    await scheduler.tick(); // the startup check: fresh, nothing to do
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']);

    // 23 h 59 m 59 s after the newest: not yet.
    fixture.clock.set('2026-03-16T09:59:59Z');
    vi.advanceTimersByTime(HOUR);
    await scheduler.tick();
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']);

    // 24 hours: the next hourly check makes it, without anyone calling tick().
    fixture.clock.set('2026-03-16T10:00:00Z');
    vi.advanceTimersByTime(HOUR);
    await eventually(() => existsSync(join(dir, 'wallet-20260316-100000.db')), 'the hourly backup');
    await whenBackupsIdle(dir);
    // The 15th and the 16th are two days: rotation keeps the newest of each.
    expect(files(dir)).toEqual(['wallet-20260315-100000.db', 'wallet-20260316-100000.db']);
  });

  it('holds an unref-ed timer, so it never keeps the process alive, and stop clears it', async () => {
    vi.useRealTimers(); // a real timer object, to ask it
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const fixture = createBackupFixture();
    const { scheduler } = start(fixture);
    const timer = intervals.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await scheduler.stop();
    expect(intervals).toHaveBeenCalledTimes(1);
  });

  it('after stop() the timer is gone and nothing runs any more', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    const { scheduler } = start(fixture);
    await scheduler.tick();
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    fixture.clock.set('2026-03-20T10:00:00Z');
    vi.advanceTimersByTime(10 * HOUR);
    await scheduler.tick(); // a late call does nothing either
    await whenBackupsIdle(dir);
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']);
  });
});

describe('failures', () => {
  it('a failed backup is logged, never thrown, and the next check tries again', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    const real = fixture.db.$client.backup.bind(fixture.db.$client);
    vi.spyOn(fixture.db.$client, 'backup').mockImplementationOnce(async (destination: string) => {
      writeFileSync(destination, 'partial');
      throw new Error('ENOSPC: no space left on device');
    });
    const { scheduler, log } = start(fixture);
    await expect(scheduler.tick()).resolves.toBeUndefined(); // does not reject
    await whenBackupsIdle(dir);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Scheduled backup failed.*ENOSPC/),
    );
    expect(files(dir)).toEqual([]); // no half-written file under any name

    vi.spyOn(fixture.db.$client, 'backup').mockImplementation(real);
    vi.advanceTimersByTime(HOUR); // the process is still alive and the timer still runs
    await eventually(() => existsSync(join(dir, 'wallet-20260315-100000.db')), 'the retry');
    await whenBackupsIdle(dir);
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']);
  });

  it('survives a backup directory it cannot use: logged, and the server keeps running', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    // The "directory" is a file, so nothing can be created in it.
    writeFileSync(fixture.backupDir as string, 'not a directory');
    const { scheduler, log } = start(fixture);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});

describe('stopping', () => {
  /** Makes the next backups wait on `release()` and counts how many ran at the same time. */
  function gateBackups(fixture: ReturnType<typeof createBackupFixture>) {
    const real = fixture.db.$client.backup.bind(fixture.db.$client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const state = { running: 0, peak: 0, started: 0 };
    vi.spyOn(fixture.db.$client, 'backup').mockImplementation(async (destination: string) => {
      state.started += 1;
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      try {
        await gate;
        return await real(destination);
      } finally {
        state.running -= 1;
      }
    });
    return { release, state };
  }

  it('waits for a backup in flight, so the database can be closed after it', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    const { release, state } = gateBackups(fixture);
    const { scheduler } = start(fixture);
    const ticking = scheduler.tick();
    await eventually(() => state.started === 1, 'the backup to start');

    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false); // still waiting: the backup is not done
    expect(files(dir)).toEqual([]); // and nothing under a final name yet

    release();
    await stopping;
    await ticking;
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']); // finished, whole
    fixture.db.$client.close(); // closing is safe now
  });

  it('returns at once when nothing is running', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    writeFakeBackups(fixture.backupDir as string, ['wallet-20260315-090000.db']); // fresh: nothing due
    const { scheduler } = start(fixture);
    await scheduler.tick();
    const before = Date.now();
    await scheduler.stop();
    expect(Date.now() - before).toBeLessThan(500);
  });

  it('also waits for a backup a request started, since they share one queue', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const { release, state } = gateBackups(fixture);
    const { scheduler } = start(fixture);
    const post = request(fixture.app)
      .post('/api/backups')
      .then((res) => res);
    await eventually(() => state.started === 1, 'the request backup to start');
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await post).status).toBe(201);
  });

  it('never runs two backups at once: overlapping requests and the scheduled one take turns', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    const { release, state } = gateBackups(fixture);
    const { scheduler } = start(fixture);
    // Three requests, queued in this order (the service call enqueues synchronously), then the check.
    const deps = { db: fixture.db, clock: fixture.clock, backupDir: dir };
    const requests = [createBackup(deps), createBackup(deps), createBackup(deps)];
    const ticking = scheduler.tick();
    release();
    const made = await Promise.all(requests);
    await ticking;
    await whenBackupsIdle(dir);
    expect(state.peak).toBe(1);
    expect(made.map((backup) => backup.name)).toEqual([
      'wallet-20260315-100000.db',
      'wallet-20260315-100001.db',
      'wallet-20260315-100002.db',
    ]);
    // The scheduled check waited its turn, found a fresh backup and made none: 3 backups, not 4.
    expect(state.started).toBe(3);
    expect(files(dir)).toEqual(['wallet-20260315-100002.db']);
  });

  it('a backup the scheduler had queued but not started is dropped when it is stopped', async () => {
    const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
    const dir = fixture.backupDir as string;
    const { release, state } = gateBackups(fixture);
    const post = request(fixture.app)
      .post('/api/backups')
      .then((res) => res.status);
    await eventually(() => state.started === 1, 'the request backup to start');
    const { scheduler } = start(fixture); // its check queues behind the request's backup
    const stopping = scheduler.stop();
    release();
    await stopping;
    expect(await post).toBe(201);
    expect(state.started).toBe(1);
    expect(files(dir)).toEqual(['wallet-20260315-100000.db']);
  });
});
