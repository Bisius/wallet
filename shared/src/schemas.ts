import { z } from 'zod';
import { isMonthKey } from './month';

export const centsSchema = z.number().int().refine(Number.isSafeInteger, 'Amount out of range');
export const positiveCentsSchema = centsSchema.refine((v) => v > 0, 'Amount must be positive');
export const monthKeySchema = z.string().refine(isMonthKey, 'Expected a month in YYYY-MM format');
export const isoDateSchema = z.iso.date();
export const idSchema = z.coerce.number().int().positive();
