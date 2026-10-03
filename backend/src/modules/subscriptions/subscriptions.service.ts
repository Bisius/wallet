import {
  type IsoDate,
  type MonthKey,
  type SubscriptionCancelInput,
  type SubscriptionCreateInput,
  type SubscriptionDto,
  type SubscriptionPriceDto,
  type SubscriptionPriceInput,
  type SubscriptionUpdateInput,
  ceilDiv,
} from '@wallet/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { subscriptionPrices, subscriptions } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { currentMonthOf, timestampOf } from '../../lib/today';
import {
  currentRow,
  firstRowRedate,
  isWithinActiveMonths,
  lifecycleStatus,
} from '../../lib/versioned';
import { requireSettings } from '../settings/settings.service';

type SubscriptionRow = typeof subscriptions.$inferSelect;
type PriceRow = typeof subscriptionPrices.$inferSelect;

/** Months in a year, for the display-only monthly equivalent of a yearly price. */
const MONTHS_PER_YEAR = 12;

/** Names compare ignoring case (but not accents, so "é" sorts with "e"); the id breaks ties. */
const nameCollator = new Intl.Collator('en', { sensitivity: 'accent' });

// -------------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------------

const toPriceDto = (row: PriceRow): SubscriptionPriceDto => ({
  effectiveMonth: row.effectiveMonth,
  amount: row.amount,
});

/**
 * Subscriptions as DTOs, ascending by name (ignoring case) then id: all of them, or only `ids`.
 * Computed fresh from the stored rows.
 */
export function loadSubscriptionDtos(
  { db, clock }: Deps,
  ids?: readonly number[],
): SubscriptionDto[] {
  if (ids && ids.length === 0) return [];
  const only = ids ? [...ids] : null;
  const currentMonth = currentMonthOf(clock);

  const rows = db
    .select()
    .from(subscriptions)
    .where(only ? inArray(subscriptions.id, only) : undefined)
    .all();
  const priceRows = db
    .select()
    .from(subscriptionPrices)
    .where(only ? inArray(subscriptionPrices.subscriptionId, only) : undefined)
    .orderBy(asc(subscriptionPrices.effectiveMonth))
    .all();

  const pricesBySubscription = new Map<number, SubscriptionPriceDto[]>();
  for (const row of priceRows) {
    const list = pricesBySubscription.get(row.subscriptionId) ?? [];
    list.push(toPriceDto(row));
    pricesBySubscription.set(row.subscriptionId, list);
  }

  return rows
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
    .map((row: SubscriptionRow): SubscriptionDto => {
      const prices = pricesBySubscription.get(row.id) ?? [];
      const currentPrice =
        currentRow(prices, row.startMonth, row.endMonth, currentMonth)?.amount ?? null;
      const status = lifecycleStatus(row.startMonth, row.endMonth, currentMonth);
      return {
        id: row.id,
        name: row.name,
        frequency: row.frequency,
        anchorDate: row.anchorDate,
        startMonth: row.startMonth,
        endMonth: row.endMonth,
        color: row.color,
        notes: row.notes,
        prices,
        currentPrice,
        monthlyEquivalent: monthlyEquivalent(row.frequency, currentPrice),
        status: status === 'ended' ? 'cancelled' : status,
      };
    });
}

/**
 * Display-only monthly cost: the price itself for a monthly subscription, the yearly price / 12
 * rounded UP to the next cent for a yearly one (100.00 a year shows as 8.34). Null without a price.
 */
function monthlyEquivalent(frequency: 'monthly' | 'yearly', price: number | null): number | null {
  if (price === null) return null;
  return frequency === 'yearly' ? ceilDiv(price, MONTHS_PER_YEAR) : price;
}

export function loadSubscriptionDto(deps: Deps, id: number): SubscriptionDto {
  const [dto] = loadSubscriptionDtos(deps, [id]);
  if (!dto) throw notFound('Subscription');
  return dto;
}

function findSubscription(db: DbOrTx, id: number): SubscriptionRow {
  const row = db.select().from(subscriptions).where(eq(subscriptions.id, id)).get();
  if (!row) throw notFound('Subscription');
  return row;
}

function pricesOf(db: DbOrTx, subscriptionId: number): PriceRow[] {
  return db
    .select()
    .from(subscriptionPrices)
    .where(eq(subscriptionPrices.subscriptionId, subscriptionId))
    .all();
}

/** GET /api/subscriptions */
export function listSubscriptions(deps: Deps): SubscriptionDto[] {
  return loadSubscriptionDtos(deps);
}

// -------------------------------------------------------------------------------------------------
// Writing
// -------------------------------------------------------------------------------------------------

function assertNotBeforeStart(db: DbOrTx, startMonth: MonthKey): void {
  const floor = requireSettings(db).startMonth;
  if (startMonth < floor) {
    throw ruleViolation(
      'before_start_month',
      `A subscription cannot start in ${startMonth}, before the start month ${floor}`,
      'startMonth',
    );
  }
}

/** POST /api/subscriptions: the subscription and its first price, effective from `startMonth`. */
export function createSubscription(deps: Deps, input: SubscriptionCreateInput): SubscriptionDto {
  return inTransaction(deps, (tx) => {
    const startMonth = input.startMonth ?? currentMonthOf(tx.clock);
    assertNotBeforeStart(tx.db, startMonth);

    const { id } = tx.db
      .insert(subscriptions)
      .values({
        name: input.name,
        frequency: input.frequency,
        anchorDate: input.anchorDate,
        startMonth,
        endMonth: null,
        color: input.color ?? null,
        notes: input.notes ?? null,
        createdAt: timestampOf(tx.clock),
      })
      .returning({ id: subscriptions.id })
      .get();
    tx.db
      .insert(subscriptionPrices)
      .values({ subscriptionId: id, effectiveMonth: startMonth, amount: input.amount })
      .run();
    return loadSubscriptionDto(tx, id);
  });
}

/**
 * PATCH /api/subscriptions/:id. Rules, in order: `before_start_month`, `end_before_start`,
 * `renewal_month_in_history`. No price is deleted: moving `startMonth` EARLIER than the first price
 * re-dates that price to the new month, so a price is in effect at the start month, and moving it
 * later changes no price (a price dated before the start month may be the one in effect at it;
 * docs/DOMAIN.md, "Versioned values").
 */
export function updateSubscription(
  deps: Deps,
  id: number,
  input: SubscriptionUpdateInput,
): SubscriptionDto {
  return inTransaction(deps, (tx) => {
    const subscription = findSubscription(tx.db, id);

    if (input.startMonth !== undefined) {
      const newStart = input.startMonth;
      assertNotBeforeStart(tx.db, newStart);
      if (subscription.endMonth !== null && newStart > subscription.endMonth) {
        throw ruleViolation(
          'end_before_start',
          `The start month ${newStart} is after the subscription's end month ${subscription.endMonth}`,
          'startMonth',
        );
      }
    }
    if (input.anchorDate !== undefined) {
      assertRenewalMonthKept(tx, subscription, input.anchorDate);
    }

    if (input.startMonth !== undefined) {
      const redate = firstRowRedate(pricesOf(tx.db, id), input.startMonth);
      if (redate) {
        tx.db
          .update(subscriptionPrices)
          .set({ effectiveMonth: redate.to })
          .where(eq(subscriptionPrices.id, redate.id))
          .run();
      }
    }

    tx.db.update(subscriptions).set(input).where(eq(subscriptions.id, id)).run();
    return loadSubscriptionDto(tx, id);
  });
}

/** The month of the year (1 to 12) of a `YYYY-MM-DD` date. */
const monthOfYear = (date: IsoDate): number => Number(date.slice(5, 7));

/**
 * `renewal_month_in_history`: the renewal month of a yearly subscription (the month of its
 * `anchorDate`) cannot move once the subscription has a closed month. Every cycle is computed
 * towards the renewal month, so changing it would re-spread the closed months with no explicit
 * backdating (docs/DOMAIN.md, "Editing rules"). The user cancels the subscription and adds a new
 * one instead. Changing only the day, any change while no month has closed, and any change to a
 * monthly subscription are fine.
 *
 * It looks at the subscription as stored: moving `startMonth` in the same request does not lift it.
 */
function assertRenewalMonthKept(
  { clock }: Deps,
  subscription: SubscriptionRow,
  anchorDate: IsoDate,
): void {
  if (subscription.frequency !== 'yearly') return;
  if (monthOfYear(anchorDate) === monthOfYear(subscription.anchorDate)) return;
  if (subscription.startMonth >= currentMonthOf(clock)) return; // no closed month yet

  throw ruleViolation(
    'renewal_month_in_history',
    `The renewal month of "${subscription.name}" cannot change: it already has closed months. ` +
      'Cancel it and add a new subscription instead',
    'anchorDate',
  );
}

/** PUT /api/subscriptions/:id/prices/:month: upserts the price effective from `month`. */
export function upsertSubscriptionPrice(
  deps: Deps,
  id: number,
  month: MonthKey,
  input: SubscriptionPriceInput,
): SubscriptionDto {
  const subscription = findSubscription(deps.db, id);
  if (!isWithinActiveMonths(subscription.startMonth, subscription.endMonth, month)) {
    throw ruleViolation(
      'outside_active_months',
      `${month} is outside the subscription's active months ` +
        `(${subscription.startMonth} to ${subscription.endMonth ?? 'no end'})`,
      'month',
    );
  }
  deps.db
    .insert(subscriptionPrices)
    .values({ subscriptionId: id, effectiveMonth: month, amount: input.amount })
    .onConflictDoUpdate({
      target: [subscriptionPrices.subscriptionId, subscriptionPrices.effectiveMonth],
      set: { amount: input.amount },
    })
    .run();
  return loadSubscriptionDto(deps, id);
}

/**
 * POST /api/subscriptions/:id/cancel: `endMonth` (default: the current month) becomes the last
 * active month. Cancelling again moves the end month, earlier or later. No price is deleted: those
 * effective after the end month are inert (only the active months are ever computed) and apply
 * again if the end month moves later (docs/DOMAIN.md, "Versioned values"). What a yearly
 * subscription does in its end month (release of the reserve) is the ledger's rule.
 */
export function cancelSubscription(
  deps: Deps,
  id: number,
  input: SubscriptionCancelInput,
): SubscriptionDto {
  return inTransaction(deps, (tx) => {
    const subscription = findSubscription(tx.db, id);
    const endMonth = input.endMonth ?? currentMonthOf(tx.clock);
    if (endMonth < subscription.startMonth) {
      throw ruleViolation(
        'end_before_start',
        `The end month ${endMonth} is before the subscription's start month ${subscription.startMonth}`,
        'endMonth',
      );
    }

    tx.db.update(subscriptions).set({ endMonth }).where(eq(subscriptions.id, id)).run();
    return loadSubscriptionDto(tx, id);
  });
}

/** DELETE /api/subscriptions/:id: a hard delete; the prices go with it (foreign key cascade). */
export function deleteSubscription({ db }: Deps, id: number): void {
  const removed = db
    .delete(subscriptions)
    .where(eq(subscriptions.id, id))
    .returning({ id: subscriptions.id })
    .all();
  if (removed.length === 0) throw notFound('Subscription');
}
