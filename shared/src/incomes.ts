import { z } from 'zod';
import type { Cents } from './money';
import type { IsoDate } from './month';
import {
  AT_LEAST_ONE_FIELD,
  descriptionSchema,
  hasAnyKey,
  isoDateSchema,
  monthKeySchema,
  positiveCentsSchema,
} from './schemas';

/**
 * POST /api/incomes body → 201 IncomeDto. A one-off income counted in the month of its date.
 * 422 rule_violation: `before_start_month` (date before settings.startMonth, field "date").
 */
export const incomeCreateSchema = z.strictObject({
  date: isoDateSchema,
  /** Positive cents. */
  amount: positiveCentsSchema,
  /** What it was: "Bonus", "Tax refund", ... Required, 1 to 200 characters. */
  description: descriptionSchema.min(1, 'Description is required'),
});
export type IncomeCreateInput = z.infer<typeof incomeCreateSchema>;

/**
 * PATCH /api/incomes/:id body → 200 IncomeDto. Any subset of the create fields, at least one.
 * Same 422 rule as the create.
 */
export const incomeUpdateSchema = z
  .strictObject({
    date: isoDateSchema.optional(),
    amount: positiveCentsSchema.optional(),
    description: descriptionSchema.min(1, 'Description is required').optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type IncomeUpdateInput = z.infer<typeof incomeUpdateSchema>;

/**
 * GET /api/incomes query → 200 IncomeDto[], newest first (date, then id, descending). Without
 * `month` every income is returned.
 */
export const incomeListQuerySchema = z.strictObject({
  month: monthKeySchema.optional(),
});
export type IncomeListQuery = z.infer<typeof incomeListQuerySchema>;

/**
 * Element of GET /api/incomes → 200, and the response of POST (201) and PATCH (200)
 * /api/incomes. DELETE /api/incomes/:id → 204.
 */
export interface IncomeDto {
  id: number;
  date: IsoDate;
  amount: Cents;
  description: string;
}
