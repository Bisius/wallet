import type {
  IsoDate,
  SpendingCreateInput,
  SpendingDto,
  SpendingUpdateInput,
  SpendingsPage,
  spendingListQuerySchema,
} from '@wallet/shared';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { budgets, spendings } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { monthBounds, monthOfDate, timestampOf } from '../../lib/today';
import { isWithinActiveMonths } from '../../lib/versioned';
import { requireSettings } from '../settings/settings.service';

type SpendingRow = typeof spendings.$inferSelect;

/** The parsed query of GET /api/spendings: the defaults (`limit`, `offset`) are applied. */
export type SpendingListFilters = z.output<typeof spendingListQuerySchema>;

const toDto = (row: SpendingRow): SpendingDto => ({
  id: row.id,
  date: row.date,
  amount: row.amount,
  budgetId: row.budgetId,
  description: row.description,
  notes: row.notes,
  // Placeholder until the tags endpoints land: nothing can tag a spending yet, so none has tags.
  // The Phase 5 backend step reads them from `spending_tags` here (ascending by id).
  tagIds: [],
});

/**
 * The rules a spending must satisfy, checked in the documented order and against the resulting
 * date and budget (so a PATCH is checked as a whole):
 *  1. `unknown_budget`: the budget exists.
 *  2. `before_start_month`: the date is not before `settings.startMonth`.
 *  3. `outside_active_months`: the date's month is within the budget's active months.
 */
function assertSpendingAllowed(db: DbOrTx, target: { date: IsoDate; budgetId: number }): void {
  const budget = db.select().from(budgets).where(eq(budgets.id, target.budgetId)).get();
  if (!budget) {
    throw ruleViolation('unknown_budget', `Budget ${target.budgetId} does not exist`, 'budgetId');
  }

  const floor = requireSettings(db).startMonth;
  const month = monthOfDate(target.date);
  if (month < floor) {
    throw ruleViolation(
      'before_start_month',
      `A spending cannot be dated ${target.date}, before the start month ${floor}`,
      'date',
    );
  }
  if (!isWithinActiveMonths(budget.startMonth, budget.endMonth, month)) {
    throw ruleViolation(
      'outside_active_months',
      `${target.date} is outside the active months of "${budget.name}" ` +
        `(${budget.startMonth} to ${budget.endMonth ?? 'no end'})`,
      'date',
    );
  }
}

/**
 * GET /api/spendings: the filtered set, newest first (date, then id, descending), as one page plus
 * the net `totalAmount` over ALL rows matching the filters (not just this page).
 */
export function listSpendings({ db }: Deps, query: SpendingListFilters): SpendingsPage {
  const bounds = query.month ? monthBounds(query.month) : null;
  const where = and(
    bounds ? gte(spendings.date, bounds.from) : undefined,
    bounds ? lte(spendings.date, bounds.to) : undefined,
    query.from ? gte(spendings.date, query.from) : undefined,
    query.to ? lte(spendings.date, query.to) : undefined,
    query.budgetId !== undefined ? eq(spendings.budgetId, query.budgetId) : undefined,
  );

  const items = db
    .select()
    .from(spendings)
    .where(where)
    .orderBy(desc(spendings.date), desc(spendings.id))
    .limit(query.limit)
    .offset(query.offset)
    .all()
    .map(toDto);

  const totals = db
    .select({
      total: count(),
      totalAmount: sql<number>`coalesce(sum(${spendings.amount}), 0)`.mapWith(Number),
    })
    .from(spendings)
    .where(where)
    .get();

  return {
    items,
    total: totals?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
    totalAmount: totals?.totalAmount ?? 0,
  };
}

export function createSpending(deps: Deps, input: SpendingCreateInput): SpendingDto {
  assertSpendingAllowed(deps.db, input);
  const now = timestampOf(deps.clock);
  const row = deps.db
    .insert(spendings)
    .values({
      date: input.date,
      amount: input.amount,
      budgetId: input.budgetId,
      description: input.description ?? '',
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(row);
}

export function updateSpending(deps: Deps, id: number, input: SpendingUpdateInput): SpendingDto {
  const current = deps.db.select().from(spendings).where(eq(spendings.id, id)).get();
  if (!current) throw notFound('Spending');

  assertSpendingAllowed(deps.db, {
    date: input.date ?? current.date,
    budgetId: input.budgetId ?? current.budgetId,
  });
  const row = deps.db
    .update(spendings)
    .set({ ...input, updatedAt: timestampOf(deps.clock) })
    .where(eq(spendings.id, id))
    .returning()
    .get();
  return toDto(row);
}

export function deleteSpending({ db }: Deps, id: number): void {
  const removed = db
    .delete(spendings)
    .where(eq(spendings.id, id))
    .returning({ id: spendings.id })
    .all();
  if (removed.length === 0) throw notFound('Spending');
}
