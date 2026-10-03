import { z } from 'zod';
import { THEMES, type Theme } from './limits';
import type { MonthKey } from './month';
import { monthKeySchema } from './schemas';

// Defined in './limits' (no zod); re-exported so existing imports keep working.
export {
  DEFAULT_ALERT_WARN_PERCENT,
  DEFAULT_THEME,
  MAX_START_MONTH_AGE_MONTHS,
  THEMES,
  type Theme,
} from './limits';

/** True for a structurally valid BCP-47 tag ("en-US", "it", "zh-Hant-TW"), not for "en_US". */
function isWellFormedLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/** ISO 4217 currency code in upper case, such as "EUR". */
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected a 3-letter upper-case currency code like EUR');

/** BCP-47 locale tag that drives number and date formatting, such as "en-US" or "it-IT". */
export const localeSchema = z
  .string()
  .max(35)
  .refine(isWellFormedLocale, 'Expected a BCP-47 locale tag like en-US');

export const themeSchema = z.enum(THEMES);

/** Integer 1 to 100: a budget warns once this share of its available amount is spent. */
export const alertWarnPercentSchema = z.number().int().min(1).max(100);

/**
 * PUT /api/settings body → 200 SettingsDto. Replaces all five settings; the first call creates them
 * (the app is then onboarded), later calls update them.
 * 422 rule_violation, checked in this order: `start_month_in_future` (startMonth after the current
 * month), `start_month_too_old` (a startMonth that is set or changed to more than
 * MAX_START_MONTH_AGE_MONTHS months before the current month, so an unchanged old one is never
 * refused) and `start_month_after_facts` (moving startMonth later than the earliest stored fact),
 * see docs/DOMAIN.md "Start month".
 */
export const settingsInputSchema = z.strictObject({
  currency: currencySchema,
  locale: localeSchema,
  startMonth: monthKeySchema,
  theme: themeSchema,
  alertWarnPercent: alertWarnPercentSchema,
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

/** GET /api/settings → 200 (404 not_found until onboarded). Also the response of PUT (200). */
export interface SettingsDto {
  currency: string;
  locale: string;
  /** First month the app tracks. */
  startMonth: MonthKey;
  theme: Theme;
  alertWarnPercent: number;
}
