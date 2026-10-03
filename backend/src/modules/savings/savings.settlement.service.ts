import {
  MAX_MONTHS_AHEAD,
  type MonthKey,
  type OutstandingChangedDetails,
  type SavingsAllocationInput,
  type SavingsSettleInput,
  type SavingsTransactionDto,
  addMonths,
  sumCents,
} from '@wallet/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { savingsGoals, savingsTransactions } from '../../db/schema';
import { loadFacts } from '../../domain/facts';
import { computeLedger, ledgerMonth } from '../../domain/ledger';
import { outstandingOf } from '../../domain/savings';
import { loadSavingsFacts } from '../../domain/savings-facts';
import { type Deps, inTransaction } from '../../lib/deps';
import { apiError, notFound, ruleViolation } from '../../lib/errors';
import { monthOfDate, timestampOf, todayOf } from '../../lib/today';
import { toTransactionDto } from './savings.transactions.service';

/**
 * 422 `allocation_mismatch` (field "allocations"): every allocation has the sign of the amount, and
 * together they add up to it exactly. (An allocation is never 0, so "the sign" is always one of the
 * two.)
 */
function assertAllocationsMatch(allocations: readonly SavingsAllocationInput[], amount: number) {
  const sign = Math.sign(amount);
  const sameSign = allocations.every((allocation) => Math.sign(allocation.amount) === sign);
  if (!sameSign || sumCents(allocations.map((allocation) => allocation.amount)) !== amount) {
    throw ruleViolation(
      'allocation_mismatch',
      'The allocations must have the sign of the amount and add up to it exactly',
      'allocations',
    );
  }
}

/**
 * 422 `unknown_goal` and `goal_archived` (field "allocations.<i>.goalId"): every goal named must
 * exist and not be archived, and the FIRST offending allocation, in order, decides. An archived
 * goal can't be named even by a slice that takes money from savings. One query for all the goals.
 */
function assertAllocationGoals(db: DbOrTx, allocations: readonly SavingsAllocationInput[]): void {
  const ids = allocations.flatMap(({ goalId }) => (goalId === null ? [] : [goalId]));
  if (ids.length === 0) return;
  const goals = new Map(
    db
      .select({
        id: savingsGoals.id,
        name: savingsGoals.name,
        archivedAt: savingsGoals.archivedAt,
      })
      .from(savingsGoals)
      .where(inArray(savingsGoals.id, ids))
      .all()
      .map((goal) => [goal.id, goal]),
  );

  allocations.forEach(({ goalId }, index) => {
    if (goalId === null) return;
    const field = `allocations.${index}.goalId`;
    const goal = goals.get(goalId);
    if (!goal) throw ruleViolation('unknown_goal', `Goal ${goalId} does not exist`, field);
    if (goal.archivedAt !== null) {
      throw ruleViolation(
        'goal_archived',
        `Goal "${goal.name}" is archived and cannot be part of a settlement`,
        field,
      );
    }
  });
}

/**
 * POST /api/savings/settle/:month: settles a closed month, in ONE transaction (either every row is
 * stored or none is). The checks run in this order (docs/DOMAIN.md, "Settling a month"):
 *
 *  1. 404 when the month is outside `startMonth..current month + MAX_MONTHS_AHEAD`, then 422
 *     `month_not_closed` (field "month") for the current month or a future one;
 *  2. 409 `nothing_to_settle` when its outstanding is 0;
 *  3. 409 `outstanding_changed` when `amount` is not the current outstanding (optimistic lock: the
 *     user confirms the figure they saw, `details` carries the current one);
 *  4. 422 `allocation_mismatch`, then 422 `unknown_goal` / `goal_archived`.
 *
 * It then stores one `settlement` row per allocation, in order, dated today, with no note. A
 * negative amount ("take from savings") is never refused for lack of balance: it records what
 * really happened, even when that takes a goal below 0.
 */
export function settleMonth(
  deps: Deps,
  month: MonthKey,
  input: SavingsSettleInput,
): SavingsTransactionDto[] {
  return inTransaction(deps, (tx) => {
    const { db } = tx;

    // 1. The month exists and is closed.
    const facts = loadFacts(db);
    const today = todayOf(tx.clock);
    const currentMonth = monthOfDate(today);
    const horizon = addMonths(currentMonth, MAX_MONTHS_AHEAD);
    if (month < facts.startMonth || month > horizon) {
      throw apiError(
        'not_found',
        `Month ${month} is outside the tracked months (${facts.startMonth} to ${horizon})`,
      );
    }
    if (month >= currentMonth) {
      throw ruleViolation(
        'month_not_closed',
        `Month ${month} is not closed: only months before ${currentMonth} can be settled`,
        'month',
      );
    }

    // 2. and 3. What is outstanding now, from the ledger and the settlement rows.
    const row = ledgerMonth(computeLedger(facts, month, today), month);
    if (!row) throw new Error(`The ledger has no row for ${month}`); // unreachable: checked above
    const entry = outstandingOf(row, loadSavingsFacts(db).settlements.get(month));
    if (!entry) throw apiError('nothing_to_settle', `Nothing is outstanding for ${month}`);
    if (input.amount !== entry.outstanding) {
      const details: OutstandingChangedDetails = { month, outstanding: entry.outstanding };
      throw apiError(
        'outstanding_changed',
        `The outstanding of ${month} is ${entry.outstanding} cents now, not ${input.amount}`,
        details,
      );
    }

    // 4. The split.
    const allocations = input.allocations ?? [{ goalId: null, amount: input.amount }];
    assertAllocationsMatch(allocations, input.amount);
    assertAllocationGoals(db, allocations);

    const createdAt = timestampOf(tx.clock);
    return allocations.map(({ goalId, amount }) =>
      toTransactionDto(
        db
          .insert(savingsTransactions)
          .values({
            date: today,
            amount,
            kind: 'settlement',
            settlesMonth: month,
            goalId,
            note: null,
            createdAt,
          })
          .returning()
          .get(),
      ),
    );
  });
}

/**
 * DELETE /api/savings/settle/:month: undoes the settlement of the month by removing every one of
 * its settlement rows in one transaction. The month is then outstanding by its whole `savingsDue`
 * again, no longer as an adjustment. 404 when the month has no settlement rows. A settlement is
 * never edited row by row: undo it and settle again.
 */
export function undoSettlement(deps: Deps, month: MonthKey): void {
  inTransaction(deps, ({ db }) => {
    const removed = db
      .delete(savingsTransactions)
      .where(
        and(
          eq(savingsTransactions.kind, 'settlement'),
          eq(savingsTransactions.settlesMonth, month),
        ),
      )
      .returning({ id: savingsTransactions.id })
      .all();
    if (removed.length === 0) throw notFound(`Settlement of ${month}`);
  });
}
