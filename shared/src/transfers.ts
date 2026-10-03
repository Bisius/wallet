import { z } from 'zod';
import type { Cents } from './money';
import type { IsoDate } from './month';
import {
  idRefSchema,
  idSchema,
  isoDateSchema,
  monthKeySchema,
  notesSchema,
  positiveCentsSchema,
} from './schemas';

/**
 * POST /api/transfers body → 201 TransferDto. Moves `amount` out of `fromBudgetId` and into
 * `toBudgetId`, in the month of `date` (docs/DOMAIN.md, "Transfers"). A null side is that month's
 * unallocated pool: `fromBudgetId: null` takes the money from the pool and `toBudgetId: null`
 * gives it back to it. Both keys are required, so an omitted side is a 400 and not "the pool".
 * The direction is the two sides, never a sign: `amount` is positive.
 *
 * A transfer is a dated fact like any other: `date` may be in a closed month (an explicit edit
 * that rewrites it), in the current month or in a future one. It is never refused for lack of
 * money: a source that holds less than `amount` just goes negative (a budget) or over-allocated
 * (the pool).
 *
 * Like a spending, a transfer may be dated any day from `settings.startMonth` on, even beyond the
 * 120-month projection horizon (`MAX_MONTHS_AHEAD`), where no month view exists. Such a transfer
 * is in no month view but still counts for the budget guards (`end_before_activity`,
 * `has_history`), and it is found with `GET /api/transfers` (without a filter, with `?budgetId=`,
 * or with the `month` or `from`/`to` of its date), so the UI bounds its date picker.
 *
 * Errors, checked in this order: 400 validation_error, at "toBudgetId", when both sides are null
 * (no budget at all) or both are the same budget; then 422 rule_violation: `unknown_budget` (field
 * "fromBudgetId", then "toBudgetId"), `before_start_month` (date before settings.startMonth,
 * field "date"), and `outside_active_months` (a budget side that is not active in the month of
 * `date`, field "fromBudgetId", then "toBudgetId"). The last one is what keeps every stored
 * transfer counted by the ledger, which ignores a transfer unless each budget it names is active
 * in its month. The two rules that move a budget's active months, `start_after_activity` and
 * `end_before_activity`, count transfers on both sides, so a stored transfer stays inside them.
 */
export const transferCreateSchema = z
  .strictObject({
    /** Required, not prefilled by the server. The UI offers `GET /api/today`. */
    date: isoDateSchema,
    /** The budget the money leaves. null: the unallocated pool of the month of `date`. */
    fromBudgetId: idRefSchema.nullable(),
    /** The budget the money arrives in. null: the unallocated pool of the month of `date`. */
    toBudgetId: idRefSchema.nullable(),
    /** Positive cents. */
    amount: positiveCentsSchema,
    /** Free text, up to 1000 characters. Blank becomes null. */
    note: notesSchema.nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.fromBudgetId === null && value.toBudgetId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a budget: at least one side of a transfer must be a budget',
        path: ['toBudgetId'],
      });
    } else if (value.fromBudgetId === value.toBudgetId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose two different budgets to move the money between',
        path: ['toBudgetId'],
      });
    }
  });
export type TransferCreateInput = z.infer<typeof transferCreateSchema>;

/**
 * GET /api/transfers query → 200 TransferDto[], newest first (date, then id, descending). Not
 * paged: a personal ledger has few transfers, and `month` or `from`/`to` keeps the list short. No
 * 409 or 422 rule applies: a bad query is a 400 validation_error. Filters combine with AND. `month`
 * and `from`/`to` (inclusive dates) are mutually exclusive, and `from` must not be after `to`.
 * `budgetId` keeps the transfers that move money out of OR into that budget. `month`, `from` and
 * `to` are plain date filters, not checks against the tracked range: a month with no transfers
 * gives `[]` whether or not it lies inside that range, and a transfer dated far ahead (see
 * `transferCreateSchema`) is returned for its own month. An unknown `budgetId` matches nothing.
 * Without a filter, every transfer.
 */
export const transferListQuerySchema = z
  .strictObject({
    month: monthKeySchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    budgetId: idSchema.optional(),
  })
  .refine((q) => q.month === undefined || (q.from === undefined && q.to === undefined), {
    message: 'Use either month or from/to, not both',
    path: ['month'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['to'],
  });
export type TransferListQuery = z.infer<typeof transferListQuerySchema>;

/**
 * Element of GET /api/transfers → 200, and the response of POST /api/transfers (201).
 * DELETE /api/transfers/:id → 204 (404 not_found for an unknown id; no 409 or 422 rule applies).
 * There is no PATCH: a transfer is never edited, it is deleted and entered again. Deleting one
 * dated in a closed month rewrites that month (docs/DOMAIN.md, "Transfers"), so the UI confirms.
 *
 * `fromBudgetId` and `toBudgetId` are never both null and never the same budget (the API refuses
 * to store such a transfer). A null side is the unallocated pool of the month of `date`.
 */
export interface TransferDto {
  id: number;
  /** The day it is dated. Its month is the month it moves money in. */
  date: IsoDate;
  /** The budget the money leaves, or null: the unallocated pool. */
  fromBudgetId: number | null;
  /** The budget the money arrives in, or null: the unallocated pool. */
  toBudgetId: number | null;
  /** Positive cents. */
  amount: Cents;
  note: string | null;
}
