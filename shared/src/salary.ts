import { z } from 'zod';
import type { Cents } from './money';
import type { MonthKey } from './month';
import { nonNegativeCentsSchema } from './schemas';

/**
 * PUT /api/salary/:month body → 200 SalaryEntryDto. Upserts the salary effective from `:month`
 * (the UI defaults the month to the current one). 422 rule_violation: `before_start_month`.
 */
export const salaryUpsertSchema = z.strictObject({
  /** Monthly net salary in cents. 0 is allowed. */
  amount: nonNegativeCentsSchema,
});
export type SalaryUpsertInput = z.infer<typeof salaryUpsertSchema>;

/**
 * GET /api/salary → 200 SalaryEntryDto[] (ascending by effectiveMonth). Also the response of
 * PUT /api/salary/:month and the `salary` of POST /api/onboarding. The salary of month M is the
 * entry with the latest effectiveMonth <= M. DELETE /api/salary/:month → 204 (404 if no entry has
 * exactly that effectiveMonth).
 */
export interface SalaryEntryDto {
  effectiveMonth: MonthKey;
  amount: Cents;
}
