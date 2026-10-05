/**
 * The notifications: budget alerts, renewal reminders and the monthly recap, and their dedupe log
 * (docs/DOMAIN.md, "Notifications" and the sections after it). OWNED BY T3. Every figure in a message
 * is a field of a read model (`getMonthView`, `listUpcomingRenewals`, `getSavings`), built by
 * `telegram.notification-messages.ts`: nothing here computes money.
 *
 * - `recordAlertBaseline(deps)`: called when an account is linked and when `budgetAlerts` is
 *   switched on. Records the current alert level of every budget of the current month as notified,
 *   sending nothing. A plain function over the database, so it works with the bot off, and inside
 *   the transaction of the settings save (`deps.db` may be a `tx`).
 * - `TelegramNotify`, built by `createTelegramNotify` and held by `TelegramContext.notify` and
 *   `TelegramHandle.notify`: what the bot's own writes call (`markNotified`, then
 *   `scheduleBudgetAlertCheck`) and what the `/api` write hook (`budgetAlertWriteHook`, mounted in
 *   `app.ts`) and the scheduler call.
 * - `sendRenewalReminders` and `sendMonthlyRecap`: one pass each, called by the scheduler's tick.
 *
 * THE DEDUPE LOG (`telegram_notifications`, unique by kind and key) has one rule: a row is written
 * only AFTER Telegram accepted the message, so a failed send is tried again at the next pass and a
 * sent one is never repeated. Two exceptions send nothing and write at once: the baseline, and
 * `markNotified` (the bot's own confirmation already showed the level, so there is nothing to send).
 * The one gap is a stop between Telegram's acceptance and the row, which can send that message twice.
 *
 *   budget_alert  `<month>:<budgetId>`             value: the highest level notified (ok < warning < over)
 *   renewal       `<subscriptionId>:<billingDate>` no value
 *   recap         `<month recapped>`               no value
 *
 * A pass sends nothing unless the bot is `running` and an account is linked, and stops at the first
 * message Telegram does not accept (the rest waits for the next pass). It never throws: a failure is
 * logged through `options.log`, which redacts the token.
 */
import {
  type BudgetAlert,
  type MonthBudgetLine,
  type MonthKey,
  addMonths,
  parseMonthKey,
} from '@wallet/shared';
import { and, eq, inArray, like } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Db, DbOrTx } from '../../db/client';
import { telegramNotifications } from '../../db/schema';
import type { Clock } from '../../lib/clock';
import { type Deps, inTransaction } from '../../lib/deps';
import { currentMonthOf, timestampOf } from '../../lib/today';
import { getMonthView } from '../months/months.service';
import { getSavings } from '../savings/savings.service';
import { findSettings } from '../settings/settings.service';
import { listUpcomingRenewals } from '../subscriptions/subscriptions.upcoming.service';
import { findLink } from './telegram.access';
import { budgetAlertText, recapMessage, renewalMessages } from './telegram.notification-messages';
import { readNotificationPreferences } from './telegram.notification-preferences';
import {
  type TelegramBotConfig,
  type TelegramLog,
  type TelegramRuntimeStatus,
  type TelegramSendExtra,
  TelegramSendError,
} from './telegram.types';

/** The alert check that a write asks for waits this long for more writes before it runs. */
export const ALERT_DEBOUNCE_MS = 2_000;

/** The alert level a message showed for one budget in one month. */
export interface AlertLevelRecord {
  month: MonthKey;
  budgetId: number;
  level: BudgetAlert;
}

export interface TelegramNotify {
  /** `recordAlertBaseline` for this bot's database and clock. */
  recordBaseline(): void;
  /**
   * The bot's own confirmation showed `record.level` for that budget, so the alert for it must not
   * be sent again (docs/DOMAIN.md, "No duplicates"). Writes the row at once, because nothing is
   * sent: the confirmation was the message. Never lowers a level already recorded, and never
   * throws (a failure is logged). Call it after the write and before awaiting the confirmation, so
   * that a check which starts in between does not announce what the confirmation is about to show.
   */
  markNotified(record: AlertLevelRecord): void;
  /**
   * Runs the alert check now: one message per budget that rose. Never rejects. One check runs at a
   * time: a call that finds one running makes it run once more when it ends (the new write may have
   * raised another budget) and resolves when that is done.
   */
  checkBudgetAlerts(): Promise<void>;
  /**
   * Asks for a check soon: it runs `ALERT_DEBOUNCE_MS` after the LAST call, so a burst of writes is
   * one check. What the `/api` write hook and the bot's writes call.
   */
  scheduleBudgetAlertCheck(): void;
  /** Drops a pending debounced check and refuses new ones. Called at shutdown. */
  stop(): void;
  /**
   * Resolves when no check is running, so that the database can be closed. Optional: the fakes of
   * the tests have none.
   */
  whenIdle?(): Promise<void>;
}

/** What the `/api` write hook needs of `TelegramNotify`. */
export type AlertChecker = Pick<TelegramNotify, 'checkBudgetAlerts' | 'scheduleBudgetAlertCheck'>;

export interface TelegramNotifyOptions {
  db: Db;
  clock: Clock;
  /** `appUrl`, for the "Open" links. */
  config: TelegramBotConfig;
  /** The connection state: nothing is sent while the bot is not `running`. */
  status(): TelegramRuntimeStatus;
  sendToLinked(text: string, extra?: TelegramSendExtra): Promise<void>;
  log: TelegramLog;
  /** Tests: another debounce than `ALERT_DEBOUNCE_MS`. */
  debounceMs?: number;
}

// --- The dedupe log ---------------------------------------------------------------------------

type Kind = (typeof telegramNotifications.$inferSelect)['kind'];

/** The keys of `kind` that are in the log, with their values. */
function loggedKeys(db: DbOrTx, kind: Kind, keys: readonly string[]): Map<string, string | null> {
  if (keys.length === 0) return new Map();
  const rows = db
    .select({ key: telegramNotifications.key, value: telegramNotifications.value })
    .from(telegramNotifications)
    .where(and(eq(telegramNotifications.kind, kind), inArray(telegramNotifications.key, [...keys])))
    .all();
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** Logs a notification that needs no value (a renewal, a recap). Writing a key twice changes nothing. */
function writeLog(db: DbOrTx, clock: Clock, kind: Kind, key: string): void {
  db.insert(telegramNotifications)
    .values({ kind, key, value: null, sentAt: timestampOf(clock) })
    .onConflictDoNothing()
    .run();
}

// --- Budget alerts: the levels ----------------------------------------------------------------

const LEVEL_RANK: Record<BudgetAlert, number> = { ok: 0, warning: 1, over: 2 };

const levelOf = (value: string | null | undefined): BudgetAlert =>
  value === 'warning' || value === 'over' ? value : 'ok';

const alertKey = (month: MonthKey, budgetId: number): string => `${month}:${budgetId}`;

/** The highest level notified so far this month, by budget. A budget with no row is `ok`. */
function recordedLevels(db: DbOrTx, month: MonthKey): Map<number, BudgetAlert> {
  const rows = db
    .select({ key: telegramNotifications.key, value: telegramNotifications.value })
    .from(telegramNotifications)
    .where(
      and(
        eq(telegramNotifications.kind, 'budget_alert'),
        like(telegramNotifications.key, `${month}:%`),
      ),
    )
    .all();
  return new Map(rows.map((row) => [Number(row.key.slice(month.length + 1)), levelOf(row.value)]));
}

/**
 * Records that `level` was notified for a budget in a month. A level never goes down: a row that
 * already holds the same or a higher level stays as it is, so a refund and a rise again never
 * announce anything twice.
 */
function raiseLevel(
  db: DbOrTx,
  clock: Clock,
  month: MonthKey,
  budgetId: number,
  level: BudgetAlert,
): void {
  const key = alertKey(month, budgetId);
  const where = and(
    eq(telegramNotifications.kind, 'budget_alert'),
    eq(telegramNotifications.key, key),
  );
  const row = db.select().from(telegramNotifications).where(where).get();
  if (!row) {
    db.insert(telegramNotifications)
      .values({ kind: 'budget_alert', key, value: level, sentAt: timestampOf(clock) })
      .run();
  } else if (LEVEL_RANK[level] > LEVEL_RANK[levelOf(row.value)]) {
    db.update(telegramNotifications)
      .set({ value: level, sentAt: timestampOf(clock) })
      .where(where)
      .run();
  }
}

/**
 * The budget lines of the current month and the settings that format them, or null when there is
 * nothing to watch: not onboarded, or the current month is before `startMonth` (no figures).
 */
function currentBudgetLines(deps: Deps): {
  month: MonthKey;
  lines: MonthBudgetLine[];
  format: { currency: string; locale: string };
} | null {
  const settings = findSettings(deps.db);
  if (!settings) return null;
  const month = currentMonthOf(deps.clock);
  if (month < settings.startMonth) return null;
  return { month, lines: getMonthView(deps, month).budgets, format: settings };
}

/**
 * Records the current alert level of every budget of the current month as notified, sending
 * nothing (docs/DOMAIN.md, "Baseline"): linking and switching alerts on call it, so that the first
 * check afterwards does not announce what was already over. Synchronous, and one transaction. Does
 * nothing before onboarding.
 */
export function recordAlertBaseline(deps: Deps): void {
  const current = currentBudgetLines(deps);
  if (!current) return;
  inTransaction(deps, ({ db, clock }) => {
    for (const line of current.lines) raiseLevel(db, clock, current.month, line.id, line.alert);
  });
}

/** Records that `record.level` was announced (or shown by the bot's confirmation). Never lowers. */
export function markAlertNotified(deps: Deps, record: AlertLevelRecord): void {
  raiseLevel(deps.db, deps.clock, record.month, record.budgetId, record.level);
}

// --- Sending ----------------------------------------------------------------------------------

/** Nothing is sent while the bot is not `running` or while no account is linked. */
function canSend({ db, status }: Pick<TelegramNotifyOptions, 'db' | 'status'>): boolean {
  return status().connection === 'running' && findLink(db) !== null;
}

/** What `deliver` did: Telegram accepted the message, or it did not (and, when it said so, why). */
type Delivery = { sent: true } | { sent: false; telegramCode: number | undefined };

/**
 * What failed when a message did not go out: the `error_code` that Telegram answered with
 * (`TelegramSendError.telegramCode`: 400 for a message it refuses, 403 for a blocked bot, 429 for a
 * flood, 5xx for its own trouble), or undefined for a failure with no answer (a network error, a
 * timeout), where nobody knows whether the message went out, and for an error that is not a
 * `TelegramSendError` at all.
 */
function telegramCodeOf(error: unknown): number | undefined {
  return error instanceof TelegramSendError ? error.telegramCode : undefined;
}

/**
 * Sends one message to the linked chat. A refusal is logged and is not an error: the caller then
 * leaves its dedupe row unwritten, so the next pass tries again.
 */
async function deliver(
  { sendToLinked, log }: Pick<TelegramNotifyOptions, 'sendToLinked' | 'log'>,
  what: string,
  text: string,
  extra?: TelegramSendExtra,
): Promise<Delivery> {
  try {
    await sendToLinked(text, extra);
    return { sent: true };
  } catch (error) {
    log.error(`could not send ${what}, it is tried again at the next pass`, error);
    return { sent: false, telegramCode: telegramCodeOf(error) };
  }
}

// --- Budget alerts: the check -----------------------------------------------------------------

/**
 * A budget whose alert has no event of the current month behind it: no spending dated in the month
 * (`spent` is 0, net of refunds) and no transfer (`transfersNet` is 0). Its level then comes from
 * what the budget carried in from the month before (an incremental budget that began the month in
 * deficit), so the turn of the month is all there is to announce.
 *
 * The test is on these two fields and nothing else, so it cannot tell a carry-in from an edit of
 * what the budget has (an allocation or mode changed for the month, a late spending added to the
 * month before): those are held to the notify time as well, delayed and never lost. A carried-in
 * `warning` cannot happen (a warning needs something spent: `warnPercent` is at least 1), so this is
 * in practice a budget that is `over`.
 */
export function isCarriedIn(line: Pick<MonthBudgetLine, 'spent' | 'transfersNet'>): boolean {
  return line.spent === 0 && line.transfersNet === 0;
}

/**
 * One alert check. When alerts are on, the bot runs and an account is linked, it sends one message
 * for every budget of the current month whose level is higher than the highest notified (no row
 * counts as `ok`), and writes the row after Telegram accepted each. It stops at the first message
 * that is not accepted.
 *
 * A budget whose alert is only what it carried in (`isCarriedIn`) is announced at the first check at
 * or after the notify time, not at the turn of the month, so that the phone does not buzz at 00:01.
 * It is only skipped (no row is written), so nothing is lost: the first check at or after the notify
 * time, a restart included, announces it. A spending, a refund or a transfer dated in the month
 * gives the alert a cause, and it is announced at once.
 */
async function checkAlerts(options: TelegramNotifyOptions): Promise<void> {
  const { db, clock } = options;
  const prefs = readNotificationPreferences(db);
  if (!prefs.budgetAlerts) return;
  if (!canSend(options)) return;
  const current = currentBudgetLines(options);
  if (!current) return;

  const recorded = recordedLevels(db, current.month);
  const beforeNotifyTime = timeOfDayOf(clock) < prefs.notifyAt;
  const rose = current.lines.filter(
    (line) =>
      LEVEL_RANK[line.alert] > LEVEL_RANK[recorded.get(line.id) ?? 'ok'] &&
      !(beforeNotifyTime && isCarriedIn(line)),
  );
  for (const line of rose) {
    const text = budgetAlertText(line, current.format);
    if (!(await deliver(options, `the alert of budget ${line.id}`, text)).sent) return;
    raiseLevel(db, clock, current.month, line.id, line.alert);
  }
}

/**
 * The alert watcher of one bot: `recordBaseline`, `markNotified`, the check with its one-at-a-time
 * rule and the debounce.
 */
export function createTelegramNotify(options: TelegramNotifyOptions): TelegramNotify {
  const debounceMs = options.debounceMs ?? ALERT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const pass = async (): Promise<void> => {
    try {
      await checkAlerts(options);
    } catch (error) {
      options.log.error('the budget alert check failed', error);
    }
  };

  const checkBudgetAlerts = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true; // what this caller wrote may not be in the pass that is running
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    recordBaseline: () => recordAlertBaseline(options),
    markNotified: (record) => {
      try {
        markAlertNotified(options, record);
      } catch (error) {
        options.log.error('could not record an alert level', error);
      }
    },
    checkBudgetAlerts,
    scheduleBudgetAlertCheck: () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void checkBudgetAlerts();
      }, debounceMs);
      timer.unref?.(); // a pending check never keeps the process alive
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    whenIdle: async () => {
      await running;
    },
  };
}

// --- Budget alerts: the `/api` write hook -----------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The hook that mounts at the start of the `/api` router in `app.ts`: after every successful write
 * (`POST`, `PUT`, `PATCH` or `DELETE` answered below 400) it asks for an alert check, which is
 * debounced, so a CSV import commit is one check. Requests to `/api/telegram` itself are left out:
 * they change the bot, not a figure. It never fails a request: the check runs on a timer, and an
 * exception while asking is swallowed.
 */
export function budgetAlertWriteHook(
  notify: Pick<AlertChecker, 'scheduleBudgetAlertCheck'>,
): RequestHandler {
  return (req, res, next) => {
    // `req.path` is relative to where the `/api` router is mounted.
    const ownRoute = req.path === '/telegram' || req.path.startsWith('/telegram/');
    if (WRITE_METHODS.has(req.method) && !ownRoute) {
      res.once('finish', () => {
        if (res.statusCode >= 400) return;
        try {
          notify.scheduleBudgetAlertCheck();
        } catch {
          // An alert that cannot be asked for is not worth an uncaught exception.
        }
      });
    }
    next();
  };
}

// --- Renewal reminders ------------------------------------------------------------------------

/** The server's local time of day as `HH:MM`, read from the clock like `todayOf` reads the date. */
export function timeOfDayOf(clock: Clock): string {
  const now = clock.now();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * One pass of the renewal reminders (docs/DOMAIN.md, "Renewal reminders"). From the notify time on,
 * it reminds, in one message, about every renewal that is within its lead (yearly or monthly days,
 * 0 is off) and has no row `(renewal, '<subscriptionId>:<billingDate>')` yet, then writes the rows
 * once Telegram accepted it. There is no "ran today" mark: a pass that finds nothing new does
 * nothing, and a missed day is made up at the next pass while the billing date has not passed
 * (`listUpcomingRenewals` starts at today). A list too long for one message is sent as several.
 */
export async function sendRenewalReminders(options: TelegramNotifyOptions): Promise<void> {
  const { db, clock } = options;
  const prefs = readNotificationPreferences(db);
  const horizon = Math.max(prefs.renewalYearlyDays, prefs.renewalMonthlyDays);
  if (horizon === 0) return;
  if (timeOfDayOf(clock) < prefs.notifyAt) return;
  if (!canSend(options)) return;
  const settings = findSettings(db);
  if (!settings) return;

  const leadOf = (yearly: boolean) => (yearly ? prefs.renewalYearlyDays : prefs.renewalMonthlyDays);
  const keyOf = (renewal: { id: number; date: string }) => `${renewal.id}:${renewal.date}`;
  const near = listUpcomingRenewals(options, { days: horizon }).filter(
    (renewal) => leadOf(renewal.yearly) > 0 && renewal.daysUntil <= leadOf(renewal.yearly),
  );
  const done = loggedKeys(db, 'renewal', near.map(keyOf));
  const due = near.filter((renewal) => !done.has(keyOf(renewal)));

  for (const message of renewalMessages(due, settings)) {
    if (!(await deliver(options, 'a renewal reminder', message.text)).sent) return;
    inTransaction(options, (tx) => {
      for (const renewal of message.renewals) writeLog(tx.db, tx.clock, 'renewal', keyOf(renewal));
    });
  }
}

// --- Monthly recap ----------------------------------------------------------------------------

/** The first instant of `month` in the server's local time zone, as a timestamp. */
function startOfMonth(month: MonthKey): number {
  const { year, month: monthOfYear } = parseMonthKey(month);
  return new Date(year, monthOfYear - 1, 1).getTime();
}

/**
 * One pass of the monthly recap (docs/DOMAIN.md, "Monthly recap"). From the notify time on any day
 * of the month M, it sends the recap of M − 1 once (its row is keyed by the month recapped), when
 * the preference is on, the account was linked before M began and M − 1 is not before `startMonth`.
 * "Open savings" is a button that only exists with `APP_URL`. If Telegram answers 400 to the message
 * with it (a link it does not accept), the recap is sent once more without the button, so that it is
 * never lost over a link. Any other failure (a timeout, a 5xx) waits for the next pass with no
 * second attempt, because the first message may have gone out and a recap must not arrive twice.
 */
export async function sendMonthlyRecap(options: TelegramNotifyOptions): Promise<void> {
  const { db, clock, config } = options;
  const prefs = readNotificationPreferences(db);
  if (!prefs.monthlyRecap) return;
  if (timeOfDayOf(clock) < prefs.notifyAt) return;
  if (!canSend(options)) return;
  const settings = findSettings(db);
  const link = findLink(db);
  if (!settings || !link) return;

  const current = currentMonthOf(clock);
  const recapped = addMonths(current, -1);
  if (recapped < settings.startMonth) return;
  if (!(Date.parse(link.linkedAt) < startOfMonth(current))) return;
  if (loggedKeys(db, 'recap', [recapped]).size > 0) return;

  const outstanding = getSavings(options).outstanding.find((entry) => entry.month === recapped);
  const { text, extra } = recapMessage({
    view: getMonthView(options, recapped),
    nextMonth: current,
    outstanding,
    format: settings,
    appUrl: config.appUrl,
  });
  let delivery = await deliver(options, 'the monthly recap', text, extra);
  // Only an answer of Telegram, a 400, says that it is the message itself that was refused (a link in
  // the button that it does not accept). Anything else (a timeout, a 5xx, a flood limit) may have
  // gone out or may go out at the next pass: waiting is the only way never to send it twice.
  if (!delivery.sent && extra && delivery.telegramCode === 400) {
    options.log.info('Telegram refused the monthly recap with its button, sending it without');
    delivery = await deliver(options, 'the monthly recap without its button', text);
  }
  if (delivery.sent) writeLog(db, clock, 'recap', recapped);
}
