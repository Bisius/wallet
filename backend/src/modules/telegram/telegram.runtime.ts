/**
 * The Telegram bot's runtime: the grammY bot, the connection to Telegram (long polling), its state
 * machine, the token redaction and the shutdown. Docs: docs/DOMAIN.md "Telegram bot", plan in
 * docs/TELEGRAM-PLAN.md.
 *
 * WHO OWNS WHICH FILE (`backend/src/modules/telegram/`; T1 wrote all of them, T2 and T3 then work in
 * parallel on the files they own, so they do not collide):
 *
 *   T1, the platform (done; changes only by agreement)
 *     telegram.runtime.ts        this file: grammY setup, polling, status, backoff, `stop()`
 *     telegram.access.ts         the sender guard, pairing, link, unlink
 *     telegram.types.ts          `TelegramContext`, `TelegramHandle`, `TelegramLog`, `TelegramSendError`
 *     telegram.log.ts            `redact()` and the redacting log
 *     telegram.format.ts         `formatMoney`, `formatDay`, `formatMonth` (shared by T2 and T3)
 *     telegram.service.ts        the six `/api/telegram` endpoints' logic, and the preferences
 *     telegram.routes.ts         the router
 *   T2, recording
 *     telegram.flows.ts          `registerFlows(bot, tg)`: /spending, quick entry, /income, date, Undo
 *     telegram.commands.ts       `registerCommands(bot, tg, flows)`: /status, /recent, /undo (T1 wrote
 *                                /help, /start, /cancel and the fallbacks, which must stay last)
 *     telegram.messages.ts       the texts and keyboards (T1 wrote the help, the greeting, escapeHtml)
 *     telegram.parse.ts          the amount parser (new)
 *   T3, notifications
 *     telegram.notifications.ts  budget alerts, renewals, recap, the dedupe log; `TelegramNotify`
 *     telegram.scheduler.ts      `startTelegramScheduler`, the one-minute tick
 *     the `/api` write hook      in `app.ts`, at the marked place
 *
 * The runtime calls, in this order: the access guard, `registerFlows`, `registerCommands`. Handlers
 * only ever see the linked user in a private chat.
 *
 * TESTS use no network: `src/testing/fake-bot-api.ts` (a fake Bot API as an API transformer, and the
 * builders of message and button updates), `src/testing/telegram-harness.ts` (the bot over an
 * in-memory database, driven with `say()` / `tap()`), and `src/testing/fake-telegram.ts` (a
 * `TelegramHandle` for route tests). Nothing in `createApp` or in a test ever starts a bot.
 *
 * THE CONNECTION. We do our own long-polling loop instead of `bot.start()`, because grammY's retries
 * every 3 seconds and does not tell anyone. The states are `connecting` (until the first answer of
 * Telegram), `running`, and `error` with a problem:
 *
 *   network error, 5xx, 429   `unreachable`  retry with a growing delay, 30 s up to 5 min
 *   409 (another poller)      `conflict`     the same retries
 *   401, or 404 (a token that is not even well formed)
 *                             `invalid_token` stop until the server restarts
 *   403 on a send to the linked chat   `blocked`  (the poll goes on; a send that goes through, or a
 *                                      message from the owner, clears it)
 *
 * The first poll after a start or an error uses `timeout: 0`, so a working connection shows as
 * `running` at once and not after a 30 second wait.
 *
 * THE TOKEN appears in every Bot API URL, so every error that is logged goes through `redact()`
 * (`createTelegramLog`), and no error of grammY ever leaves this module: a failed send becomes a
 * `TelegramSendError` with a redacted message. Never log with `console` here.
 */
import { type Api, Bot, BotError, GrammyError, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import type { Clock } from '../../lib/clock';
import { findLink, registerAccess } from './telegram.access';
import { registerCommands } from './telegram.commands';
import { registerFlows } from './telegram.flows';
import { createTelegramLog, redact } from './telegram.log';
import { BOT_COMMANDS } from './telegram.messages';
import { createTelegramNotify } from './telegram.notifications';
import {
  type TelegramBot,
  type TelegramContext,
  type TelegramRuntime,
  type TelegramRuntimeStatus,
  type TelegramSendExtra,
  TelegramSendError,
} from './telegram.types';

/** The updates the bot asks for: nothing else is ever delivered. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

/** The delays between two attempts after a failure: 30 s, doubling, at most 5 min. */
export const DEFAULT_BACKOFF = { initialMs: 30_000, maxMs: 5 * 60_000 } as const;

const LONG_POLL_SECONDS = 30;
/** No call to the Bot API takes longer than this (grammY's own default is 500 s). */
const REQUEST_TIMEOUT_SECONDS = 60;
/** How long `stop()` waits to confirm the last update to Telegram. */
const CONFIRM_TIMEOUT_MS = 2_000;

/**
 * grammY types its abort signals with the `abort-controller` package, while Node has its own
 * `AbortSignal`. They are the same at runtime (grammY only calls `addEventListener`), so the
 * standard one is passed through this.
 */
type GrammySignal = NonNullable<Parameters<Api['getMe']>[0]>;
const forGrammy = (signal: AbortSignal): GrammySignal => signal as unknown as GrammySignal;

// --- The bot ---------------------------------------------------------------------------------

export interface TelegramBotOptions {
  token: string;
  /** Default `https://api.telegram.org`. */
  apiRoot?: string;
  /**
   * Who the bot is. Normally unset (the runtime asks `getMe`); tests give it so that
   * `bot.handleUpdate()` works with no call at all.
   */
  botInfo?: UserFromGetMe;
  /**
   * An API transformer installed innermost, i.e. closest to the network. Tests pass one that records
   * the calls and answers them, so no request is ever made.
   */
  transformer?: Transformer;
}

/** Every message of the bot is HTML (names and notes are escaped by the builders); say so unless a call chose. */
const htmlByDefault: Transformer = (prev, method, payload, signal) => {
  if (method === 'sendMessage' || method === 'editMessageText') {
    const params = payload as Record<string, unknown>;
    if (params['parse_mode'] === undefined && params['entities'] === undefined) {
      return prev(method, { ...params, parse_mode: 'HTML' } as typeof payload, signal);
    }
  }
  return prev(method, payload, signal);
};

/**
 * The grammY bot with the module's middleware: the access guard, then the flows, the commands and
 * the fallbacks. It starts nothing: `createTelegramRuntime` polls, tests call `bot.handleUpdate()`.
 */
export function createTelegramBot(tg: TelegramContext, options: TelegramBotOptions): TelegramBot {
  const bot = new Bot(options.token, {
    botInfo: options.botInfo,
    client: { apiRoot: options.apiRoot, timeoutSeconds: REQUEST_TIMEOUT_SECONDS },
  });
  if (options.transformer) bot.api.config.use(options.transformer);
  bot.api.config.use(htmlByDefault);
  // Only used by grammY's own loop, which we do not run; set anyway so nothing is ever printed raw.
  bot.catch((error) => tg.log.error('an update failed', error));

  registerAccess(bot, tg);
  const flows = registerFlows(bot, tg);
  registerCommands(bot, tg, flows);
  return bot;
}

// --- The runtime -----------------------------------------------------------------------------

export interface TelegramRuntimeOptions {
  db: Db;
  /** The only source of "now". */
  clock: Clock;
  config: Pick<Config, 'telegramBotToken' | 'telegramApiRoot' | 'appUrl'>;
  /** Where the log goes (default: the console). It only ever receives redacted strings. */
  sink?: Pick<Console, 'log' | 'error'>;
  /** Tests: an API transformer that replaces the network (see `TelegramBotOptions.transformer`). */
  transformer?: Transformer;
  /** Tests: shorter delays than 30 s to 5 min. */
  backoff?: { initialMs: number; maxMs: number };
  /** Tests: the long-poll length in seconds (default 30). */
  pollSeconds?: number;
}

type Phase =
  | { kind: 'connecting' }
  | { kind: 'running' }
  | { kind: 'error'; problem: 'invalid_token' | 'conflict' | 'unreachable' }
  | { kind: 'stopped' };

interface Failure {
  problem: 'invalid_token' | 'conflict' | 'unreachable';
  /** Do not retry: the token is wrong, so retrying changes nothing. */
  fatal: boolean;
  /** Telegram asked to wait at least this long (429). */
  retryAfterMs: number;
  what: string;
}

function classify(error: unknown): Failure {
  if (error instanceof GrammyError) {
    const code = error.error_code;
    if (code === 401 || code === 404) {
      return {
        problem: 'invalid_token',
        fatal: true,
        retryAfterMs: 0,
        what: 'Telegram refused the token',
      };
    }
    if (code === 409) {
      return {
        problem: 'conflict',
        fatal: false,
        retryAfterMs: 0,
        what: 'another program is polling with this bot',
      };
    }
    const retryAfterMs = code === 429 ? (error.parameters.retry_after ?? 0) * 1000 : 0;
    return {
      problem: 'unreachable',
      fatal: false,
      retryAfterMs,
      what: 'Telegram answered with an error',
    };
  }
  return {
    problem: 'unreachable',
    fatal: false,
    retryAfterMs: 0,
    what: 'Telegram cannot be reached',
  };
}

/** Resolves after `ms`, or at once when `signal` aborts. The timer does not keep the process alive. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Builds the bot and its state machine. Nothing happens until `start()`, which `index.ts` calls after
 * the server listens. The returned object is also the `TelegramHandle` of `createApp` and the
 * scheduler.
 */
export function createTelegramRuntime(options: TelegramRuntimeOptions): TelegramRuntime {
  const { db, clock, config } = options;
  const token = config.telegramBotToken;
  if (!token) throw new Error('createTelegramRuntime needs TELEGRAM_BOT_TOKEN');
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const pollSeconds = options.pollSeconds ?? LONG_POLL_SECONDS;
  const log = createTelegramLog(token, options.sink);

  let phase: Phase = { kind: 'connecting' };
  let blocked = false;
  let botUsername: string | undefined;
  let started = false;
  let offset: number | undefined;
  let loop: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const abort = new AbortController();

  const status = (): TelegramRuntimeStatus => {
    const bot = botUsername === undefined ? null : { username: botUsername };
    switch (phase.kind) {
      case 'connecting':
        return { connection: 'connecting', problem: null, bot };
      case 'running':
        // Blocked is about the linked chat: with no link (it was removed since) there is nothing blocked.
        return blocked && findLink(db) !== null
          ? { connection: 'error', problem: 'blocked', bot }
          : { connection: 'running', problem: null, bot };
      case 'error':
        return { connection: 'error', problem: phase.problem, bot };
      case 'stopped':
        return { connection: 'off', problem: null, bot };
    }
  };

  // --- Sending ---------------------------------------------------------------------------------

  const sendMessage = async (
    chatId: number,
    text: string,
    extra?: TelegramSendExtra,
  ): Promise<void> => {
    if (phase.kind !== 'running') {
      throw new TelegramSendError('not_running', 'The Telegram bot is not running');
    }
    try {
      await bot.api.sendMessage(chatId, text, extra);
    } catch (error) {
      log.error('could not send a message', error);
      throw new TelegramSendError(
        'refused',
        `Telegram did not accept the message: ${redact(error, token)}`,
        error instanceof GrammyError ? error.error_code : undefined,
      );
    }
  };

  const sendToLinked = async (text: string, extra?: TelegramSendExtra): Promise<void> => {
    const link = findLink(db);
    if (!link) throw new TelegramSendError('not_linked', 'No Telegram account is linked');
    await sendMessage(link.chatId, text, extra);
  };

  const notify = createTelegramNotify({
    db,
    clock,
    config: { appUrl: config.appUrl },
    status,
    sendToLinked,
    log,
  });
  const tg: TelegramContext = {
    db,
    clock,
    config: { appUrl: config.appUrl },
    notify,
    sendToLinked,
    log,
  };
  const bot = createTelegramBot(tg, {
    token,
    apiRoot: config.telegramApiRoot,
    transformer: options.transformer,
  });

  // A 403 on a call to the linked chat means the owner blocked the bot; any call that goes through
  // to that chat means they did not (or no longer do). It sees the response, so it sits outermost.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    const chatId = (payload as { chat_id?: unknown }).chat_id;
    if (chatId !== undefined && findLink(db)?.chatId === Number(chatId)) {
      if (!response.ok && response.error_code === 403) {
        if (!blocked) log.error('the owner blocked the bot, nothing can be sent to the chat');
        blocked = true;
      } else if (response.ok) {
        blocked = false;
      }
    }
    return response;
  });

  // --- The loop --------------------------------------------------------------------------------

  const setPhase = (next: Phase): void => {
    const changed =
      phase.kind !== next.kind ||
      (phase.kind === 'error' && next.kind === 'error' && phase.problem !== next.problem);
    phase = next;
    if (changed && next.kind === 'running') log.info(`bot @${botUsername ?? '?'} is running`);
  };

  /** What a start does before polling: no webhook (it would stop `getUpdates`), who am I, the menu. */
  const setup = async (signal: AbortSignal): Promise<void> => {
    await bot.api.deleteWebhook({}, forGrammy(signal));
    const me = await bot.api.getMe(forGrammy(signal));
    bot.botInfo = me;
    botUsername = me.username;
    await bot.api.setMyCommands(BOT_COMMANDS, undefined, forGrammy(signal));
  };

  const handleOne = async (update: Update): Promise<void> => {
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      // One update that fails must neither stop the polling nor be handled again: it is skipped.
      // `handleUpdate` wraps what a handler threw in a `BotError`: log the original, with its stack.
      log.error(
        `could not handle update ${update.update_id}`,
        error instanceof BotError ? error.error : error,
      );
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    let delayMs = backoff.initialMs;
    let ready = false;
    let probing = true;
    while (!signal.aborted) {
      try {
        if (!ready) {
          await setup(signal);
          ready = true;
        }
        const updates = await bot.api.getUpdates(
          {
            offset,
            limit: 100,
            timeout: probing ? 0 : pollSeconds,
            allowed_updates: [...ALLOWED_UPDATES],
          },
          forGrammy(signal),
        );
        probing = false;
        delayMs = backoff.initialMs;
        setPhase({ kind: 'running' });
        for (const update of updates) {
          if (signal.aborted) break; // what was not handled is fetched again at the next start
          offset = update.update_id + 1;
          await handleOne(update);
        }
      } catch (error) {
        if (signal.aborted) return;
        probing = true;
        const failure = classify(error);
        setPhase({ kind: 'error', problem: failure.problem });
        if (failure.fatal) {
          log.error(`${failure.what}; the bot stays off until Wallet restarts`, error);
          return;
        }
        const waitMs = Math.max(delayMs, failure.retryAfterMs);
        log.error(`${failure.what}; trying again in ${Math.ceil(waitMs / 1000)} s`, error);
        await sleep(waitMs, signal);
        delayMs = Math.min(delayMs * 2, backoff.maxMs);
      }
    }
  };

  return {
    status,
    sendMessage,
    sendToLinked,
    notify,
    log,

    start() {
      if (started) return;
      started = true;
      log.info('starting the bot');
      loop = run(abort.signal).catch((error: unknown) => {
        log.error('the polling loop failed', error);
        setPhase({ kind: 'error', problem: 'unreachable' });
      });
    },

    stop() {
      stopping ??= (async () => {
        abort.abort();
        notify.stop();
        await loop;
        // Tell Telegram which updates were handled, so that a restart does not deliver them again.
        if (started && offset !== undefined) {
          try {
            await bot.api.getUpdates(
              { offset, limit: 1, timeout: 0 },
              forGrammy(AbortSignal.timeout(CONFIRM_TIMEOUT_MS)),
            );
          } catch {
            // Best effort: at worst the last update is handled twice after a restart.
          }
        }
        phase = { kind: 'stopped' };
      })();
      return stopping;
    },
  };
}
