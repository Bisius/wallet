/**
 * The types the files of the Telegram module share. Owned by T1 (the platform): T2 and T3 import
 * from here and do not edit it, so that they never collide. See the header of `telegram.runtime.ts`
 * for who owns what.
 */
import type { TelegramBotDto, TelegramConnectionState, TelegramProblem } from '@wallet/shared';
import type { Api, Bot, Context } from 'grammy';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import type { Clock } from '../../lib/clock';
import type { TelegramNotify } from './telegram.notifications';

/** The grammY bot. Handlers get a plain grammY `Context` (`ctx`). */
export type TelegramBot = Bot<Context>;

/** The options of `sendMessage` after the text: `reply_markup`, `parse_mode`, ... */
export type TelegramSendExtra = NonNullable<Parameters<Api['sendMessage']>[2]>;

/**
 * Where the bot writes its log. Every message and every error goes through `redact()` first, because
 * the URLs of the Bot API contain the token (docs/DOMAIN.md, "Security and privacy"). Never log
 * with `console` directly in this module.
 */
export interface TelegramLog {
  info(message: string): void;
  /** `error` is anything that was thrown: it is described and redacted, never passed on as an object. */
  error(message: string, error?: unknown): void;
}

/** What the handlers may know of the configuration. The token is deliberately not in it. */
export type TelegramBotConfig = Pick<Config, 'appUrl'>;

/**
 * What every handler of the bot gets (`registerCommands(bot, tg)`, `registerFlows(bot, tg)`).
 * It is also a `Deps` (`db`, `clock`), so `createSpending(tg, input)` and the other services take it
 * as it is. `tg` is the name used for it, because `ctx` is grammY's.
 */
export interface TelegramContext {
  db: Db;
  /** The only source of "now" (docs/DOMAIN.md: the time of a Telegram message is never used). */
  clock: Clock;
  config: TelegramBotConfig;
  /** The alert watcher (T3's): the bot's own writes tell it what the confirmation showed. */
  notify: TelegramNotify;
  /** Sends to the linked chat; resolves when Telegram accepted it, rejects with `TelegramSendError`. */
  sendToLinked(text: string, extra?: TelegramSendExtra): Promise<void>;
  log: TelegramLog;
}

/** What the routes cannot read from the database: the state of the connection to Telegram. */
export interface TelegramRuntimeStatus {
  connection: TelegramConnectionState;
  /** Why `connection` is `error`; null otherwise. */
  problem: TelegramProblem | null;
  /** From `getMe`, once connected. */
  bot: TelegramBotDto | null;
}

/**
 * What `createApp({ telegram })` takes, and what the scheduler uses. The real one is
 * `createTelegramRuntime`; tests pass `fakeTelegram` (`src/testing/fake-telegram.ts`). The link and
 * the pairing code live in the database (`telegram.access.ts`), not here.
 */
export interface TelegramHandle {
  status(): TelegramRuntimeStatus;
  /**
   * Sends one message and resolves once Telegram accepted it. Rejects with a `TelegramSendError`
   * (never with the raw error, which can hold the token) when the poll is not `running` or Telegram
   * refused. Text is HTML: escape names and notes with `escapeHtml`.
   */
  sendMessage(chatId: number, text: string, extra?: TelegramSendExtra): Promise<void>;
  /** `sendMessage` to the linked chat; rejects with reason `not_linked` when there is none. */
  sendToLinked(text: string, extra?: TelegramSendExtra): Promise<void>;
  readonly notify: TelegramNotify;
  readonly log: TelegramLog;
  /** Stops polling and waits for the update in progress. Never rejects. Call before closing the database. */
  stop(): Promise<void>;
}

/** What `index.ts` holds: a handle that also starts (after `listen`). */
export interface TelegramRuntime extends TelegramHandle {
  /** Starts connecting and polling in the background. It never throws and does nothing twice. */
  start(): void;
}

export type TelegramSendFailure = 'not_running' | 'not_linked' | 'refused';

/**
 * A message that did not go out. Its message is safe to log and to show: it was redacted, and the
 * original error is deliberately not kept as `cause`.
 */
export class TelegramSendError extends Error {
  override readonly name = 'TelegramSendError';
  constructor(
    readonly reason: TelegramSendFailure,
    message: string,
    /** Telegram's `error_code` when it answered with an error; undefined when there was no answer. */
    readonly telegramCode?: number,
  ) {
    super(message);
  }
}
