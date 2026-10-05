/**
 * What the bot created (`telegram_entries`, docs/DOMAIN.md, "The stored data") and the reads of the
 * stored rows the buttons act on. Not a fact and not a figure: the table only lets `/undo` find the
 * latest spending or income that came from Telegram and still exists (deleting the row, from
 * anywhere, deletes its entry by foreign key cascade).
 *
 * The reads here return the stored row as it is. Nothing here writes a spending or an income: that
 * is the services' job (`telegram.records.ts`).
 */
import type { BudgetAlert, IsoDate, MonthKey } from '@wallet/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { incomes, spendings, telegramEntries, telegramNotifications } from '../../db/schema';
import type { Clock } from '../../lib/clock';
import { timestampOf } from '../../lib/today';
import type { RowKind } from './telegram.callbacks';

/** A stored spending or income, by kind and id. */
export interface EntryRef {
  kind: RowKind;
  id: number;
}

/** The part of a stored spending the messages print. */
export interface StoredSpending {
  id: number;
  date: IsoDate;
  /** Signed cents: negative is a refund. */
  amount: number;
  budgetId: number;
  description: string;
  /** When it was created (never edited): what the fingerprint of its buttons is made of. */
  createdAt: string;
}

export interface StoredIncome {
  id: number;
  date: IsoDate;
  amount: number;
  description: string;
  createdAt: string;
}

/**
 * The fingerprint of a row, which its buttons carry next to its id (telegram.callbacks.ts): its
 * `createdAt` in milliseconds, in base 36. `createdAt` is set once, so the fingerprint survives
 * every edit of the row, and another row that gets the same id (after a backup was restored, which
 * brings `sqlite_sequence` back) was created at another time and has another one.
 *
 * THE ASSUMPTION: that the clock does not repeat a millisecond between the row that a restore took
 * away and the new row that got its id. A restore always takes time (stopping the server, copying
 * the file, starting it again, then somebody enters something), so on a real clock the two rows are
 * seconds or minutes apart and the fingerprints differ. A test that freezes the clock gives both
 * rows the same `createdAt`, and then there is nothing in the row to tell them apart: the table has
 * no other column that an edit cannot change, and this is not a reason to add one.
 */
export function fingerprintOf(createdAt: string): string {
  const millis = Date.parse(createdAt);
  return (Number.isFinite(millis) ? millis : 0).toString(36);
}

/** The fingerprints of these spendings, by id (a spending that is gone has no entry). */
export function spendingFingerprints(db: DbOrTx, ids: readonly number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: spendings.id, createdAt: spendings.createdAt })
    .from(spendings)
    .where(inArray(spendings.id, [...ids]))
    .all();
  return new Map(rows.map((row) => [row.id, fingerprintOf(row.createdAt)]));
}

/** Remembers that the bot created this spending or income. Call it in the transaction of the write. */
export function recordEntry(db: DbOrTx, clock: Clock, ref: EntryRef): void {
  db.insert(telegramEntries)
    .values({
      spendingId: ref.kind === 's' ? ref.id : null,
      incomeId: ref.kind === 'i' ? ref.id : null,
      createdAt: timestampOf(clock),
    })
    .run();
}

/** The latest spending or income the bot created that still exists, or null. */
export function latestEntry(db: DbOrTx): EntryRef | null {
  const row = db.select().from(telegramEntries).orderBy(desc(telegramEntries.id)).limit(1).get();
  if (!row) return null;
  if (row.spendingId !== null) return { kind: 's', id: row.spendingId };
  if (row.incomeId !== null) return { kind: 'i', id: row.incomeId };
  return null;
}

/** The stored spending, as it is now (it may have been edited on the web), or null when it is gone. */
export function findSpending(db: DbOrTx, id: number): StoredSpending | null {
  const row = db.select().from(spendings).where(eq(spendings.id, id)).get();
  return row
    ? {
        id: row.id,
        date: row.date,
        amount: row.amount,
        budgetId: row.budgetId,
        description: row.description,
        createdAt: row.createdAt,
      }
    : null;
}

export function findIncome(db: DbOrTx, id: number): StoredIncome | null {
  const row = db.select().from(incomes).where(eq(incomes.id, id)).get();
  return row
    ? {
        id: row.id,
        date: row.date,
        amount: row.amount,
        description: row.description,
        createdAt: row.createdAt,
      }
    : null;
}

// --- Alert levels that a confirmation recorded as shown ---------------------------------------

/** The level row that the bot's confirmation records through `markNotified` (telegram.notifications.ts). */
export interface LevelRow {
  /** `ok`, `warning` or `over`; null for a row with no value. */
  value: string | null;
  sentAt: string;
}

/** One alert level, as `markNotified` takes it. */
export interface LevelKey {
  month: MonthKey;
  budgetId: number;
  level: BudgetAlert;
}

const levelWhere = ({ month, budgetId }: Pick<LevelKey, 'month' | 'budgetId'>) =>
  and(
    eq(telegramNotifications.kind, 'budget_alert'),
    eq(telegramNotifications.key, `${month}:${budgetId}`),
  );

/**
 * The dedupe row of a budget's alert level this month (`budget_alert`, key `<month>:<budgetId>`, the
 * highest level notified), or null when there is none. Read BEFORE `markNotified`, so that the mark
 * can be taken back (`restoreLevel`) if its confirmation never reaches the user.
 */
export function levelRow(db: DbOrTx, key: Pick<LevelKey, 'month' | 'budgetId'>): LevelRow | null {
  const row = db.select().from(telegramNotifications).where(levelWhere(key)).get();
  return row ? { value: row.value, sentAt: row.sentAt } : null;
}

/**
 * Takes back what `markNotified(key)` wrote, so that the next alert check announces the level: the
 * confirmation that was to show it was never delivered, and the user has not seen it. `before` is
 * what `levelRow` read before the mark. It restores only a row that STILL holds the level this mark
 * wrote: when the row holds another one, a check or another confirmation has moved it since and its
 * value is that one's business, and when `before` held the same level the mark wrote nothing.
 */
export function restoreLevel(db: DbOrTx, key: LevelKey, before: LevelRow | null): void {
  const now = levelRow(db, key);
  if (now === null || now.value !== key.level) return;
  if (before !== null && before.value === key.level) return;
  if (before === null) {
    db.delete(telegramNotifications).where(levelWhere(key)).run();
  } else {
    db.update(telegramNotifications)
      .set({ value: before.value, sentAt: before.sentAt })
      .where(levelWhere(key))
      .run();
  }
}
