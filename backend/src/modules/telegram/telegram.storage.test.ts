/**
 * What the tables of the bot are, and are not (docs/DOMAIN.md, "Not facts" and "The stored data"):
 * in the backups, so a restore brings the link and the preferences back; in no export, no ledger
 * figure and no check of `start_month_after_facts`; and not touched by any money rule.
 */
import type { MonthView, SavingsDto } from '@wallet/shared';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { type Db, createDb, runMigrations } from '../../db/client';
import {
  telegramEntries,
  telegramLink,
  telegramNotifications,
  telegramPairing,
  telegramSettings,
} from '../../db/schema';
import {
  cleanUpBackupFixtures,
  createBackupFixture,
  openBackupReadOnly,
} from '../../testing/backup-fixture';
import { dumpDb } from '../../testing/db-dump';
import { FakeBotApi, OWNER, messageUpdate } from '../../testing/fake-bot-api';
import { linkTelegramAccount } from '../../testing/fake-telegram';
import {
  addBudget,
  addIncome,
  addSpending,
  addSubscription,
  expectRuleViolation,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { balances, budgetLine, getJson, monthView } from '../../testing/story';
import { earliestFactMonth } from '../settings/settings.service';
import { createPairing, findLink } from './telegram.access';
import { createTelegramRuntime } from './telegram.runtime';
import { TOKEN } from '../../testing/telegram-harness';

afterEach(cleanUpBackupFixtures);

const MONTHS = ['2026-01', '2026-02', '2026-03'];

/** Salary 3000.00, opening savings 500.00; Groceries 400.00 (settled each month), Fun 100.00 (carries over). */
async function scenario() {
  const fixture = createBackupFixture({ now: '2026-03-15T10:00:00Z' });
  const { app, db } = fixture;
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
  const bigShop = await addSpending(app, {
    budgetId: groceries.id,
    date: '2026-01-20',
    amount: 25000,
    description: 'Big shop',
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
  const bonus = await addIncome(app, { date: '2026-03-05', amount: 50000, description: 'Bonus' });
  return { ...fixture, groceries, fun, bigShop, bonus };
}

/** Rows in every table of the bot, as a link, a code, preferences, what the bot made and what it sent. */
function fillTelegramTables(db: Db, spendingId: number, incomeId: number): void {
  linkTelegramAccount(db, OWNER, '2026-03-10T08:15:00.000Z');
  createPairing({ db, clock: mutableClock('2026-03-15T10:00:00Z') });
  db.insert(telegramSettings)
    .values({
      id: 1,
      budgetAlerts: false,
      renewalYearlyDays: 14,
      renewalMonthlyDays: 3,
      monthlyRecap: false,
      notifyAt: '07:45',
    })
    .run();
  db.insert(telegramEntries).values({ spendingId }).run();
  db.insert(telegramEntries).values({ incomeId }).run();
  db.insert(telegramNotifications)
    .values([
      {
        kind: 'budget_alert',
        key: '2026-02:1',
        value: 'warning',
        sentAt: '2026-02-20T09:00:00.000Z',
      },
      { kind: 'renewal', key: '1:2026-03-15', sentAt: '2026-03-14T09:00:00.000Z' },
      { kind: 'recap', key: '2026-02', sentAt: '2026-03-01T09:00:00.000Z' },
    ])
    .run();
}

const ledger = async (app: Parameters<typeof request>[0]) => ({
  months: await Promise.all(MONTHS.map((month) => monthView(app as never, month))),
  savings: await getJson<SavingsDto>(app as never, '/api/savings'),
  spendings: (await request(app).get('/api/export/spendings.csv')).text,
  incomes: (await request(app).get('/api/export/incomes.csv')).text,
  savingsCsv: (await request(app).get('/api/export/savings.csv')).text,
});

describe('the tables of the bot are not facts', () => {
  it('leave every ledger figure and every export as they were, to the cent', async () => {
    const { app, db, bigShop, bonus } = await scenario();
    const before = await ledger(app);

    // Hand-worked figures of the scenario, so that the comparison below is not of two wrong numbers.
    const [jan, feb] = before.months as [MonthView, MonthView, MonthView];
    // [carriedIn, allocated, available, spent, remaining, carriedOut, toSavings]
    expect(balances(budgetLine(jan, 'Groceries'))).toEqual([
      0, 40000, 40000, 25000, 15000, 0, 15000,
    ]);
    expect(balances(budgetLine(feb, 'Groceries'))).toEqual([
      0, 40000, 40000, 18000, 22000, 0, 22000,
    ]);
    expect(balances(budgetLine(jan, 'Fun'))).toEqual([0, 10000, 10000, 0, 10000, 10000, 0]);
    expect(balances(budgetLine(feb, 'Fun'))).toEqual([10000, 10000, 20000, 3500, 16500, 16500, 0]);

    fillTelegramTables(db, bigShop.id, bonus.id);
    expect(db.select().from(telegramLink).all()).toHaveLength(1);
    expect(await ledger(app)).toEqual(before);
  });

  it('are not read by earliestFactMonth, so they never block moving the start month', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const app = createApp({
      db,
      clock: mutableClock('2026-03-15T10:00:00Z'),
      config: { env: 'test', staticDir: undefined },
    });
    const settings = {
      currency: 'EUR',
      locale: 'en-US',
      startMonth: '2026-01',
      theme: 'system',
      alertWarnPercent: 80,
    };
    await request(app).put('/api/settings').send(settings).expect(200);

    // Rows of the bot dated before the new start month, and no fact at all.
    linkTelegramAccount(db, OWNER, '2025-11-01T08:00:00.000Z');
    db.insert(telegramNotifications)
      .values([
        { kind: 'budget_alert', key: '2026-01:1', value: 'over' },
        { kind: 'recap', key: '2026-01' },
      ])
      .run();
    expect(earliestFactMonth(db)).toBeNull();
    await request(app)
      .put('/api/settings')
      .send({ ...settings, startMonth: '2026-02' })
      .expect(200);

    // A real fact does block the next move: the check is alive, the bot's rows just are not facts.
    await request(app)
      .post('/api/incomes')
      .send({ date: '2026-02-05', amount: 100, description: 'Gift' })
      .expect(201);
    expect(earliestFactMonth(db)).toBe('2026-02');
    expectRuleViolation(
      await request(app)
        .put('/api/settings')
        .send({ ...settings, startMonth: '2026-03' }),
      'start_month_after_facts',
      'startMonth',
    );
  });
});

describe('the backups hold the link and the preferences', () => {
  it('a backup copies every table of the bot, and a restore brings them back with the same figures', async () => {
    const { app, db, clock, dbPath, backupDir, bigShop, bonus } = await scenario();
    fillTelegramTables(db, bigShop.id, bonus.id);
    const ledgerBefore = await ledger(app);
    const dumpBefore = dumpDb(db);

    const backup = (await request(app).post('/api/backups').expect(201)).body as { name: string };
    const file = join(backupDir as string, backup.name);
    const copy = openBackupReadOnly(file);
    try {
      for (const table of [
        'telegram_link',
        'telegram_pairing',
        'telegram_settings',
        'telegram_entries',
        'telegram_notifications',
      ]) {
        expect(copy.prepare(`select count(*) from ${table}`).pluck().get(), table).toBeGreaterThan(
          0,
        );
      }
      expect(copy.prepare('select first_name, user_id from telegram_link').get()).toEqual({
        first_name: 'Olivia',
        user_id: OWNER.id,
      });
    } finally {
      copy.close();
    }

    // Then the link is lost, the preferences changed and a spending (with its entry) deleted.
    await request(app).delete('/api/telegram/link').expect(204);
    await request(app)
      .put('/api/telegram/notifications')
      .send({
        budgetAlerts: true,
        renewalYearlyDays: 1,
        renewalMonthlyDays: 1,
        monthlyRecap: true,
        notifyAt: '12:00',
      })
      .expect(200);
    await request(app).delete(`/api/spendings/${bigShop.id}`).expect(204);
    expect(dumpDb(db)).not.toBe(dumpBefore);
    expect((await request(app).get('/api/telegram')).body.link).toBeNull();

    // Restore as the documentation says: stop, copy the file over the database, drop -wal and -shm, start.
    db.$client.close();
    copyFileSync(file, dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const restoredDb = createDb(dbPath);
    runMigrations(restoredDb);
    try {
      const restored = createApp({
        db: restoredDb,
        clock,
        config: { env: 'test', staticDir: undefined },
      });
      expect(dumpDb(restoredDb)).toBe(dumpBefore);
      const status = (await request(restored).get('/api/telegram').expect(200)).body;
      expect(status.link).toEqual({
        name: 'Olivia',
        username: 'olivia',
        linkedAt: '2026-03-10T08:15:00.000Z',
      });
      expect(status.notifications).toEqual({
        budgetAlerts: false,
        renewalYearlyDays: 14,
        renewalMonthlyDays: 3,
        monthlyRecap: false,
        notifyAt: '07:45',
      });
      expect(status.pairing).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{8}$/) });
      expect(restoredDb.select().from(telegramEntries).all()).toHaveLength(2);
      expect(restoredDb.select().from(telegramNotifications).all()).toHaveLength(3);
      expect(await ledger(restored)).toEqual(ledgerBefore);
    } finally {
      restoredDb.$client.close();
    }
  });

  it('never puts the bot token in the database or in a backup, after a real link through the bot', async () => {
    const { db, clock, backupDir, dbPath } = createBackupFixture();
    const fake = new FakeBotApi();
    const runtime = createTelegramRuntime({
      db,
      clock,
      config: {
        telegramBotToken: TOKEN,
        telegramApiRoot: 'https://api.telegram.org',
        appUrl: undefined,
      },
      sink: { log: () => undefined, error: () => undefined },
      transformer: fake.transformer,
    });
    const app = createApp({
      db,
      clock,
      config: { env: 'test', staticDir: undefined, backupDir },
      telegram: runtime,
    });
    try {
      await onboard(app);
      runtime.start();
      await vi.waitFor(() => expect(runtime.status().connection).toBe('running'));
      const { code } = (await request(app).post('/api/telegram/pairing').expect(201)).body;
      fake.push(messageUpdate(`/start ${code}`, { from: OWNER }));
      await vi.waitFor(() => expect(findLink(db)?.userId).toBe(OWNER.id));
      await request(app)
        .put('/api/telegram/notifications')
        .send({
          budgetAlerts: true,
          renewalYearlyDays: 7,
          renewalMonthlyDays: 1,
          monthlyRecap: true,
          notifyAt: '09:00',
        })
        .expect(200);
      const backup = (await request(app).post('/api/backups').expect(201)).body as { name: string };

      db.$client.pragma('wal_checkpoint(TRUNCATE)');
      for (const file of [dbPath, join(backupDir as string, backup.name)]) {
        const bytes = readFileSync(file);
        expect(bytes.includes(TOKEN), file).toBe(false);
        expect(bytes.includes(TOKEN.split(':')[1] as string), file).toBe(false);
      }
    } finally {
      await runtime.stop();
    }
  });
});

describe('telegram_entries', () => {
  it('lose a row when the spending or the income is deleted, from anywhere', async () => {
    const { app, db, bigShop, bonus } = await scenario();
    fillTelegramTables(db, bigShop.id, bonus.id);
    expect(db.select().from(telegramEntries).all()).toHaveLength(2);
    await request(app).delete(`/api/spendings/${bigShop.id}`).expect(204);
    expect(
      db
        .select()
        .from(telegramEntries)
        .all()
        .map((e) => [e.spendingId, e.incomeId]),
    ).toEqual([[null, bonus.id]]);
    await request(app).delete(`/api/incomes/${bonus.id}`).expect(204);
    expect(db.select().from(telegramEntries).all()).toEqual([]);
  });

  it('hold exactly one of the two ids, and one row per spending or income', async () => {
    const { db, bigShop, bonus } = await scenario();
    expect(() => db.insert(telegramEntries).values({}).run()).toThrow(
      /CHECK|telegram_entries_one_target/,
    );
    expect(() =>
      db.insert(telegramEntries).values({ spendingId: bigShop.id, incomeId: bonus.id }).run(),
    ).toThrow(/CHECK|telegram_entries_one_target/);
    db.insert(telegramEntries).values({ spendingId: bigShop.id }).run();
    expect(() => db.insert(telegramEntries).values({ spendingId: bigShop.id }).run()).toThrow(
      /UNIQUE/,
    );
    db.insert(telegramEntries).values({ incomeId: bonus.id }).run();
    expect(() => db.insert(telegramEntries).values({ incomeId: bonus.id }).run()).toThrow(/UNIQUE/);
  });

  it('cannot point at a spending that does not exist', async () => {
    const { db } = await scenario();
    expect(() => db.insert(telegramEntries).values({ spendingId: 999 }).run()).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('telegram_notifications and the other tables', () => {
  it('is unique by kind and key, and the kinds are the three of the log', async () => {
    const { db } = await scenario();
    db.insert(telegramNotifications).values({ kind: 'recap', key: '2026-02' }).run();
    expect(() =>
      db.insert(telegramNotifications).values({ kind: 'recap', key: '2026-02' }).run(),
    ).toThrow(/UNIQUE/);
    db.insert(telegramNotifications).values({ kind: 'renewal', key: '2026-02' }).run(); // same key, another kind
    expect(db.select().from(telegramNotifications).all()).toHaveLength(2);
  });

  it('keeps the preferences in range and the singletons single, in the database itself', async () => {
    const { db } = await scenario();
    const row = {
      budgetAlerts: true,
      renewalYearlyDays: 7,
      renewalMonthlyDays: 1,
      monthlyRecap: true,
      notifyAt: '09:00',
    };
    expect(() =>
      db
        .insert(telegramSettings)
        .values({ id: 1, ...row, renewalYearlyDays: 31 })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(telegramSettings)
        .values({ id: 1, ...row, renewalMonthlyDays: -1 })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(telegramSettings)
        .values({ id: 2, ...row })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(telegramPairing)
        .values({ id: 1, code: 'ABCDEFGH', expiresAt: 'x', failedAttempts: -1 })
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('migration 0003_telegram', () => {
  it('applies on a database that is at 0002 and has data, and leaves that data alone', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const app = createApp({
      db,
      clock: mutableClock('2026-03-15T10:00:00Z'),
      config: { env: 'test', staticDir: undefined },
    });
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
    await addSpending(app, { budgetId: budget.id, date: '2026-03-10', amount: 1250 });

    // Put the database back as 0002 left it: no table of the bot, and no record of the migration.
    const sqlite = db.$client;
    for (const table of [
      'telegram_entries',
      'telegram_notifications',
      'telegram_pairing',
      'telegram_settings',
      'telegram_link',
    ]) {
      sqlite.exec(`drop table ${table}`);
    }
    sqlite.exec(
      'delete from __drizzle_migrations where rowid = (select max(rowid) from __drizzle_migrations)',
    );
    const before = (name: string) => sqlite.prepare(`select * from ${name} order by rowid`).all();
    const spendingsBefore = before('spendings');
    const budgetsBefore = before('budgets');

    runMigrations(db); // what a server does at startup
    expect(
      sqlite
        .prepare(
          "select count(*) from sqlite_master where name like 'telegram_%' and type = 'table'",
        )
        .pluck()
        .get(),
    ).toBe(5);
    expect(sqlite.prepare('select count(*) from __drizzle_migrations').pluck().get()).toBe(4);
    expect(before('spendings')).toEqual(spendingsBefore);
    expect(before('budgets')).toEqual(budgetsBefore);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect((await request(app).get('/api/telegram').expect(200)).body.configured).toBe(false);
  });
});
