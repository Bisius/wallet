import {
  type IsoDate,
  type MonthKey,
  type UpcomingRenewalDto,
  type UpcomingRenewalsQuery,
  UPCOMING_DEFAULT_DAYS,
  addDays,
  addMonths,
  billingDateIn,
  daysBetween,
} from '@wallet/shared';
import { type SubscriptionFact, loadFacts } from '../../domain/facts';
import { computeLedger, ledgerMonth } from '../../domain/ledger';
import type { Deps } from '../../lib/deps';
import { currentMonthOf, monthOfDate, todayOf } from '../../lib/today';
import { effectiveAt, isWithinActiveMonths } from '../../lib/versioned';

/**
 * The next billing date of a subscription that falls from `today` to `lastDay` (both inclusive), or
 * null. A billing day is the day of the anchor date clamped to the month; a yearly subscription
 * bills only in the month-of-year of its anchor. The subscription must be active in the month of
 * the date, so one that is over (or ends before the date) has none and one that starts later gets
 * its first date once it is in the window. Months are tried in order, so the first hit is the next.
 */
function nextBillingDate(
  subscription: SubscriptionFact,
  today: IsoDate,
  lastDay: IsoDate,
): { date: IsoDate; month: MonthKey } | null {
  const renewalMonthOfYear = subscription.anchorDate.slice(5, 7);
  const lastMonth = monthOfDate(lastDay);
  for (let month = monthOfDate(today); month <= lastMonth; month = addMonths(month, 1)) {
    if (subscription.frequency === 'yearly' && month.slice(5, 7) !== renewalMonthOfYear) continue;
    if (!isWithinActiveMonths(subscription.startMonth, subscription.endMonth, month)) continue;
    const date = billingDateIn(month, subscription.anchorDate);
    if (date >= today && date <= lastDay) return { date, month };
  }
  return null;
}

/**
 * GET /api/subscriptions/upcoming?days=: the next billing date of every subscription that bills
 * within `days` days from today (default 30), ascending by date, then id (docs/DOMAIN.md,
 * "Upcoming renewals").
 *
 * The price is the one in effect in the month of the date, read from the price rows, and never
 * `nextRenewalPrice` of the month view. For a yearly subscription, `reserved` is what is held
 * towards that renewal as of today, from the same ledger as the month views:
 *
 * - renewal in the CURRENT month: the reserve in that month's line before the renewal is paid, that
 *   is its reserve after this month's top-up (which is part of this month's fixed costs). It is
 *   always the whole price, and it is derived from the line so that it follows the ledger.
 * - renewal in a LATER month: the `reserveBalance` at the end of the current month (this month's
 *   top-up counted, as the ledger treats the current month as already planned), 0 when the
 *   subscription has no line this month (it starts later).
 *
 * Either way it is capped at the price of the renewal, since a price drop dated in the renewal
 * month can leave more held than will be paid (the rest is released after the payment).
 */
export function listUpcomingRenewals(
  deps: Deps,
  query: UpcomingRenewalsQuery = {},
): UpcomingRenewalDto[] {
  const days = query.days ?? UPCOMING_DEFAULT_DAYS;
  const today = todayOf(deps.clock);
  const currentMonth = currentMonthOf(deps.clock);
  const lastDay = addDays(today, days);
  const facts = loadFacts(deps.db);

  const due = facts.subscriptions.flatMap((subscription) => {
    const next = nextBillingDate(subscription, today, lastDay);
    return next ? [{ subscription, ...next }] : [];
  });
  if (due.length === 0) return [];

  // The reserves are only needed for yearly renewals, so only then is the ledger run.
  const linesOfCurrentMonth = due.some((item) => item.subscription.frequency === 'yearly')
    ? (ledgerMonth(computeLedger(facts, currentMonth, today), currentMonth)?.subscriptions ?? [])
    : [];

  return due
    .map(({ subscription, date, month }): UpcomingRenewalDto => {
      const prices = [...subscription.prices].sort((a, b) =>
        a.effectiveMonth < b.effectiveMonth ? -1 : a.effectiveMonth > b.effectiveMonth ? 1 : 0,
      );
      const amount = effectiveAt(prices, month)?.amount ?? 0;
      const yearly = subscription.frequency === 'yearly';

      let reserved: number | null = null;
      if (yearly) {
        const line = linesOfCurrentMonth.find((candidate) => candidate.id === subscription.id);
        // The renewal's own month: the reserve before it is paid (the line's reserve after the
        // payment, plus the payment, plus what the payment left over and released).
        const held = !line
          ? 0
          : month === currentMonth
            ? line.reserveBalance + line.price + line.reserveReleased
            : line.reserveBalance;
        reserved = Math.min(amount, held);
      }

      return {
        id: subscription.id,
        name: subscription.name,
        color: subscription.color,
        frequency: subscription.frequency,
        yearly,
        date,
        daysUntil: daysBetween(today, date),
        amount,
        reserved,
        unreserved: reserved === null ? null : amount - reserved,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.id - b.id);
}
