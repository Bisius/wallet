/**
 * The point of backups (docs/DOMAIN.md, "Backups"): after the data is lost or changed, the file
 * taken earlier holds exactly the state of that moment, and restoring it brings the app back to
 * what it showed then, to the cent. Every step goes through the public endpoints; the files are
 * opened with a database handle of their own.
 */
import type { BackupDto, MonthView } from '@wallet/shared';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  addTag,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { dumpDb } from '../../testing/db-dump';
import {
  cleanUpBackupFixtures,
  createBackupFixture,
  dumpSqlite,
  openBackupReadOnly,
} from '../../testing/backup-fixture';
import { getJson, monthView } from '../../testing/story';

afterEach(() => {
  cleanUpBackupFixtures();
  vi.restoreAllMocks();
});

const take = async (app: Parameters<typeof request>[0]): Promise<BackupDto> =>
  (await request(app).post('/api/backups').expect(201)).body;

describe('restoring a backup', () => {
  it('holds exactly the state of the moment it was taken, and restoring it brings back every figure', async () => {
    const { app, db, clock, dbPath, backupDir } = createBackupFixture({
      now: '2026-03-15T10:00:00Z',
    });
    await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
    const groceries = await addBudget(app, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
      startMonth: '2026-01',
    });
    const fun = await addBudget(app, {
      name: 'Fun',
      amount: 10000,
      incremental: true,
      startMonth: '2026-01',
    });
    await addSubscription(app, { name: 'Netflix', amount: 1299, anchorDate: '2026-01-15' });
    const tag = await addTag(app, { name: 'weekly' });
    await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-01-20',
      amount: 25000,
      description: 'Big shop',
      tagIds: [tag.id],
    });
    await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-02-11',
      amount: 18000,
      description: 'Market',
    });
    await addSpending(app, {
      budgetId: fun.id,
      date: '2026-02-14',
      amount: 3500,
      description: 'Cinema',
    });
    await addSpending(app, {
      budgetId: groceries.id,
      date: '2026-03-10',
      amount: 12050,
      description: 'Lunch',
    });
    await addIncome(app, { date: '2026-03-05', amount: 50000, description: 'Bonus' });
    // A row of the newest table too: a backup holds every table.
    db.$client
      .prepare(
        "insert into import_profiles (name, mapping) values ('My bank', '{\"hasHeader\":true}')",
      )
      .run();

    // What the app shows and what the database holds, right before the backup.
    const months = ['2026-01', '2026-02', '2026-03'];
    const viewsBefore = await Promise.all(months.map((month) => monthView(app, month)));
    const savingsBefore = await getJson(app, '/api/savings');
    const dumpBefore = dumpDb(db);

    const backup = await take(app);
    expect(backup.name).toBe('wallet-20260315-100000.db');
    expect(dumpDb(db)).toBe(dumpBefore); // taking a backup writes no table
    expect(await monthView(app, '2026-03')).toEqual(viewsBefore[2]);

    // Then the data is changed: spendings gone, a budget removed, the salary raised, a new month.
    for (const spending of (
      await getJson<{ items: { id: number }[] }>(app, '/api/spendings?limit=100')
    ).items) {
      await request(app).delete(`/api/spendings/${spending.id}`).expect(204);
    }
    await request(app).put('/api/salary/2026-03').send({ amount: 999900 }).expect(200);
    clock.set('2026-04-10T09:00:00Z');
    await addSpending(app, {
      budgetId: fun.id,
      date: '2026-04-09',
      amount: 100,
      description: 'April',
    });
    expect(dumpDb(db)).not.toBe(dumpBefore);
    expect(await monthView(app, '2026-03')).not.toEqual(viewsBefore[2]);

    // The backup file still holds the old state: every row of every table, the migrations included.
    const file = join(backupDir as string, backup.name);
    const copy = openBackupReadOnly(file);
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(dumpSqlite(copy)).toBe(dumpBefore);
      expect(copy.prepare('select count(*) from spendings').pluck().get()).toBe(4);
      expect(copy.prepare('select name from import_profiles').pluck().get()).toBe('My bank');
    } finally {
      copy.close();
    }

    // Restore as the documentation says: stop the app (close the database), copy the backup over the
    // database file, delete the -wal and -shm files, start it again.
    db.$client.close();
    copyFileSync(file, dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const restoredDb = createDb(dbPath);
    runMigrations(restoredDb);
    try {
      const restored = createApp({
        db: restoredDb,
        clock: mutableClock('2026-03-15T10:00:00Z'),
        config: { env: 'test', staticDir: undefined, backupDir },
      });
      expect(dumpDb(restoredDb)).toBe(dumpBefore);
      const viewsAfter: MonthView[] = await Promise.all(
        months.map((month) => monthView(restored, month)),
      );
      expect(viewsAfter).toEqual(viewsBefore);
      expect(await getJson(restored, '/api/savings')).toEqual(savingsBefore);
    } finally {
      restoredDb.$client.close();
    }
  });

  it('a backup file works as a database on its own, and so does a copy of it somewhere else', async () => {
    const { app, db, backupDir, root } = createBackupFixture();
    await onboard(app);
    const budget = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
    await addSpending(app, { budgetId: budget.id, date: '2026-03-10', amount: 1250 });
    const backup = await take(app);
    expect(readdirSync(backupDir as string)).toEqual([backup.name]); // no -wal, -shm or temporary file

    mkdirSync(join(root, 'elsewhere'));
    const elsewhere = join(root, 'elsewhere', 'restored.db');
    copyFileSync(join(backupDir as string, backup.name), elsewhere);
    const restoredDb = createDb(elsewhere); // opens it the way the server does: WAL, foreign keys
    try {
      runMigrations(restoredDb); // nothing to apply: the migrations are in the file
      expect(dumpDb(restoredDb)).toBe(dumpDb(db));
      expect(restoredDb.$client.pragma('foreign_key_check')).toEqual([]);
    } finally {
      restoredDb.$client.close();
    }
  });
});

describe('a backup is a snapshot', () => {
  it('multi-month: one backup at the end of each month, each holding the state of its day', async () => {
    const { app, clock, backupDir } = createBackupFixture({ now: '2026-01-31T22:00:00Z' });
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, {
      name: 'Groceries',
      amount: 40000,
      incremental: true,
      startMonth: '2026-01',
    });

    const taken: { backup: BackupDto; spendings: number; remaining: number }[] = [];
    const spend = [
      { day: '2026-01-31T22:00:00Z', date: '2026-01-30', amount: 10000 },
      { day: '2026-02-28T22:00:00Z', date: '2026-02-27', amount: 25000 },
      { day: '2026-03-31T22:00:00Z', date: '2026-03-30', amount: 5000 },
      { day: '2026-04-30T22:00:00Z', date: '2026-04-29', amount: 40000 },
    ];
    let count = 0;
    for (const step of spend) {
      clock.set(step.day);
      await addSpending(app, { budgetId: budget.id, date: step.date, amount: step.amount });
      count += 1;
      const view = await monthView(app, step.day.slice(0, 7));
      const line = view.budgets.find((b) => b.name === 'Groceries');
      taken.push({ backup: await take(app), spendings: count, remaining: line?.remaining ?? NaN });
    }

    // Four days, four months: nothing is rotated away, and each file has its own moment.
    expect(
      (await getJson<{ backups: BackupDto[] }>(app, '/api/backups')).backups.map((b) => b.name),
    ).toEqual(taken.map((t) => t.backup.name).reverse());
    for (const { backup, spendings } of taken) {
      const copy = openBackupReadOnly(join(backupDir as string, backup.name));
      try {
        expect(copy.prepare('select count(*) from spendings').pluck().get()).toBe(spendings);
      } finally {
        copy.close();
      }
    }
    // The incremental budget carried 30000 and 5000 over (January: 40000 - 10000 = 30000; February
    // 30000 + 40000 - 25000 = 45000; March 45000 + 40000 - 5000 = 80000; April 80000 + 40000 - 40000 = 80000).
    expect(taken.map((t) => t.remaining)).toEqual([30000, 45000, 80000, 80000]);
  });

  it('keeps writes that happen while it runs out of it half-applied: every budget has its version, in every state it could see', async () => {
    const { app, db, backupDir } = createBackupFixture();
    await onboard(app);
    const sqlite = db.$client;
    // Ballast, so the copy takes many cycles of the online backup and the writes interleave with them.
    sqlite.exec('create table ballast (id integer primary key, pad text not null)');
    const pad = 'x'.repeat(400);
    sqlite.transaction(() => {
      const insert = sqlite.prepare('insert into ballast (pad) values (?)');
      for (let i = 0; i < 20_000; i++) insert.run(pad);
    })();

    // A write of two related rows in one transaction, as the service does: a budget and its version.
    const insertBudget = sqlite.prepare(
      "insert into budgets (name, start_month) values (?, '2026-01')",
    );
    const insertVersion = sqlite.prepare(
      "insert into budget_versions (budget_id, effective_month, amount, incremental) values (?, '2026-01', 1000, 0)",
    );
    let written = 0;
    const writePair = sqlite.transaction(() => {
      written += 1;
      const { lastInsertRowid } = insertBudget.run(`budget ${written}`);
      insertVersion.run(lastInsertRowid);
    });

    // Deterministic interleaving: after every few pages the online backup hands control back, and
    // this writes a pair on the same connection, which is what a request does between two cycles.
    const realBackup = sqlite.backup.bind(sqlite);
    let cycles = 0;
    vi.spyOn(sqlite, 'backup').mockImplementation((destination: string) =>
      realBackup(destination, {
        progress: () => {
          cycles += 1;
          writePair();
          return 25;
        },
      }),
    );

    const backup = await take(app);
    expect(cycles).toBeGreaterThan(10); // the copy really was taken in many cycles, with writes between them
    expect(written).toBe(cycles);

    const copy = openBackupReadOnly(join(backupDir as string, backup.name));
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.pragma('foreign_key_check')).toEqual([]);
      const budgets = copy.prepare('select count(*) from budgets').pluck().get() as number;
      const versions = copy.prepare('select count(*) from budget_versions').pluck().get() as number;
      const orphans = copy
        .prepare(
          'select count(*) from budgets b where not exists (select 1 from budget_versions v where v.budget_id = b.id)',
        )
        .pluck()
        .get();
      expect(budgets).toBeGreaterThan(0);
      expect(versions).toBe(budgets); // never a budget without its version, nor a version without its budget
      expect(orphans).toBe(0);
      // The copy is one state of the database: it is the state at the end of the last cycle.
      expect(budgets).toBeLessThanOrEqual(written);
      expect(budgets).toBeGreaterThanOrEqual(written - 1);
    } finally {
      copy.close();
    }
  });

  it('is consistent while requests keep writing through the API, and nothing gets lost in the live database', async () => {
    const { app, db, backupDir } = createBackupFixture();
    await onboard(app);
    const sqlite = db.$client;
    sqlite.exec('create table ballast (id integer primary key, pad text not null)');
    sqlite.transaction(() => {
      const insert = sqlite.prepare('insert into ballast (pad) values (?)');
      for (let i = 0; i < 20_000; i++) insert.run('y'.repeat(400));
    })();

    const writes = 60;
    const backupPromise = take(app);
    // Requests are served while the copy is taken: each one is a transaction (a budget and its version).
    for (let i = 0; i < writes; i++) {
      await request(app)
        .post('/api/budgets')
        .send({
          name: `Budget ${i}`,
          amount: 1000 + i,
          incremental: i % 2 === 0,
          startMonth: '2026-01',
        })
        .expect(201);
    }
    const backup = await backupPromise;

    const live = sqlite.prepare('select count(*) from budgets').pluck().get();
    expect(live).toBe(writes); // every write was kept by the live database
    const copy = openBackupReadOnly(join(backupDir as string, backup.name));
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.pragma('foreign_key_check')).toEqual([]);
      const budgets = copy.prepare('select count(*) from budgets').pluck().get() as number;
      expect(copy.prepare('select count(*) from budget_versions').pluck().get()).toBe(budgets);
      expect(budgets).toBeLessThanOrEqual(writes);
      // Whatever it holds is a prefix of what was written: ids are 1..n without gaps.
      expect(copy.prepare('select max(id) from budgets').pluck().get()).toBe(budgets || null);
      expect(existsSync(join(backupDir as string, `${backup.name}.tmp`))).toBe(false);
    } finally {
      copy.close();
    }
  });
});
