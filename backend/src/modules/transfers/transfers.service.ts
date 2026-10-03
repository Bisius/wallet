import type { TransferCreateInput, TransferDto, TransferListQuery } from '@wallet/shared';
import { and, desc, eq, gte, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { budgetTransfers, budgets } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { monthBounds, monthOfDate, timestampOf } from '../../lib/today';
import { isWithinActiveMonths } from '../../lib/versioned';
import { requireSettings } from '../settings/settings.service';

type TransferRow = typeof budgetTransfers.$inferSelect;

/** The two sides of a transfer, in the order the rules name them. */
const SIDES = ['fromBudgetId', 'toBudgetId'] as const;

const toDto = (row: TransferRow): TransferDto => ({
  id: row.id,
  date: row.date,
  fromBudgetId: row.fromBudgetId,
  toBudgetId: row.toBudgetId,
  amount: row.amount,
  note: row.note,
});

/**
 * The rules a transfer must satisfy once its shape is valid (the 400s are the zod schema's), in the
 * documented order (docs/DOMAIN.md, "Transfers"):
 *  1. `unknown_budget`: every budget side exists, `fromBudgetId` before `toBudgetId`.
 *  2. `before_start_month`: the date is not before `settings.startMonth`.
 *  3. `outside_active_months`: every budget side is active in the month of the date (`fromBudgetId`
 *     before `toBudgetId`). The ledger ignores a transfer unless each budget it names is active in
 *     its month, so one that fails this is never stored: the money of a stored transfer arrives.
 *
 * A transfer is never refused for lack of money: the balances are not read.
 */
function assertTransferAllowed(db: DbOrTx, input: TransferCreateInput): void {
  const sides = SIDES.map((field) => {
    const id = input[field];
    if (id === null) return { field, budget: null }; // the unallocated pool
    const budget = db.select().from(budgets).where(eq(budgets.id, id)).get();
    if (!budget) throw ruleViolation('unknown_budget', `Budget ${id} does not exist`, field);
    return { field, budget };
  });

  const floor = requireSettings(db).startMonth;
  const month = monthOfDate(input.date);
  if (month < floor) {
    throw ruleViolation(
      'before_start_month',
      `A transfer cannot be dated ${input.date}, before the start month ${floor}`,
      'date',
    );
  }

  for (const { field, budget } of sides) {
    if (budget && !isWithinActiveMonths(budget.startMonth, budget.endMonth, month)) {
      throw ruleViolation(
        'outside_active_months',
        `${input.date} is outside the active months of "${budget.name}" ` +
          `(${budget.startMonth} to ${budget.endMonth ?? 'no end'})`,
        field,
      );
    }
  }
}

/**
 * GET /api/transfers: newest first (date, then id, descending), not paged. The filters combine with
 * AND; `budgetId` keeps the transfers out of OR into that budget.
 */
export function listTransfers({ db }: Deps, query: TransferListQuery): TransferDto[] {
  const bounds = query.month ? monthBounds(query.month) : null;
  const where = and(
    bounds ? gte(budgetTransfers.date, bounds.from) : undefined,
    bounds ? lte(budgetTransfers.date, bounds.to) : undefined,
    query.from ? gte(budgetTransfers.date, query.from) : undefined,
    query.to ? lte(budgetTransfers.date, query.to) : undefined,
    query.budgetId !== undefined
      ? or(
          eq(budgetTransfers.fromBudgetId, query.budgetId),
          eq(budgetTransfers.toBudgetId, query.budgetId),
        )
      : undefined,
  );
  return db
    .select()
    .from(budgetTransfers)
    .where(where)
    .orderBy(desc(budgetTransfers.date), desc(budgetTransfers.id))
    .all()
    .map(toDto);
}

/** POST /api/transfers. */
export function createTransfer(deps: Deps, input: TransferCreateInput): TransferDto {
  assertTransferAllowed(deps.db, input);
  const row = deps.db
    .insert(budgetTransfers)
    .values({
      date: input.date,
      fromBudgetId: input.fromBudgetId,
      toBudgetId: input.toBudgetId,
      amount: input.amount,
      note: input.note ?? null,
      createdAt: timestampOf(deps.clock),
    })
    .returning()
    .get();
  return toDto(row);
}

/** DELETE /api/transfers/:id: undoes exactly what the transfer did, in its month and after it. */
export function deleteTransfer({ db }: Deps, id: number): void {
  const removed = db
    .delete(budgetTransfers)
    .where(eq(budgetTransfers.id, id))
    .returning({ id: budgetTransfers.id })
    .all();
  if (removed.length === 0) throw notFound('Transfer');
}
