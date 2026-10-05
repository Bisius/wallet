/**
 * `levelRow` and `restoreLevel`: how the bot takes back the alert level a confirmation recorded when
 * that confirmation never reached the user (telegram.rows.ts, `deliver`). The row is the dedupe row
 * of T3's notifier: kind `budget_alert`, key `<month>:<budgetId>`, value the highest level notified.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../db/client';
import { telegramNotifications } from '../../db/schema';
import { levelRow, restoreLevel } from './telegram.entries';

function database() {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

const KEY = { month: '2026-10', budgetId: 7 };
const SENT = '2026-10-05T10:00:00.000Z';

const insert = (db: ReturnType<typeof database>, value: string | null, sentAt = SENT) =>
  db
    .insert(telegramNotifications)
    .values({ kind: 'budget_alert', key: '2026-10:7', value, sentAt })
    .run();

const rows = (db: ReturnType<typeof database>) =>
  db
    .select()
    .from(telegramNotifications)
    .where(and(eq(telegramNotifications.kind, 'budget_alert')))
    .all()
    .map(({ key, value, sentAt }) => ({ key, value, sentAt }));

describe('levelRow', () => {
  it('reads the row of a budget this month, or null', () => {
    const db = database();
    expect(levelRow(db, KEY)).toBeNull();
    insert(db, 'warning');
    expect(levelRow(db, KEY)).toEqual({ value: 'warning', sentAt: SENT });
    expect(levelRow(db, { month: '2026-09', budgetId: 7 })).toBeNull();
    expect(levelRow(db, { month: '2026-10', budgetId: 8 })).toBeNull();
  });
});

describe('restoreLevel', () => {
  it('deletes the row the mark created, so that the next check announces the level', () => {
    const db = database();
    const before = levelRow(db, KEY); // none
    insert(db, 'warning'); // markNotified
    restoreLevel(db, { ...KEY, level: 'warning' }, before);
    expect(rows(db)).toEqual([]);
  });

  it('puts back the lower value the mark raised', () => {
    const db = database();
    insert(db, 'ok', '2026-10-01T00:00:00.000Z');
    const before = levelRow(db, KEY);
    db.update(telegramNotifications)
      .set({ value: 'over', sentAt: SENT })
      .where(eq(telegramNotifications.key, '2026-10:7'))
      .run();
    restoreLevel(db, { ...KEY, level: 'over' }, before);
    expect(rows(db)).toEqual([
      { key: '2026-10:7', value: 'ok', sentAt: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  it('leaves a row alone that held the same level before: the mark wrote nothing', () => {
    const db = database();
    insert(db, 'warning');
    const before = levelRow(db, KEY);
    restoreLevel(db, { ...KEY, level: 'warning' }, before);
    expect(rows(db)).toEqual([{ key: '2026-10:7', value: 'warning', sentAt: SENT }]);
  });

  it('leaves a row alone that holds another level now: a check or another confirmation moved it', () => {
    const db = database();
    const before = levelRow(db, KEY);
    insert(db, 'over'); // something announced 'over' meanwhile
    restoreLevel(db, { ...KEY, level: 'warning' }, before);
    expect(rows(db)).toEqual([{ key: '2026-10:7', value: 'over', sentAt: SENT }]);
  });

  it('does nothing when the row is gone, and touches no other budget or month', () => {
    const db = database();
    db.insert(telegramNotifications)
      .values({ kind: 'budget_alert', key: '2026-10:8', value: 'warning', sentAt: SENT })
      .run();
    db.insert(telegramNotifications)
      .values({ kind: 'budget_alert', key: '2026-09:7', value: 'warning', sentAt: SENT })
      .run();
    restoreLevel(db, { ...KEY, level: 'warning' }, null);
    expect(
      rows(db)
        .map((row) => row.key)
        .sort(),
    ).toEqual(['2026-09:7', '2026-10:8']);
  });

  it('never touches a row of another kind with the same key', () => {
    const db = database();
    db.insert(telegramNotifications)
      .values({ kind: 'recap', key: '2026-10:7', value: 'warning', sentAt: SENT })
      .run();
    restoreLevel(db, { ...KEY, level: 'warning' }, null);
    expect(db.select().from(telegramNotifications).all()).toHaveLength(1);
  });
});
