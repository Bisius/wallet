import { z } from 'zod';
import type { Cents } from './money';
import type { IsoDate } from './month';
import {
  AT_LEAST_ONE_FIELD,
  colorSchema,
  hasAnyKey,
  isoDateSchema,
  nameSchema,
  positiveCentsSchema,
} from './schemas';

/**
 * POST /api/goals body → 201 GoalDto. A new goal holds nothing (its balance is 0) and is not
 * archived. Defaults: `deadline` and `color` = null. No 422 rule applies: any deadline is
 * accepted, a past one included (the goal is then `overdue` at once).
 */
export const goalCreateSchema = z.strictObject({
  name: nameSchema,
  /** The amount to save, in positive cents. */
  targetAmount: positiveCentsSchema,
  /** The date to reach the target by. Only its month counts (docs/DOMAIN.md, "Goals"). */
  deadline: isoDateSchema.nullish(),
  color: colorSchema.nullish(),
});
export type GoalCreateInput = z.infer<typeof goalCreateSchema>;

/**
 * PATCH /api/goals/:id body → 200 GoalDto (404 not_found for an unknown id). Any subset, at least
 * one. `null` clears `deadline` and `color`. `archived: true` archives the goal and `false` brings
 * it back: an archived goal keeps its balance and that money can still be taken out (it may be
 * the source of a withdrawal or a reallocation), but it can't receive money: a deposit, a
 * reallocation to it and a settlement allocation naming it are 422 `goal_archived`. No 422 rule
 * applies to the goal itself.
 */
export const goalUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    targetAmount: positiveCentsSchema.optional(),
    deadline: isoDateSchema.nullable().optional(),
    color: colorSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type GoalUpdateInput = z.infer<typeof goalUpdateSchema>;

/**
 * `archived` (the goal was archived, whatever its balance) wins over everything. Otherwise
 * `reached` (balance >= target), else `overdue` (a deadline whose month is before the current
 * month), else `active`.
 */
export type GoalStatus = 'active' | 'reached' | 'overdue' | 'archived';

/**
 * GET /api/goals → 200 GoalDto[]: every goal, archived ones last, each group ascending by id
 * (creation order). Also the response of POST (201) and PATCH (200), and the `goals` of
 * `SavingsDto`. DELETE /api/goals/:id → 204 (404 not_found for an unknown id): the goal's rows
 * move to unassigned savings (their `goalId` becomes null), so no money is lost and the savings
 * balance does not change.
 *
 * Every figure is derived (docs/DOMAIN.md, "Goals"). `balance` comes from the savings
 * transactions, and `monthlyNeeded` and `status` also depend on the current month, so they change
 * when a new month starts.
 */
export interface GoalDto {
  id: number;
  name: string;
  /** Positive cents. */
  targetAmount: Cents;
  /** The date to reach the target by, or null. Only its month counts. */
  deadline: IsoDate | null;
  color: string | null;
  archived: boolean;
  /**
   * The sum of the savings transactions of this goal. Negative when something took more out of it
   * than it held: a settlement that takes money from savings is not limited by the balance
   * (docs/DOMAIN.md, "Savings").
   */
  balance: Cents;
  /**
   * `max(0, floor(100 * balance / targetAmount))`, not capped (150 means 50% over the target).
   * Rounded down, so 100 or more always means `reached`.
   */
  progressPercent: number;
  /** `max(0, targetAmount - balance)`: what is still missing. */
  remaining: Cents;
  /** `balance >= targetAmount`: the same as `remaining === 0` and `progressPercent >= 100`. */
  reached: boolean;
  /**
   * What to put aside per month to reach the target by the deadline:
   * `ceilDiv(remaining, monthsLeft)`, where `monthsLeft` is the number of months from the current
   * month to the deadline's month, both included, and at least 1. A goal whose deadline month has
   * passed therefore needs all of `remaining` now. Rounded up, so the last month needs a little
   * less. It is set exactly when the goal has a deadline and its `status` is `active` or
   * `overdue`: null without a deadline, once `reached` and when `archived`.
   */
  monthlyNeeded: Cents | null;
  status: GoalStatus;
}
