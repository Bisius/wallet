import { z } from 'zod';
import {
  SUBSCRIPTION_FREQUENCIES,
  type SubscriptionFrequency,
  UPCOMING_DEFAULT_DAYS,
  UPCOMING_MAX_DAYS,
  UPCOMING_MIN_DAYS,
} from './limits';
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
export {
  SUBSCRIPTION_FREQUENCIES,
  type SubscriptionFrequency,
  UPCOMING_DEFAULT_DAYS,
  UPCOMING_MAX_DAYS,
  UPCOMING_MIN_DAYS,
} from './limits';

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

// ---------------------------------------------------------------------------------------------
// Upcoming renewals (docs/DOMAIN.md, "Upcoming renewals")
// ---------------------------------------------------------------------------------------------

/**
 * GET /api/subscriptions/upcoming query → 200 UpcomingRenewalDto[]. `days` is a whole number of
 * days, written with digits only, from UPCOMING_MIN_DAYS (1) to UPCOMING_MAX_DAYS (366), default
 * UPCOMING_DEFAULT_DAYS (30). Anything else (0, 367, 1.5, "1e1", blank, repeated) is a 400
 * validation_error at `days`. No 404, 409 or 422 rule applies.
 */
export const upcomingRenewalsQuerySchema = z.strictObject({
  days: z
    .preprocess(
      (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
      z.number().int().min(UPCOMING_MIN_DAYS).max(UPCOMING_MAX_DAYS),
    )
    .default(UPCOMING_DEFAULT_DAYS),
});
/** What a client may send (`days` optional); the backend's parsed value always has it. */
export type UpcomingRenewalsQuery = Partial<z.infer<typeof upcomingRenewalsQuerySchema>>;

/**
 * Element of GET /api/subscriptions/upcoming → 200 UpcomingRenewalDto[], ascending by `date`, then
 * `id`. It lists, for each subscription, its NEXT billing date when that date is from today to
 * today + `days` (both inclusive, in the server's time zone), so a subscription appears at most
 * once. The route is registered before `/:id`.
 *
 * - The billing date is the day of `anchorDate` clamped to the length of the month (31 becomes 30
 *   in April); a yearly subscription bills only in the month-of-year of its `anchorDate`.
 * - The subscription must be active in the month of that date (`startMonth <= month <= endMonth`).
 *   So a cancelled one never appears, one that ends before its next renewal does not, and one that
 *   starts later does appear once its first billing date is in the window (its `reserved` is 0).
 * - `amount` is the price in effect in the month of `date`, read from the price rows. It is NOT
 *   `MonthSubscriptionLine.nextRenewalPrice`, which can differ when a price change is dated in the
 *   renewal month itself.
 * - `reserved` (yearly only) is what is already set aside towards this renewal, as of today:
 *   the reserve after the current month's top-up and before the renewal's payment, never more than
 *   `amount`. For a renewal in the current month the whole price counts as reserved (this month's
 *   top-up is part of this month's fixed costs); for a later one it is the `reserveBalance` of the
 *   current month's line (0 when the subscription has no line this month).
 */
export interface UpcomingRenewalDto {
  /** The subscription's id. */
  id: number;
  name: string;
  color: string | null;
  frequency: SubscriptionFrequency;
  /** `frequency === 'yearly'`: a yearly renewal, shown highlighted with its reserve. */
  yearly: boolean;
  /** The billing date. */
  date: IsoDate;
  /** Days from today to `date`: 0 when it is today. */
  daysUntil: number;
  /** The price charged on `date`: per month for monthly, per year for yearly. */
  amount: Cents;
  /** Yearly only (null for monthly): the part of `amount` already reserved, 0 to `amount`. */
  reserved: Cents | null;
  /** Yearly only (null for monthly): `amount - reserved`, what the months left still have to add. */
  unreserved: Cents | null;
}
