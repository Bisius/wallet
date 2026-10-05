/**
 * The texts of the three notifications (docs/DOMAIN.md, "Budget alerts", "Renewal reminders" and
 * "Monthly recap"): pure builders, no I/O and no arithmetic beyond sums of cents. Every figure is a
 * field of a read model, printed as it is (`MonthBudgetLine`, `UpcomingRenewalDto`, `MonthView`),
 * and is formatted with `telegram.format.ts` (the currency and the locale of Settings).
 *
 * Messages are HTML (the runtime sets `parse_mode: 'HTML'`), so every name goes through `escapeHtml`.
 * The texts are plain on purpose: they read like the examples of DOMAIN.md.
 *
 * LENGTH. Telegram refuses a message of more than 4096 characters. A name is at most
 * `NAME_MAX_LENGTH` (60) characters, so one line is always far below that; what can grow is a
 * list. A reminder with many renewals is split into several messages (`renewalMessages`), and the
 * recap shortens its "Over" list (`recapMessage`). Lengths are counted on the HTML text, entities
 * included, which is more than Telegram counts, so the limit is never exceeded.
 */
import {
  type MonthBudgetLine,
  type MonthKey,
  type MonthView,
  type OutstandingMonthDto,
  type UpcomingRenewalDto,
  sumCents,
} from '@wallet/shared';
import { type MessageFormat, formatDay, formatMoney, formatMonth } from './telegram.format';
import { escapeHtml } from './telegram.messages';
import type { TelegramSendExtra } from './telegram.types';

/** Telegram's limit on the text of one message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

// --- Budget alerts ----------------------------------------------------------------------------

/** The part of a budget's line that an alert prints. */
export type AlertLine = Pick<
  MonthBudgetLine,
  'name' | 'alert' | 'usagePercent' | 'remaining' | 'available'
>;

/**
 * One budget that rose to `warning` or `over`:
 *
 *     ⚠️ Groceries: 84% used, €48.00 left of €300.00
 *     🔴 Eating out is over by €12.40
 *
 * `usagePercent`, `remaining` and `available` are the line's fields. "Over by" is `-remaining`,
 * which is positive whenever `alert` is `over`. A line that is `ok` has no alert.
 */
export function budgetAlertText(line: AlertLine, format: MessageFormat): string {
  const name = escapeHtml(line.name);
  switch (line.alert) {
    case 'over':
      return `🔴 ${name} is over by ${formatMoney(-line.remaining, format)}`;
    case 'warning': {
      // `warning` needs available > 0, so `usagePercent` is a number; the guard is for a line
      // that was built by hand.
      const used = line.usagePercent === null ? '' : `${line.usagePercent}% used, `;
      return `⚠️ ${name}: ${used}${formatMoney(line.remaining, format)} left of ${formatMoney(line.available, format)}`;
    }
    case 'ok':
      throw new RangeError('budgetAlertText: a budget that is ok has no alert');
  }
}

// --- Renewal reminders ------------------------------------------------------------------------

/** "today (Mon 5 Oct)", "tomorrow (Tue 6 Oct)", "in 7 days (Mon 12 Oct)". */
export function renewalWhen(
  renewal: Pick<UpcomingRenewalDto, 'daysUntil' | 'date'>,
  format: MessageFormat,
): string {
  const { daysUntil, date } = renewal;
  const away = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
  return `${away} (${formatDay(date, format)})`;
}

/**
 * One renewal, with its price (`amount`) and, for a yearly one, what is set aside (`reserved`) and
 * what is not (`unreserved`), all fields of `UpcomingRenewalDto` (never `nextRenewalPrice`):
 *
 *     Netflix · tomorrow (Tue 6 Oct) · €13.99
 *     Domain · in 7 days (Mon 12 Oct) · €15.00 · set aside ✅
 *     Insurance · in 6 days (Sun 11 Oct) · €480.00 · €400.00 set aside, €80.00 not covered
 */
export function renewalLine(renewal: UpcomingRenewalDto, format: MessageFormat): string {
  const parts = [
    escapeHtml(renewal.name),
    renewalWhen(renewal, format),
    formatMoney(renewal.amount, format),
  ];
  if (renewal.reserved !== null && renewal.unreserved !== null) {
    parts.push(
      renewal.unreserved === 0
        ? 'set aside ✅'
        : `${formatMoney(renewal.reserved, format)} set aside, ${formatMoney(renewal.unreserved, format)} not covered`,
    );
  }
  return parts.join(' · ');
}

export const RENEWALS_HEADER = '🔔 Renewals';
export const RENEWALS_CONTINUED_HEADER = '🔔 Renewals (continued)';

/** One message of a reminder, and the renewals it tells about. */
export interface RenewalMessage {
  text: string;
  renewals: UpcomingRenewalDto[];
}

/**
 * The reminder for `renewals` (in the order given): the header and one line each. When they do not
 * fit in one message (more than `limit` characters, which only a long list reaches), they are split
 * in order into messages that each fit, the later ones headed "🔔 Renewals (continued)". Each
 * message names the renewals it contains, so a caller can log exactly those once Telegram accepted
 * it. No renewal is dropped.
 */
export function renewalMessages(
  renewals: readonly UpcomingRenewalDto[],
  format: MessageFormat,
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): RenewalMessage[] {
  const headerOf = (index: number) => (index === 0 ? RENEWALS_HEADER : RENEWALS_CONTINUED_HEADER);
  const chunks: { lines: string[]; renewals: UpcomingRenewalDto[] }[] = [];
  let length = 0;
  for (const renewal of renewals) {
    const line = renewalLine(renewal, format);
    let chunk = chunks[chunks.length - 1];
    if (!chunk || length + 1 + line.length > limit) {
      chunk = { lines: [], renewals: [] };
      chunks.push(chunk);
      length = headerOf(chunks.length - 1).length;
    }
    chunk.lines.push(line);
    chunk.renewals.push(renewal);
    length += 1 + line.length;
  }
  return chunks.map((chunk, index) => ({
    text: [headerOf(index), ...chunk.lines].join('\n'),
    renewals: chunk.renewals,
  }));
}

// --- Monthly recap ----------------------------------------------------------------------------

/**
 * The month's entry in `getSavings().outstanding`, which says what is still to be settled: the part
 * of `OutstandingMonthDto` that the recap prints.
 */
export type OutstandingEntry = Pick<
  OutstandingMonthDto,
  'settled' | 'outstanding' | 'direction' | 'adjustment'
>;

/** What `recapMessage` needs besides the month view of the month that closed. */
export interface RecapInput {
  /** `getMonthView(M − 1)`. */
  view: MonthView;
  /** M, the month that began: the one the leftovers are carried into. */
  nextMonth: MonthKey;
  /**
   * The entry of `getSavings().outstanding` for `view.month`, or undefined when the month has none
   * (it is settled exactly, or it moves nothing).
   */
  outstanding: OutstandingEntry | undefined;
  format: MessageFormat;
  /** `APP_URL`: without it there is no button. */
  appUrl: string | undefined;
}

/**
 * The marker after the savings figure (docs/DOMAIN.md, "Monthly recap"), the first of these that
 * holds. `due` is `savingsDue.total`.
 *
 * - The month has an entry in the inbox and it is not an adjustment (`adjustment` is false: no
 *   settlement was made): " · not settled yet".
 * - The month has an entry that is an adjustment (`adjustment` is true, as the savings inbox
 *   decides when it shows a "Correction"): it was settled before and a later edit moved what it is
 *   due, so what is outstanding is a correction. It says what was settled, in words and unsigned,
 *   and what is still to do, as the inbox words it:
 *     " · €600.00 already moved to savings, take €30.00 more from savings"
 *     " · €200.00 already taken from savings, move €50.00 more to savings"
 *   A month whose settlements cancel out (`settled` is 0 but `adjustment` is true) says
 *   " · settled before, move €30.00 more to savings".
 * - No entry and `due` is not 0: " · settled".
 * - Otherwise nothing.
 */
export function savingsMarker(
  due: number,
  entry: OutstandingEntry | undefined,
  format: MessageFormat,
): string {
  if (!entry) return due === 0 ? '' : ' · settled';
  if (!entry.adjustment) return ' · not settled yet';

  const amount = formatMoney(Math.abs(entry.outstanding), format);
  const correction =
    entry.direction === 'move'
      ? `move ${amount} more to savings`
      : `take ${amount} more from savings`;
  if (entry.settled === 0) return ` · settled before, ${correction}`;
  const already =
    entry.settled > 0
      ? `${formatMoney(entry.settled, format)} already moved to savings`
      : `${formatMoney(-entry.settled, format)} already taken from savings`;
  return ` · ${already}, ${correction}`;
}

/**
 * The recap of the month that closed:
 *
 *     📅 September 2026 is closed
 *     Spent €1,820.00 · €280.00 left over
 *     🔴 Over: Eating out by €42.00, Fuel by €12.40
 *     ↪ Carried into October: €180.00
 *     💰 Due to savings: €630.00 · not settled yet        (button: Open savings)
 *
 * After an adjustment (September was settled for 600.00, then a forgotten 30.00 spending was added)
 * the last line reads:
 *
 *     💰 Due to savings: €570.00 · €600.00 already moved to savings, take €30.00 more from savings
 *
 * - "Spent" and "left over" are `totals.spent` and `totals.remaining`. When the second is negative
 *   (the month was overspent as a whole) it reads "€40.00 over" instead.
 * - "Over" lists the lines with `alert = over` by `-remaining`, in the view's order, and is left
 *   out when no budget is over. When the list is too long for one message it is cut and ends with
 *   "and N more".
 * - "Carried" is the sum of `carriedOut` over the lines.
 * - "Due" is `savingsDue.total`: "Due to savings" when it is not negative, "To take from savings"
 *   (its absolute value) when it is. The marker is `savingsMarker`, which uses the month's entry of
 *   `getSavings().outstanding` (`settled`, `outstanding`, `direction`, `adjustment`).
 * - The button "Open savings" (a link to `APP_URL/savings`) only exists with `appUrl`.
 */
export function recapMessage({ view, nextMonth, outstanding, format, appUrl }: RecapInput): {
  text: string;
  extra: TelegramSendExtra | undefined;
} {
  const { totals, savingsDue } = view;
  const money = (cents: number) => formatMoney(cents, format);

  const left =
    totals.remaining < 0
      ? `${money(-totals.remaining)} over`
      : `${money(totals.remaining)} left over`;
  const carried = sumCents(view.budgets.map((budget) => budget.carriedOut));
  const due = savingsDue.total;
  const dueLabel = due < 0 ? 'To take from savings' : 'Due to savings';

  const before = [
    `📅 ${formatMonth(view.month, format, true)} is closed`,
    `Spent ${money(totals.spent)} · ${left}`,
  ];
  const after = [
    `↪ Carried into ${formatMonth(nextMonth, format)}: ${money(carried)}`,
    `💰 ${dueLabel}: ${money(Math.abs(due))}${savingsMarker(due, outstanding, format)}`,
  ];
  const over = view.budgets
    .filter((budget) => budget.alert === 'over')
    .map((budget) => `${escapeHtml(budget.name)} by ${money(-budget.remaining)}`);

  const fixedLength = [...before, ...after].join('\n').length + 1; // + the newline of the Over line
  const lines = [...before];
  if (over.length > 0) lines.push(overLine(over, TELEGRAM_MESSAGE_LIMIT - fixedLength));
  lines.push(...after);

  const extra: TelegramSendExtra | undefined = appUrl
    ? { reply_markup: { inline_keyboard: [[{ text: 'Open savings', url: `${appUrl}/savings` }]] } }
    : undefined;
  return { text: lines.join('\n'), extra };
}

/** "🔴 Over: a by €1.00, b by €2.00", shortened with "and N more" to fit in `room` characters. */
function overLine(items: readonly string[], room: number): string {
  const full = `🔴 Over: ${items.join(', ')}`;
  if (full.length <= room) return full;
  for (let shown = items.length - 1; shown >= 1; shown--) {
    const line = `🔴 Over: ${items.slice(0, shown).join(', ')} and ${items.length - shown} more`;
    if (line.length <= room) return line;
  }
  return `🔴 Over: ${items.length} budgets`;
}
