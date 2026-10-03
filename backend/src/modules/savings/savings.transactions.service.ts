import type {
  IsoDate,
  Page,
  SavingsTransactionCreateInput,
  SavingsTransactionDto,
  savingsTransactionListQuerySchema,
} from '@wallet/shared';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { savingsGoals, savingsTransactions } from '../../db/schema';
import { balanceOf } from '../../domain/savings-facts';
import { type Deps, inTransaction } from '../../lib/deps';
import { apiError, notFound, ruleViolation } from '../../lib/errors';
import { monthOfDate, timestampOf, todayOf } from '../../lib/today';
import { requireSettings } from '../settings/settings.service';

type TransactionRow = typeof savingsTransactions.$inferSelect;
type TransactionInsert = typeof savingsTransactions.$inferInsert;

/** The parsed query of GET /api/savings/transactions: the defaults (`limit`, `offset`) are applied. */
export type SavingsTransactionListFilters = z.output<typeof savingsTransactionListQuerySchema>;

export const toTransactionDto = (row: TransactionRow): SavingsTransactionDto => ({
  id: row.id,
  date: row.date,
  kind: row.kind,
  amount: row.amount,
  goalId: row.goalId,
  settlesMonth: row.settlesMonth,
  note: row.note,
  groupId: row.groupId,
});

function insertRow(db: DbOrTx, values: TransactionInsert): TransactionRow {
  return db.insert(savingsTransactions).values(values).returning().get();
}

// -------------------------------------------------------------------------------------------------
// The rules of a manual transaction, in the order they are checked: date, goals, balance
// -------------------------------------------------------------------------------------------------

/**
 * `before_start_month` (nothing is accepted before the first day of `settings.startMonth`), then
 * `date_in_future` (these rows record money that has already moved). Both name the field "date".
 */
function assertDateAllowed(db: DbOrTx, date: IsoDate, today: IsoDate): void {
  const { startMonth } = requireSettings(db);
  if (monthOfDate(date) < startMonth) {
    throw ruleViolation(
      'before_start_month',
      `A savings transaction cannot be dated ${date}, before the start month ${startMonth}`,
      'date',
    );
  }
  if (date > today) {
    throw ruleViolation(
      'date_in_future',
      `A savings transaction cannot be dated ${date}, after today (${today})`,
      'date',
    );
  }
}

/**
 * The goal must exist (`unknown_goal`), and when money goes INTO it (`destination`) it must not be
 * archived (`goal_archived`). An archived goal may still be a `source`, so what is left in it is
 * never frozen (docs/DOMAIN.md, "Goals"). null is the unassigned savings, which always exists.
 */
function assertGoalUsable(
  db: DbOrTx,
  goalId: number | null,
  field: string,
  role: 'source' | 'destination',
): void {
  if (goalId === null) return;
  const goal = db
    .select({ name: savingsGoals.name, archivedAt: savingsGoals.archivedAt })
    .from(savingsGoals)
    .where(eq(savingsGoals.id, goalId))
    .get();
  if (!goal) throw ruleViolation('unknown_goal', `Goal ${goalId} does not exist`, field);
  if (role === 'destination' && goal.archivedAt !== null) {
    throw ruleViolation(
      'goal_archived',
      `Goal "${goal.name}" is archived and cannot receive money`,
      field,
    );
  }
}

/**
 * `insufficient_balance`: a withdrawal or a reallocation cannot take more than the source holds
 * now, that is the sum of every row of the goal (or of the unassigned savings), whatever its date.
 */
function assertSourceHolds(db: DbOrTx, goalId: number | null, amount: number): void {
  const held = balanceOf(db, goalId);
  if (held < amount) {
    throw ruleViolation(
      'insufficient_balance',
      `The source holds ${held} cents, which is less than the ${amount} cents to take out`,
      'amount',
    );
  }
}

// -------------------------------------------------------------------------------------------------
// Endpoints
// -------------------------------------------------------------------------------------------------

/**
 * POST /api/savings/transactions: a deposit (one row, +amount), a withdrawal (one row, -amount) or
 * a reallocation (two rows that sum to 0 and share a `groupId`: the id of the first, which is the
 * `-amount` row of the source). Everything is one transaction.
 */
export function createSavingsTransactions(
  deps: Deps,
  input: SavingsTransactionCreateInput,
): SavingsTransactionDto[] {
  return inTransaction(deps, (tx) => {
    const { db } = tx;
    const today = todayOf(tx.clock);
    const date = input.date ?? today;
    const note = input.note ?? null;
    const createdAt = timestampOf(tx.clock);
    assertDateAllowed(db, date, today);

    switch (input.kind) {
      case 'deposit': {
        const goalId = input.goalId ?? null;
        assertGoalUsable(db, goalId, 'goalId', 'destination');
        const row = insertRow(db, {
          date,
          amount: input.amount,
          kind: 'deposit',
          goalId,
          note,
          createdAt,
        });
        return [toTransactionDto(row)];
      }

      case 'withdrawal': {
        const goalId = input.goalId ?? null;
        assertGoalUsable(db, goalId, 'goalId', 'source');
        assertSourceHolds(db, goalId, input.amount);
        const row = insertRow(db, {
          date,
          amount: -input.amount,
          kind: 'withdrawal',
          goalId,
          note,
          createdAt,
        });
        return [toTransactionDto(row)];
      }

      case 'reallocation': {
        const { fromGoalId, toGoalId, amount } = input;
        assertGoalUsable(db, fromGoalId, 'fromGoalId', 'source');
        assertGoalUsable(db, toGoalId, 'toGoalId', 'destination');
        assertSourceHolds(db, fromGoalId, amount);

        const base = { date, kind: 'reallocation', note, createdAt } as const;
        const inserted = insertRow(db, { ...base, amount: -amount, goalId: fromGoalId });
        // The group id is the id of the first row, which only exists once it is inserted.
        const first = db
          .update(savingsTransactions)
          .set({ groupId: inserted.id })
          .where(eq(savingsTransactions.id, inserted.id))
          .returning()
          .get();
        const second = insertRow(db, {
          ...base,
          amount,
          goalId: toGoalId,
          groupId: inserted.id,
        });
        return [toTransactionDto(first), toTransactionDto(second)];
      }
    }
  });
}

/**
 * GET /api/savings/transactions: the filtered rows, newest first (date, then id, descending), as
 * one page. The filters (`goalId`, `unassigned`, `kind`) combine with AND.
 */
export function listSavingsTransactions(
  { db }: Deps,
  query: SavingsTransactionListFilters,
): Page<SavingsTransactionDto> {
  const where = and(
    query.goalId !== undefined ? eq(savingsTransactions.goalId, query.goalId) : undefined,
    query.unassigned ? isNull(savingsTransactions.goalId) : undefined,
    query.kind !== undefined ? eq(savingsTransactions.kind, query.kind) : undefined,
  );

  const items = db
    .select()
    .from(savingsTransactions)
    .where(where)
    .orderBy(desc(savingsTransactions.date), desc(savingsTransactions.id))
    .limit(query.limit)
    .offset(query.offset)
    .all()
    .map(toTransactionDto);
  const total = db.select({ total: count() }).from(savingsTransactions).where(where).get()?.total;

  return { items, total: total ?? 0, limit: query.limit, offset: query.offset };
}

/**
 * DELETE /api/savings/transactions/:id: a deposit, a withdrawal or a reallocation (both rows,
 * whichever row's id is given). It is not limited by the balances, so it can leave one below 0.
 * The `opening` row and a `settlement` row are not deletable one by one (409 `not_deletable`): the
 * opening balance is replaced with `PUT /api/savings/opening`, and a settlement is undone for its
 * whole month with `DELETE /api/savings/settle/:month`.
 */
export function deleteSavingsTransaction(deps: Deps, id: number): void {
  inTransaction(deps, ({ db }) => {
    const row = db.select().from(savingsTransactions).where(eq(savingsTransactions.id, id)).get();
    if (!row) throw notFound('Savings transaction');

    if (row.kind === 'opening') {
      throw apiError(
        'not_deletable',
        'The opening balance cannot be deleted: change it with PUT /api/savings/opening',
      );
    }
    if (row.kind === 'settlement') {
      throw apiError(
        'not_deletable',
        'A settlement cannot be deleted row by row: undo it with DELETE /api/savings/settle/:month',
      );
    }

    // Both rows of a reallocation share a group id (the id of the first one).
    db.delete(savingsTransactions)
      .where(
        row.groupId === null
          ? eq(savingsTransactions.id, row.id)
          : eq(savingsTransactions.groupId, row.groupId),
      )
      .run();
  });
}
