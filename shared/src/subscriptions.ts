import { z } from 'zod';
import { SUBSCRIPTION_FREQUENCIES, type SubscriptionFrequency } from './limits';
import type { Cents } from './money';
import type { IsoDate, MonthKey } from './month';
import {
  AT_LEAST_ONE_FIELD,
  colorSchema,
  hasAnyKey,
  isoDateSchema,
  monthKeySchema,
  nameSchema,
  notesSchema,
  positiveCentsSchema,
} from './schemas';

// Defined in './limits' (no zod); re-exported so existing imports keep working.
export { SUBSCRIPTION_FREQUENCIES, type SubscriptionFrequency } from './limits';

/**
 * POST /api/subscriptions body → 201 SubscriptionDto. Creates the subscription and its first price
 * (`amount`, effective from `startMonth`). Defaults: `startMonth` = current month; color and notes
 * = null. 422 rule_violation: `before_start_month` (startMonth before settings.startMonth).
 */
export const subscriptionCreateSchema = z.strictObject({
  name: nameSchema,
  frequency: z.enum(SUBSCRIPTION_FREQUENCIES),
  /**
   * A real charge date. Its day is the billing day (clamped to short months); for a yearly
   * subscription its month is the renewal month.
   */
  anchorDate: isoDateSchema,
  /** Price per charge in cents: per month for monthly, per year for yearly. Positive. */
  amount: positiveCentsSchema,
  startMonth: monthKeySchema.optional(),
  color: colorSchema.nullish(),
  notes: notesSchema.nullish(),
});
export type SubscriptionCreateInput = z.infer<typeof subscriptionCreateSchema>;

/**
 * PATCH /api/subscriptions/:id body → 200 SubscriptionDto. Any subset, at least one. `null` clears
 * color and notes. The frequency cannot change (cancel and create a new one). Prices go through
 * PUT .../prices/:month and the end through POST .../cancel. No price is ever deleted: moving
 * `startMonth` earlier than the first price re-dates that first price to the new month (so a price
 * is in effect at the start), and moving it later changes no price (a price dated before the start
 * month may be the one in effect at it). 422 rule_violation, checked in this order:
 * `before_start_month`, `end_before_start` (startMonth after the endMonth) and
 * `renewal_month_in_history` (`anchorDate` of a yearly subscription moved to another month of the
 * year while the subscription, as stored, has a closed month, that is a `startMonth` before the
 * current month: cancel it and add a new one). Changing only the day of `anchorDate`, any
 * `anchorDate` change while no month has closed, and any change to a monthly subscription are
 * accepted.
 */
export const subscriptionUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    anchorDate: isoDateSchema.optional(),
    startMonth: monthKeySchema.optional(),
    color: colorSchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type SubscriptionUpdateInput = z.infer<typeof subscriptionUpdateSchema>;

/**
 * PUT /api/subscriptions/:id/prices/:month body → 200 SubscriptionDto. Upserts the price effective
 * from `:month` (the UI defaults it to the current month). 422 rule_violation:
 * `outside_active_months` (month before the startMonth or after the endMonth).
 */
export const subscriptionPriceSchema = z.strictObject({
  amount: positiveCentsSchema,
});
export type SubscriptionPriceInput = z.infer<typeof subscriptionPriceSchema>;

/**
 * POST /api/subscriptions/:id/cancel body → 200 SubscriptionDto. `endMonth` is the last month it is
 * charged and defaults to the current month. The body may be empty or absent. Calling it again on
 * a cancelled subscription moves its endMonth, earlier or later. No price is deleted: prices
 * effective after endMonth are inert, and take effect again if endMonth moves later. A monthly
 * subscription is charged in full in its endMonth, whatever its billing day. A yearly one only
 * behaves differently in its endMonth itself (earlier months are unaffected): if the next renewal
 * is after it, nothing more is set aside and the whole reserve is released to savings; if endMonth
 * is its renewal month, the renewal is paid as usual. 422 rule_violation: `end_before_start`.
 */
export const subscriptionCancelSchema = z.strictObject({
  endMonth: monthKeySchema.optional(),
});
export type SubscriptionCancelInput = z.infer<typeof subscriptionCancelSchema>;

/**
 * `upcoming`: the current month is before startMonth. `active`: startMonth <= current month <=
 * endMonth (no endMonth = ongoing). `cancelled`: the current month is after endMonth. A
 * subscription cancelled with endMonth = this month is still `active` until the month is over (its
 * figures for that month are described at `cancel`); the UI can show "ends <endMonth>" whenever
 * `active` comes with an endMonth.
 */
export type SubscriptionStatus = 'upcoming' | 'active' | 'cancelled';

/** The price of a subscription from `effectiveMonth` until the next price. */
export interface SubscriptionPriceDto {
  effectiveMonth: MonthKey;
  amount: Cents;
}

/**
 * GET /api/subscriptions → 200 SubscriptionDto[] (all statuses, ascending by name ignoring case,
 * then id). Also the response of POST (201), PATCH, PUT .../prices/:month and POST .../cancel
 * (200). DELETE /api/subscriptions/:id → 204. A hard delete also removes the subscription from
 * every past month, so the UI should confirm first.
 */
export interface SubscriptionDto {
  id: number;
  name: string;
  frequency: SubscriptionFrequency;
  anchorDate: IsoDate;
  startMonth: MonthKey;
  /** Last charged month. null while ongoing. */
  endMonth: MonthKey | null;
  color: string | null;
  notes: string | null;
  /**
   * Every stored price, ascending by effectiveMonth (none is ever deleted). A price is in effect at
   * startMonth: it is dated at startMonth, or before it when startMonth was moved later. Prices
   * dated after endMonth are inert (they apply again if endMonth moves later).
   */
  prices: SubscriptionPriceDto[];
  /**
   * The price in effect in min(current month, endMonth), so a cancelled subscription shows its last
   * price and an inert later one is never shown. null if `upcoming`.
   */
  currentPrice: Cents | null;
  /**
   * What it costs per month for display: `currentPrice` for monthly, `currentPrice / 12` rounded
   * UP to the next cent for yearly. null if `upcoming`. Indicative only: the ledger's yearly
   * reserve (see `MonthSubscriptionLine`) is what is actually set aside.
   */
  monthlyEquivalent: Cents | null;
  status: SubscriptionStatus;
}
