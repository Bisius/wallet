/**
 * The Settings side of the bot (`/api/telegram`, contract in `shared/src/telegram.ts`): the status,
 * the pairing code, the link, the notification preferences and the test message. Plain functions that
 * take `(deps, ...)`. The connection to Telegram comes in through the optional `TelegramHandle`:
 * without one the bot is off.
 */
import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  type TelegramNotificationSettingsDto,
  type TelegramNotificationSettingsInput,
  type TelegramPairingDto,
  type TelegramStatusDto,
} from '@wallet/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { telegramSettings } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { apiError, notFound } from '../../lib/errors';
import {
  cancelPairing,
  createPairing,
  findLink,
  findPairing,
  isPairingLive,
  removeLink,
  toLinkDto,
} from './telegram.access';
import { NO_LONGER_LINKED_TEXT, WALLET_CONNECTED_TEXT } from './telegram.messages';
import { recordAlertBaseline } from './telegram.notifications';
import {
  type TelegramHandle,
  type TelegramRuntimeStatus,
  TelegramSendError,
} from './telegram.types';

export interface TelegramServiceDeps extends Deps {
  /** The running bot, or undefined when there is no token (the bot is off). */
  telegram: TelegramHandle | undefined;
}

const SINGLETON_ID = 1;

const notConfigured = () =>
  apiError(
    'telegram_not_configured',
    'The Telegram bot is off: set TELEGRAM_BOT_TOKEN and restart Wallet',
  );

/** `https://t.me/<bot>?start=<code>`, or null until the bot has told its username. */
const deepLinkOf = (botUsername: string | undefined, code: string): string | null =>
  botUsername === undefined ? null : `https://t.me/${botUsername}?start=${code}`;

// --- Notification preferences -----------------------------------------------------------------

/** The preferences: the saved row, or the defaults while none was saved. */
export function getTelegramNotificationSettings(db: DbOrTx): TelegramNotificationSettingsDto {
  const row = db.select().from(telegramSettings).where(eq(telegramSettings.id, SINGLETON_ID)).get();
  if (!row) return { ...DEFAULT_TELEGRAM_NOTIFICATIONS };
  return {
    budgetAlerts: row.budgetAlerts,
    renewalYearlyDays: row.renewalYearlyDays,
    renewalMonthlyDays: row.renewalMonthlyDays,
    monthlyRecap: row.monthlyRecap,
    notifyAt: row.notifyAt,
  };
}

/**
 * PUT /api/telegram/notifications: replaces the five preferences (the row is created by the first
 * call). Switching `budgetAlerts` on, from off, records the baseline of the alert levels in the same
 * transaction. It needs neither a link nor a token.
 */
export function saveTelegramNotificationSettings(
  deps: Deps,
  input: TelegramNotificationSettingsInput,
): TelegramNotificationSettingsDto {
  return inTransaction(deps, (tx) => {
    const before = getTelegramNotificationSettings(tx.db);
    tx.db
      .insert(telegramSettings)
      .values({ id: SINGLETON_ID, ...input })
      .onConflictDoUpdate({ target: telegramSettings.id, set: input })
      .run();
    if (input.budgetAlerts && !before.budgetAlerts) recordAlertBaseline(tx);
    return getTelegramNotificationSettings(tx.db);
  });
}

// --- Status, pairing, link --------------------------------------------------------------------

const OFF: TelegramRuntimeStatus = { connection: 'off', problem: null, bot: null };

/** GET /api/telegram. */
export function getTelegramStatus({ db, clock, telegram }: TelegramServiceDeps): TelegramStatusDto {
  const runtime = telegram ? telegram.status() : OFF;
  const link = findLink(db);
  const open = findPairing(db);
  const pairing =
    open && isPairingLive({ clock }, open)
      ? {
          code: open.code,
          expiresAt: open.expiresAt,
          deepLink: deepLinkOf(runtime.bot?.username, open.code),
        }
      : null;
  return {
    configured: telegram !== undefined,
    connection: runtime.connection,
    problem: runtime.problem,
    bot: runtime.bot,
    link: link ? toLinkDto(link) : null,
    pairing,
    notifications: getTelegramNotificationSettings(db),
  };
}

/** POST /api/telegram/pairing: a new code, replacing a pending one. 409 without a token. */
export function createTelegramPairing(deps: TelegramServiceDeps): TelegramPairingDto {
  if (!deps.telegram) throw notConfigured();
  const pairing = createPairing(deps);
  return {
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    deepLink: deepLinkOf(deps.telegram.status().bot?.username, pairing.code),
  };
}

/** DELETE /api/telegram/pairing: cancels the pending code; nothing to cancel is fine. */
export function cancelTelegramPairing({ db }: Deps): void {
  cancelPairing(db);
}

/**
 * DELETE /api/telegram/link: removes the link (404 when none), and tells the old chat, best effort:
 * the notice is sent in the background and a failure changes nothing.
 */
export function unlinkTelegram({ db, telegram }: TelegramServiceDeps): void {
  const removed = removeLink(db);
  if (!removed) throw notFound('Telegram link');
  void telegram?.sendMessage(removed.chatId, NO_LONGER_LINKED_TEXT).catch(() => undefined);
}

/**
 * POST /api/telegram/test. In this order: 409 `telegram_not_configured`, 409 `telegram_not_linked`,
 * 503 `telegram_unavailable` when the bot is not running or Telegram refuses. A bot that Telegram
 * says is `blocked` still tries: a message that goes through is how it learns it was unblocked. The
 * messages of the errors are fixed: nothing from Telegram's answer is passed on.
 */
export async function sendTelegramTest({ db, telegram }: TelegramServiceDeps): Promise<void> {
  if (!telegram) throw notConfigured();
  if (!findLink(db)) throw apiError('telegram_not_linked', 'No Telegram account is linked');

  const { connection, problem } = telegram.status();
  if (connection !== 'running' && !(connection === 'error' && problem === 'blocked')) {
    throw apiError('telegram_unavailable', 'The Telegram bot is not running');
  }
  try {
    await telegram.sendToLinked(WALLET_CONNECTED_TEXT);
  } catch (error) {
    if (error instanceof TelegramSendError && error.reason === 'not_linked') {
      throw apiError('telegram_not_linked', 'No Telegram account is linked');
    }
    throw apiError('telegram_unavailable', 'Telegram did not accept the message');
  }
}
