import { z } from 'zod';
import type { Cents } from './money';
import type { MonthKey } from './month';
import {
  AT_LEAST_ONE_FIELD,
  colorSchema,
  hasAnyKey,
  iconSchema,
  monthKeySchema,
  nameSchema,
  nonNegativeCentsSchema,
  notesSchema,
} from './schemas';
import { alertWarnPercentSchema } from './settings';

/** Position in the budget list: ascending, ties broken by id. Reorder by PATCHing it. */
export const sortOrderSchema = z.number().int().min(0).max(1_000_000);

/**
 * POST /api/budgets body → 201 BudgetDto. Creates the budget and its first version
 * (`amount` + `incremental`, effective from `startMonth`).
 * Defaults: `startMonth` = current month; `sortOrder` = after the last budget; the optional text
 * fields = null. 422 rule_violation: `before_start_month` (startMonth before settings.startMonth).
 */
export const budgetCreateSchema = z.strictObject({
  name: nameSchema,
  /** Monthly allocation in cents. 0 is allowed. */
  amount: nonNegativeCentsSchema,
  /** true: leftover or deficit carries into the next month. false: settled with savings. */
  incremental: z.boolean(),
  startMonth: monthKeySchema.optional(),
  color: colorSchema.nullish(),
  icon: iconSchema.nullish(),
  sortOrder: sortOrderSchema.optional(),
  /** Overrides settings.alertWarnPercent for this budget. null/omitted: use the settings value. */
  alertWarnPercent: alertWarnPercentSchema.nullish(),
  notes: notesSchema.nullish(),
});
export type BudgetCreateInput = z.infer<typeof budgetCreateSchema>;

/**
 * PATCH /api/budgets/:id body → 200 BudgetDto. Any subset, at least one. `null` clears color, icon,
 * alertWarnPercent (back to the settings value) and notes. Amount and mode are not here: use
 * PUT /api/budgets/:id/versions/:month. No version is ever deleted: moving `startMonth` earlier
 * than the first version re-dates that first version to the new month (so a version is in effect
 * at the start), and moving it later changes no version (a version dated before the start month
 * may be the one in effect at it).
 * 422 rule_violation: `before_start_month` (startMonth before settings.startMonth),
 * `end_before_start` (startMonth after the budget's endMonth) and `start_after_activity`
 * (startMonth after the earliest spending or transfer).
 */
export const budgetUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    color: colorSchema.nullable().optional(),
    icon: iconSchema.nullable().optional(),
    sortOrder: sortOrderSchema.optional(),
    alertWarnPercent: alertWarnPercentSchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
    startMonth: monthKeySchema.optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type BudgetUpdateInput = z.infer<typeof budgetUpdateSchema>;

/**
 * PUT /api/budgets/:id/versions/:month body → 200 BudgetDto. Upserts the amount and mode effective
 * from `:month` (the UI defaults it to the current month, so closed months never change by
 * accident). 422 rule_violation: `outside_active_months` (month before the budget's startMonth or
 * after its endMonth). Backdating inside the active months is allowed when asked for explicitly.
 */
export const budgetVersionSchema = z.strictObject({
  amount: nonNegativeCentsSchema,
  incremental: z.boolean(),
});
export type BudgetVersionInput = z.infer<typeof budgetVersionSchema>;

/**
 * POST /api/budgets/:id/archive body → 200 BudgetDto. `endMonth` is the last active month and
 * defaults to the current month. The body may be empty or absent. Calling it again on an archived
 * budget moves its endMonth, earlier or later. No version is deleted: versions effective after
 * endMonth are inert, and take effect again if endMonth moves later. The budget's whole balance is
 * settled with savings when that month closes. 422 rule_violation: `end_before_start`,
 * `end_before_activity` (endMonth before the latest spending or transfer).
 */
export const budgetArchiveSchema = z.strictObject({
  endMonth: monthKeySchema.optional(),
});
export type BudgetArchiveInput = z.infer<typeof budgetArchiveSchema>;

/**
 * `upcoming`: the current month is before startMonth. `active`: startMonth <= current month <=
 * endMonth (no endMonth = always). `ended`: the current month is after endMonth. A budget archived
 * with endMonth = this month is still `active` until the month is over.
 */
export type BudgetStatus = 'upcoming' | 'active' | 'ended';

/** Amount and mode of a budget from `effectiveMonth` until the next version. */
export interface BudgetVersionDto {
  effectiveMonth: MonthKey;
  amount: Cents;
  incremental: boolean;
}

/**
 * GET /api/budgets → 200 BudgetDto[] (all statuses, ascending by sortOrder then id). Also the
 * response of POST (201), PATCH, PUT .../versions/:month and POST .../archive (200), and an
 * element of the 201 response of POST /api/onboarding. DELETE /api/budgets/:id → 204, or 409
 * has_history when `hasHistory` is true.
 */
export interface BudgetDto {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  startMonth: MonthKey;
  /** Last active month. null while the budget is not archived. */
  endMonth: MonthKey | null;
  /** Per-budget override of the warning threshold. null: settings.alertWarnPercent applies. */
  alertWarnPercent: number | null;
  notes: string | null;
  /**
   * Every stored version, ascending by effectiveMonth (none is ever deleted). A version is in
   * effect at startMonth: it is dated at startMonth, or before it when startMonth was moved later.
   * Versions dated after endMonth are inert (they apply again if endMonth moves later).
   */
  versions: BudgetVersionDto[];
  /**
   * The version in effect in min(current month, endMonth): the latest one with effectiveMonth <=
   * that month. So an ended budget shows its last version and an inert later one is never shown.
   * null if upcoming.
   */
  current: BudgetVersionDto | null;
  /** True when spendings or transfers exist for it, so it can only be archived, not deleted. */
  hasHistory: boolean;
  status: BudgetStatus;
}
