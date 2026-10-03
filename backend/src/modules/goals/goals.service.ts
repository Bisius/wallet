import type { GoalCreateInput, GoalDto, GoalUpdateInput } from '@wallet/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { loadSavingsFacts, type SavingsFacts } from '../../domain/savings-facts';
import { goalFigures } from '../../domain/savings';
import { savingsGoals, savingsTransactions } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { notFound } from '../../lib/errors';
import { currentMonthOf, timestampOf } from '../../lib/today';

type GoalRow = typeof savingsGoals.$inferSelect;

/** A goal's DTO from its row and its balance (the sum of its savings transactions). */
function toDto(row: GoalRow, balance: number, currentMonth: string): GoalDto {
  return goalFigures(
    {
      id: row.id,
      name: row.name,
      targetAmount: row.targetAmount,
      deadline: row.deadline,
      color: row.color,
      archived: row.archivedAt !== null,
    },
    balance,
    currentMonth,
  );
}

/**
 * Every goal as a DTO, archived ones last and each group in creation order (ascending by id). The
 * balances come from `savings` when the caller has read them already (`GET /api/savings` does), or
 * from one grouped query, never from one query per goal.
 */
export function loadGoalDtos(
  deps: Deps,
  savings: SavingsFacts = loadSavingsFacts(deps.db),
): GoalDto[] {
  const currentMonth = currentMonthOf(deps.clock);
  return deps.db
    .select()
    .from(savingsGoals)
    .orderBy(asc(sql`${savingsGoals.archivedAt} is not null`), asc(savingsGoals.id))
    .all()
    .map((row) => toDto(row, savings.balances.get(row.id) ?? 0, currentMonth));
}

/** One goal as a DTO, or a 404 `not_found`. */
function loadGoalDto(deps: Deps, id: number): GoalDto {
  const goal = loadGoalDtos(deps).find((candidate) => candidate.id === id);
  if (!goal) throw notFound('Goal');
  return goal;
}

/** GET /api/goals: archived goals last, each group in creation order. */
export function listGoals(deps: Deps): GoalDto[] {
  return loadGoalDtos(deps);
}

/** POST /api/goals: a new goal holds nothing and is not archived. */
export function createGoal(deps: Deps, input: GoalCreateInput): GoalDto {
  const row = deps.db
    .insert(savingsGoals)
    .values({
      name: input.name,
      targetAmount: input.targetAmount,
      deadline: input.deadline ?? null,
      color: input.color ?? null,
      createdAt: timestampOf(deps.clock),
    })
    .returning()
    .get();
  return toDto(row, 0, currentMonthOf(deps.clock));
}

/**
 * PATCH /api/goals/:id: any subset of the fields. `null` clears `deadline` and `color`. `archived`
 * archives the goal (keeping the time of an earlier archive when it already is) or brings it back.
 */
export function updateGoal(deps: Deps, id: number, input: GoalUpdateInput): GoalDto {
  return inTransaction(deps, (tx) => {
    const current = tx.db.select().from(savingsGoals).where(eq(savingsGoals.id, id)).get();
    if (!current) throw notFound('Goal');

    const { archived, ...fields } = input;
    tx.db
      .update(savingsGoals)
      .set({
        ...fields,
        ...(archived === undefined
          ? {}
          : { archivedAt: archived ? (current.archivedAt ?? timestampOf(tx.clock)) : null }),
      })
      .where(eq(savingsGoals.id, id))
      .run();
    return loadGoalDto(tx, id);
  });
}

/**
 * DELETE /api/goals/:id: the goal's rows move to unassigned savings (their `goalId` becomes null),
 * so no money is lost and the savings balance does not change. One transaction.
 */
export function deleteGoal(deps: Deps, id: number): void {
  inTransaction(deps, ({ db }) => {
    const goal = db
      .select({ id: savingsGoals.id })
      .from(savingsGoals)
      .where(eq(savingsGoals.id, id))
      .get();
    if (!goal) throw notFound('Goal');
    db.update(savingsTransactions)
      .set({ goalId: null })
      .where(eq(savingsTransactions.goalId, id))
      .run();
    db.delete(savingsGoals).where(eq(savingsGoals.id, id)).run();
  });
}
