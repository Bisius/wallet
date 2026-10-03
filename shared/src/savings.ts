import { z } from 'zod';
import type { GoalDto } from './goals';
import {
  MAX_SETTLEMENT_ALLOCATIONS,
  SAVINGS_TRANSACTIONS_DEFAULT_LIMIT,
  SAVINGS_TRANSACTIONS_MAX_LIMIT,
  SAVINGS_TRANSACTION_KINDS,
  type SavingsTransactionKind,
} from './limits';
import type { Cents } from './money';
import type { IsoDate, MonthKey } from './month';
import {
  idRefSchema,
  idSchema,
  isoDateSchema,
  nonNegativeCentsSchema,
  nonZeroCentsSchema,
  notesSchema,
  positiveCentsSchema,
} from './schemas';

// The constants live in './limits' (no zod); they are re-exported so existing imports keep working.
export {
  MANUAL_SAVINGS_KINDS,
  MAX_SETTLEMENT_ALLOCATIONS,
  SAVINGS_TRANSACTIONS_DEFAULT_LIMIT,
  SAVINGS_TRANSACTIONS_MAX_LIMIT,
  SAVINGS_TRANSACTION_KINDS,
  type ManualSavingsKind,
  type SavingsTransactionKind,
} from './limits';

// ---------------------------------------------------------------------------------------------
// Settling a month
// ---------------------------------------------------------------------------------------------

/**
 * One slice of a settlement (an element of `savingsSettleSchema.allocations`). It becomes one
 * `settlement` row. 422 `unknown_goal` / `goal_archived` (field "allocations.<i>.goalId") when
 * the goal does not exist or is archived. An archived goal can't be named here at all, not even
 * by a slice that takes money from savings: take its money out with a withdrawal or a
 * reallocation first.
 */
export const savingsAllocationSchema = z.strictObject({
  /**
   * The goal that receives the slice, or that gives it when the amount is negative. null:
   * unassigned savings.
   */
  goalId: idRefSchema.nullable(),
  /** Cents, never 0, with the sign of the settlement's `amount` (422 `allocation_mismatch`). */
  amount: nonZeroCentsSchema,
});
export type SavingsAllocationInput = z.infer<typeof savingsAllocationSchema>;

/**
 * POST /api/savings/settle/:month body → 201 SavingsTransactionDto[]. Settles a closed month: the
 * client confirms the amount it saw and the server stores one `settlement` row per allocation, in
 * order, dated today, with `settlesMonth` = `:month`. The month's `outstanding` is then 0.
 *
 * `amount` is the month's outstanding as the client saw it, and it must still be the current one
 * (an optimistic lock): positive means "move to savings", negative "take from savings". It is
 * never 0. Default: `allocations` = one allocation of the whole `amount` to unassigned savings.
 * Otherwise at most one allocation per goal (and one for unassigned savings, `goalId: null`),
 * 1 to MAX_SETTLEMENT_ALLOCATIONS of them (a repeated goal is a 400 validation_error at
 * "allocations.<i>.goalId").
 *
 * Errors, checked in this order: 404 not_found (the month is before settings.startMonth or more
 * than MAX_MONTHS_AHEAD months after the current month), 422 rule_violation `month_not_closed`
 * (field "month": the current or a future month), 409 `nothing_to_settle` (the outstanding is 0),
 * 409 `outstanding_changed` (`amount` is not the outstanding, `details` is an
 * `OutstandingChangedDetails`), 422 `allocation_mismatch` (field "allocations": an allocation
 * has the opposite sign of `amount`, or they do not add up to it), then 422 `unknown_goal` and
 * `goal_archived` (field "allocations.<i>.goalId", the first offending one).
 *
 * A settlement that takes money from savings is not limited by what the goal or the unassigned
 * savings holds: it records what happened, so a balance can go below 0.
 */
export const savingsSettleSchema = z
  .strictObject({
    amount: nonZeroCentsSchema,
    allocations: z.array(savingsAllocationSchema).min(1).max(MAX_SETTLEMENT_ALLOCATIONS).optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number | null>();
    (value.allocations ?? []).forEach((allocation, index) => {
      if (seen.has(allocation.goalId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each goal may appear only once',
          path: ['allocations', index, 'goalId'],
        });
      }
      seen.add(allocation.goalId);
    });
  });
export type SavingsSettleInput = z.infer<typeof savingsSettleSchema>;

/**
 * `details` of the 409 `outstanding_changed` response of `POST /api/savings/settle/:month`: the
 * month's outstanding right now, which differs from the `amount` the client sent.
 */
export interface OutstandingChangedDetails {
  month: MonthKey;
  /** The current outstanding. Never 0: a month with nothing outstanding is `nothing_to_settle`. */
  outstanding: Cents;
}

// ---------------------------------------------------------------------------------------------
// Manual money: deposit, withdrawal, reallocation
// ---------------------------------------------------------------------------------------------

/** The fields the three manual transactions share. Each schema below adds its `kind`. */
const manualFields = {
  /** Positive cents. A withdrawal is stored negative. */
  amount: positiveCentsSchema,
  /**
   * Defaults to today. Not before the first day of settings.startMonth (422 `before_start_month`)
   * and not after today (422 `date_in_future`), field "date". The server's clock decides "today".
   */
  date: isoDateSchema.optional(),
  /** Free text, up to 1000 characters. Blank becomes null. */
  note: notesSchema.nullish(),
};

/**
 * `kind: "deposit"` of `POST /api/savings/transactions` → 201 SavingsTransactionDto[] (one row,
 * `+amount`): money put into a goal, or into unassigned savings when `goalId` is omitted or null.
 * 422 rule_violation, checked in this order: `before_start_month` and `date_in_future` (field
 * "date"), `unknown_goal` and `goal_archived` (field "goalId": an archived goal can't receive
 * money).
 */
export const savingsDepositSchema = z.strictObject({
  kind: z.literal('deposit'),
  ...manualFields,
  goalId: idRefSchema.nullish(),
});
export type SavingsDepositInput = z.infer<typeof savingsDepositSchema>;

/**
 * `kind: "withdrawal"` of `POST /api/savings/transactions` → 201 SavingsTransactionDto[] (one row,
 * stored as `-amount`): money taken out of a goal (for example paying the holiday from its goal),
 * or out of unassigned savings when `goalId` is omitted or null. 422 rule_violation, checked in
 * this order: `before_start_month` and `date_in_future` (field "date"), `unknown_goal` (field
 * "goalId"), then `insufficient_balance` (field "amount") when the source holds less than
 * `amount`. An ARCHIVED goal is a valid source (there is no `goal_archived` here): the money left
 * in an archived goal is never frozen.
 */
export const savingsWithdrawalSchema = z.strictObject({
  kind: z.literal('withdrawal'),
  ...manualFields,
  goalId: idRefSchema.nullish(),
});
export type SavingsWithdrawalInput = z.infer<typeof savingsWithdrawalSchema>;

/**
 * `kind: "reallocation"` of `POST /api/savings/transactions` → 201 SavingsTransactionDto[]: moves
 * money between two goals, or between a goal and unassigned savings (null). It is stored as two
 * rows that sum to 0 and share a `groupId`, in this order: `-amount` for `fromGoalId`, then
 * `+amount` for `toGoalId`. Both rows carry the same date and note. The savings balance does not
 * change.
 *
 * Both goal fields are required (null means unassigned savings) and must differ (a 400
 * validation_error at "toGoalId"). 422 rule_violation, checked in this order: `before_start_month`
 * and `date_in_future` (field "date"), `unknown_goal` (field "fromGoalId", then "toGoalId"),
 * `goal_archived` (field "toGoalId": an archived goal can't be the destination, but it can be the
 * source, so its leftover money can be moved out), `insufficient_balance` (field "amount": the
 * source holds less than `amount`).
 */
export const savingsReallocationSchema = z
  .strictObject({
    kind: z.literal('reallocation'),
    ...manualFields,
    /** The source. null: unassigned savings. */
    fromGoalId: idRefSchema.nullable(),
    /** The destination. null: unassigned savings. */
    toGoalId: idRefSchema.nullable(),
  })
  .refine((value) => value.fromGoalId !== value.toGoalId, {
    message: 'Choose two different places to move the money between',
    path: ['toGoalId'],
  });
export type SavingsReallocationInput = z.infer<typeof savingsReallocationSchema>;

/**
 * POST /api/savings/transactions body → 201 SavingsTransactionDto[]: the rows stored, one for a
 * deposit or a withdrawal and two for a reallocation. A discriminated union on `kind`. Money
 * only moves through these three and through settlements: `opening` has `PUT /api/savings/opening`
 * and `settlement` has `POST /api/savings/settle/:month`.
 */
export const savingsTransactionCreateSchema = z.discriminatedUnion('kind', [
  savingsDepositSchema,
  savingsWithdrawalSchema,
  savingsReallocationSchema,
]);
export type SavingsTransactionCreateInput = z.infer<typeof savingsTransactionCreateSchema>;

/**
 * GET /api/savings/transactions query → 200 Page<SavingsTransactionDto>, newest first (date, then
 * id, descending). Filters combine with AND. `goalId` and `unassigned=true` (the rows with no
 * goal) are mutually exclusive, and `unassigned=false` is the same as leaving it out. `kind` is
 * any of the five kinds. An unknown goalId just matches nothing. Defaults: limit 50 (1 to 200),
 * offset 0.
 */
export const savingsTransactionListQuerySchema = z
  .strictObject({
    goalId: idSchema.optional(),
    unassigned: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    kind: z.enum(SAVINGS_TRANSACTION_KINDS).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SAVINGS_TRANSACTIONS_MAX_LIMIT)
      .default(SAVINGS_TRANSACTIONS_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => q.goalId === undefined || q.unassigned !== true, {
    message: 'Use either goalId or unassigned, not both',
    path: ['unassigned'],
  });
/**
 * What a client may send (every key optional; defaults apply server side). The backend's parsed
 * value, with defaults applied, is `z.output<typeof savingsTransactionListQuerySchema>`.
 */
export type SavingsTransactionListQuery = Partial<
  z.infer<typeof savingsTransactionListQuerySchema>
>;

// ---------------------------------------------------------------------------------------------
// Opening balance
// ---------------------------------------------------------------------------------------------

/**
 * PUT /api/savings/opening body → 200 SavingsOpeningDto. Sets the savings balance on the first
 * day of settings.startMonth (docs/DOMAIN.md, "Savings"): it upserts the one `opening` row, which
 * belongs to no goal and is always dated that day. 0 is allowed. No 422 rule applies.
 */
export const savingsOpeningSchema = z.strictObject({
  amount: nonNegativeCentsSchema,
});
export type SavingsOpeningInput = z.infer<typeof savingsOpeningSchema>;

/**
 * GET /api/savings/opening → 200, and the response of PUT /api/savings/opening (200). Without an
 * `opening` row (a first `PUT /api/settings` creates none) it is `amount` 0 dated like a stored
 * one. Moving `settings.startMonth` moves `date` but never changes `amount`: it was the balance
 * on the old first day, so the UI must ask the user for the balance on the new one.
 */
export interface SavingsOpeningDto {
  /** The savings balance on `date`, in cents. Not negative. */
  amount: Cents;
  /** The first day of settings.startMonth. */
  date: IsoDate;
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

/**
 * `GET /api/savings` → `OutstandingMonthDto.direction`. `move`: the outstanding is positive, so
 * that amount is to be moved to savings. `take`: it is negative, so that amount is to be taken
 * from savings.
 */
export type SettlementDirection = 'move' | 'take';

/**
 * What a month's `savingsDue` is made of, the same three lines as `MonthView.savingsDue`
 * (docs/DOMAIN.md, "Savings"): `savingsDue` = `unallocated` + `budgetsSettled` +
 * `reservesReleased`.
 */
export interface SavingsDueBreakdown {
  /** The month's unallocated income (negative when it was over-allocated). */
  unallocated: Cents;
  /** Budgets settled to savings: the sum of their `toSavings` (negative for a deficit). */
  budgetsSettled: Cents;
  /** Yearly subscription reserves released to savings. */
  reservesReleased: Cents;
}

/**
 * One closed month that is still to be settled (an element of `SavingsDto.outstanding`).
 * Identities: `outstanding` = `savingsDue` - `settled`, `outstanding` is never 0, `direction` is
 * `move` when it is positive and `take` when it is negative, and `breakdown` adds up to
 * `savingsDue`.
 */
export interface OutstandingMonthDto {
  /** A closed month: `settings.startMonth` <= month < the current month. */
  month: MonthKey;
  /**
   * What the month moves to savings (positive) or takes from savings (negative), from the ledger as
   * it is now. A late edit to the month's facts changes it.
   */
  savingsDue: Cents;
  /** The sum of the month's `settlement` rows: what was already moved (negative: taken). */
  settled: Cents;
  /** `savingsDue - settled`, not 0: the amount to move (positive) or to take (negative) now. */
  outstanding: Cents;
  direction: SettlementDirection;
  breakdown: SavingsDueBreakdown;
  /**
   * The month has settlement rows already: it was settled and later edits moved its `savingsDue`,
   * so `outstanding` is a correction of the earlier settlement and not a first move. Normally the
   * same as `settled !== 0`, and different only when earlier settlements netted to 0.
   */
  adjustment: boolean;
}

/**
 * GET /api/savings → 200: the savings balance, how it is spread and what is still to be settled.
 * Everything is derived from the savings transactions and the ledger (docs/DOMAIN.md, "Savings").
 * Identities: `balance` = `unassigned` + the sum of the balances of ALL `goals` (archived ones
 * too), and `outstandingTotal` = the sum of `outstanding[].outstanding`.
 */
export interface SavingsDto {
  /** The sum of every savings transaction. It can go below 0 (docs/DOMAIN.md, "Savings"). */
  balance: Cents;
  /** The sum of the transactions that belong to no goal. Can go below 0 like a goal's balance. */
  unassigned: Cents;
  /** Every goal, archived ones last, each group ascending by id (as in `GET /api/goals`). */
  goals: GoalDto[];
  /**
   * The "move to savings" list: every closed month (`settings.startMonth` <= month < the current
   * month) with a non-zero outstanding, ascending by month. Empty when nothing is outstanding.
   */
  outstanding: OutstandingMonthDto[];
  /** The signed sum of the outstanding amounts: positive is money to move, negative to take. */
  outstandingTotal: Cents;
}

/**
 * Element of GET /api/savings/transactions → 200 Page<SavingsTransactionDto>, and of the 201
 * responses of POST /api/savings/transactions (one row, two for a reallocation, `-amount` first)
 * and POST /api/savings/settle/:month (one row per allocation, in order).
 * DELETE /api/savings/transactions/:id → 204 for a deposit, a withdrawal or a reallocation (both
 * rows, whichever row's id is given), 404 not_found for an unknown id, and 409 `not_deletable`
 * for an `opening` or a `settlement` row. A deletion is not limited by the balances: it can leave a
 * goal, or the unassigned savings, below 0.
 */
export interface SavingsTransactionDto {
  id: number;
  /** The day the money moved. A settlement is dated the day it was made, not its month. */
  date: IsoDate;
  kind: SavingsTransactionKind;
  /**
   * Signed cents: positive moves money into savings (or into the goal), negative takes it out. So a
   * withdrawal is negative, and the two rows of a reallocation are `-amount` and `+amount`.
   */
  amount: Cents;
  /** The goal the row belongs to. null: unassigned savings. */
  goalId: number | null;
  /** The closed month a `settlement` settles. null for every other kind. */
  settlesMonth: MonthKey | null;
  note: string | null;
  /** The same number on both rows of a reallocation. null for every other kind. */
  groupId: number | null;
}
