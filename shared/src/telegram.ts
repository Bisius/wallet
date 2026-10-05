import { z } from 'zod';

// The Telegram bot (docs/DOMAIN.md, "Telegram bot"; the plan is docs/TELEGRAM-PLAN.md). This file is
// the contract of its SETTINGS side: how Settings reads the state of the bot, links one Telegram
// account with a one-time code, sets the notification preferences and sends a test message. The bot
// itself talks to Telegram and not to a client of this API, and it adds no money rule: it writes
// through the spending and income services and prints fields of the month view, the upcoming
// renewals and the savings read model.
//
// THE ENDPOINTS (all under `requireOnboarded`: 409 `not_onboarded` until the settings exist; none
// of them ever returns or logs the bot token, which only the server's environment holds):
//
//     GET    /api/telegram                200  TelegramStatusDto
//     POST   /api/telegram/pairing        201  TelegramPairingDto
//                                              (no body; 409 telegram_not_configured)
//     DELETE /api/telegram/pairing        204  (also when no code is pending)
//     DELETE /api/telegram/link           204  (404 not_found when nothing is linked)
//     PUT    /api/telegram/notifications  200  TelegramNotificationSettingsDto
//                                              (body: telegramNotificationSettingsInputSchema)
//     POST   /api/telegram/test           204  (no body; 409 telegram_not_configured,
//                                              409 telegram_not_linked, 503 telegram_unavailable)
//
// WHEN THE BOT IS OFF. Without `TELEGRAM_BOT_TOKEN` (unset or empty) the bot is off and nothing
// else in Wallet changes: `GET` still answers (`configured: false`, `connection: 'off'`), the
// preferences can still be saved, and only the endpoints that need a bot answer 409
// `telegram_not_configured`.
//
// TIMESTAMPS are ISO-8601 UTC instants from the server clock (`2026-10-05T10:10:00.000Z`), like
// `BackupDto.createdAt`. A time of day (`notifyAt`) is in the server's time zone (`TZ`).

// --- Constants --------------------------------------------------------------------------------

/**
 * How many days before a renewal its reminder is sent: a whole number from 0 (the reminder is off)
 * to 30. `renewalYearlyDays` and `renewalMonthlyDays` take it.
 */
export const TELEGRAM_RENEWAL_DAYS_MIN = 0;
export const TELEGRAM_RENEWAL_DAYS_MAX = 30;

/** `TelegramStatusDto.connection`. */
export const TELEGRAM_CONNECTION_STATES = ['off', 'connecting', 'running', 'error'] as const;
export type TelegramConnectionState = (typeof TELEGRAM_CONNECTION_STATES)[number];

/** `TelegramStatusDto.problem`: why the connection is in the `error` state. */
export const TELEGRAM_PROBLEMS = ['invalid_token', 'conflict', 'unreachable', 'blocked'] as const;
export type TelegramProblem = (typeof TELEGRAM_PROBLEMS)[number];

/**
 * A time of day, strictly `HH:MM` on a 24-hour clock: two digits for the hour (`00` to `23`), a
 * colon and two digits for the minute (`00` to `59`). `09:00` and `23:59` match; `9:00`, `24:00`,
 * `09:60`, `09:00:00`, `9:00 PM`, a value with spaces or a line break around it, and digits that
 * are not ASCII do not.
 */
export const TELEGRAM_NOTIFY_AT_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

// --- Notification preferences -----------------------------------------------------------------

/** A reminder lead in days: an integer from 0 (off) to 30 (`TELEGRAM_RENEWAL_DAYS_MAX`). */
export const telegramRenewalDaysSchema = z
  .number()
  .int()
  .min(TELEGRAM_RENEWAL_DAYS_MIN)
  .max(TELEGRAM_RENEWAL_DAYS_MAX);

/**
 * The time of day, in the server's time zone, from which the renewal reminders and the monthly
 * recap are sent. Strictly `HH:MM` (see `TELEGRAM_NOTIFY_AT_PATTERN`): it is not trimmed or
 * rewritten, so `9:00` is a 400 and not `09:00`.
 */
export const telegramNotifyAtSchema = z
  .string()
  .regex(TELEGRAM_NOTIFY_AT_PATTERN, 'Expected a time of day like 09:00 (24-hour HH:MM)');

/**
 * PUT /api/telegram/notifications body → 200 TelegramNotificationSettingsDto. Replaces all five
 * preferences (like PUT /api/settings, so every field is required); they are kept, and the same
 * ones come back, until the next call. 400 `validation_error` for a field that is missing, of the
 * wrong type or out of range, and for an unknown key. It does not need a linked account or a
 * token: the preferences can be saved while the bot is off, and unlinking keeps them. No 409 or
 * 422 rule applies.
 *
 * Switching `budgetAlerts` on (from off) records the current alert levels as the baseline, without
 * sending anything, so the first check afterwards does not announce budgets that were already
 * over (docs/DOMAIN.md, "Budget alerts").
 */
export const telegramNotificationSettingsInputSchema = z.strictObject({
  /** Send a message when a spending, from any source, takes a budget to a higher alert level. */
  budgetAlerts: z.boolean(),
  /** Remind about a yearly renewal this many days before it. 0 turns it off, at most 30. */
  renewalYearlyDays: telegramRenewalDaysSchema,
  /** Remind about a monthly renewal this many days before it. 0 turns it off, at most 30. */
  renewalMonthlyDays: telegramRenewalDaysSchema,
  /** Send the recap of the month that just closed, on the 1st. */
  monthlyRecap: z.boolean(),
  /** `HH:MM`, 24-hour, server time zone: when reminders and the recap go out. */
  notifyAt: telegramNotifyAtSchema,
});
export type TelegramNotificationSettingsInput = z.infer<
  typeof telegramNotificationSettingsInputSchema
>;

/**
 * The notification preferences, as `TelegramStatusDto.notifications` and as the response of PUT
 * /api/telegram/notifications (200). They exist from the start with `DEFAULT_TELEGRAM_NOTIFICATIONS`
 * (a database that never saved them answers with the defaults), and they belong to the install,
 * not to the link: unlinking keeps them.
 */
export interface TelegramNotificationSettingsDto {
  budgetAlerts: boolean;
  /** Days before a yearly renewal, 0 (off) to 30. */
  renewalYearlyDays: number;
  /** Days before a monthly renewal, 0 (off) to 30. */
  renewalMonthlyDays: number;
  monthlyRecap: boolean;
  /** `HH:MM`, 24-hour, in the server's time zone. */
  notifyAt: string;
}

/**
 * The preferences a new install starts with: budget alerts on, yearly renewals 7 days before,
 * monthly renewals 1 day before, the monthly recap on, everything at `09:00`. The backend creates
 * its row with these values and the UI offers them, so both agree. Frozen, so a caller cannot change
 * the defaults of the whole process by mistake: copy it (`{ ...DEFAULT_TELEGRAM_NOTIFICATIONS }`).
 */
export const DEFAULT_TELEGRAM_NOTIFICATIONS: Readonly<TelegramNotificationSettingsDto> =
  Object.freeze({
    budgetAlerts: true,
    renewalYearlyDays: 7,
    renewalMonthlyDays: 1,
    monthlyRecap: true,
    notifyAt: '09:00',
  });

// --- Status, pairing and link -----------------------------------------------------------------

/**
 * A one-time pairing code: the response of POST /api/telegram/pairing (201), and
 * `TelegramStatusDto.pairing` while a code is pending. The request has no body. 409
 * `telegram_not_configured` while there is no bot token.
 *
 * The code is 8 characters from an alphabet without the look-alikes `0`, `O`, `1` and `I`, can be
 * used once, and is valid for 10 minutes. A new code replaces a pending one, which stops working.
 * The owner does not have to type it: Settings shows the code and an **Open in Telegram** button
 * (`deepLink`), which sends `/start <code>` to the bot. Once the code is used the account is
 * linked and `TelegramStatusDto.pairing` is null. A pending code is also cancelled after 5 wrong
 * codes.
 *
 * DELETE /api/telegram/pairing → 204 cancels the pending code, and answers 204 as well when none
 * is pending (so a stale Cancel button is harmless).
 */
export interface TelegramPairingDto {
  /** The code to send to the bot as `/start <code>`. */
  code: string;
  /** When it stops being valid: an ISO-8601 UTC instant, 10 minutes after it was created. */
  expiresAt: string;
  /**
   * `https://t.me/<bot username>?start=<code>`, a link that opens the bot with the code filled in,
   * or null until the bot has told its username (`TelegramStatusDto.bot`), which it only does once
   * it is connected.
   */
  deepLink: string | null;
}

/**
 * The linked account: `TelegramStatusDto.link`. There is at most one. It is made by the bot, when
 * `/start <code>` arrives in a private chat with a valid code, and removed by DELETE
 * /api/telegram/link → 204 (404 `not_found` when nothing is linked). The bot then sends a
 * best-effort "This chat is no longer linked to Wallet" to the old chat. Linking another account
 * while one is linked replaces it once the new code is used, and the UI confirms that first.
 */
export interface TelegramLinkDto {
  /** The account's first name, as Telegram gave it. */
  name: string;
  /** The `@username` without the `@`, or null when the account has none. */
  username: string | null;
  /** When it was linked: an ISO-8601 UTC instant. */
  linkedAt: string;
}

/** The bot behind the token: `TelegramStatusDto.bot`. */
export interface TelegramBotDto {
  /** The bot's username without the `@`, as `getMe` reports it. */
  username: string;
}

/**
 * GET /api/telegram → 200 TelegramStatusDto. Everything Settings shows about the bot, in one
 * read. It never contains the token.
 *
 * `connection` is `off` when no token is set (`configured` is false), `connecting` while the bot
 * starts, `running` while it polls Telegram, and `error` when it cannot: `problem` then says why,
 * and it is null in every other state. The `problem`s are
 *
 * - `invalid_token`: Telegram refused the token. The bot stays stopped until the server restarts.
 * - `conflict`: another program polls with the same bot (usually a second Wallet: use one bot per
 *   instance). The bot retries.
 * - `unreachable`: a network error. The bot retries with a growing delay.
 * - `blocked`: the owner blocked the bot, so it cannot write to the chat.
 *
 * POST /api/telegram/test → 204 sends a "Wallet is connected" message to the linked chat and answers
 * once Telegram has accepted it (the request has no body, and the status code is the whole answer).
 * Errors, checked in this order: 409 `telegram_not_configured` (no token), 409 `telegram_not_linked`
 * (no account is linked) and 503 `telegram_unavailable` (the bot is not `running`, or Telegram
 * refused the message).
 */
export interface TelegramStatusDto {
  /** `TELEGRAM_BOT_TOKEN` is set. */
  configured: boolean;
  connection: TelegramConnectionState;
  /** Why `connection` is `error`; null otherwise. */
  problem: TelegramProblem | null;
  /** From `getMe`, once connected; null before. */
  bot: TelegramBotDto | null;
  /** The linked account, or null. */
  link: TelegramLinkDto | null;
  /**
   * The pending pairing code, or null when none is pending. A code that has expired (its
   * `expiresAt` is not in the future of the server clock) counts as not pending.
   */
  pairing: TelegramPairingDto | null;
  /** The notification preferences (the defaults until saved). */
  notifications: TelegramNotificationSettingsDto;
}
