import { z } from 'zod';
import type { BudgetDto } from './budgets';
import { MAX_ONBOARDING_BUDGETS } from './limits';
import type { Cents } from './money';
import type { SalaryEntryDto } from './salary';
import { monthKeySchema, nameSchema, nonNegativeCentsSchema } from './schemas';
import {
  type SettingsDto,
  alertWarnPercentSchema,
  currencySchema,
  localeSchema,
  themeSchema,
} from './settings';

// The constant lives in './limits' (no zod); it is re-exported so existing imports keep working.
export { MAX_ONBOARDING_BUDGETS } from './limits';

/** One first budget of `POST /api/onboarding`: effective from the start month. */
export const onboardingBudgetSchema = z.strictObject({
  name: nameSchema,
  /** Monthly allocation in cents. 0 is allowed. */
  amount: nonNegativeCentsSchema,
  /** true: leftover or deficit carries into the next month. false: settled with savings. */
  incremental: z.boolean(),
});
export type OnboardingBudgetInput = z.infer<typeof onboardingBudgetSchema>;

/**
 * POST /api/onboarding body → 201 OnboardingResponse. The whole wizard in one atomic request: the
 * settings, the first salary (effective from startMonth), the opening savings balance and the
 * first budgets (effective from startMonth, in the given order). Either everything is stored or
 * nothing is. Defaults: `theme` = "system", `alertWarnPercent` = 80, `budgets` = [].
 * 409 already_onboarded when the settings exist. 422 rule_violation: `start_month_in_future` and
 * `start_month_too_old` (more than MAX_START_MONTH_AGE_MONTHS months before the current month).
 */
export const onboardingSchema = z.strictObject({
  currency: currencySchema,
  locale: localeSchema,
  startMonth: monthKeySchema,
  theme: themeSchema.optional(),
  alertWarnPercent: alertWarnPercentSchema.optional(),
  /** Monthly net salary in cents, effective from startMonth. 0 is allowed. */
  salary: nonNegativeCentsSchema,
  /** Savings balance when tracking starts, in cents. Not negative. */
  openingSavings: nonNegativeCentsSchema,
  budgets: z.array(onboardingBudgetSchema).max(MAX_ONBOARDING_BUDGETS).optional(),
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** POST /api/onboarding → 201: everything the request stored, so the UI can seed its state. */
export interface OnboardingResponse {
  settings: SettingsDto;
  /** The first salary entry, effective from startMonth. */
  salary: SalaryEntryDto;
  /** The opening savings balance as stored. */
  openingSavings: Cents;
  /** The created budgets in request order (empty when none were sent). */
  budgets: BudgetDto[];
}
