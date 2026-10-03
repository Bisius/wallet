/**
 * The savings side of the ledger's input: what the `savings_transactions` rows add up to, loaded in
 * two grouped queries however many rows there are (nothing per row, nothing per goal). The "move to
 * savings" list and the goal figures (`savings.ts`) are pure functions of this, the ledger and the
 * current month: nothing about them is stored (docs/DOMAIN.md, "Savings").
 */
import type { Cents, MonthKey } from '@wallet/shared';
import { count, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { savingsTransactions } from '../db/schema';

/** The `settlement` rows of one month. */
export interface SettlementFact {
  /** The sum of their amounts: what was moved to savings (negative: taken) for that month. */
  settled: Cents;
  /** How many rows there are (a month settled in several slices, or settled again as an adjustment). */
  rows: number;
}

export interface SavingsFacts {
  /**
   * The sum of the rows of each goal, by goal id. The `null` key is the unassigned savings. A goal
   * (or the unassigned savings) with no row is absent, which means 0.
   */
  balances: Map<number | null, Cents>;
  /**
   * Per month that has at least one `settlement` row, whether that month is closed or not (a row of
   * a month that is not closed only exists if the server clock moved backwards).
   */
  settlements: Map<MonthKey, SettlementFact>;
}

const sumOf = (column: unknown) => sql<number>`sum(${column})`.mapWith(Number);

/** Reads the balances and the settlements in two queries. */
export function loadSavingsFacts(db: DbOrTx): SavingsFacts {
  const balances = new Map<number | null, Cents>();
  const balanceRows = db
    .select({ goalId: savingsTransactions.goalId, balance: sumOf(savingsTransactions.amount) })
    .from(savingsTransactions)
    .groupBy(savingsTransactions.goalId)
    .all();
  for (const row of balanceRows) balances.set(row.goalId, row.balance);

  const settlements = new Map<MonthKey, SettlementFact>();
  const settlementRows = db
    .select({
      month: savingsTransactions.settlesMonth,
      settled: sumOf(savingsTransactions.amount),
      rows: count(),
    })
    .from(savingsTransactions)
    .where(eq(savingsTransactions.kind, 'settlement'))
    .groupBy(savingsTransactions.settlesMonth)
    .all();
  for (const row of settlementRows) {
    // A settlement always has its month (a CHECK in the schema), so the null case is unreachable.
    if (row.month !== null) settlements.set(row.month, { settled: row.settled, rows: row.rows });
  }
  return { balances, settlements };
}

/** What a goal holds right now, or what the unassigned savings do (`null`): the sum of its rows. */
export function balanceOf(db: DbOrTx, goalId: number | null): Cents {
  const row = db
    .select({
      balance: sql<number>`coalesce(sum(${savingsTransactions.amount}), 0)`.mapWith(Number),
    })
    .from(savingsTransactions)
    .where(
      goalId === null ? isNull(savingsTransactions.goalId) : eq(savingsTransactions.goalId, goalId),
    )
    .get();
  return row?.balance ?? 0;
}
